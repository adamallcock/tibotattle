import { execFileSync, fork, spawn } from "node:child_process";
import { closeSync, openSync, opendirSync, readSync, readlinkSync, realpathSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CATEGORIES, parseStat as parseBaseStat, writeRecord } from "./hosted-backend-process-sampler.mjs";

// Fixed synthetic CI diagnostic; never a replacement for the full Worker gate.
// Native x86-64 syscall numbers: Linux v6.17 arch/x86/entry/syscalls/syscall_64.tbl.
// /proc/PID/task/TID/schedstat: CPU ns, runqueue ns, timeslices. Disabled or
// all-zero accounting is unavailable, not evidence of zero scheduling delay.
// /proc/PID/task/TID/syscall uses PTRACE_MODE_ATTACH_FSCREDS permission checks;
// reading it does not attach a tracer. Only its first token is read.
// Samples are racy occupancy observations, not call counts, wait durations,
// SQL attribution, or a measurement of this observer's overhead.
export const COMMAND = Object.freeze(["npm", "--prefix", "apps/worker", "test", "--", "test/storage-community-graph-publication.spec.ts"]);
export const LIMITS = Object.freeze({ cadenceMs: 250, commandMs: 240_000, readyMs: 5000, graceMs: 1000, reapMs: 3000,
  processes: 64, tasks: 256, operations: 4096, scanMs: 40, fileBytes: 16_384, records: 970, outputBytes: 8_000_000 });
const SYSCALLS = Object.freeze({ fsync: [74], fdatasync: [75], futex_family: [202, 449, 454, 455, 456],
  poll_family: [7, 23, 232, 270, 271, 281, 441], read_write: [0, 1, 17, 18, 19, 20, 295, 296, 327, 328], sleep: [35, 230] });
const SAMPLE_CLASSES = Object.freeze([...Object.keys(SYSCALLS), "other_syscall", "running", "blocked_unknown", "unknown_abi", "unavailable"]);
const STATES = Object.freeze(["running", "sleeping", "uninterruptible", "stopped", "zombie", "other"]);
const GAP_NAMES = ["missing", "permission", "malformed", "identity", "budget", "escapedGroup", "other"];
const SIGNAL_EXITS = Object.freeze({ SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGILL: 132, SIGTRAP: 133, SIGABRT: 134,
  SIGBUS: 135, SIGFPE: 136, SIGKILL: 137, SIGUSR1: 138, SIGSEGV: 139, SIGUSR2: 140, SIGPIPE: 141, SIGALRM: 142,
  SIGTERM: 143, SIGXCPU: 152, SIGXFSZ: 153, SIGVTALRM: 154, SIGPROF: 155, SIGSYS: 159 });
const fault = (code) => Object.assign(new Error("graph diagnostic unavailable"), { code });
const uint = (text) => {
  if (!/^(0|[1-9][0-9]{0,19})$/u.test(text ?? "")) throw fault("malformed");
  const value = BigInt(text);
  if (value > 18446744073709551615n) throw fault("malformed");
  return value;
};
const pid = (text) => { const value = uint(text); if (value < 1n || value > 2147483647n) throw fault("malformed"); return Number(value); };
const identity = (s) => `${s.pid}:${s.startTicks}`;
export const sameIdentity = (a, b) => a.pid === b.pid && a.startTicks === b.startTicks && a.ppid === b.ppid && a.pgrp === b.pgrp && a.session === b.session;
export const sameOwnedLeader = (a, b) => a.pid === b.pid && a.startTicks === b.startTicks && a.pgrp === a.pid && b.pgrp === b.pid && a.session === a.pid && b.session === b.pid;
export function admitSupervisor(candidate, childPid, parentPid) {
  if (candidate.pid !== childPid || candidate.ppid !== parentPid || candidate.pgrp !== childPid || candidate.session !== childPid) throw fault("identity");
  return candidate;
}

