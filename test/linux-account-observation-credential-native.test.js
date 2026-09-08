import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "../src/platform/keychain-capabilities.js";
import {
  createLinuxAccountObservationCredentialBackend,
  LinuxAccountObservationCredentialError,
  isLinuxAccountObservationCredentialError,
} from "../src/platform/linux-account-observation-credential.js";

const BLACKHOLE_CHILD = process.env.USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_BLACKHOLE_CHILD
  === "1";
const BLACKHOLE_PRIVATE_BUS_CHILD = process.env
  .USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_BLACKHOLE_PRIVATE_BUS_CHILD === "1";
const NESTED_CONTEXT_CHILD = process.env.USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_NESTED_CONTEXT_CHILD
  === "1";
const NATIVE_TEST_PREREQUISITES = process.platform === "linux"
  && process.arch === "x64"
  && process.env.TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED === "1"
  && process.env.USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_NATIVE_TEST === "1";
const NATIVE_TEST_ENABLED = NATIVE_TEST_PREREQUISITES && !BLACKHOLE_CHILD;
const BLACKHOLE_CHILD_ENABLED = NATIVE_TEST_PREREQUISITES
  && BLACKHOLE_CHILD
  && BLACKHOLE_PRIVATE_BUS_CHILD;
const OPERATION_JOURNAL = "account-observation-operation-5-v1";
const BLACKHOLE_CHILD_DEADLINE_MS = 9_000;
const BLACKHOLE_MINIMUM_DELAY_MS = 4_000;
const BLACKHOLE_TOOL_READY_TIMEOUT_MS = 1_000;
const BLACKHOLE_TOOL_CLEANUP_TIMEOUT_MS = 1_000;
const NESTED_CONTEXT_CHILD_DELAY_MS = 175;
const NESTED_CONTEXT_CHILD_MINIMUM_DELAY_MS = 125;
const NESTED_CONTEXT_CHILD_TEST_NAME = "native Linux account-observation nested test child waits";
const DBUS_SEND = "/usr/bin/dbus-send";
const DBUS_RUN_SESSION = "/usr/bin/dbus-run-session";
const DBUS_TEST_TOOL = "/usr/bin/dbus-test-tool";
const DBUS_REPLY_TIMEOUT_MS = 1_000;
const DBUS_MAX_OUTPUT_BYTES = 4_096;
const DEFAULT_COLLECTION_ALIAS = "default";
const SECRET_SERVICE_DESTINATION = "org.freedesktop.secrets";
const SECRET_SERVICE_PATH = "/org/freedesktop/secrets";
const SECRET_SERVICE_READ_ALIAS = "org.freedesktop.Secret.Service.ReadAlias";
const DBUS_DESTINATION = "org.freedesktop.DBus";
const DBUS_PATH = "/org/freedesktop/DBus";
const DBUS_GET_CONNECTION_UNIX_PROCESS_ID = "org.freedesktop.DBus.GetConnectionUnixProcessID";
const DBUS_PROPERTIES_GET = "org.freedesktop.DBus.Properties.Get";
const SECRET_COLLECTION_INTERFACE = "org.freedesktop.Secret.Collection";
const COLLECTION_PATH = /^\/org\/freedesktop\/secrets\/collection\/[A-Za-z_][A-Za-z0-9_]*$/u;
const CREATE_DIAGNOSTIC_PHASES = new Set([
  "CREATE_PRECHECK",
  "CREATE_NATIVE_READ",
  "CREATE_MUTATION",
]);
const CREATE_NATIVE_UNAVAILABLE_PHASES = new Set([
  "WATCHDOG",
  "LEASE",
  "READ",
  "DEADLINE",
  "COLLECTION_PRE_CANCELLED",
  "COLLECTION_ERROR_GIO_CANCELLED",
  "COLLECTION_ERROR_GIO_TIMED_OUT",
  "COLLECTION_ERROR_GIO_NOT_FOUND",
  "COLLECTION_ERROR_GIO_PERMISSION_DENIED",
  "COLLECTION_ERROR_GIO_INVALID_ARGUMENT",
  "COLLECTION_ERROR_GIO_NOT_INITIALIZED",
  "COLLECTION_ERROR_GIO_NOT_SUPPORTED",
  "COLLECTION_ERROR_GIO_CLOSED",
  "COLLECTION_ERROR_GIO_DBUS",
  "COLLECTION_ERROR_GIO_OTHER",
  "COLLECTION_ERROR_DBUS_SERVICE_UNKNOWN",
  "COLLECTION_ERROR_DBUS_NO_OWNER",
  "COLLECTION_ERROR_DBUS_NO_REPLY",
  "COLLECTION_ERROR_DBUS_ACCESS_DENIED",
  "COLLECTION_ERROR_DBUS_AUTH_FAILED",
  "COLLECTION_ERROR_DBUS_TIMEOUT",
  "COLLECTION_ERROR_DBUS_DISCONNECTED",
  "COLLECTION_ERROR_DBUS_INVALID_ARGUMENT",
  "COLLECTION_ERROR_DBUS_NOT_SUPPORTED",
  "COLLECTION_ERROR_DBUS_NOT_FOUND",
  "COLLECTION_ERROR_DBUS_OTHER",
  "COLLECTION_ERROR_OTHER",
  "COLLECTION_NULL",
  "COLLECTION_LOCKED",
  "COLLECTION_POST_CANCELLED",
]);
const OPERATION_MAGIC = Buffer.from([
  0x54, 0x49, 0x42, 0x4f, 0x54, 0x41, 0x54, 0x54,
  0x4c, 0x45, 0x2d, 0x46, 0x44, 0x34, 0x00, 0x00,
]);

