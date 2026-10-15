import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { COMMAND, LIMITS, aggregateThreads, chooseExit, classifySyscall, cleanupOwnedGroup,
  createOutput, createThreadSampler, installSupervisorGuard, linuxReader, parseSchedstat, parseStat, runDiagnostic,
  sameIdentity, sameOwnedLeader, validatePlatform } from "../scripts/worker-graph-thread-diagnostic.mjs";

function stat(id, { ppid = 1, pgrp = 10, session = 10, start = id, user = 0, system = 0, state = "S", name = "private )\nthread" } = {}) {
  const fields = Array(22).fill("0");
  Object.assign(fields, { 0: state, 1: String(ppid), 2: String(pgrp), 3: String(session), 11: String(user), 12: String(system), 19: String(start) });
  return `${id} (${name}) ${fields.join(" ")}\n`;
}
function fixture() {
  const files = new Map([
    ["sys/kernel/sched_schedstats", "1\n"], ["10/stat", stat(10, { ppid: 1 })], ["10/task/10/stat", stat(10, { ppid: 1 })], ["10/task/10/children", "20"],
    ["20/stat", stat(20, { ppid: 10 })], ["20/task/20/stat", stat(20, { ppid: 10, user: 10 })], ["20/task/20/children", ""], ["20/task/20/schedstat", "1000000 2000000 3\n"],
  ]), taskIds = new Map([[10, [10]], [20, [20]]]), executables = new Map([[10, "/fixed/node"], [20, "/fixed/workerd"]]), tokens = new Map([["20/20", "74"]]);
  const accesses = [];
  const reader = {
    read(path) { accesses.push(path); const value = files.get(path); if (value === undefined) throw Object.assign(new Error("private/path"), { code: "ENOENT" }); if (value instanceof Error) throw value; return typeof value === "function" ? value() : value; },
    tasks(id, remaining) { const values = taskIds.get(id); if (values.length > remaining) throw Object.assign(new Error(), { code: "budget" }); return values; },
    executable(id) { return executables.get(id); },
    syscall(id, tid) { const value = tokens.get(`${id}/${tid}`); if (value instanceof Error) throw value; return value; },
  };
  let clock = 0;
  const options = { reader, root: parseStat(files.get("10/stat")), knownExecutables: { node: "/fixed/node", workerd: "/fixed/workerd" }, hz: 100, now: () => clock, utc: () => 123456 };
  return { files, taskIds, executables, tokens, accesses, reader, options, advance: () => { clock += 250; } };
}