export function parseStat(text) {
  const base = parseBaseStat(text), fields = text.slice(text.lastIndexOf(") ") + 2).trim().split(/\s+/u);
  return { ...base, pgrp: pid(fields[2]), session: pid(fields[3]), state: fields[0] };
}
export function parseSchedstat(text, enabled) {
  const fields = text.trim().split(/\s+/u);
  if (fields.length !== 3) throw fault("malformed");
  const values = fields.map(uint);
  return enabled === true && values.some((value) => value !== 0n) ? { cpuNs: values[0], runqueueNs: values[1], slices: values[2] } : null;
}
export function classifySyscall(token, nativeX64) {
  if (token === "running") return "running";
  if (token === "-1") return "blocked_unknown";
  if (!/^(0|[1-9][0-9]{0,9})$/u.test(token)) throw fault("malformed");
  const number = Number(token);
  if (!nativeX64 || number >= 0x40000000) return "unknown_abi"; // Never mask x32 bits.
  return Object.entries(SYSCALLS).find(([, numbers]) => numbers.includes(number))?.[0] ?? "other_syscall";
}
function stateClass(state) {
  return ({ R: "running", S: "sleeping", D: "uninterruptible", T: "stopped", t: "stopped", Z: "zombie" })[state] ?? "other";
}
export function linuxReader(fs = { openSync, readSync, closeSync, opendirSync, readlinkSync }) {
  return {
    read(relative) {
      if (!/^(?:sys\/kernel\/sched_schedstats|[1-9][0-9]*\/stat|[1-9][0-9]*\/task\/[1-9][0-9]*\/(?:stat|schedstat|children))$/u.test(relative)) throw fault("malformed");
      const fd = fs.openSync(`/proc/${relative}`, "r");
      try { const buffer = Buffer.alloc(LIMITS.fileBytes + 1), size = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (size > LIMITS.fileBytes) throw fault("budget"); return buffer.toString("utf8", 0, size);
      } finally { fs.closeSync(fd); }
    },
    syscall(pidValue, tid) {
      if (!Number.isSafeInteger(pidValue) || !Number.isSafeInteger(tid) || pidValue < 1 || tid < 1) throw fault("malformed");
      const fd = fs.openSync(`/proc/${pidValue}/task/${tid}/syscall`, "r"), byte = Buffer.alloc(1);
      try {
        let token = "";
        for (let i = 0; i < 16; i++) {
          if (fs.readSync(fd, byte, 0, 1, null) === 0) return token;
          const char = String.fromCharCode(byte[0]);
          if (/\s/u.test(char)) return token;
          token += char;
        }
        throw fault("malformed");
      } finally { fs.closeSync(fd); }
    },
    tasks(pidValue, remaining) {
      const directory = fs.opendirSync(`/proc/${pidValue}/task`), result = [];
      try { for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (result.length >= remaining) throw fault("budget"); result.push(pid(entry.name));
      } return result; } finally { directory.closeSync(); }
    },
    executable(pidValue) { return fs.readlinkSync(`/proc/${pidValue}/exe`); },
  };
}