function operationJournal(value) {
  assert.equal(Buffer.isBuffer(value), true);
  assert.equal(value.byteLength, 32);
  const journal = Buffer.alloc(64);
  OPERATION_MAGIC.copy(journal, 0);
  journal[16] = 1;
  journal[17] = 1;
  createHash("sha256").update(value).digest().copy(journal, 32);
  return journal;
}

function fixturePaths(stateBase) {
  const applicationDirectory = join(stateBase, "app-usagemonitor");
  const mutexDirectory = join(applicationDirectory, "linux-credential-mutex-v1");
  return {
    applicationDirectory,
    mutexDirectory,
    legacyJournal: join(mutexDirectory, "journal-5-v1"),
    operationJournal: join(mutexDirectory, OPERATION_JOURNAL),
  };
}

async function ownerOnlyDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function writeOwnerOnlyFile(path, bytes) {
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function prepareOwnerPrivateState(stateBase) {
  const paths = fixturePaths(stateBase);
  await ownerOnlyDirectory(stateBase);
  await ownerOnlyDirectory(paths.applicationDirectory);
  await ownerOnlyDirectory(paths.mutexDirectory);
  return paths;
}

function equalSecret(actual, expected) {
  assert.equal(Buffer.isBuffer(actual), true);
  assert.equal(actual.byteLength, 32);
  assert.equal(Buffer.compare(actual, expected), 0);
}

function nativeError(code) {
  return (error) => {
    assert.equal(error instanceof LinuxAccountObservationCredentialError, true);
    assert.equal(error.code, `linux_account_observation_credential_${code}`);
    assert.equal(error.message, "Linux account observation credential backend failed");
    return true;
  };
}

function closedObservationDiagnosticSuffix(error) {
  if (!isLinuxAccountObservationCredentialError(error)) return "OTHER";
  if (error.code === "linux_account_observation_credential_unavailable") {
    return "UNAVAILABLE";
  }
  if (error.code === "linux_account_observation_credential_recovery_required") {
    return "RECOVERY_REQUIRED";
  }
  return "OTHER";
}

function closedNativeUnavailablePhase(error) {
  if (!isLinuxAccountObservationCredentialError(error)
      || error.code !== "linux_account_observation_credential_unavailable") {
    return null;
  }
  try {
    const phase = error.qualificationPhase;
    return CREATE_NATIVE_UNAVAILABLE_PHASES.has(phase) ? phase : null;
  } catch {
    return null;
  }
}

async function runClosedObservationDiagnosticPhase(testContext, phase, operation) {
  if (!CREATE_DIAGNOSTIC_PHASES.has(phase)) {
    throw new TypeError("Unknown closed account-observation diagnostic phase");
  }
  testContext.diagnostic(`LINUX_ACCOUNT_OBSERVATION_PHASE_${phase}`);
  try {
    return await operation();
  } catch (error) {
    // Keep the runner receipt content-free while preserving the fixed facade
    // outcome that follows this exact native boundary.
    const suffix = closedObservationDiagnosticSuffix(error);
    testContext.diagnostic(`LINUX_ACCOUNT_OBSERVATION_PHASE_${phase}_${suffix}`);
    const nativePhase = phase === "CREATE_MUTATION" && suffix === "UNAVAILABLE"
      ? closedNativeUnavailablePhase(error)
      : null;
    if (nativePhase !== null) {
      testContext.diagnostic(
        `LINUX_ACCOUNT_OBSERVATION_PHASE_${phase}_NATIVE_${nativePhase}_UNAVAILABLE`,
      );
    }
    throw error;
  }
}

function fixedDbusReply(argumentsList, spawnCommand = spawnSync) {
  let result;
  try {
    result = spawnCommand(DBUS_SEND, argumentsList, {
      encoding: "utf8",
      maxBuffer: DBUS_MAX_OUTPUT_BYTES,
      timeout: DBUS_REPLY_TIMEOUT_MS,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return null;
  }
  try {
    return result?.error === undefined
      && result.signal === null
      && result.status === 0
      && typeof result.stdout === "string"
      ? result.stdout
      : null;
  } catch {
    return null;
  }
}

function exactlyOneOutputMatch(output, expression) {
  if (typeof output !== "string") return null;
  const matches = [...output.matchAll(expression)];
  return matches.length === 1 ? matches[0] : null;
}

function secretServiceOwnerProcessId({ spawnCommand = spawnSync } = {}) {
  const output = fixedDbusReply([
    "--session",
    "--print-reply",
    `--reply-timeout=${DBUS_REPLY_TIMEOUT_MS}`,
    `--dest=${DBUS_DESTINATION}`,
    DBUS_PATH,
    DBUS_GET_CONNECTION_UNIX_PROCESS_ID,
    `string:${SECRET_SERVICE_DESTINATION}`,
  ], spawnCommand);
  const match = exactlyOneOutputMatch(output, /^\s*uint32\s+([1-9]\d*)\s*$/gmu);
  if (match === null) return null;
  const processId = Number(match[1]);
  return Number.isSafeInteger(processId) && processId >= 2 ? processId : null;
}

function wait(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function blackholeToolHasExited(tool) {
  return tool !== null
    && typeof tool === "object"
    && ((tool.exitCode !== null && tool.exitCode !== undefined)
      || (tool.signalCode !== null && tool.signalCode !== undefined));
}

async function waitForBlackholeToolExit(tool, timeoutMs) {
  if (tool === null || typeof tool !== "object") return false;
  if (blackholeToolHasExited(tool)) return true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tool.off("close", closed);
      tool.off("error", failed);
      resolve(result);
    };
    const closed = () => finish(true);
    const failed = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    tool.once("close", closed);
    tool.once("error", failed);
  });
}

async function stopPrivateBlackholeTool(tool) {
  if (tool === null || typeof tool !== "object") return false;
  if (await waitForBlackholeToolExit(tool, 0)) return true;
  try {
    if (tool.kill("SIGTERM") === false && !blackholeToolHasExited(tool)) return false;
  } catch {
    return false;
  }
  if (await waitForBlackholeToolExit(tool, BLACKHOLE_TOOL_CLEANUP_TIMEOUT_MS)) return true;
  try {
    if (tool.kill("SIGKILL") === false && !blackholeToolHasExited(tool)) return false;
  } catch {
    return false;
  }
  return waitForBlackholeToolExit(tool, BLACKHOLE_TOOL_CLEANUP_TIMEOUT_MS);
}

async function startPrivateBlackholeTool({
  spawnTool = spawn,
  ownerProcessId = secretServiceOwnerProcessId,
} = {}) {
  let tool;
  try {
    tool = spawnTool(
      DBUS_TEST_TOOL,
      ["black-hole", "--session", `--name=${SECRET_SERVICE_DESTINATION}`],
      {
        env: process.env,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      },
    );
  } catch {
    return null;
  }
  tool.on("error", () => {});
  if (!Number.isSafeInteger(tool.pid) || tool.pid < 2) {
    await stopPrivateBlackholeTool(tool);
    return null;
  }
  const deadline = Date.now() + BLACKHOLE_TOOL_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (ownerProcessId() === tool.pid) return tool;
    if (blackholeToolHasExited(tool)) break;
    await wait(25);
  }
  await stopPrivateBlackholeTool(tool);
  return null;
}

