/** Parent-owned supervisor for one persistent, current-source D7 case reader. */
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import * as D1 from "./current-q1-d1-reference.mjs";
import * as Contract from "./current-q1-d7-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(HERE, "../..");
const CHILD_PATH = fileURLToPath(new URL("./current-q1-d7-diagnostic-child.mjs", import.meta.url));
const GUARDIAN_PATH = fileURLToPath(new URL("./current-q1-d7-diagnostic-guardian.mjs", import.meta.url));
const PROTOCOL = "current-q1-d7-diagnostic-v1";
const GUARDIAN_PROTOCOL = "current-q1-d7-diagnostic-guardian-v1";
const CASE_KEYS = Object.freeze(["conflictPreserving", "conflictFreePositive"]);
const OWNER_KEYS = Object.freeze(["a", "b", "c", "d"]);
const METRICS = new Set(["fits", "model"]);
const METHODS = new Set(["initialize", "captureScope", "readResult", "checkpointProgress",
  "proveEffectiveConflictPage", "captureIngestionInvariant", "close"]);
const TEST_SCENARIOS = new Set(["success", "blocked", "blocked-stalled-guardian", "early-exit", "malformed",
  "oversized", "exited-reader-inherited-pipe", "closed-reader-ignored-descendant"]);
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const INVOCATION_WATCHDOG_MS = Contract.CURRENT_Q1_D7_BOUNDS.diagnosticDeadlineMs;
const TERMINATION_GRACE_MS = 300;
const IMMEDIATE_REAP_MS = TERMINATION_GRACE_MS;
const PROCESS_REAP_MS = 4000;
const PROCESS_GROUP_VERIFY_MS = 1000;
const MAX_PINNED_SCRIPT_BYTES = 256 * 1024;
const GUARDIAN_STARTUP_MS = 5000;
const SHA = /^[a-f0-9]{64}$/u;
const SOURCE_HEAD = /^[a-f0-9]{40,64}$/u;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, expected) => object(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

const ERROR = Object.freeze({
  invalid: "CURRENT_Q1_D7_DIAGNOSTIC_INPUT_INVALID",
  deadline: "CURRENT_Q1_D7_DEADLINE",
  timeout: "CURRENT_Q1_D7_DIAGNOSTIC_TIMEOUT",
  exited: "CURRENT_Q1_D7_DIAGNOSTIC_CHILD_EXITED",
  protocol: "CURRENT_Q1_D7_DIAGNOSTIC_PROTOCOL_INVALID",
  failed: "CURRENT_Q1_D7_DIAGNOSTIC_FAILED",
  terminate: "CURRENT_Q1_D7_DIAGNOSTIC_TERMINATION_UNCONFIRMED",
});

function validateOwners(expectedOwners) {
  if (!Array.isArray(expectedOwners) || expectedOwners.length !== OWNER_KEYS.length) fail(ERROR.invalid);
  const seenDigests = new Set();
  for (let index = 0; index < expectedOwners.length; index++) {
    const owner = expectedOwners[index];
    if (!exactKeys(owner, ["ownerKey", "ownerDigest", "ownerRevision", "authorityEpoch"])
        || owner.ownerKey !== OWNER_KEYS[index] || !SHA.test(owner.ownerDigest)
        || !Number.isSafeInteger(owner.ownerRevision) || owner.ownerRevision < 1
        || !Number.isSafeInteger(owner.authorityEpoch) || owner.authorityEpoch < 1
        || seenDigests.has(owner.ownerDigest)) fail(ERROR.invalid);
    seenDigests.add(owner.ownerDigest);
  }
}

function validateBootstrap(input) {
  if (!exactKeys(input, ["scratchDirectory", "caseKey", "sourceId", "sourceNamespace", "nowMs",
    "expectedOwners", "deadlineMonotonicMs", "expectedChildSha256", "expectedGuardianSha256", "runtime", "sourceFence"])
      || typeof input.scratchDirectory !== "string" || !input.scratchDirectory.startsWith("/")
      || !CASE_KEYS.includes(input.caseKey) || input.sourceId !== D1.CURRENT_Q1_REFERENCE_SOURCE_ID
      || input.sourceNamespace !== input.sourceId || input.nowMs !== Contract.CURRENT_Q1_D7_NOW_MS
      || !SHA.test(input.expectedChildSha256) || !SHA.test(input.expectedGuardianSha256)
      || !exactKeys(input.runtime, ["path", "version", "binarySha256"])
      || typeof input.runtime.path !== "string" || !input.runtime.path.startsWith("/")
      || input.runtime.version !== "v26.2.0" || !SHA.test(input.runtime.binarySha256)
      || !exactKeys(input.sourceFence, ["head", "sha256"])
      || typeof input.sourceFence.head !== "string" || !SOURCE_HEAD.test(input.sourceFence.head)
      || !SHA.test(input.sourceFence.sha256)
      || !Number.isFinite(input.deadlineMonotonicMs) || input.deadlineMonotonicMs <= performance.now()) {
    fail(ERROR.invalid);
  }
  validateOwners(input.expectedOwners);
}

async function verifyPinnedRuntimeBeforeSpawn(expectedRuntime) {
  let handle;
  try {
    const executablePath = await realpath(process.execPath);
    if (expectedRuntime.path !== executablePath || expectedRuntime.version !== process.version
        || process.version !== "v26.2.0") fail(ERROR.invalid);
    const before = await lstat(executablePath);
    if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o111) === 0
        || !Number.isSafeInteger(before.size) || before.size < 1 || before.size > 512 * 1024 * 1024) fail(ERROR.invalid);
    handle = await open(executablePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || (opened.mode & 0o111) === 0) fail(ERROR.invalid);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - position), position);
      if (bytesRead === 0) fail(ERROR.invalid);
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(executablePath);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
        || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size
        || hash.digest("hex") !== expectedRuntime.binarySha256) fail(ERROR.invalid);
    return { path: executablePath, version: process.version, binarySha256: expectedRuntime.binarySha256 };
  } catch {
    fail(ERROR.invalid);
  } finally {
    try { await handle?.close(); } catch { fail(ERROR.invalid); }
  }
}