export function createThreadSampler({ reader, root, knownExecutables, hz, now = () => performance.now(), utc = () => Date.now(), limits = LIMITS }) {
  if (!Number.isSafeInteger(hz) || hz <= 0) throw fault("malformed");
  let previous = null;
  return () => {
    const start = now(), atUnixMs = utc(), gaps = Object.fromEntries(GAP_NAMES.map((name) => [name, 0]));
    let operations = 0, tasksEnumerated = 0, rootLost = false, schedstats = "unknown";
    const tasks = new Map(), queue = [{ stat: root, chain: [] }], seen = new Set();
    const note = (error) => { const code = ["ENOENT", "ESRCH"].includes(error.code) ? "missing" : ["EACCES", "EPERM"].includes(error.code) ? "permission" : GAP_NAMES.includes(error.code) ? error.code : "other"; gaps[code]++; };
    const budget = () => { if (++operations > limits.operations || now() - start > limits.scanMs) throw fault("budget"); };
    const read = (path, parse) => { budget(); return parse(reader.read(path)); };
    const stat = (id) => read(`${id}/stat`, parseStat);
    const verify = (expected) => { if (!sameIdentity(expected, stat(expected.pid))) throw fault("identity"); };
    const verifyRoot = () => { operations++; if (!sameIdentity(root, parseStat(reader.read(`${root.pid}/stat`)))) throw fault("identity"); };
    const optional = (fn) => { try { return fn(); } catch (error) { note(error); return null; } };
    try {
      verifyRoot();
      const enabled = optional(() => read("sys/kernel/sched_schedstats", (text) => {
        if (!/^[01]\s*$/u.test(text)) throw fault("malformed"); return text.trim() === "1";
      }));
      schedstats = enabled === null ? "unknown" : enabled ? "enabled" : "disabled";
      for (let index = 0; index < queue.length; index++) {
        if (index >= limits.processes) { gaps.budget++; break; }
        const { stat: expected, chain } = queue[index];
        try {
          for (const ancestor of chain) verify(ancestor);
          verify(expected);
          if (seen.has(identity(expected))) continue;
          seen.add(identity(expected));
          if (expected.pgrp !== root.pgrp || expected.session !== root.session) throw fault("escapedGroup");
          budget(); const exe = reader.executable(expected.pid);
          const category = exe === knownExecutables.workerd ? "workerd" : exe === knownExecutables.node ? "node" : "other";
          budget(); const tids = reader.tasks(expected.pid, limits.tasks - tasksEnumerated);
          tasksEnumerated += tids.length;
          const pending = [], children = new Set();
          for (const tid of tids) {
            try {
              const path = `${expected.pid}/task/${tid}`, before = read(`${path}/stat`, parseStat);
              if (before.pid !== tid || before.ppid !== expected.ppid || before.pgrp !== root.pgrp || before.session !== root.session) throw fault("identity");
              let sched = null, syscall = "unavailable";
              if (expected.pid !== root.pid) {
                sched = optional(() => read(`${path}/schedstat`, (text) => parseSchedstat(text, enabled)));
                syscall = optional(() => { budget(); return classifySyscall(reader.syscall(expected.pid, tid), category !== "other"); }) ?? "unavailable";
              }
              const childText = read(`${path}/children`, (text) => text);
              for (const token of childText.trim().split(/\s+/u).filter(Boolean)) children.add(pid(token));
              const after = read(`${path}/stat`, parseStat);
              if (!sameIdentity(before, after)) throw fault("identity");
              if (expected.pid !== root.pid) pending.push({ id: `${identity(expected)}/${identity(after)}`, category,
                cpuTicks: after.userTicks + after.systemTicks, sched, syscall, state: stateClass(after.state) });
            } catch (error) { note(error); }
            if (gaps.budget) break;
          }
          verify(expected); budget(); if (reader.executable(expected.pid) !== exe) throw fault("identity");
          for (const ancestor of chain) verify(ancestor);
          for (const task of pending) tasks.set(task.id, task);
          for (const child of children) {
            if (gaps.budget) break;
            if (queue.length >= limits.processes) { gaps.budget++; break; }
            optional(() => { verify(expected); const next = stat(child); if (next.ppid !== expected.pid) throw fault("identity");
              queue.push({ stat: next, chain: [...chain, expected] }); return true; });
          }
        } catch (error) { note(error); }
        if (gaps.budget) break;
      }
      verifyRoot();
    } catch (error) { note(error); rootLost = true; tasks.clear(); }
    const end = now(), current = { tasks, start, end };
    const record = { kind: "worker-graph-thread-sample-v1", atUnixMs, intervalMs: { previousStart: previous?.start ?? null, previousEnd: previous?.end ?? null, start, end },
      scope: { complete: false, rootLost, schedstats, processesVisited: seen.size, tasksEnumerated, tasksObserved: tasks.size, metadataOperationsAttempted: operations, gaps },
      categories: aggregateThreads(current, previous, hz) };
    previous = rootLost ? null : current;
    return record;
  };
}

export function aggregateThreads(current, previous, hz) {
  return Object.fromEntries(CATEGORIES.map((category) => {
    const selected = [...current.tasks.values()].filter((task) => task.category === category);
    let matched = 0, ticks = 0n, maxTicks = 0n, schedulingMatched = 0, cpuNs = 0n, queueNs = 0n, regressions = 0;
    const syscallSamples = Object.fromEntries(SAMPLE_CLASSES.map((name) => [name, 0])), stateSamples = Object.fromEntries(STATES.map((name) => [name, 0]));
    for (const task of selected) {
      syscallSamples[task.syscall]++; stateSamples[task.state]++;
      const old = previous?.tasks.get(task.id);
      if (!old || old.category !== category) continue;
      if (task.cpuTicks < old.cpuTicks) { regressions++; continue; }
      const delta = task.cpuTicks - old.cpuTicks; ticks += delta; if (delta > maxTicks) maxTicks = delta; matched++;
      if (!task.sched || !old.sched) continue;
      if (task.sched.cpuNs < old.sched.cpuNs || task.sched.runqueueNs < old.sched.runqueueNs || task.sched.slices < old.sched.slices) { regressions++; continue; }
      schedulingMatched++; cpuNs += task.sched.cpuNs - old.sched.cpuNs; queueNs += task.sched.runqueueNs - old.sched.runqueueNs;
    }
    const ms = (value) => value <= BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)) ? Number(value) * 1000 / hz : null;
    return [category, { threadsObserved: selected.length, matchedThreads: matched, observedCpuTicks: matched ? String(ticks) : null,
      observedCpuMs: matched ? ms(ticks) : null, maxMatchedThreadCpuMs: matched ? ms(maxTicks) : null,
      schedstatMatchedThreads: schedulingMatched, schedstatCpuNs: schedulingMatched ? String(cpuNs) : null,
      runqueueDelayNs: schedulingMatched ? String(queueNs) : null, counterRegressions: regressions,
      newOrReclassifiedThreads: selected.filter((task) => previous?.tasks.get(task.id)?.category !== category).length,
      priorThreadsUnobserved: [...(previous?.tasks.values() ?? [])].filter((task) => task.category === category && current.tasks.get(task.id)?.category !== category).length,
      syscallSamples, stateSamples }];
  }));
}