// Qualification-only probe: it calls the fixed Secret Service alias/property
// reads without asking the daemon to unlock, create, replace, or delete
// anything. Its closed state tells the native test whether a later pre-intent
// refusal is caused by the default collection rather than by record mutation.
function defaultCollectionState({ spawnCommand = spawnSync } = {}) {
  const alias = fixedDbusReply([
    "--session",
    "--print-reply",
    `--reply-timeout=${DBUS_REPLY_TIMEOUT_MS}`,
    `--dest=${SECRET_SERVICE_DESTINATION}`,
    SECRET_SERVICE_PATH,
    SECRET_SERVICE_READ_ALIAS,
    `string:${DEFAULT_COLLECTION_ALIAS}`,
  ], spawnCommand);
  if (alias === null) return "UNAVAILABLE";
  const pathMatch = exactlyOneOutputMatch(alias, /^\s*object path "([^"]+)"\s*$/gmu);
  if (pathMatch === null) return "INVALID";
  const collectionPath = pathMatch[1];
  if (collectionPath === "/") return "MISSING";
  if (!COLLECTION_PATH.test(collectionPath)) return "INVALID";

  const locked = fixedDbusReply([
    "--session",
    "--print-reply",
    `--reply-timeout=${DBUS_REPLY_TIMEOUT_MS}`,
    `--dest=${SECRET_SERVICE_DESTINATION}`,
    collectionPath,
    DBUS_PROPERTIES_GET,
    `string:${SECRET_COLLECTION_INTERFACE}`,
    "string:Locked",
  ], spawnCommand);
  if (locked === null) return "UNAVAILABLE";
  const lockedMatch = exactlyOneOutputMatch(
    locked,
    /^\s*variant\s+boolean\s+(true|false)\s*$/gmu,
  );
  if (lockedMatch === null) return "INVALID";
  return lockedMatch[1] === "true" ? "LOCKED" : "READY";
}

