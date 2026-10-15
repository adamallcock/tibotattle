/** Fixed non-SQL guardian for one D7 reader. It survives owner EOF and reaps the reader. */
import { createHash } from "node:crypto";
import { constants as fsConstants, createWriteStream } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(HERE, "../..");
const GUARDIAN_PATH = fileURLToPath(import.meta.url);
const READER_PATH = fileURLToPath(new URL("./current-q1-d7-diagnostic-child.mjs", import.meta.url));
const GUARDIAN_PROTOCOL = "current-q1-d7-diagnostic-guardian-v1";
const READER_PROTOCOL = "current-q1-d7-diagnostic-v1";
const READER_METHODS = new Set(["initialize", "captureScope", "readResult", "checkpointProgress",
  "proveEffectiveConflictPage", "captureIngestionInvariant", "close"]);
const TEST_SCENARIOS = new Set(["success", "blocked", "blocked-stalled-guardian", "early-exit", "malformed",
  "oversized", "exited-reader-inherited-pipe", "closed-reader-ignored-descendant"]);
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_READER_SCRIPT_BYTES = 256 * 1024;
const READER_TERM_GRACE_MS = 300;
const READER_REAP_MS = 2000;
const SHA = /^[a-f0-9]{64}$/u;
const SOURCE_HEAD = /^[a-f0-9]{40,64}$/u;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, expected) => object(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());

const safePayloadKeys = Object.freeze({
  initialize: ["scratchDirectory", "caseKey", "sourceId", "sourceNamespace", "nowMs", "expectedOwners",
    "runtime", "sourceFence", "expectedChildSha256", "expectedGuardianSha256"],
  captureScope: ["ownerKey", "metric", "day"], readResult: ["scopeSha256"],
  checkpointProgress: ["scopeSha256"], proveEffectiveConflictPage: ["scopeSha256"],
  captureIngestionInvariant: [], close: [],
});

let controlStream;
let reader = null;
let readerExitEvent = null;
let readerCloseEvent = null;
let readerCloseWaiters = new Set();
let cleanupPromise = null;
let activeRequestId = null;
let lastRequestId = -1;
let closeRequested = false;
let exiting = false;
let requestBuffer = Buffer.alloc(0);
let responseBuffer = Buffer.alloc(0);
let testScenario = null;
let readerReapedNotified = false;
let readerSignalSkipNotified = false;
let bootstrap = null;

function control(kind) {
  if (!controlStream || controlStream.destroyed) return;
  const line = `${JSON.stringify({ protocol: GUARDIAN_PROTOCOL, kind })}\n`;
  if (Buffer.byteLength(line, "utf8") > 1024) return;
  controlStream.write(line, "utf8", () => {});
}

function failClosed() { void cleanupAndExit(1); }
function failProtocol() { control("protocol-invalid"); failClosed(); }

function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

function waitForReaderClose(maximumMs) {
  if (readerCloseEvent !== null) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => {
      readerCloseWaiters.delete(onClose);
      resolveWait(false);
    }, maximumMs);
    const onClose = () => {
      clearTimeout(timer);
      readerCloseWaiters.delete(onClose);
      resolveWait(true);
    };
    readerCloseWaiters.add(onClose);
    if (readerCloseEvent !== null) onClose();
  });
}

function signalReader(signal) {
  if (!reader || !Number.isSafeInteger(reader.pid) || reader.pid <= 1 || readerCloseEvent !== null) return false;
  if (readerExitEvent !== null || reader.exitCode !== null || reader.signalCode !== null) {
    if (testScenario === "exited-reader-inherited-pipe" && !readerSignalSkipNotified) {
      readerSignalSkipNotified = true;
      control("test-reader-signal-skipped");
    }
    return false;
  }
  try { process.kill(reader.pid, signal); } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  return true;
}

async function terminateAndReapReader() {
  if (readerCloseEvent !== null) return true;
  if (!reader) return true;
  try { signalReader("SIGTERM"); } catch { /* The close event is authoritative. */ }
  if (!await waitForReaderClose(READER_TERM_GRACE_MS)) {
    try { signalReader("SIGKILL"); } catch { /* The bounded reap below decides success. */ }
  }
  if (!await waitForReaderClose(READER_REAP_MS)) return false;
  return true;
}