export function createOutput(output, limits = LIMITS) {
  let records = 0, bytes = 0;
  return (record) => {
    const size = Buffer.byteLength(JSON.stringify(record)) + 1;
    if (++records > limits.records || (bytes += size) > limits.outputBytes) throw fault("budget");
    writeRecord(output, record);
  };
}
export function chooseExit({ result, interruption, capped, collectorFailed, cleanupComplete }) {
  if (result && Number.isInteger(result.code) && result.code !== 0) return result.code;
  if (interruption) return interruption === "SIGINT" ? 130 : 143;
  if (capped) return 124;
  if (result?.signal) return SIGNAL_EXITS[result.signal] ?? 1;
  return !result || collectorFailed || !cleanupComplete ? 1 : 0;
}

const sleep = (ms) => new Promise((accept) => setTimeout(accept, ms));
export async function cleanupOwnedGroup({ root, readIdentity, signalGroup, disconnect = () => {}, reaped, wait = sleep, limits = LIMITS }) {
  let term = false, kill = false, identityVerified = false;
  try {
    if (!sameIdentity(root, readIdentity()) || root.pid !== root.pgrp || root.pid !== root.session) throw fault("identity");
    identityVerified = true; signalGroup("SIGTERM"); term = true;
    await wait(limits.graceMs);
    if (!sameIdentity(root, readIdentity())) throw fault("identity");
    signalGroup("SIGKILL"); kill = true;
  } catch { /* Never signal a group after losing its identity anchor. */ }
  if (!kill) disconnect(); // Owned IPC only: supervisor performs its own identity check.
  const wasReaped = await Promise.race([reaped.then(() => true), wait(limits.reapMs).then(() => false)]);
  return { identityVerified, termSent: term, killSent: kill, supervisorReaped: wasReaped, complete: identityVerified && kill && wasReaped };
}

// The held, IPC-only supervisor remains the group leader after npm exits. This
// keeps group ownership provable through cleanup instead of reusing a stale PID.
export function installSupervisorGuard({ channel, root, readIdentity, killGroup, exit, schedule = setTimeout }) {
  const terminate = () => {
    // A dead parent reparents us. Self-owned group identity intentionally does
    // not require the dead parent's PPID; launcher admission still does.
    try { if (sameOwnedLeader(root, readIdentity())) killGroup(); }
    catch { /* Only the current owned group may be signalled. */ }
    exit(1);
  };
  channel.on("SIGINT", () => {}); channel.on("SIGTERM", () => {});
  channel.once("disconnect", terminate);
  schedule(terminate, LIMITS.readyMs + LIMITS.commandMs + LIMITS.graceMs + LIMITS.reapMs + 1000);
  return terminate;
}
async function supervisor() {
  if (process.platform !== "linux" || !process.send || !process.connected) throw fault("malformed");
  const reader = linuxReader(), root = parseStat(reader.read(`${process.pid}/stat`));
  if (root.pgrp !== process.pid || root.session !== process.pid) throw fault("identity");
  const terminateOwnGroup = installSupervisorGuard({ channel: process, root, readIdentity: () => parseStat(reader.read(`${process.pid}/stat`)),
    killGroup: () => process.kill(-process.pid, "SIGKILL"), exit: (code) => process.exit(code) });
  const send = (message) => {
    if (!process.connected) { terminateOwnGroup(); return; }
    try { process.send(message, (error) => { if (error) terminateOwnGroup(); }); }
    catch { terminateOwnGroup(); }
  };
  let started = false;
  process.on("message", (message) => {
    if (started || message?.type !== "start" || Object.keys(message).length !== 1) { terminateOwnGroup(); return; }
    started = true;
    let child;
    try { child = spawn(COMMAND[0], COMMAND.slice(1), { stdio: "inherit", cwd: resolve(dirname(fileURLToPath(import.meta.url)), "..") }); }
    catch { send({ type: "result", code: 127, signal: null }); return; }
    let reported = false;
    const report = (code, signal) => { if (!reported) { reported = true; send({ type: "result", code, signal }); } };
    child.once("error", () => report(127, null)); child.once("exit", report);
  });
  send({ type: "ready" });
  await new Promise(() => {}); // Parent kills and reaps this held group leader.
}