test("native account-observation CREATE diagnostics retain only closed facade outcomes", async () => {
  const diagnostics = [];
  const testContext = {
    diagnostic(value) {
      diagnostics.push(value);
    },
  };
  await assert.rejects(
    runClosedObservationDiagnosticPhase(testContext, "CREATE_PRECHECK", async () => {
      throw new LinuxAccountObservationCredentialError("unavailable");
    }),
    nativeError("unavailable"),
  );
  const collectionError = new LinuxAccountObservationCredentialError("unavailable");
  Object.defineProperty(collectionError, "qualificationPhase", {
    configurable: false,
    enumerable: false,
    value: "COLLECTION_NULL",
    writable: false,
  });
  await assert.rejects(
    runClosedObservationDiagnosticPhase(testContext, "CREATE_MUTATION", async () => {
      throw collectionError;
    }),
    nativeError("unavailable"),
  );
  await assert.rejects(
    runClosedObservationDiagnosticPhase(testContext, "CREATE_MUTATION", async () => {
      throw new LinuxAccountObservationCredentialError("recovery_required");
    }),
    nativeError("recovery_required"),
  );
  await assert.rejects(
    runClosedObservationDiagnosticPhase(testContext, "CREATE_MUTATION", async () => {
      throw new Error("synthetic private native detail");
    }),
  );
  await assert.rejects(
    runClosedObservationDiagnosticPhase(testContext, "UNREVIEWED", async () => {}),
    TypeError,
  );
  assert.deepEqual(diagnostics, [
    "LINUX_ACCOUNT_OBSERVATION_PHASE_CREATE_PRECHECK",
    "LINUX_ACCOUNT_OBSERVATION_PHASE_CREATE_PRECHECK_UNAVAILABLE",
    "LINUX_ACCOUNT_OBSERVATION_PHASE_CREATE_MUTATION",
    "LINUX_ACCOUNT_OBSERVATION_PHASE_CREATE_MUTATION_UNAVAILABLE",
    "LINUX_ACCOUNT_OBSERVATION_PHASE_CREATE_MUTATION_NATIVE_COLLECTION_NULL_UNAVAILABLE",
    "LINUX_ACCOUNT_OBSERVATION_PHASE_CREATE_MUTATION",
    "LINUX_ACCOUNT_OBSERVATION_PHASE_CREATE_MUTATION_RECOVERY_REQUIRED",
    "LINUX_ACCOUNT_OBSERVATION_PHASE_CREATE_MUTATION",
    "LINUX_ACCOUNT_OBSERVATION_PHASE_CREATE_MUTATION_OTHER",
  ]);
  assert.equal(diagnostics.join("\n").includes("synthetic private native detail"), false);
});