function notifyReaderReaped() {
  if (readerReapedNotified || readerCloseEvent === null) return;
  readerReapedNotified = true;
  control("reader-reaped");
}

async function cleanupAndExit(code = 0) {
  if (cleanupPromise) return cleanupPromise;
  exiting = true;
  cleanupPromise = (async () => {
    const reaped = await terminateAndReapReader();
    if (!reaped) {
      // The guardian still owns its detached process group. If ChildProcess
      // close cannot confirm a reap, terminate that group while this leader is
      // alive; never retry a potentially stale reader PID indefinitely.
      process.exitCode = 1;
      try { process.kill(-process.pid, "SIGKILL"); }
      catch { process.exit(1); }
      return false;
    }
    notifyReaderReaped();
    process.stdin.pause();
    process.stdout.end();
    controlStream?.end(() => {
      setTimeout(() => {
        // The reader-reaped control is flushed before this callback. Keep the
        // guardian alive until its complete owned group, including ignored-
        // stdio descendants, is terminated even while the owner is connected.
        try { process.kill(-process.pid, "SIGKILL"); }
        catch (error) { if (error?.code !== "ESRCH") process.exitCode = 1; }
      }, READER_TERM_GRACE_MS);
    });
    process.exitCode = code;
    return true;
  })();
  return cleanupPromise;
}

async function verifyPinnedScript(scriptPath, expectedSha256) {
  let handle;
  try {
    if (!SHA.test(expectedSha256) || await realpath(scriptPath) !== scriptPath) return false;
    const before = await lstat(scriptPath);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid()
        || before.nlink !== 1 || (before.mode & 0o022) !== 0 || before.size < 1
        || before.size > MAX_READER_SCRIPT_BYTES) return false;
    handle = await open(scriptPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.uid !== before.uid || opened.nlink !== 1 || opened.size !== before.size
        || (opened.mode & 0o022) !== 0) return false;
    const bytes = Buffer.alloc(MAX_READER_SCRIPT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(scriptPath);
    return after.dev === opened.dev && after.ino === opened.ino && after.size === opened.size
      && (after.mode & 0o022) === 0 && current.dev === before.dev && current.ino === before.ino
      && current.nlink === 1 && current.size === before.size && length === opened.size
      && createHash("sha256").update(bytes.subarray(0, length)).digest("hex") === expectedSha256;
  } catch { return false; }
  finally { try { await handle?.close(); } catch { /* Fail closed through the boolean result. */ } }
}

async function verifyRuntime(expectedRuntime) {
  let handle;
  try {
    const executablePath = await realpath(process.execPath);
    if (!expectedRuntime || expectedRuntime.path !== executablePath
        || expectedRuntime.version !== process.version || process.version !== "v26.2.0") return false;
    const before = await lstat(executablePath);
    if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o111) === 0
        || !Number.isSafeInteger(before.size) || before.size < 1 || before.size > 512 * 1024 * 1024) return false;
    handle = await open(executablePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || (opened.mode & 0o111) === 0) return false;
    const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - position), position);
      if (bytesRead === 0) return false;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat(), current = await lstat(executablePath);
    return after.dev === opened.dev && after.ino === opened.ino && after.size === opened.size
      && current.dev === before.dev && current.ino === before.ino && current.size === before.size
      && hash.digest("hex") === expectedRuntime.binarySha256;
  } catch { return false; }
  finally { try { await handle?.close(); } catch { /* Fail closed through the boolean result. */ } }
}

function parseBootstrap() {
  try {
    const raw = process.env.CURRENT_Q1_D7_DIAGNOSTIC_BOOTSTRAP;
    if (typeof raw !== "string" || raw.length > 4096) return null;
    const value = JSON.parse(raw);
    if (!exactKeys(value, ["runtime", "sourceFence", "expectedChildSha256", "expectedGuardianSha256"])
        || !exactKeys(value.runtime, ["path", "version", "binarySha256"])
        || typeof value.runtime.path !== "string" || !value.runtime.path.startsWith("/")
        || value.runtime.version !== "v26.2.0" || !SHA.test(value.runtime.binarySha256)
        || !exactKeys(value.sourceFence, ["head", "sha256"])
        || typeof value.sourceFence.head !== "string" || !SOURCE_HEAD.test(value.sourceFence.head)
        || !SHA.test(value.sourceFence.sha256)
        || !SHA.test(value.expectedChildSha256) || !SHA.test(value.expectedGuardianSha256)) return null;
    return value;
  } catch { return null; }
}

