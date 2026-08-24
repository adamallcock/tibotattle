#!/usr/bin/env node
import { spawn } from "node:child_process";
import { win32 } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  ClaudeStatuslineError,
  DEFAULT_MAX_CLAUDE_STATUS_INPUT_BYTES,
  runClaudeStatusline,
} from "./claude-statusline.js";
import {
  ClaudeCallbackCapabilityError,
  createProductionClaudeCallbackBackend,
  readClaudeCallbackCapability,
} from "./claude-callback-capability.js";
import {
  buildClaudeCallbackRunnerInvocation,
  readClaudeCallbackRuntimeConfiguration,
  validateClaudeCallbackRunner,
} from "./claude-callback-lifecycle.js";

const MAX_COEXISTING_OUTPUT_BYTES = 8 * 1024;
const COEXISTING_TIMEOUT_MILLISECONDS = 1_500;
const WINDOWS_TREE_CLEANUP_TIMEOUT_MILLISECONDS = 3_000;

function missingCapability() {
  throw new ClaudeCallbackCapabilityError("credential_missing");
}

function waitForProcessClose(child, timeoutMilliseconds) {
  if (!child || typeof child.once !== "function") return Promise.resolve({ closed: false, code: null });
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ closed: true, code: child.exitCode ?? null });
  }
  return new Promise((resolve) => {
    let timer = null;
    let settled = false;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      child.off?.("close", onClose);
      child.off?.("error", onError);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onClose = (code) => finish({ closed: true, code });
    const onError = () => finish({ closed: false, code: null });
    child.once("close", onClose);
    child.once("error", onError);
    timer = setTimeout(() => finish({ closed: false, code: null }), timeoutMilliseconds);
    timer.unref?.();
  });
}

function windowsTaskkillPath(environment) {
  const root = typeof environment?.SystemRoot === "string" && environment.SystemRoot.length > 0
    ? environment.SystemRoot
    : "C:\\Windows";
  let normalized;
  try {
    normalized = win32.normalize(root.replaceAll("/", "\\"));
  } catch {
    return null;
  }
  const trimmed = normalized.replace(/[\\]+$/u, "");
  // Only the real Windows directory at the root of a local drive is reviewed
  // as a source for taskkill.exe. An arbitrary SystemRoot-like environment
  // value could otherwise redirect cleanup to attacker-controlled code.
  if (!/^[A-Za-z]:\\Windows$/iu.test(trimmed)) return null;
  return `${trimmed}\\System32\\taskkill.exe`;
}

