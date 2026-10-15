import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CATEGORIES, IO_FIELDS, LIMITS, aggregate, classifyExecutable, createSampler, installOutputFailureHandlers, linuxReader, parseArguments, parseIo, parseRss, parseStat, writeRecord } from "../scripts/hosted-backend-process-sampler.mjs";

function statText(pid, ppid, { start = 10, user = 0, system = 0, comm = "synthetic (private) name" } = {}) {
  const fields = Array(50).fill("0");
  fields[0] = "S";
  fields[1] = String(ppid);
  fields[11] = String(user);
  fields[12] = String(system);
  fields[13] = "999999"; // Waited-child CPU must never enter the result.
  fields[14] = "999999";
  fields[19] = String(start);
  return `${pid} (${comm}) ${fields.join(" ")}\n`;
}
const ioText = (value = 0) => IO_FIELDS.map((field) => `${field}: ${value}`).join("\n");

function fixture() {
  const files = new Map();
  const taskLists = new Map();
  const exes = new Map();
  const accesses = [];
  const state = { time: 0, onRead: () => {} };
  const add = (pid, ppid, category, { tids = [pid], children = [], ...options } = {}) => {
    files.set(`${pid}/stat`, statText(pid, ppid, options));
    files.set(`${pid}/status`, "Name:\tprivate-do-not-emit\nVmRSS:\t123 kB\n");
    taskLists.set(pid, tids);
    exes.set(pid, `/synthetic/private/path/${category}`);
    for (const tid of tids) {
      files.set(`${pid}/task/${tid}/stat`, statText(tid, ppid, options));
      files.set(`${pid}/task/${tid}/children`, tid === pid ? children.join(" ") : "");
      files.set(`${pid}/task/${tid}/io`, ioText());
    }
  };
  add(100, 1, "bash", { children: [101, 200] });
  add(101, 100, "node", { children: [999] }); // Sampler branch must never be traversed.
  add(200, 100, "node", { children: [300] });
  add(300, 200, "workerd", { tids: [300, 301] });
  add(999, 101, "must-not-read");
  const reader = {
    read(path) {
      accesses.push(path);
      state.onRead(path);
      if (!files.has(path)) throw Object.assign(new Error("private path must not escape"), { code: "ENOENT" });
      const value = files.get(path);
      if (value instanceof Error) throw value;
      return value;
    },
    tasks(pid, limit) {
      accesses.push(`${pid}/task`);
      const tids = taskLists.get(pid);
      if (tids.length > limit) throw Object.assign(new Error("bounded"), { code: "limitReached" });
      return tids;
    },
    executable(pid) {
      accesses.push(`${pid}/exe`);
      const value = exes.get(pid);
      if (value instanceof Error) throw value;
      return value;
    },
  };
  const sampler = (limits = LIMITS) => createSampler({ reader, rootPid: 100, selfPid: 101, clockTicksPerSecond: 250, now: () => state.time, utc: () => "2026-10-15T00:00:00.000Z", limits });
  return { files, exes, taskLists, accesses, state, add, sampler };
}

test("stat parses parentheses without exposing names and keeps exact CPU/start ticks", () => {
  const actual = parseStat(statText(7, 3, { user: 9007199254740993n, system: 4, start: 8 }));
  assert.deepEqual(actual, { pid: 7, ppid: 3, userTicks: 9007199254740993n, systemTicks: 4n, startTicks: 8n });
  for (const text of ["", "7 () S", statText(7, 3).replace(" S ", " ? "), statText(7, 3, { user: -1 })]) assert.throws(() => parseStat(text));
});

test("I/O and RSS require exact counter fields and units, including legitimate zero", () => {
  assert.deepEqual(parseIo(ioText(12)), Object.fromEntries(IO_FIELDS.map((field) => [field, 12n])));
  assert.equal(parseRss("VmRSS: 0 kB\n"), 0n);
  for (const text of ["", "VmRSS: 5 bytes", "VmRSS: -1 kB", "VmRSS: 1 kB\nVmRSS: 2 kB"]) assert.throws(() => parseRss(text));
  assert.throws(() => parseIo(ioText().replace("syscr: 0", "")));
  assert.throws(() => parseIo(`${ioText()}\nrchar: 1`));
});

test("CLI accepts only the direct parent's decimal PID and classifications are closed", () => {
  assert.equal(parseArguments(["--parent-pid", "100"], 100), 100);
  for (const args of [[], ["--parent-pid", "101"], ["--parent-pid", "0100"], ["--parent-pid", "100", "--all"], ["--parent-pid", "../100"], ["--parent-pid", "0"]]) assert.throws(() => parseArguments(args, 100));
  assert.deepEqual(["/private/node", "/private/workerd (deleted)", "/private/node-evil"].map(classifyExecutable), ["node", "workerd", "other"]);
  for (const path of ["stat", "1/cmdline", "1/environ", "1/fd/0", "1/../2/stat", "1/io"]) assert.throws(() => linuxReader().read(path), "forbidden paths rejected before any filesystem access");
});