export function validatePlatform(platform, architecture, args) {
  if (platform !== "linux" || architecture !== "x64" || args.length !== 0) throw fault("unsupported");
}
export async function runDiagnostic({ reader, knownExecutables, hz, output, createSupervisor, parentPid,
  signalGroup, signals = process, streams = [], now = () => performance.now(), wait = sleep, limits = LIMITS }) {
  let collectorFailed = false, interruption = null, capped = false, result = null, child, root, startedAt;
  let wake = () => {};
  const stop = (signal) => { interruption ??= signal; wake(); };
  const stopInt = () => stop("SIGINT"), stopTerm = () => stop("SIGTERM");
  const outputFailed = () => { collectorFailed = true; wake(); };
  signals.on("SIGINT", stopInt); signals.on("SIGTERM", stopTerm);
  for (const stream of streams) stream.on("error", outputFailed);
  let exitChild;
  try {
    child = createSupervisor();
    exitChild = new Promise((accept) => { child.once("exit", accept); });
    // An IPC/spawn error is not proof of process exit or reap.
    child.on("error", () => { collectorFailed = true; wake(); });
    let ready = false;
    child.on("message", (message) => {
      if (message?.type === "ready" && Object.keys(message).length === 1) ready = true;
      else if (message?.type === "result" && Object.keys(message).length === 3 && ((Number.isInteger(message.code) && message.code >= 0 && message.code <= 255 && message.signal === null) || (message.code === null && Object.hasOwn(SIGNAL_EXITS, message.signal)))) result = { code: message.code, signal: message.signal };
      else collectorFailed = true;
      wake();
    });
    const readyDeadline = now() + limits.readyMs;
    while (!ready && !interruption && !collectorFailed && now() < readyDeadline) {
      const event = await Promise.race([exitChild.then(() => "exit"), wait(20).then(() => "timer")]);
      if (event === "exit") collectorFailed = true;
    }
    if (!ready || interruption || collectorFailed) throw fault("unavailable");
    root = admitSupervisor(parseStat(reader.read(`${child.pid}/stat`)), child.pid, parentPid);
    const sample = createThreadSampler({ reader, root, knownExecutables, hz, now, limits });
    output({ kind: "worker-graph-thread-diagnostic-v1", platform: "linux", architecture: "native-x64-known-executables-only", cadenceMs: limits.cadenceMs, commandCapMs: limits.commandMs, clockTicksPerSecond: hz, limits,
      semantics: "matched thread identities only; supervisor excluded; task CPU ticks are not added to process totals; schedstat ns unavailable when disabled/unknown/all-zero; syscall/state counts are racy occupancy samples, not durations or SQL attribution; cooperative scan budget, not syscall timeout; observer overhead unmeasured" });
    startedAt = now(); child.send({ type: "start" });
    while (!result && !interruption && !collectorFailed) {
      const began = now();
      if (began - startedAt >= limits.commandMs) { capped = true; break; }
      const record = sample(); output(record);
      if (record.scope.rootLost || record.scope.gaps.escapedGroup) { collectorFailed = true; break; }
      const event = await Promise.race([new Promise((accept) => { wake = () => accept("message"); }), wait(Math.max(0, limits.cadenceMs - (now() - began))).then(() => "timer"), exitChild.then(() => "exit")]);
      if (event === "exit") collectorFailed = true;
    }
  } catch { collectorFailed = true; }
  // Even a pre-ready failure may capture the newly spawned, exact direct child
  // before signalling. An unprovable identity is never replaced with a PID guess.
  if (!root && child?.pid) {
    try { root = admitSupervisor(parseStat(reader.read(`${child.pid}/stat`)), child.pid, parentPid);
    } catch { /* Its own disconnect watchdog handles an inaccessible supervisor. */ }
  }
  // Cleanup-induced npm signals must never replace the original outcome.
  const authoritativeResult = result;
  const disconnect = () => { if (child?.connected) child.disconnect(); };
  let cleanup;
  if (root) cleanup = await cleanupOwnedGroup({ root, readIdentity: () => parseStat(reader.read(`${root.pid}/stat`)), signalGroup: (signal) => signalGroup(root.pid, signal), disconnect, reaped: exitChild, wait, limits });
  else {
    disconnect();
    const supervisorReaped = !child?.pid || await Promise.race([exitChild.then(() => true), wait(limits.reapMs).then(() => false)]);
    cleanup = { identityVerified: false, termSent: false, killSent: false, supervisorReaped, complete: !child?.pid };
  }
  if (child?.connected) child.disconnect();
  const code = chooseExit({ result: authoritativeResult, interruption, capped, collectorFailed, cleanupComplete: cleanup.complete });
  try { output({ kind: "worker-graph-thread-terminal-v1", child: { resultReceived: authoritativeResult !== null, exitCode: authoritativeResult?.code ?? null, signal: authoritativeResult?.signal ?? null },
    interruption, commandCapReached: capped, collectorFailed, cleanup,
    cleanupProof: "identity-verified owned-group signalling and direct-supervisor reap only; not independent disappearance proof for every descendant",
    diagnosticExitCode: code }); }
  catch { collectorFailed = true; }
  signals.removeListener("SIGINT", stopInt); signals.removeListener("SIGTERM", stopTerm);
  for (const stream of streams) stream.removeListener("error", outputFailed);
  const outcome = { result: authoritativeResult, interruption, capped, collectorFailed, cleanupComplete: cleanup.complete };
  return { ...outcome, cleanup, code: chooseExit(outcome) };
}

