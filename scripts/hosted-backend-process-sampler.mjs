import { execFileSync } from "node:child_process";
import { closeSync, openSync, opendirSync, readSync, readlinkSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// Passive diagnostics only. Linux documents children as a racy, per-thread
// interface: https://docs.kernel.org/filesystems/proc.html#proc-pid-task-tid-children-information-about-task-children
// stat utime/stime exclude waited-child CPU; do not add cutime/cstime.
// https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
// Unlike /proc/PID/io, task/TID/io excludes waited-child accounting:
// https://github.com/torvalds/linux/blob/v6.17/fs/proc/base.c (do_io_accounting).
// VmRSS is approximate and summing processes counts shared pages repeatedly.
// I/O accounting is neither fsync latency nor device throughput; write_bytes
// includes writes later cancelled (reported separately). No causal inference.

export const CATEGORIES = Object.freeze(["workerd", "node", "other"]);
export const IO_FIELDS = Object.freeze(["rchar", "wchar", "syscr", "syscw", "read_bytes", "write_bytes", "cancelled_write_bytes"]);
export const LIMITS = Object.freeze({ processes: 128, tasks: 1024, reads: 8192, fileBytes: 16384, roundMs: 100 });
const CADENCE_MS = 1000;
const FAULTS = ["missing", "unreadable", "malformed", "identityChanged", "limitReached"];
const fault = (code) => Object.assign(new Error("process diagnostic unavailable"), { code });
const uint = (value) => {
  if (!/^(0|[1-9][0-9]{0,19})$/u.test(value ?? "")) throw fault("malformed");
  const parsed = BigInt(value);
  if (parsed > 18446744073709551615n) throw fault("malformed");
  return parsed;
};
const pidNumber = (value) => {
  const parsed = uint(value);
  if (parsed < 1n || parsed > 2147483647n) throw fault("malformed");
  return Number(parsed);
};
const key = (stat) => `${stat.pid}:${stat.startTicks}`;
const same = (a, b) => a.pid === b.pid && a.startTicks === b.startTicks && a.ppid === b.ppid;

export function parseStat(text) {
  // comm may contain spaces and parentheses. It is discarded, never emitted.
  const end = text.lastIndexOf(") ");
  const prefix = /^(\d+) \(/u.exec(text);
  if (!prefix || end < prefix[0].length) throw fault("malformed");
  const fields = text.slice(end + 2).trim().split(/\s+/u);
  if (fields.length < 22 || !/^[A-Za-z]$/u.test(fields[0])) throw fault("malformed");
  const ppid = uint(fields[1]);
  if (ppid > 2147483647n) throw fault("malformed");
  return { pid: pidNumber(prefix[1]), ppid: Number(ppid), userTicks: uint(fields[11]), systemTicks: uint(fields[12]), startTicks: uint(fields[19]) };
}

export function parseIo(text) {
  const result = {};
  for (const field of IO_FIELDS) {
    const matches = [...text.matchAll(new RegExp(`^${field}:\\s*([0-9]+)\\s*$`, "gmu"))];
    if (matches.length !== 1) throw fault("malformed");
    result[field] = uint(matches[0][1]);
  }
  return result;
}

export function parseRss(text) {
  const matches = [...text.matchAll(/^VmRSS:\s*([0-9]+) kB\s*$/gmu)];
  if (matches.length !== 1) throw fault("malformed");
  return uint(matches[0][1]); // proc's kB is KiB; no page-size assumption.
}

export function classifyExecutable(target) {
  const basename = target.split("/").at(-1)?.replace(/ \(deleted\)$/u, "");
  return basename === "workerd" || basename === "node" ? basename : "other";
}

export function parseArguments(args, parentPid) {
  if (args.length !== 2 || args[0] !== "--parent-pid") throw fault("malformed");
  const pid = pidNumber(args[1]);
  if (pid !== parentPid) throw fault("identityChanged");
  return pid;
}

export function linuxReader(fs = { openSync, readSync, closeSync, opendirSync, readlinkSync }) {
  return {
    read(relative) {
      // Only the fixed metadata surfaces below are ever opened. No cmdline,
      // environ, fd, stack, log or payload reads, and no /proc-wide inventory.
      if (!/^[1-9][0-9]*\/(?:stat|status|task\/[1-9][0-9]*\/(?:stat|io|children))$/u.test(relative)) throw fault("malformed");
      const fd = fs.openSync(`/proc/${relative}`, "r");
      try {
        const buffer = Buffer.alloc(LIMITS.fileBytes + 1);
        const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (size > LIMITS.fileBytes) throw fault("limitReached");
        return buffer.toString("utf8", 0, size);
      } finally { fs.closeSync(fd); }
    },
    tasks(pid, limit) {
      const directory = fs.opendirSync(`/proc/${pid}/task`);
      try {
        const ids = [];
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (ids.length >= limit) throw fault("limitReached");
          ids.push(pidNumber(entry.name));
        }
        return ids;
      } finally { directory.closeSync(); }
    },
    executable(pid) { return fs.readlinkSync(`/proc/${pid}/exe`); },
  };
}

export function createSampler({ reader, rootPid, selfPid, clockTicksPerSecond, now = () => performance.now(), utc = () => new Date().toISOString(), limits = LIMITS }) {
  if (!Number.isSafeInteger(clockTicksPerSecond) || clockTicksPerSecond <= 0) throw fault("malformed");
  const root = parseStat(reader.read(`${rootPid}/stat`));
  const self = parseStat(reader.read(`${selfPid}/stat`));
  if (root.pid !== rootPid || self.pid !== selfPid || self.ppid !== rootPid) throw fault("identityChanged");
  let previous = null;

  return function sample() {
    const started = now();
    const atUtc = utc();
    const gaps = Object.fromEntries(FAULTS.map((name) => [name, 0]));
    const processes = new Map();
    const tasks = new Map();
    let reads = 0;
    let taskCount = 0;
    let candidates = 0;
    let rootLost = false;
    const countFault = (error) => {
      const code = ["ENOENT", "ESRCH"].includes(error.code) ? "missing" : FAULTS.includes(error.code) ? error.code : "unreadable";
      gaps[code] += 1;
    };
    const budget = () => {
      if (++reads > limits.reads || now() - started > limits.roundMs) throw fault("limitReached");
    };
    const read = (path, parser) => { budget(); return parser(reader.read(path)); };
    const stat = (pid) => read(`${pid}/stat`, parseStat);
    const verify = (expected) => { if (!same(expected, stat(expected.pid))) throw fault("identityChanged"); };
    const verifyRoot = () => {
      reads += 1;
      if (!same(root, parseStat(reader.read(`${rootPid}/stat`)))) throw fault("identityChanged");
    };
    const verifyChain = (chain) => { for (const ancestor of chain) verify(ancestor); };
    const optional = (fn) => { try { return fn(); } catch (error) { countFault(error); return null; } };
    const queue = [{ expected: root, chain: [] }];
    const seen = new Set();
    try {
      verifyRoot();
      for (let index = 0; index < queue.length; index += 1) {
        if (++candidates > limits.processes) { countFault(fault("limitReached")); break; }
        const { expected, chain } = queue[index];
        try {
          verifyChain(chain);
          verify(expected);
          if (seen.has(key(expected))) continue;
          seen.add(key(expected));
          if (same(expected, self)) continue; // Exclude this sampler and its entire branch.
          const pid = expected.pid;
          budget();
          const executable = pid === rootPid ? null : optional(() => reader.executable(pid));
          const category = executable === null ? null : classifyExecutable(executable);
          const rss = pid === rootPid ? null : optional(() => read(`${pid}/status`, parseRss));
          const localTasks = [];
          const children = new Set();
          budget();
          const tids = reader.tasks(pid, limits.tasks - taskCount);
          taskCount += tids.length;
          for (const tid of tids) {
            try {
              const taskPath = `${pid}/task/${tid}`;
              const before = read(`${taskPath}/stat`, parseStat);
              if (before.pid !== tid || before.ppid !== expected.ppid) throw fault("identityChanged");
              const io = pid === rootPid || category === null ? null : optional(() => read(`${taskPath}/io`, parseIo));
              const childText = read(`${taskPath}/children`, (value) => value);
              for (const token of childText.trim().split(/\s+/u).filter(Boolean)) children.add(pidNumber(token));
              if (!same(before, read(`${taskPath}/stat`, parseStat))) throw fault("identityChanged");
              if (io !== null) localTasks.push({ identity: `${key(expected)}/${key(before)}`, category, io });
            } catch (error) { countFault(error); }
          }
          const after = stat(pid);
          if (!same(expected, after)) throw fault("identityChanged");
          if (executable !== null) {
            budget();
            if (reader.executable(pid) !== executable) throw fault("identityChanged");
          }
          verifyChain(chain);
          if (pid !== rootPid && category !== null) {
            processes.set(key(after), { ...after, category, rss });
            for (const task of localTasks) tasks.set(task.identity, task);
          }
          for (const childPid of children) {
            if (queue.length >= limits.processes) { countFault(fault("limitReached")); break; }
            try {
              verify(after); // Bind the discovered child to this parent's start identity.
              const child = stat(childPid);
              if (child.ppid !== pid) throw fault("identityChanged");
              queue.push({ expected: child, chain: [...chain, after] });
            } catch (error) { countFault(error); }
          }
        } catch (error) { countFault(error); }
        if (gaps.limitReached > 0) break;
      }
      // One reserved read checks the anchor even after the cooperative scan
      // budget expires. A truncated scan is a gap, not a lost-root claim.
      verifyRoot();
    } catch (error) { countFault(error); rootLost = true; processes.clear(); tasks.clear(); }
    const finished = now();
    const current = { processes, tasks, started, finished };
    const categories = aggregate(current, previous, clockTicksPerSecond);
    const result = {
      kind: "worker-process-sample-v1", atUtc,
      intervalMs: { previousStart: previous?.started ?? null, previousEnd: previous?.finished ?? null, start: started, end: finished },
      scope: { complete: false, rootLost, processesObserved: processes.size, tasksEnumerated: taskCount, ioTasksObserved: tasks.size, metadataReads: reads, gaps },
      categories,
    };
    previous = rootLost ? null : current;
    return result;
  };
}

export function aggregate(current, previous, hz) {
  return Object.fromEntries(CATEGORIES.map((category) => {
    const selected = [...current.processes.values()].filter((entry) => entry.category === category);
    const old = [...(previous?.processes.values() ?? [])].filter((entry) => entry.category === category);
    const newTasks = [...current.tasks.values()].filter((entry) => entry.category === category);
    const oldTasks = [...(previous?.tasks.values() ?? [])].filter((entry) => entry.category === category);
    let cpuTicks = 0n;
    let cpuMatched = 0;
    let counterRegressions = 0;
    for (const entry of selected) {
      const prior = previous?.processes.get(key(entry));
      if (!prior || prior.category !== category) continue;
      if (entry.userTicks < prior.userTicks || entry.systemTicks < prior.systemTicks) { counterRegressions += 1; continue; }
      cpuTicks += entry.userTicks - prior.userTicks + entry.systemTicks - prior.systemTicks;
      cpuMatched += 1;
    }
    const io = Object.fromEntries(IO_FIELDS.map((field) => [field, 0n]));
    let ioMatched = 0;
    for (const task of newTasks) {
      const prior = previous?.tasks.get(task.identity);
      if (!prior || prior.category !== category) continue;
      if (IO_FIELDS.some((field) => task.io[field] < prior.io[field])) { counterRegressions += 1; continue; }
      for (const field of IO_FIELDS) io[field] += task.io[field] - prior.io[field];
      ioMatched += 1;
    }
    const rss = selected.filter((entry) => entry.rss !== null);
    return [category, {
      processes: selected.length,
      newOrReclassifiedProcesses: selected.filter((entry) => previous?.processes.get(key(entry))?.category !== category).length,
      priorProcessesUnobserved: old.filter((entry) => current.processes.get(key(entry))?.category !== category).length,
      cpuMatchedProcesses: cpuMatched,
      observedCpuTicks: cpuMatched ? String(cpuTicks) : null,
      observedCpuMs: cpuMatched && cpuTicks <= BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)) ? Number(cpuTicks) * 1000 / hz : null,
      rssObservedProcesses: rss.length,
      processSummedRssKiB: rss.length ? String(rss.reduce((sum, entry) => sum + entry.rss, 0n)) : null,
      ioMatchedTasks: ioMatched,
      newOrReclassifiedTasks: newTasks.filter((entry) => previous?.tasks.get(entry.identity)?.category !== category).length,
      priorTasksUnobserved: oldTasks.filter((entry) => current.tasks.get(entry.identity)?.category !== category).length,
      observedTaskIoDelta: Object.fromEntries(IO_FIELDS.map((field) => [field, ioMatched ? String(io[field]) : null])),
      counterRegressions,
    }];
  }));
}