function validateReaderRequest(line) {
  if (line.length === 0 || line.length > MAX_REQUEST_BYTES) return null;
  let request;
  try { request = JSON.parse(line.toString("utf8")); } catch { return null; }
  if (!exactKeys(request, ["protocol", "id", "method", "payload"])
      || request.protocol !== READER_PROTOCOL || !Number.isSafeInteger(request.id)
      || request.id !== lastRequestId + 1 || !READER_METHODS.has(request.method)
      || !exactKeys(request.payload, safePayloadKeys[request.method])) return null;
  if (request.method === "initialize" && request.id !== 0) return null;
  if (request.method !== "initialize" && request.id === 0) return null;
  if (request.method === "initialize" && (!isDeepStrictEqual(request.payload.runtime, bootstrap?.runtime)
      || !isDeepStrictEqual(request.payload.sourceFence, bootstrap?.sourceFence)
      || request.payload.expectedChildSha256 !== bootstrap?.expectedChildSha256
      || request.payload.expectedGuardianSha256 !== bootstrap?.expectedGuardianSha256)) return null;
  return request;
}

function consumeReaderOutput(chunk) {
  if (!Buffer.isBuffer(chunk) || responseBuffer.length + chunk.length > MAX_RESPONSE_BYTES) {
    failProtocol(); return;
  }
  responseBuffer = Buffer.concat([responseBuffer, chunk]);
  let newline;
  while ((newline = responseBuffer.indexOf(0x0a)) >= 0) {
    const line = responseBuffer.subarray(0, newline);
    responseBuffer = responseBuffer.subarray(newline + 1);
    if (line.length === 0 || activeRequestId === null || line.length > MAX_RESPONSE_BYTES) {
      failProtocol(); return;
    }
    let response;
    try { response = JSON.parse(line.toString("utf8")); } catch { failProtocol(); return; }
    if (!object(response) || response.protocol !== READER_PROTOCOL || response.id !== activeRequestId
        || (response.ok === true && !exactKeys(response, ["protocol", "id", "ok", "result"]))
        || (response.ok === false && (!exactKeys(response, ["protocol", "id", "ok", "code"])
          || typeof response.code !== "string" || response.code.length > 128))) {
      failProtocol(); return;
    }
    const forwarded = Buffer.concat([line, Buffer.from("\n")]);
    if (process.stdout.write(forwarded) === false) process.stdout.once("drain", () => {});
    activeRequestId = null;
    if (response.ok === true && requestMethodById.get(response.id) === "close") closeRequested = true;
  }
}

const requestMethodById = new Map();

function acceptOwnerBytes(chunk) {
  if (!Buffer.isBuffer(chunk) || requestBuffer.length + chunk.length > MAX_REQUEST_BYTES) {
    failClosed(); return;
  }
  requestBuffer = Buffer.concat([requestBuffer, chunk]);
  let newline;
  while ((newline = requestBuffer.indexOf(0x0a)) >= 0) {
    const line = requestBuffer.subarray(0, newline);
    requestBuffer = requestBuffer.subarray(newline + 1);
    const request = validateReaderRequest(line);
    if (!request || activeRequestId !== null || exiting || !reader || readerCloseEvent !== null) {
      failProtocol(); return;
    }
    lastRequestId = request.id;
    activeRequestId = request.id;
    requestMethodById.set(request.id, request.method);
    if (requestMethodById.size > 1) requestMethodById.delete(request.id - 1);
    const serialized = Buffer.concat([line, Buffer.from("\n")]);
    if (!reader.stdin.write(serialized)) reader.stdin.once("drain", () => {});
  }
}

function parseScenario() {
  const args = process.argv.slice(2);
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== "--test-fixture"
      || process.env.CURRENT_Q1_D7_DIAGNOSTIC_TEST_FIXTURE !== "1"
      || !TEST_SCENARIOS.has(args[1])) throw new Error("invalid guardian startup");
  return args[1];
}

function safeReaderEnvironment(bootstrapValue) {
  const env = { PATH: typeof process.env.PATH === "string" ? process.env.PATH : "",
    TMPDIR: tmpdir(), NODE_NO_WARNINGS: "1", CI: "true", TZ: "UTC" };
  if (testScenario !== null) env.CURRENT_Q1_D7_DIAGNOSTIC_TEST_FIXTURE = "1";
  env.CURRENT_Q1_D7_DIAGNOSTIC_BOOTSTRAP = JSON.stringify(bootstrapValue);
  return { env };
}