async function verifyPinnedScriptBeforeSpawn(scriptPath, expectedSha256) {
  let handle;
  try {
    if (await realpath(scriptPath) !== scriptPath) fail(ERROR.invalid);
    const before = await lstat(scriptPath);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid()
        || before.nlink !== 1 || (before.mode & 0o022) !== 0
        || !Number.isSafeInteger(before.size) || before.size < 1 || before.size > MAX_PINNED_SCRIPT_BYTES) {
      fail(ERROR.invalid);
    }
    handle = await open(scriptPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.uid !== before.uid || opened.nlink !== 1 || (opened.mode & 0o022) !== 0
        || opened.size !== before.size || opened.size > MAX_PINNED_SCRIPT_BYTES) fail(ERROR.invalid);
    const bytes = Buffer.alloc(MAX_PINNED_SCRIPT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.byteLength) {
      const result = await handle.read(bytes, bytesRead, bytes.byteLength - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
        || (after.mode & 0o022) !== 0 || bytesRead !== opened.size
        || createHash("sha256").update(bytes.subarray(0, bytesRead)).digest("hex") !== expectedSha256) fail(ERROR.invalid);
    const current = await lstat(scriptPath);
    if (!current.isFile() || current.isSymbolicLink() || current.uid !== before.uid
        || current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino
        || current.size !== before.size || (current.mode & 0o022) !== 0) fail(ERROR.invalid);
  } catch {
    fail(ERROR.invalid);
  } finally {
    try { await handle?.close(); } catch { fail(ERROR.invalid); }
  }
}

function checkDeadline(deadlineMonotonicMs) {
  if (!Number.isFinite(deadlineMonotonicMs) || performance.now() >= deadlineMonotonicMs) fail(ERROR.deadline);
}

function validateJsonTree(value, { maxDepth = 28 } = {}) {
  const visit = (entry, depth) => {
    if (depth > maxDepth) fail(ERROR.protocol);
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) fail(ERROR.protocol);
      return;
    }
    if (Array.isArray(entry)) {
      if (entry.length > 4096) fail(ERROR.protocol);
      for (const item of entry) visit(item, depth + 1);
      return;
    }
    if (!object(entry) || Object.getPrototypeOf(entry) !== Object.prototype) fail(ERROR.protocol);
    const keys = Object.keys(entry);
    if (keys.length > 4096) fail(ERROR.protocol);
    for (const key of keys) {
      if (key.length > 256) fail(ERROR.protocol);
      visit(entry[key], depth + 1);
    }
  };
  visit(value, 0);
  return value;
}

function jsonBytes(value, maximum) {
  let line;
  try {
    validateJsonTree(value);
    line = JSON.stringify(value);
  } catch {
    fail(ERROR.protocol);
  }
  if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > maximum) fail(ERROR.protocol);
  return `${line}\n`;
}