test("fixed entrypoint retains the complete graph file and refuses platform, ABI, and CLI overrides", () => {
  assert.deepEqual(COMMAND, ["npm", "--prefix", "apps/worker", "test", "--", "test/storage-community-graph-publication.spec.ts"]);
  assert.equal(LIMITS.cadenceMs, 250); assert.equal(LIMITS.commandMs, 240000);
  validatePlatform("linux", "x64", []);
  for (const args of [["darwin", "x64", []], ["linux", "arm64", []], ["linux", "x64", ["--timeout=0"]]]) assert.throws(() => validatePlatform(...args));
});
test("stat parser discards hostile comm and retains ownership and per-thread counters", () => {
  const parsed = parseStat(stat(20, { ppid: 10, user: 7, system: 8, start: 99 }));
  assert.deepEqual(parsed, { pid: 20, ppid: 10, pgrp: 10, session: 10, userTicks: 7n, systemTicks: 8n, startTicks: 99n, state: "S" });
  assert.equal(sameIdentity(parsed, { ...parsed, startTicks: 100n }), false);
  assert.equal(sameIdentity(parsed, { ...parsed, pgrp: 20 }), false);
  assert.throws(() => parseStat("private malformed text"));
});
test("scheduler capability and all-zero counters remain unavailable rather than zero delay", () => {
  assert.equal(parseSchedstat("0 0 0", true), null);
  assert.equal(parseSchedstat("100 0 1", false), null);
  assert.equal(parseSchedstat("100 0 1", null), null);
  assert.deepEqual(parseSchedstat("100 0 1", true), { cpuNs: 100n, runqueueNs: 0n, slices: 1n });
  assert.throws(() => parseSchedstat("1 2 3 private", true));
});
test("native syscall map keeps futex operations honest and rejects x32 and unknown ABI attribution", () => {
  const expected = { fsync: [74], fdatasync: [75], futex_family: [202, 449, 454, 455, 456], poll_family: [7, 23, 232, 270, 271, 281, 441], read_write: [0, 1, 17, 18, 19, 20, 295, 296, 327, 328], sleep: [35, 230] };
  for (const [category, numbers] of Object.entries(expected)) for (const number of numbers) assert.equal(classifySyscall(String(number), true), category);
  assert.equal(classifySyscall("233", true), "other_syscall"); assert.equal(classifySyscall("24", true), "other_syscall");
  assert.equal(classifySyscall("1073741898", true), "unknown_abi"); assert.equal(classifySyscall("74", false), "unknown_abi");
  assert.equal(classifySyscall("running", false), "running"); assert.equal(classifySyscall("-1", true), "blocked_unknown");
  assert.throws(() => classifySyscall("74 0xPRIVATE", true));
});
test("Linux syscall reader stops before arguments and refuses forbidden metadata surfaces", () => {
  const content = "74 0xSECRET 0xADDRESS\n", seen = [], opened = []; let offset = 0, closed = 0;
  const reader = linuxReader({ openSync(path) { opened.push(path); return 3; }, readSync(fd, buffer, start, count) { assert.equal(count, 1); if (offset >= content.length) return 0; buffer[start] = content.charCodeAt(offset); seen.push(content[offset++]); return 1; }, closeSync() { closed++; } });
  assert.equal(reader.syscall(20, 21), "74"); assert.equal(seen.join(""), "74 "); assert.equal(closed, 1);
  assert.deepEqual(opened, ["/proc/20/task/21/syscall"]);
  for (const path of ["20/cmdline", "20/environ", "20/fd/1", "20/stack", "../20/stat"]) assert.throws(() => reader.read(path));
});
test("oversize proc metadata is refused and its descriptor is closed", () => {
  let closed = 0;
  const reader = linuxReader({ openSync() { return 3; }, readSync(fd, buffer) { return buffer.length; }, closeSync(fd) { assert.equal(fd, 3); closed++; } });
  assert.throws(() => reader.read("20/task/20/stat"), { code: "budget" }); assert.equal(closed, 1);
});
test("thread samples exclude supervisor, show first-observation gaps, and compute matched deltas", () => {
  const f = fixture(), sample = createThreadSampler(f.options), first = sample();
  assert.equal(first.categories.workerd.matchedThreads, 0); assert.equal(first.categories.workerd.observedCpuMs, null);
  assert.equal(first.categories.node.threadsObserved, 0); assert.equal(first.categories.workerd.syscallSamples.fsync, 1);
  f.advance(); f.files.set("20/task/20/stat", stat(20, { ppid: 10, user: 14, system: 2 })); f.files.set("20/task/20/schedstat", "4000000 7000000 6");
  const second = sample();
  assert.equal(second.categories.workerd.observedCpuTicks, "6"); assert.equal(second.categories.workerd.observedCpuMs, 60);
  assert.equal(second.categories.workerd.maxMatchedThreadCpuMs, 60); assert.equal(second.categories.workerd.schedstatCpuNs, "3000000");
  assert.equal(second.categories.workerd.runqueueDelayNs, "5000000"); assert.equal(second.scope.complete, false);
  assert.doesNotMatch(JSON.stringify(second), /private|fixed|SECRET|ADDRESS/u);
});
test("disabled or unreadable scheduler state and syscall permission failures remain explicit gaps", () => {
  const f = fixture(); f.files.set("sys/kernel/sched_schedstats", "0\n"); f.tokens.set("20/20", Object.assign(new Error("private"), { code: "EPERM" }));
  const sample = createThreadSampler(f.options); sample(); f.advance(); const result = sample();
  assert.equal(result.scope.schedstats, "disabled"); assert.equal(result.scope.gaps.permission, 1);
  assert.equal(result.categories.workerd.runqueueDelayNs, null); assert.equal(result.categories.workerd.syscallSamples.unavailable, 1);
  f.files.delete("sys/kernel/sched_schedstats"); assert.equal(sample().scope.schedstats, "unknown");
});
test("children created by non-leader threads are scoped and admitted", () => {
  const f = fixture(); f.taskIds.set(10, [10, 11]); f.files.set("10/task/10/children", "");
  f.files.set("10/task/11/stat", stat(11, { ppid: 1 })); f.files.set("10/task/11/children", "20");
  assert.equal(createThreadSampler(f.options)().categories.workerd.threadsObserved, 1);
});
test("task identity reuse and mid-read exits discard metrics", () => {
  const f = fixture(); let reads = 0;
  f.files.set("20/task/20/stat", () => stat(20, { ppid: 10, start: ++reads === 1 ? 20 : 21 }));
  const result = createThreadSampler(f.options)();
  assert.equal(result.categories.workerd.threadsObserved, 0); assert.equal(result.scope.gaps.identity, 1);
});
test("intermediate parent reuse cannot admit a child with the reused numeric parent", () => {
  const f = fixture(); f.files.set("20/task/20/children", "30");
  f.files.set("30/stat", stat(30, { ppid: 20 })); f.taskIds.set(30, [30]); f.executables.set(30, "/fixed/node");
  f.files.set("30/task/30/stat", stat(30, { ppid: 20 })); f.files.set("30/task/30/children", ""); f.files.set("30/task/30/schedstat", "1 2 3"); f.tokens.set("30/30", "running");
  let reads = 0; f.files.set("20/stat", () => stat(20, { ppid: 10, start: ++reads < 5 ? 20 : 99 }));
  const result = createThreadSampler(f.options)();
  assert.equal(result.categories.node.threadsObserved, 0); assert.ok(result.scope.gaps.identity > 0);
});
test("lost anchor clears the complete current observation and escaped groups are gaps", () => {
  const f = fixture(); f.files.set("20/stat", stat(20, { ppid: 10, pgrp: 20, session: 20 }));
  let result = createThreadSampler(f.options)(); assert.equal(result.scope.gaps.escapedGroup, 1); assert.equal(result.categories.workerd.threadsObserved, 0);
  const g = fixture(); let reads = 0; g.files.set("10/stat", () => stat(10, { ppid: 1, start: ++reads < 5 ? 10 : 11 }));
  result = createThreadSampler(g.options)(); assert.equal(result.scope.rootLost, true); assert.equal(result.scope.tasksObserved, 0);
});
test("unknown executable is not silently attributed as native x64 workerd", () => {
  const f = fixture(); f.executables.set(20, "/unapproved/workerd"); const result = createThreadSampler(f.options)();
  assert.equal(result.categories.workerd.threadsObserved, 0); assert.equal(result.categories.other.syscallSamples.unknown_abi, 1);
});
test("cooperative operation and task bounds truncate honestly without inventing zero metrics", () => {
  const f = fixture(), result = createThreadSampler({ ...f.options, limits: { ...LIMITS, operations: 3 } })();
  assert.ok(result.scope.gaps.budget > 0); assert.equal(result.categories.workerd.observedCpuMs, null);
  const g = fixture(); assert.ok(createThreadSampler({ ...g.options, limits: { ...LIMITS, tasks: 1 } })().scope.gaps.budget > 0);
});
test("cooperative elapsed scan budget is explicit and does not fabricate matched CPU", () => {
  const f = fixture(); let time = 0;
  const result = createThreadSampler({ ...f.options, now: () => time++, limits: { ...LIMITS, scanMs: 0 } })();
  assert.ok(result.scope.gaps.budget > 0); assert.equal(result.scope.rootLost, false);
  assert.equal(result.categories.workerd.observedCpuTicks, null);
});
test("exited/reclassified identities and counter regressions cannot create fabricated deltas", () => {
  const task = { id: "p/t", category: "workerd", cpuTicks: 10n, sched: { cpuNs: 4n, runqueueNs: 5n, slices: 1n }, syscall: "running", state: "running" };
  const previous = { tasks: new Map([[task.id, task]]) }, current = { tasks: new Map([[task.id, { ...task, cpuTicks: 9n }]]) };
  assert.equal(aggregateThreads(current, previous, 100).workerd.counterRegressions, 1);
  assert.equal(aggregateThreads(current, previous, 100).workerd.observedCpuTicks, null);
  assert.equal(aggregateThreads({ tasks: new Map() }, previous, 100).workerd.priorThreadsUnobserved, 1);
});
test("output caps stop records and backpressure rather than queueing data indefinitely", () => {
  const written = [], output = createOutput({ write(line) { written.push(line); return true; } }, { ...LIMITS, records: 1 });
  output({ kind: "sample" }); assert.throws(() => output({ kind: "sample" })); assert.equal(written.length, 1);
  assert.throws(() => createOutput({ write() { return false; } })({ kind: "sample" }));
  assert.throws(() => createOutput({ write() { assert.fail("oversize was written"); } })({ text: "x".repeat(9000) }));
});
test("cumulative diagnostic byte cap refuses before the next write", () => {
  let writes = 0;
  const record = { kind: "sample" }, bytes = Buffer.byteLength(JSON.stringify(record)) + 1;
  const output = createOutput({ write() { writes++; return true; } }, { ...LIMITS, outputBytes: bytes });
  output(record); assert.throws(() => output(record), { code: "budget" }); assert.equal(writes, 1);
});
test("established npm failure outranks collector and cleanup failure, while cancellation outranks induced cleanup status", () => {
  const base = { result: { code: 0, signal: null }, interruption: null, capped: false, collectorFailed: false, cleanupComplete: true };
  assert.equal(chooseExit(base), 0); assert.equal(chooseExit({ ...base, collectorFailed: true }), 1);
  assert.equal(chooseExit({ ...base, cleanupComplete: false }), 1);
  assert.equal(chooseExit({ ...base, result: { code: 23, signal: null }, collectorFailed: true, cleanupComplete: false, interruption: "SIGINT" }), 23);
  // The caller snapshots result before cleanup; a later npm143 is not admitted.
  const initiated = { ...base, result: null, capped: true }, afterCleanup = { code: 143, signal: null };
  assert.equal(afterCleanup.code, 143); assert.equal(chooseExit(initiated), 124);
  assert.equal(chooseExit({ ...initiated, capped: false, interruption: "SIGINT" }), 130);
  assert.equal(chooseExit({ ...base, result: { code: null, signal: "SIGSEGV" }, collectorFailed: true }), 139);
});
test("cleanup retains leader identity through TERM then KILL and waits for reaping", async () => {
  const root = parseStat(stat(10)), signals = []; let reap;
  const reaped = new Promise((accept) => { reap = accept; });
  const receipt = await cleanupOwnedGroup({ root, readIdentity: () => root, signalGroup(signal) { signals.push(signal); if (signal === "SIGKILL") reap(); }, reaped, wait: async () => {} });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]); assert.equal(receipt.complete, true); assert.equal(receipt.supervisorReaped, true);
});
test("cleanup refuses reused identity before either signal and uses only owned IPC fallback", async () => {
  const root = parseStat(stat(10)), signals = []; let calls = 0, disconnected = false;
  const receipt = await cleanupOwnedGroup({ root, readIdentity: () => ({ ...root, startTicks: ++calls === 1 ? root.startTicks : 99n }), signalGroup: (signal) => signals.push(signal),
    disconnect() { disconnected = true; }, reaped: Promise.resolve(), wait: async () => {} });
  assert.deepEqual(signals, ["SIGTERM"]); assert.equal(disconnected, true); assert.equal(receipt.complete, false);
  const first = await cleanupOwnedGroup({ root, readIdentity: () => ({ ...root, startTicks: 99n }), signalGroup() { assert.fail("reused PID signalled"); }, reaped: Promise.resolve(), wait: async () => {} });
  assert.equal(first.identityVerified, false);
});
test("missing reap proof is bounded and never reported as complete", async () => {
  const root = parseStat(stat(10));
  const receipt = await cleanupOwnedGroup({ root, readIdentity: () => root, signalGroup() {}, reaped: new Promise(() => {}), wait: async () => {} });
  assert.equal(receipt.supervisorReaped, false); assert.equal(receipt.complete, false);
});
test("portable real child exit remains authoritative when diagnostic cleanup reports failure", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(23)"], { stdio: "ignore" });
  const result = await new Promise((accept, reject) => { child.once("error", reject); child.once("exit", (code, signal) => accept({ code, signal })); });
  assert.equal(chooseExit({ result, interruption: null, capped: false, collectorFailed: true, cleanupComplete: false }), 23);
});