async function terminateWindowsProcessTree(child, {
  spawnCommand,
  env,
  timeoutMilliseconds = WINDOWS_TREE_CLEANUP_TIMEOUT_MILLISECONDS,
} = {}) {
  const pid = child?.pid;
  const executable = windowsTaskkillPath(env);
  if (!Number.isSafeInteger(pid) || pid < 1 || executable === null) {
    try { child.kill?.("SIGKILL"); } catch { /* Best-effort containment only. */ }
    return false;
  }
  let killer;
  try {
    killer = spawnCommand(executable, ["/PID", String(pid), "/T", "/F"], {
      env,
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
  } catch {
    try { child.kill?.("SIGKILL"); } catch { /* Best-effort containment only. */ }
    return false;
  }
  const killerResult = await waitForProcessClose(killer, timeoutMilliseconds);
  const childResult = await waitForProcessClose(child, timeoutMilliseconds);
  if (!killerResult.closed || killerResult.code !== 0 || !childResult.closed) {
    try { child.kill?.("SIGKILL"); } catch { /* No success is reported below. */ }
    return false;
  }
  return true;
}

export function createCoexistingInvocation(command, {
  platform = process.platform,
  runner = null,
  spawnCommand = spawn,
  env = process.env,
  timeoutMilliseconds = COEXISTING_TIMEOUT_MILLISECONDS,
  windowsCleanupTimeoutMilliseconds = WINDOWS_TREE_CLEANUP_TIMEOUT_MILLISECONDS,
} = {}) {
  if (command === null) {
    return Object.freeze({
      present: false,
      write: async () => {},
      end: () => {},
      result: Promise.resolve({ status: "absent", output: "" }),
    });
  }
  let child;
  let acceptingInput = true;
  let settled = false;
  let outputBytes = 0;
  let timer = null;
  let terminationRequested = false;
  let terminationPromise = null;
  const outputChunks = [];
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  const finish = (status) => {
    if (settled) return;
    settled = true;
    acceptingInput = false;
    clearTimeout(timer);
    const output = status === "ok" ? Buffer.concat(outputChunks, outputBytes).toString("utf8") : "";
    for (const chunk of outputChunks) chunk.fill(0);
    outputChunks.length = 0;
    outputBytes = 0;
    resolveResult({
      status,
      output,
    });
  };
  const requestTermination = () => {
    if (settled || terminationRequested) return;
    terminationRequested = true;
    if (platform !== "win32") {
      try { child.kill("SIGKILL"); } catch { /* The result owns failure handling. */ }
      child.stdin.destroy();
      finish("failed");
      return;
    }
    terminationPromise = terminateWindowsProcessTree(child, {
      spawnCommand,
      env,
      timeoutMilliseconds: windowsCleanupTimeoutMilliseconds,
    }).finally(() => {
      // A Windows timeout/overflow is never a successful coexistence result;
      // completion waits for taskkill and the target close event first.
      child.stdin.destroy();
      finish("failed");
    });
    terminationPromise.catch(() => finish("failed"));
  };
  const failChild = () => {
    if (!terminationRequested || terminationPromise === null) {
      finish("failed");
      return;
    }
    terminationPromise.then(() => finish("failed"), () => finish("failed"));
  };
  const armTimer = () => {
    if (settled || timer !== null) return;
    timer = setTimeout(() => {
      requestTermination();
    }, timeoutMilliseconds);
    timer.unref?.();
  };
  const invocation = platform === "win32"
    ? buildClaudeCallbackRunnerInvocation(validateClaudeCallbackRunner(runner), command)
    : { command: "/bin/sh", args: ["-c", command] };
  try {
    child = spawnCommand(invocation.command, invocation.args, {
      env,
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
      windowsHide: platform === "win32",
    });
  } catch {
    finish("failed");
  }
  if (child) {
    child.on("error", failChild);
    child.stdout.on("error", failChild);
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.from(chunk);
      if (buffer.byteLength > MAX_COEXISTING_OUTPUT_BYTES - outputBytes) {
        buffer.fill(0);
        requestTermination();
        return;
      }
      outputBytes += buffer.byteLength;
      outputChunks.push(buffer);
    });
    child.on("close", (code) => {
      if (terminationRequested) {
        if (terminationPromise === null) finish("failed");
        return;
      }
      finish(code === 0 ? "ok" : "failed");
    });
    child.stdin.on("error", () => { acceptingInput = false; });
  }
  return Object.freeze({
    present: true,
    async write(chunk) {
      if (!acceptingInput || settled) return;
      let accepted;
      try {
        accepted = child.stdin.write(chunk);
      } catch {
        acceptingInput = false;
        return;
      }
      if (accepted) return;
      await new Promise((resolve) => {
        const done = () => {
          child.stdin.off("drain", done);
          child.stdin.off("error", done);
          resolve();
        };
        child.stdin.once("drain", done);
        child.stdin.once("error", done);
        result.then(done);
      });
    },
    end() {
      if (!acceptingInput || settled) return;
      acceptingInput = false;
      try { child.stdin.end(); } catch { /* The result/timeout owns failure handling. */ }
      armTimer();
    },
    result,
  });
}

async function readMonitorInputAndReplay(readable, invocation, maxBytes) {
  const chunks = [];
  let bytes = 0;
  let failure = null;
  try {
    for await (const chunk of readable) {
      if (!Buffer.isBuffer(chunk) && typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
        failure ??= new ClaudeStatuslineError("input_read");
        break;
      }
      await invocation.write(chunk);
      if (failure) continue;
      const chunkBytes = Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
        ? chunk.byteLength
        : Buffer.byteLength(chunk, "utf8");
      if (chunkBytes > maxBytes - bytes) {
        failure = new ClaudeStatuslineError("input_too_large");
        for (const retained of chunks) retained.fill(0);
        chunks.length = 0;
        bytes = 0;
        if (!invocation.present) break;
        continue;
      }
      const retained = Buffer.from(chunk);
      chunks.push(retained);
      bytes += retained.byteLength;
    }
  } catch (error) {
    failure = error instanceof ClaudeStatuslineError
      ? error
      : new ClaudeStatuslineError("input_read");
  } finally {
    invocation.end();
  }
  if (failure) {
    for (const retained of chunks) retained.fill(0);
    throw failure;
  }
  if (bytes === 0) throw new ClaudeStatuslineError("input_empty");
  const result = Buffer.concat(chunks, bytes);
  for (const retained of chunks) retained.fill(0);
  return result;
}