function validateResult(method, result) {
  validateJsonTree(result);
  if (method === "initialize") {
    if (!exactKeys(result, ["ready", "runtime", "readonlyHandles", "viteLoaded"])
        || result.ready !== true || !exactKeys(result.runtime, ["path", "version", "binarySha256"])
        || result.runtime.version !== "v26.2.0"
        || result.readonlyHandles !== 2 || result.viteLoaded !== true) fail(ERROR.protocol);
  } else if (method === "captureScope") {
    if (!exactKeys(result, ["scope", "scopeSha256"]) || !SHA.test(result.scopeSha256)
        || Contract.currentQ1D7JsonSha256(result.scope) !== result.scopeSha256) fail(ERROR.protocol);
  } else if (method === "readResult") {
    if (result !== null && !object(result)) fail(ERROR.protocol);
  } else if (method === "checkpointProgress") {
    if (typeof result !== "string" || !SHA.test(result)) fail(ERROR.protocol);
  } else if (method === "proveEffectiveConflictPage") {
    if (!exactKeys(result, ["checkpoint", "pageProof", "authorityBeforeSha256", "authorityAfterSha256"])
        || !exactKeys(result.checkpoint, ["keyDigest", "dependencyDigest", "method", "headDigest", "sourceDay", "cursorSha256"])
        || ![result.checkpoint.keyDigest, result.checkpoint.dependencyDigest, result.checkpoint.headDigest,
          result.checkpoint.cursorSha256, result.authorityBeforeSha256, result.authorityAfterSha256].every((value) => SHA.test(value))
        || !/^\d{4}-\d{2}-\d{2}$/u.test(result.checkpoint.sourceDay)
        || typeof result.checkpoint.method !== "string" || result.checkpoint.method.length > 1024
        || !exactKeys(result.pageProof, ["schemaVersion", "pageSha256", "associationSha256", "rowCount",
          "compatibleCount", "conflictCount", "compatibleRowsSchemaValid", "compatibleRowsTimeValid", "conflictFieldsNull"])
        || result.pageProof.schemaVersion !== "current-q1-effective-conflict-page-proof-v1"
        || ![result.pageProof.pageSha256, result.pageProof.associationSha256].every((value) => SHA.test(value))
        || ![result.pageProof.rowCount, result.pageProof.compatibleCount, result.pageProof.conflictCount]
          .every(Number.isSafeInteger)
        || result.pageProof.rowCount < 1 || result.pageProof.rowCount > 200
        || result.pageProof.compatibleCount + result.pageProof.conflictCount !== result.pageProof.rowCount
        || result.pageProof.conflictCount < 1 || result.pageProof.compatibleRowsSchemaValid !== true
        || result.pageProof.compatibleRowsTimeValid !== true || result.pageProof.conflictFieldsNull !== true) {
      fail(ERROR.protocol);
    }
  } else if (method === "captureIngestionInvariant") {
    if (!exactKeys(result, ["sha256", "schemaSha256", "fullSourceCaptureSha256"])
        || !Object.values(result).every((value) => SHA.test(value))) fail(ERROR.protocol);
  } else if (method === "close") {
    if (!exactKeys(result, ["closed", "closedDatabaseHandles", "closedVite", "cacheRemoved"])
        || result.closed !== true || result.closedDatabaseHandles !== 2
        || result.closedVite !== true || result.cacheRemoved !== true) fail(ERROR.protocol);
  } else fail(ERROR.protocol);
  return result;
}

function groupExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

function spawnEnvironment() {
  return { PATH: typeof process.env.PATH === "string" ? process.env.PATH : "",
    TMPDIR: tmpdir(), NODE_NO_WARNINGS: "1", CI: "true", TZ: "UTC" };
}