function lifecycle({ result = { code: 0, signal: null }, interrupt = null, foreignParent = false, outputFailure = false, ready = true, cleanupFailure = false, supervisorError = false, noReap = false } = {}) {
  const f = fixture(), child = new EventEmitter(), signals = new EventEmitter(), records = [], groupSignals = [];
  let time = 0, starts = 0, disconnected = false;
  child.pid = 10; child.connected = true;
  child.send = (message) => { assert.deepEqual(message, { type: "start" }); starts++;
    queueMicrotask(() => { if (result) child.emit("message", { type: "result", ...result }); if (interrupt) signals.emit(interrupt); });
  };
  child.disconnect = () => { disconnected = true; child.connected = false; if (!noReap) child.emit("exit", null, "SIGKILL"); };
  if (foreignParent) f.files.set("10/stat", stat(10, { ppid: 99 }));
  const invoke = () => runDiagnostic({ ...f.options, parentPid: 1, now: () => time, signals,
    wait: async (ms) => { time += ms; await Promise.resolve(); }, limits: { ...LIMITS, readyMs: 50, cadenceMs: 5, commandMs: 10, graceMs: 1, reapMs: 1 },
    output(record) { if (outputFailure && record.kind === "worker-graph-thread-terminal-v1") throw new Error("private"); records.push(record); },
    createSupervisor() { if (ready) queueMicrotask(() => child.emit("message", { type: "ready" }));
      if (supervisorError) queueMicrotask(() => child.emit("error", new Error("private"))); return child; },
    signalGroup(id, signal) { assert.equal(id, 10); groupSignals.push(signal); if (cleanupFailure) throw new Error("private");
      if (signal === "SIGTERM") child.emit("message", { type: "result", code: 143, signal: null });
      if (signal === "SIGKILL" && !noReap) child.emit("exit", null, "SIGKILL");
    },
  });
  return { invoke, records, groupSignals, child, signals, starts: () => starts, disconnected: () => disconnected };
}
test("orchestrator success stays green after supervisor reaping and losing readiness/sampling races settle", async () => {
  const f = lifecycle(), outcome = await f.invoke(); await Promise.resolve();
  assert.equal(outcome.code, 0); assert.equal(outcome.collectorFailed, false); assert.deepEqual(outcome.result, { code: 0, signal: null });
  assert.equal(outcome.cleanup.complete, true); assert.deepEqual(f.groupSignals, ["SIGTERM", "SIGKILL"]); assert.equal(f.starts(), 1);
  assert.equal(f.records.at(-1).diagnosticExitCode, 0); assert.equal(f.signals.listenerCount("SIGINT"), 0);
});
test("orchestrator preserves command cap against cleanup-induced numeric npm143", async () => {
  const f = lifecycle({ result: null }), outcome = await f.invoke();
  assert.equal(outcome.code, 124); assert.equal(outcome.capped, true); assert.equal(outcome.result, null); assert.equal(outcome.cleanup.complete, true);
});
test("orchestrator preserves SIGINT and SIGTERM against cleanup-induced npm143", async () => {
  for (const [interrupt, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    const f = lifecycle({ result: null, interrupt }), outcome = await f.invoke();
    assert.equal(outcome.code, code); assert.equal(outcome.result, null); assert.equal(outcome.cleanup.complete, true);
  }
});
test("orchestrator preserves established graph failure across collector and cleanup errors", async () => {
  const f = lifecycle({ result: { code: 23, signal: null }, outputFailure: true, cleanupFailure: true }), outcome = await f.invoke();
  assert.equal(outcome.code, 23); assert.equal(outcome.collectorFailed, true); assert.equal(outcome.cleanup.complete, false); assert.equal(f.disconnected(), true);
});
test("orchestrator rejects unadmitted foreign parent without launching npm or signalling that group", async () => {
  const f = lifecycle({ foreignParent: true }), outcome = await f.invoke();
  assert.equal(outcome.code, 1); assert.equal(f.starts(), 0); assert.deepEqual(f.groupSignals, []);
  assert.equal(f.disconnected(), true); assert.equal(outcome.cleanup.supervisorReaped, true); assert.equal(outcome.cleanup.identityVerified, false);
});
test("orchestrator readiness failure cleans its admitted child and never starts npm", async () => {
  const f = lifecycle({ ready: false }), outcome = await f.invoke();
  assert.equal(outcome.code, 1); assert.equal(f.starts(), 0); assert.equal(outcome.cleanup.supervisorReaped, true);
});
test("orchestrator never treats an IPC error as evidence that its supervisor was reaped", async () => {
  const f = lifecycle({ supervisorError: true, noReap: true }), outcome = await f.invoke();
  assert.equal(outcome.code, 1); assert.equal(f.starts(), 0); assert.equal(outcome.cleanup.supervisorReaped, false); assert.equal(outcome.cleanup.complete, false);
});
test("supervisor disconnect and watchdog kill its same group after parent death/reparenting", () => {
  for (const event of ["disconnect", "watchdog"]) {
    const channel = new EventEmitter(), root = parseStat(stat(10, { ppid: 44 })), reparented = { ...root, ppid: 1 }; let watchdog, kills = 0, exit;
    assert.equal(sameIdentity(root, reparented), false); assert.equal(sameOwnedLeader(root, reparented), true);
    installSupervisorGuard({ channel, root, readIdentity: () => reparented, killGroup() { kills++; }, exit(code) { exit = code; }, schedule(fn, ms) { watchdog = fn; assert.ok(ms > LIMITS.commandMs); } });
    if (event === "disconnect") channel.emit("disconnect"); else watchdog();
    assert.equal(kills, 1); assert.equal(exit, 1);
  }
});
test("supervisor never kills a changed start identity, session or group", () => {
  const root = parseStat(stat(10));
  for (const changed of [{ ...root, startTicks: 99n }, { ...root, session: 99 }, { ...root, pgrp: 99 }]) {
    const channel = new EventEmitter(); let exit;
    installSupervisorGuard({ channel, root, readIdentity: () => changed, killGroup() { assert.fail("unowned group signalled"); }, exit(code) { exit = code; }, schedule() {} });
    channel.emit("disconnect"); assert.equal(exit, 1);
  }
});