async function start() {
  controlStream = createWriteStream(null, { fd: 3, autoClose: false });
  testScenario = parseScenario();
  bootstrap = parseBootstrap();
  if (!bootstrap || !await verifyRuntime(bootstrap.runtime)
      || !await verifyPinnedScript(GUARDIAN_PATH, bootstrap.expectedGuardianSha256)
      || !await verifyPinnedScript(READER_PATH, bootstrap.expectedChildSha256)) {
    throw new Error("diagnostic bootstrap pin failed");
  }
  const { env } = safeReaderEnvironment(bootstrap);
  const args = testScenario === null ? [] : ["--test-fixture", testScenario];
  reader = spawn(process.execPath, [READER_PATH, ...args], {
    cwd: WORKER_ROOT, detached: false,
    stdio: ["pipe", "pipe", ["blocked", "blocked-stalled-guardian", "closed-reader-ignored-descendant"]
      .includes(testScenario) ? "pipe" : "ignore"], env,
  });
  reader.on("error", () => {
    readerCloseEvent ??= { code: null, signal: null };
    for (const onClose of [...readerCloseWaiters]) onClose();
    void cleanupAndExit(1);
  });
  reader.on("exit", (code, signal) => {
    readerExitEvent ??= { code, signal };
    if (testScenario === "exited-reader-inherited-pipe") control("test-reader-exited");
    if (!closeRequested && !exiting) void cleanupAndExit(1);
  });
  reader.on("close", (code, signal) => {
    readerCloseEvent ??= { code, signal };
    for (const onClose of [...readerCloseWaiters]) onClose();
    notifyReaderReaped();
    if (closeRequested) void cleanupAndExit(0);
    else if (!exiting) void cleanupAndExit(1);
  });
  reader.stdout.on("data", consumeReaderOutput);
  reader.stdout.on("end", () => { if (responseBuffer.length > 0) failProtocol(); });
  if (testScenario === "blocked" || testScenario === "blocked-stalled-guardian") {
    let markerBuffer = Buffer.alloc(0);
    reader.stderr.on("data", (chunk) => {
      if (!Buffer.isBuffer(chunk) || markerBuffer.length + chunk.length > 128) return;
      markerBuffer = Buffer.concat([markerBuffer, chunk]);
      const marker = Buffer.from("CURRENT_Q1_D7_TEST_BLOCKED\n");
      if (markerBuffer.equals(marker)) {
        markerBuffer = Buffer.alloc(0);
        if (testScenario === "blocked-stalled-guardian") process.on("SIGTERM", () => {});
        control("test-blocked");
        if (testScenario === "blocked-stalled-guardian") {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 35_000);
        }
      }
    });
  }
  if (testScenario === "closed-reader-ignored-descendant") {
    let markerBuffer = Buffer.alloc(0);
    reader.stderr.on("data", (chunk) => {
      if (!Buffer.isBuffer(chunk) || markerBuffer.length + chunk.length > 128) return;
      markerBuffer = Buffer.concat([markerBuffer, chunk]);
      const marker = Buffer.from("CURRENT_Q1_D7_TEST_DESCENDANT_SPAWNED\n");
      if (markerBuffer.equals(marker)) {
        markerBuffer = Buffer.alloc(0);
        control("test-descendant-spawned");
      }
    });
  }
  await new Promise((resolveSpawn, rejectSpawn) => {
    reader.once("spawn", resolveSpawn);
    reader.once("error", rejectSpawn);
  });
  control("ready");
}

process.stdin.on("data", acceptOwnerBytes);
process.stdin.on("end", () => {
  if (requestBuffer.length !== 0) { void cleanupAndExit(1); return; }
  void cleanupAndExit(0);
});
process.on("SIGTERM", () => {
  process.stdin.pause();
  void cleanupAndExit(0);
});
process.on("uncaughtException", () => { process.stdin.pause(); void cleanupAndExit(1); });
process.on("unhandledRejection", () => { process.stdin.pause(); void cleanupAndExit(1); });

void start().catch(() => {
  control("startup-failed");
  void cleanupAndExit(1);
});