/** One D7-only child remains open for a case and accepts only fixed operations. */
async function createClient(input, { testScenario = null, testWatchdogMs = null } = {}) {
  try { input = structuredClone(input); } catch { fail(ERROR.invalid); }
  validateBootstrap(input);
  checkDeadline(input.deadlineMonotonicMs);
  const [, , measuredRuntime] = await Promise.all([
    verifyPinnedScriptBeforeSpawn(GUARDIAN_PATH, input.expectedGuardianSha256),
    verifyPinnedScriptBeforeSpawn(CHILD_PATH, input.expectedChildSha256),
    verifyPinnedRuntimeBeforeSpawn(input.runtime),
  ]);
  if (!isDeepStrictEqual(measuredRuntime, input.runtime)) fail(ERROR.invalid);
  checkDeadline(input.deadlineMonotonicMs);
  if (testScenario !== null && (!TEST_SCENARIOS.has(testScenario)
      || process.env.NODE_TEST_CONTEXT !== "child-v8"
      || !Number.isSafeInteger(testWatchdogMs) || testWatchdogMs < 100
      || testWatchdogMs > INVOCATION_WATCHDOG_MS)) {
    fail(ERROR.invalid);
  }

  const args = testScenario === null ? [] : ["--test-fixture", testScenario];
  const env = spawnEnvironment();
  const guardianBootstrap = {
    runtime: input.runtime,
    sourceFence: input.sourceFence,
    expectedChildSha256: input.expectedChildSha256,
    expectedGuardianSha256: input.expectedGuardianSha256,
  };
  env.CURRENT_Q1_D7_DIAGNOSTIC_BOOTSTRAP = JSON.stringify(guardianBootstrap);
  if (testScenario !== null) env.CURRENT_Q1_D7_DIAGNOSTIC_TEST_FIXTURE = "1";
  let child;
  try {
    child = spawn(process.execPath, [GUARDIAN_PATH, ...args], {
      cwd: WORKER_ROOT, detached: true, stdio: ["pipe", "pipe", "ignore", "pipe"], env,
    });
  } catch {
    fail(ERROR.failed);
  }

  let nextId = 1;
  let pending = null;
  let stdoutBuffer = Buffer.alloc(0);
  let exitEvent = null;
  let guardianExited = false;
  const exitWaiters = new Set();
  const controlSeen = new Set();
  const controlWaiters = new Set();
  let controlBuffer = Buffer.alloc(0);
  let controlFailure = false;
  let startupFailed = false;
  let cleanupPromise = null;
  let groupGone = false;
  let immediateTerminationStartedAt = null;
  let immediateTermSentAt = null;
  let immediateKillSentAt = null;
  let closed = false;
  let invalidated = false;

  const wakeControlWaiters = () => {
    for (const waiter of [...controlWaiters]) {
      const failed = controlFailure || (startupFailed && waiter.kind === "ready")
        || (exitEvent !== null && !controlSeen.has(waiter.kind));
      if (!failed && !controlSeen.has(waiter.kind)) continue;
      clearTimeout(waiter.timer);
      controlWaiters.delete(waiter);
      waiter.resolve(!failed && controlSeen.has(waiter.kind));
    }
  };

  const acceptControl = (chunk) => {
    if (!Buffer.isBuffer(chunk) || controlBuffer.length + chunk.length > 4096) {
      controlFailure = true; wakeControlWaiters(); return;
    }
    controlBuffer = Buffer.concat([controlBuffer, chunk]);
    let newline;
    while ((newline = controlBuffer.indexOf(0x0a)) >= 0) {
      const line = controlBuffer.subarray(0, newline);
      controlBuffer = controlBuffer.subarray(newline + 1);
      let message;
      try { message = JSON.parse(line.toString("utf8")); }
      catch { controlFailure = true; wakeControlWaiters(); return; }
      const allowed = testScenario === "blocked" || testScenario === "blocked-stalled-guardian"
        ? ["ready", "reader-reaped", "test-blocked", "startup-failed", "protocol-invalid"]
        : testScenario === "exited-reader-inherited-pipe"
          ? ["ready", "reader-reaped", "test-reader-exited", "test-reader-signal-skipped",
            "startup-failed", "protocol-invalid"]
        : testScenario === "closed-reader-ignored-descendant"
          ? ["ready", "reader-reaped", "test-descendant-spawned", "startup-failed", "protocol-invalid"]
        : ["ready", "reader-reaped", "startup-failed", "protocol-invalid"];
      if (!exactKeys(message, ["protocol", "kind"]) || message.protocol !== GUARDIAN_PROTOCOL
          || typeof message.kind !== "string" || !allowed.includes(message.kind)
          || controlSeen.has(message.kind)) {
        controlFailure = true; wakeControlWaiters(); return;
      }
      if (message.kind === "startup-failed") startupFailed = true;
      else controlSeen.add(message.kind);
      wakeControlWaiters();
      if (message.kind === "protocol-invalid") protocolFailure(ERROR.protocol);
    }
  };

  const waitForControl = (kind, maximumMs) => {
    if (controlFailure || (startupFailed && kind === "ready")
        || (exitEvent !== null && !controlSeen.has(kind))) return Promise.resolve(false);
    if (controlSeen.has(kind)) return Promise.resolve(true);
    return new Promise((resolveWait) => {
      const waiter = { kind, timer: null, resolve: resolveWait };
      waiter.timer = setTimeout(() => {
        controlWaiters.delete(waiter);
        resolveWait(false);
      }, maximumMs);
      controlWaiters.add(waiter);
      if (controlFailure || (startupFailed && kind === "ready") || controlSeen.has(kind)
          || (exitEvent !== null && !controlSeen.has(kind))) {
        clearTimeout(waiter.timer);
        controlWaiters.delete(waiter);
        resolveWait(!controlFailure && !(startupFailed && kind === "ready") && controlSeen.has(kind));
      }
    });
  };

  child.stdio[3]?.on("data", acceptControl);
  child.stdio[3]?.on("error", () => { controlFailure = true; wakeControlWaiters(); });
  child.stdio[3]?.on("end", () => {
    if (controlBuffer.length !== 0) controlFailure = true;
    wakeControlWaiters();
  });

  const waitForExit = async (maximumMs) => {
    if (exitEvent !== null) return true;
    return new Promise((resolveWait) => {
      const timer = setTimeout(() => {
        exitWaiters.delete(onExit);
        resolveWait(false);
      }, maximumMs);
      const onExit = () => {
        clearTimeout(timer);
        exitWaiters.delete(onExit);
        resolveWait(true);
      };
      exitWaiters.add(onExit);
      if (exitEvent !== null) onExit();
    });
  };

  const hasGuardianOwnership = () => !guardianExited && exitEvent === null
    && child.exitCode === null && child.signalCode === null
    && Number.isSafeInteger(child.pid) && child.pid > 1;

  const signalGroup = (signal) => {
    if (!hasGuardianOwnership()) fail(ERROR.terminate);
    try { process.kill(-child.pid, signal); return true; } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  };

  const signalGuardian = (signal) => {
    if (!hasGuardianOwnership()) fail(ERROR.terminate);
    try { process.kill(child.pid, signal); } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };

  const verifyGroupGone = async () => {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 1) return false;
    const until = performance.now() + PROCESS_GROUP_VERIFY_MS;
    while (performance.now() < until) {
      if (!groupExists(child.pid)) { groupGone = true; return true; }
      await delay(20);
    }
    groupGone = !groupExists(child.pid);
    return groupGone;
  };

  const terminateAndReap = async ({ immediateGroupTermination = false } = {}) => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      invalidated = true;
      if (immediateGroupTermination) {
        immediateTerminationStartedAt = performance.now();
        // Wall-deadline expiry signals the entire owned family immediately;
        // it does not wait for the guardian's normal EOF grace path.
        if (hasGuardianOwnership()) {
          try {
            if (signalGroup("SIGTERM")) immediateTermSentAt = performance.now();
          } catch { /* Bounded ownership proof below decides success. */ }
        }
        try { child.stdin.end(); } catch { /* The guardian also handles group TERM. */ }

        await waitForControl("reader-reaped", IMMEDIATE_REAP_MS);
        if (hasGuardianOwnership() && groupExists(child.pid)) {
          // If the guardian is unresponsive, its direct reader is in the same
          // owned group. Escalate only while the guardian handle still proves
          // ownership; never signal a group after its leader has exited.
          try {
            if (signalGroup("SIGKILL")) immediateKillSentAt = performance.now();
          } catch { /* The bounded close and group absence proof decide success. */ }
        }
        if (exitEvent === null) await waitForExit(PROCESS_REAP_MS);
        if (exitEvent === null || !await verifyGroupGone()) fail(ERROR.terminate);
        return true;
      }
      try { child.stdin.end(); } catch { /* The guardian also cleans up on owner EOF. */ }
      if (guardianExited) {
        if (exitEvent === null) await waitForExit(PROCESS_REAP_MS);
        if (exitEvent !== null && await verifyGroupGone()) return true;
        fail(ERROR.terminate);
      }
      let readerReaped = await waitForControl("reader-reaped", PROCESS_REAP_MS);
      if (!readerReaped) {
        try { signalGuardian("SIGTERM"); } catch { /* Guardian EOF path remains the cleanup owner. */ }
        readerReaped = await waitForControl("reader-reaped", TERMINATION_GRACE_MS + PROCESS_REAP_MS);
      }
      if (readerReaped && exitEvent === null) {
        await waitForExit(TERMINATION_GRACE_MS);
        if (exitEvent === null && hasGuardianOwnership()) {
          try { signalGroup("SIGTERM"); } catch { /* The reader is already reaped. */ }
          await waitForExit(TERMINATION_GRACE_MS);
        }
        if (exitEvent === null && hasGuardianOwnership() && groupExists(child.pid)) {
          try { signalGroup("SIGKILL"); } catch { /* Never signal after guardian exit. */ }
        }
      }
      if (!readerReaped && !guardianExited && hasGuardianOwnership()) {
        try { signalGroup("SIGTERM"); } catch { /* Bounded close and group absence proof decide success. */ }
        await waitForControl("reader-reaped", TERMINATION_GRACE_MS);
        if (!guardianExited && hasGuardianOwnership() && groupExists(child.pid)) {
          try { signalGroup("SIGKILL"); } catch { /* Never signal after guardian exit. */ }
        }
      }
      if (exitEvent === null) await waitForExit(PROCESS_REAP_MS);
      if (exitEvent === null || !await verifyGroupGone()) fail(ERROR.terminate);
      return true;
    })();
    return cleanupPromise;
  };

  const settlePending = (error, value) => {
    const current = pending;
    if (!current) return;
    pending = null;
    clearTimeout(current.timer);
    if (error) current.reject(error);
    else current.resolve(value);
  };

  let pendingFailure = null;
  const protocolFailure = (code = ERROR.protocol) => {
    if (pendingFailure) return;
    pendingFailure = Object.assign(new Error(code), { code });
    void terminateAndReap().then(() => settlePending(pendingFailure), () => settlePending(Object.assign(new Error(ERROR.terminate), { code: ERROR.terminate })));
  };

  child.stdout.on("data", (chunk) => {
    if (!Buffer.isBuffer(chunk)) { protocolFailure(); return; }
    if (stdoutBuffer.length + chunk.length > MAX_RESPONSE_BYTES) { protocolFailure(); return; }
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    let newline;
    while ((newline = stdoutBuffer.indexOf(0x0a)) >= 0) {
      const line = stdoutBuffer.subarray(0, newline);
      stdoutBuffer = stdoutBuffer.subarray(newline + 1);
      if (line.length === 0 || !pending) { protocolFailure(); return; }
      let response;
      try { response = JSON.parse(line.toString("utf8")); }
      catch { protocolFailure(); return; }
      const current = pending;
      if (current.responseReceived || !object(response) || response.protocol !== PROTOCOL
          || response.id !== current.id) { protocolFailure(); return; }
      if (response.ok === true && exactKeys(response, ["protocol", "id", "ok", "result"])) {
        let result;
        try { result = validateResult(current.method, response.result); }
        catch { protocolFailure(); return; }
        current.responseReceived = true;
        if (current.method === "close") {
          void finishClose(current, result);
        } else settlePending(null, result);
      } else if (response.ok === false && exactKeys(response, ["protocol", "id", "ok", "code"])
          && typeof response.code === "string" && current.allowedCodes.has(response.code)) {
        current.responseReceived = true;
        const error = Object.assign(new Error(response.code), { code: response.code });
        settlePending(error);
      } else { protocolFailure(); return; }
    }
  });

  child.on("error", () => {
    guardianExited = true;
    exitEvent ??= { code: null, signal: null };
    for (const onExit of [...exitWaiters]) onExit();
    wakeControlWaiters();
    protocolFailure(ERROR.failed);
  });
  child.on("exit", (code, signal) => {
    guardianExited = true;
    wakeControlWaiters();
  });
  child.on("close", (code, signal) => {
    guardianExited = true;
    exitEvent ??= { code, signal };
    for (const onExit of [...exitWaiters]) onExit();
    wakeControlWaiters();
    if (pending && !pending.responseReceived) protocolFailure(ERROR.exited);
    else if (!closed) invalidated = true;
  });

  async function finishClose(current, result) {
    if (pending !== current) return;
    const readerReaped = controlSeen.has("reader-reaped")
      || await waitForControl("reader-reaped", PROCESS_REAP_MS);
    const reaped = await waitForExit(PROCESS_REAP_MS);
    const processGroupGone = reaped && await verifyGroupGone();
    if ((!readerReaped && !processGroupGone) || !reaped || !processGroupGone) {
      protocolFailure(ERROR.terminate);
      return;
    }
    closed = true;
    invalidated = true;
    settlePending(null, { ...result, processGroupGone: true });
  }

  async function request(method, payload, { initialization = false } = {}) {
    if (!METHODS.has(method) || invalidated || closed || pending) fail(ERROR.failed);
    const expectedPayloadKeys = {
      initialize: ["scratchDirectory", "caseKey", "sourceId", "sourceNamespace", "nowMs", "expectedOwners",
        "runtime", "sourceFence", "expectedChildSha256", "expectedGuardianSha256"],
      captureScope: ["ownerKey", "metric", "day"], readResult: ["scopeSha256"],
      checkpointProgress: ["scopeSha256"], proveEffectiveConflictPage: ["scopeSha256"],
      captureIngestionInvariant: [], close: [],
    };
    if (!exactKeys(payload, expectedPayloadKeys[method] ?? [])) fail(ERROR.invalid);
    const id = initialization ? 0 : nextId++;
    const line = jsonBytes({ protocol: PROTOCOL, id, method, payload }, MAX_REQUEST_BYTES);
    const now = performance.now();
    const outerRemaining = input.deadlineMonotonicMs - now;
    if (!Number.isFinite(outerRemaining) || outerRemaining <= 0) {
      invalidated = true;
      await terminateAndReap({ immediateGroupTermination: true });
      fail(ERROR.deadline);
    }
    const invocationLimit = initialization ? INVOCATION_WATCHDOG_MS
      : (testWatchdogMs ?? INVOCATION_WATCHDOG_MS);
    const watchdogMs = Math.min(invocationLimit, outerRemaining);
    const watchdogCode = outerRemaining <= invocationLimit ? ERROR.deadline : ERROR.timeout;

    return new Promise((resolveResult, rejectResult) => {
      const current = { id, method, allowedCodes: SAFE_CHILD_CODES, responseReceived: false,
        resolve: resolveResult, reject: rejectResult, timer: null };
      current.timer = setTimeout(() => {
        const error = Object.assign(new Error(watchdogCode), { code: watchdogCode });
        void terminateAndReap({ immediateGroupTermination: true }).then(() => settlePending(error),
          () => settlePending(Object.assign(new Error(ERROR.terminate), { code: ERROR.terminate })));
      }, Math.max(1, Math.ceil(watchdogMs)));
      pending = current;
      try {
        child.stdin.write(line, "utf8", (error) => { if (error && pending === current) protocolFailure(ERROR.failed); });
      } catch { protocolFailure(ERROR.failed); }
    });
  }

  const SAFE_CHILD_CODES = new Set([
    "CURRENT_Q1_D7_DIAGNOSTIC_INIT_FAILED",
    "CURRENT_Q1_D7_DIAGNOSTIC_METHOD_INVALID",
    "CURRENT_Q1_D7_DIAGNOSTIC_SCOPE_INVALID",
    "CURRENT_Q1_D7_DIAGNOSTIC_SCOPE_FAILED",
    "CURRENT_Q1_D7_DIAGNOSTIC_RESULT_FAILED",
    "CURRENT_Q1_D7_DIAGNOSTIC_CHECKPOINT_FAILED",
    "CURRENT_Q1_D7_DIAGNOSTIC_PAGE_FAILED",
    "CURRENT_Q1_D7_SOURCE_CHANGED",
    "CURRENT_Q1_D7_NATIVE_CHECKPOINT_INVALID",
    "CURRENT_Q1_D7_NATIVE_PAGE_INVALID",
    "CURRENT_Q1_D7_DEADLINE",
  ]);

  const startupRemaining = input.deadlineMonotonicMs - performance.now();
  const guardianReady = Number.isFinite(startupRemaining) && startupRemaining > 0
    && await waitForControl("ready", Math.max(1, Math.min(GUARDIAN_STARTUP_MS, startupRemaining)));
  if (!guardianReady) {
    invalidated = true;
    try { await terminateAndReap(); } catch { /* Preserve the bounded startup failure. */ }
    fail(performance.now() >= input.deadlineMonotonicMs ? ERROR.deadline : ERROR.failed);
  }

  let initialized;
  try {
    initialized = await request("initialize", {
      scratchDirectory: input.scratchDirectory, caseKey: input.caseKey,
      sourceId: input.sourceId, sourceNamespace: input.sourceNamespace,
      nowMs: input.nowMs, expectedOwners: input.expectedOwners, runtime: input.runtime,
      sourceFence: input.sourceFence, expectedChildSha256: input.expectedChildSha256,
      expectedGuardianSha256: input.expectedGuardianSha256,
    }, { initialization: true });
  } catch (error) {
    invalidated = true;
    try { await terminateAndReap(); } catch { /* Preserve the closed startup outcome. */ }
    throw Object.assign(new Error(SAFE_CHILD_CODES.has(error?.code) ? error.code : ERROR.failed), {
      code: SAFE_CHILD_CODES.has(error?.code) ? error.code : ERROR.failed,
    });
  }
  if (!exactKeys(initialized, ["ready", "runtime", "readonlyHandles", "viteLoaded"])
      || initialized.ready !== true || !exactKeys(initialized.runtime, ["path", "version", "binarySha256"])
      || !isDeepStrictEqual(initialized.runtime, input.runtime)
      || initialized.readonlyHandles !== 2 || initialized.viteLoaded !== true) {
    invalidated = true;
    try { await terminateAndReap(); } catch { /* Startup already failed closed. */ }
    fail(ERROR.protocol);
  }

  const api = {
    captureScope: (payload) => {
      if (!exactKeys(payload, ["ownerKey", "metric", "day"]) || !OWNER_KEYS.includes(payload.ownerKey)
          || !METRICS.has(payload.metric) || typeof payload.day !== "string") fail(ERROR.invalid);
      return request("captureScope", payload);
    },
    readResult: (payload) => {
      if (!exactKeys(payload, ["scopeSha256"]) || !SHA.test(payload.scopeSha256)) fail(ERROR.invalid);
      return request("readResult", payload);
    },
    checkpointProgress: (payload) => {
      if (!exactKeys(payload, ["scopeSha256"]) || !SHA.test(payload.scopeSha256)) fail(ERROR.invalid);
      return request("checkpointProgress", payload);
    },
    proveEffectiveConflictPage: (payload) => {
      if (!exactKeys(payload, ["scopeSha256"]) || !SHA.test(payload.scopeSha256)) fail(ERROR.invalid);
      return request("proveEffectiveConflictPage", payload);
    },
    captureIngestionInvariant: () => request("captureIngestionInvariant", {}),
    close: async () => {
      if (closed || groupGone) return { closed: true, processGroupGone: true };
      if (invalidated) {
        await terminateAndReap();
        closed = true;
        return { closed: true, processGroupGone: true };
      }
      const result = await request("close", {});
      return result;
    },
  };
  if (testScenario === "blocked" || testScenario === "blocked-stalled-guardian") {
    Object.defineProperty(api, "waitUntilTestBlocked", {
      value: () => waitForControl("test-blocked", GUARDIAN_STARTUP_MS), enumerable: false,
    });
    Object.defineProperty(api, "testProcessGroupId", { value: child.pid, enumerable: false });
    Object.defineProperty(api, "testImmediateTerminationStartedAt", {
      get: () => immediateTerminationStartedAt, enumerable: false,
    });
    Object.defineProperty(api, "testImmediateTermSentAt", { get: () => immediateTermSentAt, enumerable: false });
    Object.defineProperty(api, "testImmediateKillSentAt", { get: () => immediateKillSentAt, enumerable: false });
  }
  if (testScenario === "exited-reader-inherited-pipe") {
    Object.defineProperties(api, {
      waitUntilReaderExited: {
        value: () => waitForControl("test-reader-exited", GUARDIAN_STARTUP_MS), enumerable: false,
      },
      waitUntilReaderSignalSkipped: {
        value: () => waitForControl("test-reader-signal-skipped", GUARDIAN_STARTUP_MS), enumerable: false,
      },
      waitUntilReaderReaped: {
        value: () => waitForControl("reader-reaped", PROCESS_REAP_MS), enumerable: false,
      },
      waitUntilGuardianExited: {
        value: () => waitForExit(PROCESS_REAP_MS), enumerable: false,
      },
    });
  }
  if (testScenario === "closed-reader-ignored-descendant") {
    Object.defineProperty(api, "waitUntilTestDescendantSpawned", {
      value: () => waitForControl("test-descendant-spawned", GUARDIAN_STARTUP_MS), enumerable: false,
    });
  }
  return Object.freeze(api);
}

/** Production client. It has one fixed child entrypoint and no runtime/path hooks. */
export async function createCurrentQ1D7DiagnosticClient(input) {
  return createClient(input);
}

/** Isolated subprocess scenarios used only by this module's Node test runner. */
export async function createCurrentQ1D7DiagnosticTestClient(input, { scenario, watchdogMs = 1000 } = {}) {
  if (process.env.NODE_TEST_CONTEXT !== "child-v8" || !TEST_SCENARIOS.has(scenario)) fail(ERROR.invalid);
  return createClient(input, { testScenario: scenario, testWatchdogMs: watchdogMs });
}
