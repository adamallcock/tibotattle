import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
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
const BLACKHOLE_CREATE_DIAGNOSTIC_CHILD = process.env
  .USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_BLACKHOLE_CREATE_DIAGNOSTIC_CHILD === "1";
const NESTED_CONTEXT_CHILD = process.env.USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_NESTED_CONTEXT_CHILD
  === "1";
const NATIVE_TEST_PREREQUISITES = process.platform === "linux"
  && process.arch === "x64"
  && process.env.TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED === "1"
  && process.env.USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_NATIVE_TEST === "1";
const NATIVE_TEST_ENABLED = NATIVE_TEST_PREREQUISITES && !BLACKHOLE_CHILD;
const BLACKHOLE_CHILD_ENABLED = NATIVE_TEST_PREREQUISITES && BLACKHOLE_CHILD;
const OPERATION_JOURNAL = "account-observation-operation-5-v1";
const BLACKHOLE_CHILD_DEADLINE_MS = 9_000;
const BLACKHOLE_MINIMUM_DELAY_MS = 4_000;
const BLACKHOLE_CHILD_MAX_OUTPUT_BYTES = 4_096;
const NESTED_CONTEXT_CHILD_DELAY_MS = 175;
const NESTED_CONTEXT_CHILD_MINIMUM_DELAY_MS = 125;
const NESTED_CONTEXT_CHILD_TEST_NAME = "native Linux account-observation nested test child waits";
const BLACKHOLE_AUTH_MAX_BYTES = 4_096;
const BLACKHOLE_AUTH_OK = "OK 0123456789abcdef0123456789abcdef\r\n";
const BLACKHOLE_AUTH_REJECTED = "REJECTED EXTERNAL\r\n";
const BLACKHOLE_AUTH_AGREED_UNIX_FD = "AGREE_UNIX_FD\r\n";
const DBUS_SEND = "/usr/bin/dbus-send";
const DBUS_REPLY_TIMEOUT_MS = 1_000;
const DBUS_MAX_OUTPUT_BYTES = 4_096;
const DEFAULT_COLLECTION_ALIAS = "default";
const SECRET_SERVICE_DESTINATION = "org.freedesktop.secrets";
const SECRET_SERVICE_PATH = "/org/freedesktop/secrets";
const SECRET_SERVICE_READ_ALIAS = "org.freedesktop.Secret.Service.ReadAlias";
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
const BLACKHOLE_NATIVE_PHASES = new Set([
  "WATCHDOG",
  "LEASE",
  "READ",
  "DEADLINE",
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

function closedBlackholeNativePhase(error) {
  const phase = closedNativeUnavailablePhase(error);
  return BLACKHOLE_NATIVE_PHASES.has(phase) ? phase : "OTHER";
}

function extractBlackholeNativePhase(chunks, totalBytes, overflow) {
  let output = null;
  try {
    if (overflow || !Number.isSafeInteger(totalBytes) || totalBytes < 0) return "OTHER";
    output = Buffer.concat(chunks, totalBytes);
    const markers = output.toString("utf8").split(/\r?\n/u).filter((line) => (
      /^# LINUX_ACCOUNT_OBSERVATION_BLACKHOLE_NATIVE_(WATCHDOG|LEASE|READ|DEADLINE|OTHER)$/u
        .test(line)
    ));
    if (markers.length !== 1) return "OTHER";
    const phase = markers[0].slice("# LINUX_ACCOUNT_OBSERVATION_BLACKHOLE_NATIVE_".length);
    return BLACKHOLE_NATIVE_PHASES.has(phase) || phase === "OTHER" ? phase : "OTHER";
  } catch {
    return "OTHER";
  } finally {
    if (output !== null) output.fill(0);
    for (const chunk of chunks) chunk.fill(0);
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

test("native account-observation blackhole child diagnostics accept one closed phase only", () => {
  const accepted = Buffer.from("# LINUX_ACCOUNT_OBSERVATION_BLACKHOLE_NATIVE_DEADLINE\n");
  assert.equal(extractBlackholeNativePhase([accepted], accepted.byteLength, false), "DEADLINE");
  assert.equal(accepted.every((byte) => byte === 0), true);

  const repeated = Buffer.from([
    "# LINUX_ACCOUNT_OBSERVATION_BLACKHOLE_NATIVE_LEASE",
    "# LINUX_ACCOUNT_OBSERVATION_BLACKHOLE_NATIVE_READ",
    "",
  ].join("\n"));
  assert.equal(extractBlackholeNativePhase([repeated], repeated.byteLength, false), "OTHER");
  assert.equal(repeated.every((byte) => byte === 0), true);

  const overflowed = Buffer.from("# LINUX_ACCOUNT_OBSERVATION_BLACKHOLE_NATIVE_READ\n");
  assert.equal(extractBlackholeNativePhase([overflowed], overflowed.byteLength, true), "OTHER");
  assert.equal(overflowed.every((byte) => byte === 0), true);
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

function handleBlackholeAuthentication(socket, state, chunk) {
  if (state.messagePhase || !Buffer.isBuffer(chunk) || chunk.byteLength === 0) return;
  if (state.pending.byteLength + chunk.byteLength > BLACKHOLE_AUTH_MAX_BYTES) {
    state.pending.fill(0);
    state.pending = Buffer.alloc(0);
    socket.destroy();
    return;
  }
  const previous = state.pending;
  state.pending = Buffer.concat([previous, chunk]);
  previous.fill(0);
  while (!state.messagePhase) {
    const lineEnd = state.pending.indexOf("\r\n", 0, "ascii");
    if (lineEnd < 0) return;
    const line = state.pending.subarray(0, lineEnd).toString("ascii");
    const remaining = Buffer.from(state.pending.subarray(lineEnd + 2));
    state.pending.fill(0);
    state.pending = remaining;
    const command = line.startsWith("\0") ? line.slice(1) : line;
    if (command.startsWith("AUTH EXTERNAL")) {
      socket.write(BLACKHOLE_AUTH_OK);
      continue;
    }
    if (command === "AUTH" || command.startsWith("AUTH ") || command === "CANCEL") {
      socket.write(BLACKHOLE_AUTH_REJECTED);
      continue;
    }
    if (command === "NEGOTIATE_UNIX_FD") {
      socket.write(BLACKHOLE_AUTH_AGREED_UNIX_FD);
      continue;
    }
    if (command === "BEGIN") {
      state.messagePhase = true;
      state.pending.fill(0);
      state.pending = Buffer.alloc(0);
      socket.pause();
      return;
    }
    socket.destroy();
    return;
  }
}

// Complete only the fixed D-Bus authentication exchange. Once the client has
// entered its binary message phase, this local synthetic endpoint never
// responds, so the child must settle through the native aggregate deadline.
async function startBlackholeSessionBus(socketPath) {
  const sockets = new Set();
  let reachedMessagePhase = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    const state = { messagePhase: false, pending: Buffer.alloc(0) };
    socket.on("close", () => {
      state.pending.fill(0);
      state.pending = Buffer.alloc(0);
      sockets.delete(socket);
    });
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      handleBlackholeAuthentication(socket, state, chunk);
      if (state.messagePhase) reachedMessagePhase = true;
    });
  });
  await new Promise((resolve, reject) => {
    const fail = (error) => {
      server.off("listening", ready);
      reject(error);
    };
    const ready = () => {
      server.off("error", fail);
      resolve();
    };
    server.once("error", fail);
    server.once("listening", ready);
    server.listen(socketPath);
  });
  server.on("error", () => {});
  return {
    reachedMessagePhase: () => reachedMessagePhase,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function createIsolatedTestChildEnvironment(overrides) {
  const environment = { ...process.env, ...overrides };
  // A nested `node --test` process must initialize its own runner context.
  // Inheriting the parent context makes Node report an immediate success before
  // the selected child test runs.
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

async function runBlackholeChild({ stateBase, sessionBusAddress, createDiagnostic = false }) {
  const childEnvironment = {
    DBUS_SESSION_BUS_ADDRESS: sessionBusAddress,
    USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_BLACKHOLE_CHILD: "1",
    XDG_STATE_HOME: stateBase,
  };
  if (createDiagnostic) {
    childEnvironment.USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_BLACKHOLE_CREATE_DIAGNOSTIC_CHILD = "1";
  }
  const child = spawn(
    process.execPath,
    ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)],
    {
      cwd: process.cwd(),
      env: createIsolatedTestChildEnvironment(childEnvironment),
      shell: false,
      stdio: createDiagnostic ? ["ignore", "pipe", "ignore"] : "ignore",
    },
  );
  const outputChunks = [];
  let outputBytes = 0;
  let outputOverflow = false;
  if (createDiagnostic) {
    child.stdout?.on("data", (chunk) => {
      if (outputOverflow || !Buffer.isBuffer(chunk)) {
        outputOverflow = true;
        return;
      }
      if (outputBytes + chunk.byteLength > BLACKHOLE_CHILD_MAX_OUTPUT_BYTES) {
        outputOverflow = true;
        return;
      }
      const copy = Buffer.from(chunk);
      outputChunks.push(copy);
      outputBytes += copy.byteLength;
    });
  }
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
    nativePhase: createDiagnostic
      ? extractBlackholeNativePhase(outputChunks, outputBytes, outputOverflow)
      : null,
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
}, async (t) => {
  const backend = createLinuxAccountObservationCredentialBackend();
  if (!BLACKHOLE_CREATE_DIAGNOSTIC_CHILD) {
    await assert.rejects(
      backend.read(EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation),
      nativeError("unavailable"),
    );
    return;
  }

  // This second child runs only after the original fixed read proof has
  // failed. Its create preflight shares the native read boundary and exposes
  // the existing closed create phase. The synthetic endpoint never replies;
  // the parent separately rejects any retained intent.
  const candidate = Buffer.alloc(32, 73);
  let error = null;
  try {
    await backend.createIfMissing(
      EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation,
      candidate,
    );
  } catch (caught) {
    error = caught;
  } finally {
    candidate.fill(0);
  }
  t.diagnostic(`LINUX_ACCOUNT_OBSERVATION_BLACKHOLE_NATIVE_${closedBlackholeNativePhase(error)}`);
  assert.equal(nativeError("unavailable")(error), true);
});

test("native Linux account-observation credential refuses an absent retained intent before creation, creates once, and reconciles only a matching digest intent", {
  skip: !NATIVE_TEST_ENABLED,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-linux-account-observation-"));
  const absentStateBase = join(root, "absent-state");
  const successStateBase = join(root, "success-state");
  const interruptedStateBase = join(root, "interrupted-state");
  const blackholeStateBase = join(root, "blackhole-state");
  const blackholeDiagnosticStateBase = join(root, "blackhole-diagnostic-state");
  const blackholeSocket = join(root, "blackhole-session-bus.sock");
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

  // The native deadline is exercised through a closed child invocation with a
  // local D-Bus socket that accepts connections but never replies. This does
  // not contact a real account service or expose secret material.
  t.diagnostic("LINUX_ACCOUNT_OBSERVATION_PHASE_SERVICE_DEADLINE");
  const blackholePaths = await prepareOwnerPrivateState(blackholeStateBase);
  const blackholeBus = await startBlackholeSessionBus(blackholeSocket);
  try {
    const blackholeChild = await runBlackholeChild({
      stateBase: blackholeStateBase,
      sessionBusAddress: `unix:path=${blackholeSocket}`,
    });
    const readDeadlineProved = blackholeChild.outcome.signal === null
      && blackholeChild.outcome.code === 0
      && blackholeChild.elapsedMs >= BLACKHOLE_MINIMUM_DELAY_MS
      && blackholeChild.elapsedMs < BLACKHOLE_CHILD_DEADLINE_MS
      && blackholeBus.reachedMessagePhase();
    if (!readDeadlineProved && blackholeChild.elapsedMs < BLACKHOLE_MINIMUM_DELAY_MS) {
      const blackholeDiagnosticPaths = await prepareOwnerPrivateState(
        blackholeDiagnosticStateBase,
      );
      const diagnosticChild = await runBlackholeChild({
        stateBase: blackholeDiagnosticStateBase,
        sessionBusAddress: `unix:path=${blackholeSocket}`,
        createDiagnostic: true,
      });
      t.diagnostic(
        `LINUX_ACCOUNT_OBSERVATION_PHASE_SERVICE_DEADLINE_NATIVE_${diagnosticChild.nativePhase}`,
      );
      await assertMissing(blackholeDiagnosticPaths.operationJournal);
      try {
        assert.equal(
          await readFile(blackholeDiagnosticPaths.legacyJournal, "utf8"),
          "linux-credential-mutex-journal-v1:normal\n",
        );
      } catch (error) {
        // A LEASE boundary fails before it can create the fixed v1 journal.
        assert.equal(error?.code, "ENOENT");
      }
    }
    assert.equal(blackholeChild.outcome.signal, null);
    assert.equal(blackholeChild.outcome.code, 0);
    assert.ok(blackholeChild.elapsedMs >= BLACKHOLE_MINIMUM_DELAY_MS);
    assert.ok(blackholeChild.elapsedMs < BLACKHOLE_CHILD_DEADLINE_MS);
    assert.equal(blackholeBus.reachedMessagePhase(), true);
  } finally {
    await blackholeBus.close();
  }
  await assertMissing(blackholePaths.operationJournal);
  assert.equal(
    await readFile(blackholePaths.legacyJournal, "utf8"),
    "linux-credential-mutex-journal-v1:normal\n",
  );

  // The wrapper accepts this marker only with a zero exit and its exact TAP
  // comment form, so a skipped or partial test cannot become a passing receipt.
  console.log("LINUX_ACCOUNT_OBSERVATION_NATIVE_PASSED");
});