test("native account-observation default collection probe has only closed non-mutating states", () => {
  const replies = [
    {
      error: undefined,
      signal: null,
      status: 0,
      stdout: "method return\n   object path \"/org/freedesktop/secrets/collection/login\"\n",
    },
    {
      error: undefined,
      signal: null,
      status: 0,
      stdout: "method return\n   variant       boolean false\n",
    },
  ];
  const calls = [];
  const ready = defaultCollectionState({
    spawnCommand(command, argumentsList, options) {
      calls.push({ command, argumentsList, options });
      return replies.shift();
    },
  });
  assert.equal(ready, "READY");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, DBUS_SEND);
  assert.deepEqual(calls[0].argumentsList, [
    "--session",
    "--print-reply",
    "--reply-timeout=1000",
    "--dest=org.freedesktop.secrets",
    "/org/freedesktop/secrets",
    "org.freedesktop.Secret.Service.ReadAlias",
    "string:default",
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, DBUS_REPLY_TIMEOUT_MS);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "ignore"]);
  assert.deepEqual(calls[1].argumentsList, [
    "--session",
    "--print-reply",
    "--reply-timeout=1000",
    "--dest=org.freedesktop.secrets",
    "/org/freedesktop/secrets/collection/login",
    "org.freedesktop.DBus.Properties.Get",
    "string:org.freedesktop.Secret.Collection",
    "string:Locked",
  ]);

  const probe = (reply) => defaultCollectionState({ spawnCommand: () => reply });
  assert.equal(probe({ error: undefined, signal: null, status: 0, stdout: "object path \"/\"\n" }), "MISSING");
  assert.equal(probe({ error: undefined, signal: null, status: 0, stdout: "object path \"/unsafe\"\n" }), "INVALID");
  assert.equal(probe({ error: new Error("fixed synthetic failure"), signal: null, status: null, stdout: "" }), "UNAVAILABLE");
  const lockedReplies = [
    { error: undefined, signal: null, status: 0, stdout: "object path \"/org/freedesktop/secrets/collection/login\"\n" },
    { error: undefined, signal: null, status: 0, stdout: "variant boolean true\n" },
  ];
  assert.equal(defaultCollectionState({ spawnCommand: () => lockedReplies.shift() }), "LOCKED");
});

test("native account-observation blackhole owns only the fixed private bus name", async () => {
  const calls = [];
  const owner = secretServiceOwnerProcessId({
    spawnCommand(command, argumentsList, options) {
      calls.push({ command, argumentsList, options });
      return {
        error: undefined,
        signal: null,
        status: 0,
        stdout: "method return\n   uint32 71\n",
      };
    },
  });
  assert.equal(owner, 71);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, DBUS_SEND);
  assert.deepEqual(calls[0].argumentsList, [
    "--session",
    "--print-reply",
    "--reply-timeout=1000",
    "--dest=org.freedesktop.DBus",
    "/org/freedesktop/DBus",
    "org.freedesktop.DBus.GetConnectionUnixProcessID",
    "string:org.freedesktop.secrets",
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(secretServiceOwnerProcessId({
    spawnCommand: () => ({
      error: undefined,
      signal: null,
      status: 0,
      stdout: "uint32 71\nuint32 72\n",
    }),
  }), null);

  const tool = Object.assign(new EventEmitter(), {
    exitCode: null,
    pid: 71,
    signalCode: null,
    kill(signal) {
      this.signalCode = signal;
      queueMicrotask(() => this.emit("close", null, signal));
      return true;
    },
  });
  const toolCalls = [];
  const started = await startPrivateBlackholeTool({
    spawnTool(command, argumentsList, options) {
      toolCalls.push({ command, argumentsList, options });
      return tool;
    },
    ownerProcessId: () => 71,
  });
  assert.equal(started, tool);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].command, DBUS_TEST_TOOL);
  assert.deepEqual(toolCalls[0].argumentsList, [
    "black-hole",
    "--session",
    "--name=org.freedesktop.secrets",
  ]);
  assert.equal(toolCalls[0].options.env, process.env);
  assert.equal(toolCalls[0].options.shell, false);
  assert.equal(toolCalls[0].options.stdio, "ignore");
  assert.equal(toolCalls[0].options.windowsHide, true);
  assert.equal(await stopPrivateBlackholeTool(tool), true);
  assert.equal(tool.signalCode, "SIGTERM");
});