test("only scoped descendants are visited, including non-leader thread children; own branch is excluded", () => {
  const f = fixture();
  f.add(400, 300, "other");
  f.files.set("300/task/301/children", "400");
  const result = f.sampler()();
  assert.equal(result.scope.processesObserved, 3);
  assert.deepEqual(result.categories.workerd.processSummedRssKiB, "123");
  assert.deepEqual(Object.keys(result.categories), CATEGORIES);
  assert.equal(f.accesses.some((path) => path.startsWith("999/") || path.startsWith("101/task/")), false);
  assert.equal(f.accesses.some((path) => path === "proc" || /cmdline|environ|\/fd\//u.test(path)), false);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(result.scope.complete, false, "a passive children scan is never complete accounting");
  for (const category of CATEGORIES) assert.equal(result.categories[category].observedCpuTicks, null, "first observation is a baseline");
});

test("matched identities yield CPU deltas without child CPU and per-task I/O without process I/O", () => {
  const f = fixture();
  const sample = f.sampler();
  sample();
  f.state.time = 1000;
  f.files.set("300/stat", statText(300, 200, { user: 200, system: 50 }));
  f.files.set("300/task/300/io", ioText(7));
  f.files.set("300/task/301/io", ioText(11));
  const result = sample();
  assert.deepEqual(result.intervalMs, { previousStart: 0, previousEnd: 0, start: 1000, end: 1000 });
  assert.equal(result.categories.workerd.observedCpuTicks, "250");
  assert.equal(result.categories.workerd.observedCpuMs, 1000, "uses supplied 250 Hz, never assumed 100");
  assert.equal(result.categories.workerd.ioMatchedTasks, 2);
  assert.equal(result.categories.workerd.observedTaskIoDelta.write_bytes, "18");
  assert.equal(result.categories.workerd.observedTaskIoDelta.cancelled_write_bytes, "18");
  assert.equal(f.accesses.some((path) => /^(200|300)\/io$/u.test(path)), false);
  assert.equal(result.categories.node.observedCpuTicks, "0", "a matched unchanged counter is a genuine observed zero");
});

test("missing and unreadable metadata remain null, with gaps and no raw errors", () => {
  const f = fixture();
  f.files.delete("300/status");
  f.files.set("300/task/300/io", Object.assign(new Error("secret synthetic error"), { code: "EACCES" }));
  f.files.delete("300/task/301/io");
  const sample = f.sampler();
  sample();
  const result = sample();
  assert.equal(result.categories.workerd.processSummedRssKiB, null);
  assert.equal(result.categories.workerd.observedTaskIoDelta.read_bytes, null);
  assert.ok(result.scope.gaps.missing >= 2);
  assert.ok(result.scope.gaps.unreadable >= 1);
  assert.doesNotMatch(JSON.stringify(result), /secret|private|EACCES/u);
});

test("PID reuse, class changes and unobserved prior processes never create lifetime deltas", () => {
  const f = fixture();
  const sample = f.sampler();
  sample();
  f.add(300, 200, "node", { start: 99, user: 900 });
  const result = sample();
  assert.equal(result.categories.workerd.observedCpuTicks, null);
  assert.equal(result.categories.workerd.priorProcessesUnobserved, 1);
  assert.equal(result.categories.node.newOrReclassifiedProcesses, 1);
  assert.equal(result.categories.node.observedCpuTicks, "0", "only the original matched node contributes");
  f.exes.set(200, "/synthetic/other");
  const changed = sample();
  assert.equal(changed.categories.other.observedCpuTicks, null);
  assert.equal(changed.categories.other.newOrReclassifiedProcesses, 1);
});

test("reused intermediate parent invalidates the queued child's observations", () => {
  const f = fixture();
  let childReads = 0;
  f.state.onRead = (path) => {
    if (path === "300/stat" && ++childReads === 1) f.files.set("200/stat", statText(200, 100, { start: 999 }));
  };
  const result = f.sampler()();
  assert.equal(result.categories.workerd.processes, 0);
  assert.ok(result.scope.gaps.identityChanged >= 1);
  assert.equal(f.accesses.includes("300/status"), false, "reused parent is caught before child metrics");
});

test("mid-read thread reuse and process exits discard the affected observations", () => {
  const f = fixture();
  const sample = f.sampler();
  sample();
  f.state.onRead = (path) => {
    if (path === "300/task/300/io") f.files.set("300/task/300/stat", statText(300, 200, { start: 55 }));
    if (path === "300/task/301/io") f.files.delete("300/task/301/stat");
  };
  const result = sample();
  assert.equal(result.categories.workerd.ioMatchedTasks, 0);
  assert.equal(result.categories.workerd.priorTasksUnobserved, 2);
  assert.equal(result.categories.workerd.observedTaskIoDelta.read_bytes, null);
  assert.ok(result.scope.gaps.identityChanged > 0 && result.scope.gaps.missing > 0);
});

test("root identity change discards the complete round and never admits replacement descendants", () => {
  const f = fixture();
  const sample = f.sampler();
  sample();
  f.files.set("100/stat", statText(100, 1, { start: 999 }));
  const result = sample();
  assert.equal(result.scope.rootLost, true);
  assert.equal(result.scope.processesObserved, 0);
  assert.equal(result.categories.workerd.observedCpuTicks, null);
});

test("process/task/read/time budgets truncate explicitly without pretending the root exited", () => {
  for (const overrides of [{ processes: 1 }, { tasks: 1 }, { reads: 2 }, { roundMs: 1 }]) {
    const f = fixture();
    const sample = f.sampler({ ...LIMITS, ...overrides });
    if (overrides.roundMs) f.state.onRead = () => { f.state.time += 1; };
    const result = sample();
    assert.ok(result.scope.gaps.limitReached > 0, JSON.stringify(overrides));
    assert.equal(result.scope.complete, false);
    assert.equal(result.scope.rootLost, false);
  }
});

test("counter regressions are explicit gaps instead of negative CPU or I/O", () => {
  const f = fixture();
  f.files.set("300/stat", statText(300, 200, { user: 10 }));
  f.files.set("300/task/300/io", ioText(10));
  const sample = f.sampler();
  sample();
  f.files.set("300/stat", statText(300, 200, { user: 1 }));
  f.files.set("300/task/300/io", ioText(1));
  const result = sample();
  assert.equal(result.categories.workerd.observedCpuTicks, null);
  assert.equal(result.categories.workerd.counterRegressions, 2);
  assert.equal(result.categories.workerd.ioMatchedTasks, 1, "only the unaffected thread is a valid observed delta");
});

test("unsafe tick conversion remains null while exact integer counters survive", () => {
  const previous = { processes: new Map([["7:1", { pid: 7, startTicks: 1n, userTicks: 0n, systemTicks: 0n, category: "workerd", rss: null }]]), tasks: new Map() };
  const current = { processes: new Map([["7:1", { ...previous.processes.get("7:1"), userTicks: 9007199254740993n }]]), tasks: new Map() };
  const result = aggregate(current, previous, 250).workerd;
  assert.equal(result.observedCpuTicks, "9007199254740993");
  assert.equal(result.observedCpuMs, null);
});

test("metadata bytes and task directory entries are bounded and handles close on refusal", () => {
  let closed = 0;
  const reader = linuxReader({
    openSync(path, mode) { assert.equal(path, "/proc/7/stat"); assert.equal(mode, "r"); return 5; },
    readSync(fd, buffer) { assert.equal(fd, 5); return buffer.length; },
    closeSync(fd) { assert.equal(fd, 5); closed += 1; },
    opendirSync(path) {
      assert.equal(path, "/proc/7/task");
      return { readSync: () => ({ name: "7" }), closeSync: () => { closed += 1; } };
    },
  });
  assert.throws(() => reader.read("7/stat"), { code: "limitReached" });
  assert.throws(() => reader.tasks(7, 2), { code: "limitReached" });
  assert.equal(closed, 2);
  assert.throws(() => parseIo(ioText("18446744073709551616")), { code: "malformed" });
});

test("bounded output refuses oversize records before writing and stops at backpressure", () => {
  const lines = [];
  writeRecord({ write: (line) => { lines.push(line); return true; } }, { kind: "synthetic", count: 1 });
  assert.deepEqual(lines, ['{"kind":"synthetic","count":1}\n']);
  assert.throws(() => writeRecord({ write: () => assert.fail("oversize record must not be written") }, { data: "x".repeat(8192) }), { code: "limitReached" });
  let writes = 0;
  assert.throws(() => writeRecord({ write: () => { writes += 1; return false; } }, { kind: "synthetic" }), { code: "limitReached" });
  assert.equal(writes, 1);
});

test("missing clock frequency and wrong root/self identities fail before sampling", () => {
  for (const hz of [0, -1, NaN, Infinity, 0.5]) {
    assert.throws(() => createSampler({ clockTicksPerSecond: hz }), { code: "malformed" });
  }
  const f = fixture();
  f.files.set("101/stat", statText(101, 99));
  assert.throws(() => f.sampler(), { code: "identityChanged" });
});

test("asynchronous pipe errors exit nonzero without exposing error messages or stacks", () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const lines = [];
  const exits = [];
  stderr.write = (line) => { lines.push(line); return true; };
  const fail = installOutputFailureHandlers({ stdout, stderr, exit: (code) => exits.push(code) });
  stdout.emit("error", new Error("private output error"));
  stderr.emit("error", new Error("private diagnostic error"));
  assert.deepEqual(lines, ['{"kind":"worker-process-sampler-v1","unavailable":true}\n']);
  stderr.write = () => { throw new Error("private synchronous pipe error"); };
  assert.doesNotThrow(fail);
  assert.deepEqual(exits, [1, 1, 1]);
});