function safeErrorCode(error) {
  return typeof error?.code === "string" && /^[a-z0-9_]+$/.test(error.code)
    ? error.code
    : "claude_callback_internal";
}

async function writeWithBackpressure(stream, value) {
  if (!value) return;
  const accepted = stream.write(value);
  if (accepted !== false) return;
  if (typeof stream.once !== "function") throw new ClaudeStatuslineError("output_write");
  await new Promise((resolve, reject) => {
    let settled = false;
    const remove = typeof stream.off === "function"
      ? (event, listener) => stream.off(event, listener)
      : typeof stream.removeListener === "function"
        ? (event, listener) => stream.removeListener(event, listener)
        : () => {};
    const cleanup = () => {
      remove("drain", onDrain);
      remove("error", onError);
      remove("close", onClose);
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onDrain = () => finish(resolve);
    const onError = () => finish(() => reject(new ClaudeStatuslineError("output_write")));
    const onClose = () => finish(() => reject(new ClaudeStatuslineError("output_write")));
    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

async function writeCombinedStatus(stdout, previousOutput, monitorOutput) {
  const segments = [previousOutput.trimEnd(), monitorOutput.trimEnd()].filter(Boolean);
  await writeWithBackpressure(stdout, `${segments.join(" · ")}\n`);
}

export async function runClaudeCallback({
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  stateDirectory,
  lifecycleDirectory,
  backend,
  readRuntimeConfiguration = readClaudeCallbackRuntimeConfiguration,
  capturedAt = new Date().toISOString(),
  spawnCommand = spawn,
  platform = process.platform,
} = {}) {
  const configuration = await readRuntimeConfiguration({
    lifecycleDirectory,
    platform,
    environment: env,
  });
  const previous = createCoexistingInvocation(configuration.previousCommand, {
    spawnCommand,
    env,
    platform,
    runner: configuration.previousRunner ?? null,
  });
  let input = null;
  let secret = null;
  let secretForCapture = null;
  const monitorOutput = new PassThrough();
  const monitorChunks = [];
  monitorOutput.on("data", (chunk) => monitorChunks.push(Buffer.from(chunk)));
  try {
    input = await readMonitorInputAndReplay(stdin, previous, DEFAULT_MAX_CLAUDE_STATUS_INPUT_BYTES);
    const selectedBackend = backend === undefined ? createProductionClaudeCallbackBackend() : backend;
    secret = await readClaudeCallbackCapability({ backend: selectedBackend });
    if (secret === null) missingCapability();
    secretForCapture = Buffer.from(secret);
    const snapshot = await runClaudeStatusline({
      stdin: Readable.from([input]),
      stdout: monitorOutput,
      env,
      stateDirectory,
      capturedAt,
      loadSessionSecret: async () => secretForCapture,
    });
    const previousResult = await previous.result;
    await writeCombinedStatus(
      stdout,
      previousResult.status === "ok" ? previousResult.output : "",
      Buffer.concat(monitorChunks).toString("utf8"),
    );
    return snapshot;
  } catch (error) {
    // A supported prior command receives the complete stream independently of
    // the monitor's 64 KiB allocation bound. If it completes, preserve its
    // exact output and exit successfully so Claude keeps displaying it.
    const previousResult = await previous.result;
    if (previous.present && previousResult.status === "ok") {
      await writeWithBackpressure(stdout, previousResult.output);
      await writeWithBackpressure(stderr, `Claude monitor unavailable [${safeErrorCode(error)}]\n`);
      return { status: "existing_status_only", monitorErrorCode: safeErrorCode(error) };
    }
    throw error;
  } finally {
    input?.fill(0);
    secretForCapture?.fill(0);
    secret?.fill(0);
  }
}

async function main() {
  await runClaudeCallback();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = safeErrorCode(error);
    console.error(`Claude limits unavailable [${code}]`);
    process.exitCode = 1;
  });
}