async function assertMissing(path) {
  try {
    await lstat(path);
  } catch (error) {
    assert.equal(error?.code, "ENOENT");
    return;
  }
  assert.fail("expected fixed native journal to be absent");
}

function createIsolatedTestChildEnvironment(overrides) {
  const environment = { ...process.env, ...overrides };
  // A nested `node --test` process must initialize its own runner context.
  // Inheriting the parent context makes Node report an immediate success before
  // the selected child test runs.
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

async function runBlackholeChild({ stateBase }) {
  const childEnvironment = {
    USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_BLACKHOLE_CHILD: "1",
    USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_BLACKHOLE_PRIVATE_BUS_CHILD: "1",
    XDG_STATE_HOME: stateBase,
  };
  const child = spawn(
    DBUS_RUN_SESSION,
    ["--", process.execPath, "--test", "--test-reporter=tap", fileURLToPath(import.meta.url)],
    {
      cwd: process.cwd(),
      env: createIsolatedTestChildEnvironment(childEnvironment),
      shell: false,
      stdio: "ignore",
    },
  );
  const startedAt = Date.now();
  const outcome = await new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The close handler below reports the bounded child outcome.
      }
      finish({ code: null, signal: "deadline" });
    }, BLACKHOLE_CHILD_DEADLINE_MS);
    child.once("error", () => finish({ code: null, signal: "spawn_error" }));
    child.once("close", (code, signal) => finish({ code, signal }));
  });
  const elapsedMs = Date.now() - startedAt;
  return Object.freeze({
    elapsedMs,
    outcome: Object.freeze(outcome),
  });
}

test(NESTED_CONTEXT_CHILD_TEST_NAME, {
  skip: !NESTED_CONTEXT_CHILD,
}, async () => {
  await new Promise((resolve) => setTimeout(resolve, NESTED_CONTEXT_CHILD_DELAY_MS));
});

test("native Linux account-observation blackhole child clears a parent test context", () => {
  const startedAt = Date.now();
  const child = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      `--test-name-pattern=^${NESTED_CONTEXT_CHILD_TEST_NAME}$`,
      fileURLToPath(import.meta.url),
    ],
    {
      cwd: process.cwd(),
      env: createIsolatedTestChildEnvironment({
        USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_NESTED_CONTEXT_CHILD: "1",
      }),
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: BLACKHOLE_CHILD_DEADLINE_MS,
    },
  );
  const elapsedMs = Date.now() - startedAt;
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0);
  assert.ok(elapsedMs >= NESTED_CONTEXT_CHILD_MINIMUM_DELAY_MS);
  assert.ok(elapsedMs < BLACKHOLE_CHILD_DEADLINE_MS);
});

test("native Linux account-observation child maps an unresponsive D-Bus service to unavailable", {
  skip: !BLACKHOLE_CHILD_ENABLED,
}, async () => {
  // dbus-run-session created this child’s independent bus. The supported test
  // utility takes the exact Secret Service name on that bus and discards the
  // read request, without interacting with the outer qualification daemon.
  const blackholeTool = await startPrivateBlackholeTool();
  assert.notEqual(blackholeTool, null);
  try {
    const backend = createLinuxAccountObservationCredentialBackend();
    await assert.rejects(
      backend.read(EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation),
      nativeError("unavailable"),
    );
  } finally {
    assert.equal(await stopPrivateBlackholeTool(blackholeTool), true);
  }
});