async function main() {
  validatePlatform(process.platform, process.arch, process.argv.slice(2));
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (realpathSync(process.cwd()) !== realpathSync(repository)) throw fault("malformed");
  const hzText = execFileSync("/usr/bin/getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 1000, maxBuffer: 64, stdio: ["ignore", "pipe", "ignore"] }).trim();
  const hz = Number(uint(hzText));
  if (!Number.isSafeInteger(hz) || hz <= 0) throw fault("malformed");
  // Exact pinned native executable paths define the ABI classification. Unknown
  // descendant executables keep unknown_abi syscall classifications.
  const knownExecutables = { node: realpathSync(process.execPath), workerd: realpathSync(resolve(repository, "apps/worker/node_modules/@cloudflare/workerd-linux-64/bin/workerd")) };
  const outcome = await runDiagnostic({ reader: linuxReader(), knownExecutables, hz, output: createOutput(process.stdout), parentPid: process.pid,
    createSupervisor: () => fork(fileURLToPath(import.meta.url), ["--owned-supervisor"], { detached: true, stdio: ["ignore", "inherit", "inherit", "ipc"], execArgv: [] }),
    signalGroup: (id, signal) => process.kill(-id, signal), streams: [process.stdout, process.stderr] });
  process.on("SIGINT", () => { outcome.interruption ??= "SIGINT"; });
  process.on("SIGTERM", () => { outcome.interruption ??= "SIGTERM"; });
  // Bound final flushing and close asynchronous pipe-error paths without stacks.
  let pipeFailed = false;
  process.stdout.on("error", () => { pipeFailed = true; }); process.stderr.on("error", () => { pipeFailed = true; });
  const flushed = await Promise.race([new Promise((accept) => { process.stdout.write("", (error) => accept(!error)); }), sleep(100).then(() => false)]);
  process.exit(chooseExit({ ...outcome, collectorFailed: outcome.collectorFailed || !flushed || pipeFailed }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const entry = process.argv.length === 3 && process.argv[2] === "--owned-supervisor" ? supervisor : main;
  entry().catch(() => {
    try { process.stderr.write('{"kind":"worker-graph-thread-terminal-v1","unavailable":true}\n'); } catch { /* closed output */ }
    process.exit(1);
  });
}