export function writeRecord(output, record) {
  const line = `${JSON.stringify(record)}\n`;
  // No unbounded drain queue: stop diagnostics if the consumer falls behind.
  // main exits explicitly on this failure, so a blocked pipe cannot retain it.
  if (Buffer.byteLength(line) > 8192 || !output.write(line)) throw fault("limitReached");
}

export function installOutputFailureHandlers({ stdout, stderr, exit }) {
  const unavailable = () => {
    try { stderr.write('{"kind":"worker-process-sampler-v1","unavailable":true}\n'); }
    catch { /* A closed diagnostic pipe must not produce a raw stack either. */ }
    exit(1);
  };
  stdout.once("error", unavailable);
  stderr.once("error", () => exit(1));
  return unavailable;
}

async function main() {
  if (process.platform !== "linux") throw fault("unreadable");
  const rootPid = parseArguments(process.argv.slice(2), process.ppid);
  // Ubuntu's libc-bin supplies getconf; a missing/invalid result fails rather
  // than guessing 100 Hz. This child exits before sampling begins.
  const hzText = execFileSync("/usr/bin/getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 1000, maxBuffer: 64, stdio: ["ignore", "pipe", "ignore"] }).trim();
  const hz = Number(uint(hzText));
  const sample = createSampler({ reader: linuxReader(), rootPid, selfPid: process.pid, clockTicksPerSecond: hz });
  // There is no persisted state to flush. Discard pending diagnostic output on
  // cancellation so a stalled log consumer cannot block the shell's wait/reap.
  const stop = () => process.exit(0);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  writeRecord(process.stdout, { kind: "worker-process-sampler-v1", cadenceMs: CADENCE_MS, clockTicksPerSecond: hz, limits: LIMITS,
    semantics: "matched-identities-only; racy child lists may omit exits; roundMs is a cooperative between-read budget; sampler branch and root excluded; vmstat included as other; RSS approximate process sum, not unique memory; task I/O bytes except syscr/syscw calls; not fsync/device throughput; null means no matched observation" });
  try {
    while (true) {
      const start = performance.now();
      const result = sample();
      writeRecord(process.stdout, result);
      if (result.scope.rootLost) throw fault("identityChanged");
      await delay(Math.max(0, CADENCE_MS - (performance.now() - start)));
    }
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const unavailable = installOutputFailureHandlers({ stdout: process.stdout, stderr: process.stderr, exit: (code) => process.exit(code) });
  main().catch(unavailable);
}