test("native Linux account-observation credential refuses an absent retained intent before creation, creates once, and reconciles only a matching digest intent", {
  skip: !NATIVE_TEST_ENABLED,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-linux-account-observation-"));
  const absentStateBase = join(root, "absent-state");
  const successStateBase = join(root, "success-state");
  const interruptedStateBase = join(root, "interrupted-state");
  const blackholeStateBase = join(root, "blackhole-state");
  const previousState = process.env.XDG_STATE_HOME;
  const absentCandidate = Buffer.alloc(32, 70);
  const first = Buffer.alloc(32, 71);
  const different = Buffer.alloc(32, 72);
  t.after(async () => {
    absentCandidate.fill(0);
    first.fill(0);
    different.fill(0);
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    await rm(root, { recursive: true, force: true });
  });

  const capability = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation;
  const absentPaths = await prepareOwnerPrivateState(absentStateBase);
  process.env.XDG_STATE_HOME = absentStateBase;
  const absentBackend = createLinuxAccountObservationCredentialBackend();

  // This root must observe absence before it receives a valid digest-only
  // intent. The read below cannot recreate the candidate, because that value
  // was deliberately not persisted with the digest.
  t.diagnostic("LINUX_ACCOUNT_OBSERVATION_PHASE_INITIAL_READ");
  assert.equal(await absentBackend.read(capability), null);
  t.diagnostic("LINUX_ACCOUNT_OBSERVATION_PHASE_ABSENT_INTENT");
  let absentIntent = operationJournal(absentCandidate);
  try {
    await writeOwnerOnlyFile(absentPaths.operationJournal, absentIntent);
  } finally {
    absentIntent.fill(0);
  }
  await assert.rejects(absentBackend.read(capability), nativeError("recovery_required"));
  assert.equal(
    await readFile(absentPaths.legacyJournal, "utf8"),
    "linux-credential-mutex-journal-v1:active\n",
  );
  const retainedAbsentIntent = await lstat(absentPaths.operationJournal);
  assert.equal(retainedAbsentIntent.isFile(), true);
  assert.equal(retainedAbsentIntent.mode & 0o777, 0o600);

  // The successful lifecycle uses a distinct owner-private state root. That
  // prevents the retained absent-record intent from being adopted or cleared.
  const paths = await prepareOwnerPrivateState(successStateBase);
  process.env.XDG_STATE_HOME = successStateBase;
  const backend = createLinuxAccountObservationCredentialBackend();

  await runClosedObservationDiagnosticPhase(t, "CREATE_PRECHECK", async () => {
    assert.equal(await backend.read(capability), null);
  });
  await runClosedObservationDiagnosticPhase(t, "CREATE_NATIVE_READ", async () => {
    assert.equal(await backend.read(capability), null);
  });
  t.diagnostic("LINUX_ACCOUNT_OBSERVATION_PHASE_CREATE_COLLECTION");
  const collection = defaultCollectionState();
  t.diagnostic(`LINUX_ACCOUNT_OBSERVATION_PHASE_CREATE_COLLECTION_${collection}`);
  assert.equal(collection, "READY");
  await runClosedObservationDiagnosticPhase(t, "CREATE_MUTATION", async () => {
    assert.equal(await backend.createIfMissing(capability, first), "created");
  });
  t.diagnostic("LINUX_ACCOUNT_OBSERVATION_PHASE_READBACK");
  const stored = await backend.read(capability);
  equalSecret(stored, first);
  stored.fill(0);
  t.diagnostic("LINUX_ACCOUNT_OBSERVATION_PHASE_NO_REPLACE");
  assert.equal(await backend.createIfMissing(capability, different), "existing");
  const retained = await backend.read(capability);
  equalSecret(retained, first);
  retained.fill(0);

  t.diagnostic("LINUX_ACCOUNT_OBSERVATION_PHASE_MATCHING_INTENT");
  let settled = operationJournal(first);
  try {
    await writeOwnerOnlyFile(paths.operationJournal, settled);
  } finally {
    settled.fill(0);
  }
  const reconciled = await backend.read(capability);
  equalSecret(reconciled, first);
  reconciled.fill(0);
  await assertMissing(paths.operationJournal);
  assert.equal(
    await readFile(paths.legacyJournal, "utf8"),
    "linux-credential-mutex-journal-v1:normal\n",
  );

  // Model a crash after recovery removed a matching digest intent and before
  // its final active-to-normal settlement. The durable active fence must keep
  // the exact existing Secret Service record from being silently adopted.
  t.diagnostic("LINUX_ACCOUNT_OBSERVATION_PHASE_INTERRUPTED_REMOVAL");
  const interruptedPaths = await prepareOwnerPrivateState(interruptedStateBase);
  process.env.XDG_STATE_HOME = interruptedStateBase;
  const interruptedBackend = createLinuxAccountObservationCredentialBackend();
  const interruptedObserved = await interruptedBackend.read(capability);
  equalSecret(interruptedObserved, first);
  interruptedObserved.fill(0);
  let interruptedIntent = operationJournal(first);
  try {
    await writeOwnerOnlyFile(interruptedPaths.operationJournal, interruptedIntent);
  } finally {
    interruptedIntent.fill(0);
  }
  const interruptedReconciled = await interruptedBackend.read(capability);
  equalSecret(interruptedReconciled, first);
  interruptedReconciled.fill(0);
  await assertMissing(interruptedPaths.operationJournal);
  assert.equal(
    await readFile(interruptedPaths.legacyJournal, "utf8"),
    "linux-credential-mutex-journal-v1:normal\n",
  );
  let activeJournal = Buffer.from("linux-credential-mutex-journal-v1:active\n");
  try {
    await writeOwnerOnlyFile(interruptedPaths.legacyJournal, activeJournal);
  } finally {
    activeJournal.fill(0);
  }
  // The preceding matching recovery has removed its intent. Replacing only
  // the v1 state with active models an interruption before final settlement.
  await assertMissing(interruptedPaths.operationJournal);
  await assert.rejects(interruptedBackend.read(capability), nativeError("recovery_required"));
  assert.equal(
    await readFile(interruptedPaths.legacyJournal, "utf8"),
    "linux-credential-mutex-journal-v1:active\n",
  );

  process.env.XDG_STATE_HOME = successStateBase;
  t.diagnostic("LINUX_ACCOUNT_OBSERVATION_PHASE_MISMATCHED_INTENT");
  let unresolved = operationJournal(different);
  try {
    await writeOwnerOnlyFile(paths.operationJournal, unresolved);
  } finally {
    unresolved.fill(0);
  }
  await assert.rejects(backend.read(capability), nativeError("recovery_required"));
  assert.equal(
    await readFile(paths.legacyJournal, "utf8"),
    "linux-credential-mutex-journal-v1:active\n",
  );
  const retainedIntent = await lstat(paths.operationJournal);
  assert.equal(retainedIntent.isFile(), true);
  assert.equal(retainedIntent.mode & 0o777, 0o600);

  // The native deadline is exercised through a fresh dbus-run-session child.
  // Its supported black-hole utility owns only the fixed Secret Service name
  // on that private bus and discards the native read request. It does not
  // contact the outer disposable service or a user credential service.
  t.diagnostic("LINUX_ACCOUNT_OBSERVATION_PHASE_SERVICE_DEADLINE");
  const blackholePaths = await prepareOwnerPrivateState(blackholeStateBase);
  const blackholeChild = await runBlackholeChild({ stateBase: blackholeStateBase });
  assert.equal(blackholeChild.outcome.signal, null);
  assert.equal(blackholeChild.outcome.code, 0);
  assert.ok(blackholeChild.elapsedMs >= BLACKHOLE_MINIMUM_DELAY_MS);
  assert.ok(blackholeChild.elapsedMs < BLACKHOLE_CHILD_DEADLINE_MS);
  await assertMissing(blackholePaths.operationJournal);
  assert.equal(
    await readFile(blackholePaths.legacyJournal, "utf8"),
    "linux-credential-mutex-journal-v1:normal\n",
  );

  // The wrapper accepts this marker only with a zero exit and its exact TAP
  // comment form, so a skipped or partial test cannot become a passing receipt.
  console.log("LINUX_ACCOUNT_OBSERVATION_NATIVE_PASSED");
});
