import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
const NATIVE_TEST_PREREQUISITES = process.platform === "linux"
  && process.arch === "x64"
  && process.env.TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED === "1"
  && process.env.USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_NATIVE_TEST === "1";
const NATIVE_TEST_ENABLED = NATIVE_TEST_PREREQUISITES && !BLACKHOLE_CHILD;
const BLACKHOLE_CHILD_ENABLED = NATIVE_TEST_PREREQUISITES && BLACKHOLE_CHILD;
const OPERATION_JOURNAL = "account-observation-operation-5-v1";
const BLACKHOLE_CHILD_DEADLINE_MS = 9_000;
const BLACKHOLE_MINIMUM_DELAY_MS = 4_000;
const CREATE_DIAGNOSTIC_PHASES = new Set([
  "CREATE_PRECHECK",
  "CREATE_MUTATION",
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
    testContext.diagnostic(
      `LINUX_ACCOUNT_OBSERVATION_PHASE_${phase}_${closedObservationDiagnosticSuffix(error)}`,
    );
    throw error;
  }
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
    "LINUX_ACCOUNT_OBSERVATION_PHASE_CREATE_MUTATION_RECOVERY_REQUIRED",
    "LINUX_ACCOUNT_OBSERVATION_PHASE_CREATE_MUTATION",
    "LINUX_ACCOUNT_OBSERVATION_PHASE_CREATE_MUTATION_OTHER",
  ]);
  assert.equal(diagnostics.join("\n").includes("synthetic private native detail"), false);
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

async function startBlackholeSessionBus(socketPath) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    // A D-Bus client can connect and start authentication, but this fixed
    // fixture intentionally never responds. The child must settle through the
    // native aggregate cancellation deadline rather than an outer test kill.
    socket.resume();
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
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
  };
}

async function runBlackholeChild({ stateBase, sessionBusAddress }) {
  const child = spawn(
    process.execPath,
    ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DBUS_SESSION_BUS_ADDRESS: sessionBusAddress,
        USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_BLACKHOLE_CHILD: "1",
        XDG_STATE_HOME: stateBase,
      },
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
  assert.equal(outcome.signal, null);
  assert.equal(outcome.code, 0);
  assert.ok(elapsedMs >= BLACKHOLE_MINIMUM_DELAY_MS);
  assert.ok(elapsedMs < BLACKHOLE_CHILD_DEADLINE_MS);
}

test("native Linux account-observation child maps an unresponsive D-Bus service to unavailable", {
  skip: !BLACKHOLE_CHILD_ENABLED,
}, async () => {
  const backend = createLinuxAccountObservationCredentialBackend();
  await assert.rejects(
    backend.read(EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation),
    nativeError("unavailable"),
  );
});

test("native Linux account-observation credential refuses an absent retained intent before creation, creates once, and reconciles only a matching digest intent", {
  skip: !NATIVE_TEST_ENABLED,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-linux-account-observation-"));
  const absentStateBase = join(root, "absent-state");
  const successStateBase = join(root, "success-state");
  const interruptedStateBase = join(root, "interrupted-state");
  const blackholeStateBase = join(root, "blackhole-state");
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
  const closeBlackholeBus = await startBlackholeSessionBus(blackholeSocket);
  try {
    await runBlackholeChild({
      stateBase: blackholeStateBase,
      sessionBusAddress: `unix:path=${blackholeSocket}`,
    });
  } finally {
    await closeBlackholeBus();
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
