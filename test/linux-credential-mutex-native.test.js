import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "../src/platform/export-identity-keychain.js";
import {
  createLinuxCredentialMutationLeaseContext,
  createLinuxCredentialMutationMutexContext,
  LinuxCredentialMutationLeaseError,
} from "../src/platform/linux-credential-mutation-lease.js";
import {
  loadLinuxCredentialMutexBinding,
} from "../src/platform/linux-credential-mutex.js";

const CHILD = fileURLToPath(new URL(
  "./fixtures/linux-credential-mutex-child.mjs",
  import.meta.url,
));
const NATIVE_TEST_ENABLED = process.platform === "linux"
  && process.arch === "x64"
  && process.env.USAGE_MONITOR_LINUX_CREDENTIAL_MUTEX_NATIVE_TEST === "1";

function runChild(mode, capabilityId, environment) {
  return spawnSync(process.execPath, [CHILD, mode, String(capabilityId)], {
    encoding: "utf8",
    timeout: 15_000,
    env: environment,
    windowsHide: true,
  });
}

async function ownerOnlyDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function startHolder(capabilityId, environment) {
  const child = spawn(process.execPath, [CHILD, "hold", String(capabilityId)], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("native credential mutex holder did not report readiness"));
    }, 10_000);
    function finish(callback) {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      callback();
    }
    function onError(error) {
      finish(() => reject(error));
    }
    function onExit(code, signal) {
      finish(() => reject(new Error(
        `native credential mutex holder exited before readiness: ${code}/${signal}`,
      )));
    }
    function onData() {
      if (stdout === "LINUX_CREDENTIAL_MUTEX_CHILD_MARKED\n") {
        finish(resolve);
      }
    }
    child.on("error", onError);
    child.on("exit", onExit);
    child.stdout.on("data", onData);
  });
  return { child, stderr: () => stderr, stdout: () => stdout };
}

async function killHolder(holder) {
  if (holder.child.exitCode !== null || holder.child.signalCode !== null) return;
  const exited = once(holder.child, "exit");
  assert.equal(holder.child.kill("SIGKILL"), true);
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
  assert.equal(holder.stdout(), "LINUX_CREDENTIAL_MUTEX_CHILD_MARKED\n");
  assert.equal(holder.stderr(), "");
}

test("native Linux mutex uses a socket primary lease, preserves crash state, and refuses replacement journals", {
  skip: !NATIVE_TEST_ENABLED,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-linux-credential-mutex-"));
  const stateBase = join(root, "state");
  const runtimeOne = join(root, "runtime-one");
  const runtimeTwo = join(root, "runtime-two");
  const previousState = process.env.XDG_STATE_HOME;
  const previousRuntime = process.env.XDG_RUNTIME_DIR;
  let holder = null;
  t.after(async () => {
    if (holder !== null) await killHolder(holder);
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntime;
    await rm(root, { recursive: true, force: true });
  });

  await Promise.all([
    ownerOnlyDirectory(stateBase),
    ownerOnlyDirectory(runtimeOne),
    ownerOnlyDirectory(runtimeTwo),
  ]);
  process.env.XDG_STATE_HOME = stateBase;
  process.env.XDG_RUNTIME_DIR = runtimeOne;

  const binding = loadLinuxCredentialMutexBinding();
  const first = binding.acquireCredentialMutex(0);
  assert.deepEqual(Object.keys(first).sort(), ["abandoned", "lease"]);
  assert.equal(Object.keys(first.lease).length, 0);
  assert.equal(first.abandoned, false);
  assert.throws(
    () => binding.releaseCredentialMutex(Object.create(null)),
    (error) => error?.code === "LINUX_CREDENTIAL_MUTEX_FOREIGN",
  );

  // The primary socket authority is independent of a fresh XDG runtime
  // namespace, so a replacement of a legacy runtime lock pathname cannot
  // split the active lease.
  const replacedRuntimeDirectory = join(
    runtimeTwo,
    "app-usagemonitor",
    "linux-credential-mutex-v1",
  );
  await ownerOnlyDirectory(replacedRuntimeDirectory);
  const replacedRuntimePath = join(replacedRuntimeDirectory, "lock-0-v1");
  await writeFile(replacedRuntimePath, "foreign runtime bytes\n", { mode: 0o600 });
  await chmod(replacedRuntimePath, 0o600);
  const contended = runChild("once", 0, {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeTwo,
  });
  assert.equal(contended.status, 2);
  assert.equal(contended.stdout.trim(), "LINUX_CREDENTIAL_MUTEX_CHILD_CONTENDED");
  assert.equal(contended.stderr, "");
  binding.releaseCredentialMutex(first.lease);
  assert.equal(await readFile(replacedRuntimePath, "utf8"), "foreign runtime bytes\n");
  assert.throws(
    () => binding.releaseCredentialMutex(first.lease),
    (error) => error?.code === "LINUX_CREDENTIAL_MUTEX_FOREIGN",
  );
  const normalAgain = binding.acquireCredentialMutex(0);
  assert.equal(normalAgain.abandoned, false);
  binding.releaseCredentialMutex(normalAgain.lease);

  // Slot four is private to the fixed accountless methods. The inherited
  // generic lease surface remains exactly the four legacy FD4 capabilities.
  assert.throws(
    () => binding.acquireCredentialMutex(4),
    (error) => error?.code === "LINUX_CREDENTIAL_MUTEX_INVALID_CAPABILITY",
  );
  const accountlessDirectory = join(
    stateBase,
    "app-usagemonitor",
    "linux-accountless-installation-credential-v1",
  );
  // This failure occurs before the accountless mutation marker. Restoring the
  // owner-only directory must leave the installation eligible to create its
  // first identity rather than pinning a recovery state.
  assert.equal(binding.readAccountlessInstallationCredential(), null);
  await chmod(accountlessDirectory, 0o500);
  assert.throws(
    () => binding.createAccountlessInstallationCredentialIfMissing(Buffer.alloc(32, 90)),
    (error) => error?.code === "LINUX_ACCOUNTLESS_CREDENTIAL_UNAVAILABLE",
  );
  await chmod(accountlessDirectory, 0o700);
  const accountless = Buffer.alloc(32, 91);
  assert.equal(
    binding.createAccountlessInstallationCredentialIfMissing(accountless),
    "created",
  );
  const storedAccountless = binding.readAccountlessInstallationCredential();
  assert.deepEqual(storedAccountless, accountless);
  storedAccountless.fill(0);
  assert.equal(
    binding.createAccountlessInstallationCredentialIfMissing(Buffer.alloc(32, 92)),
    "existing",
  );
  assert.equal(
    binding.deleteAccountlessInstallationCredentialExact(Buffer.alloc(32, 93)),
    "mismatch",
  );
  assert.equal(
    binding.deleteAccountlessInstallationCredentialExact(accountless),
    "deleted",
  );
  assert.equal(binding.readAccountlessInstallationCredential(), null);
  accountless.fill(0);

  const accountlessRecordPath = join(
    stateBase,
    "app-usagemonitor",
    "linux-accountless-installation-credential-v1",
    "accountless-installation-credential-v1",
  );
  // Opening an attacker-controlled FIFO for read must not block the main
  // process before its fixed-file validation. Keep this unsafe fixture under
  // a separate state root because its expected recovery latch must persist.
  const fifoStateBase = join(root, "fifo-state");
  const fifoAccountlessDirectory = join(
    fifoStateBase,
    "app-usagemonitor",
    "linux-accountless-installation-credential-v1",
  );
  const fifoRecordPath = join(
    fifoAccountlessDirectory,
    "accountless-installation-credential-v1",
  );
  await ownerOnlyDirectory(fifoStateBase);
  await ownerOnlyDirectory(join(fifoStateBase, "app-usagemonitor"));
  await ownerOnlyDirectory(fifoAccountlessDirectory);
  const madeFifo = spawnSync("mkfifo", [fifoRecordPath], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(madeFifo.status, 0);
  assert.equal(madeFifo.signal, null);
  assert.equal(madeFifo.stderr, "");
  await chmod(fifoRecordPath, 0o600);
  const fifoRecovery = runChild("accountless-read", 0, {
    ...process.env,
    XDG_STATE_HOME: fifoStateBase,
  });
  assert.equal(fifoRecovery.error, undefined);
  assert.equal(fifoRecovery.signal, null);
  assert.equal(fifoRecovery.status, 0);
  assert.equal(
    fifoRecovery.stdout,
    "LINUX_ACCOUNTLESS_CREDENTIAL_CHILD_READ_RECOVERY_REQUIRED\n",
  );
  assert.equal(fifoRecovery.stderr, "");

  await writeFile(accountlessRecordPath, Buffer.alloc(31, 4), { mode: 0o600 });
  await chmod(accountlessRecordPath, 0o600);
  assert.throws(
    () => binding.readAccountlessInstallationCredential(),
    (error) => error?.code === "LINUX_ACCOUNTLESS_CREDENTIAL_RECOVERY_REQUIRED",
  );
  await rm(accountlessRecordPath);

  // An unsafe fixed record latches recovery before the socket is released.
  // Removing that record outside an explicit recovery workflow cannot reopen
  // create or read in a fresh process.
  const removedRecordRead = runChild("accountless-read", 0, process.env);
  assert.equal(removedRecordRead.error, undefined);
  assert.equal(removedRecordRead.signal, null);
  assert.equal(removedRecordRead.status, 0);
  assert.equal(
    removedRecordRead.stdout,
    "LINUX_ACCOUNTLESS_CREDENTIAL_CHILD_READ_RECOVERY_REQUIRED\n",
  );
  assert.equal(removedRecordRead.stderr, "");
  const removedRecordCreate = runChild("accountless-create", 0, process.env);
  assert.equal(removedRecordCreate.error, undefined);
  assert.equal(removedRecordCreate.signal, null);
  assert.equal(removedRecordCreate.status, 0);
  assert.equal(
    removedRecordCreate.stdout,
    "LINUX_ACCOUNTLESS_CREDENTIAL_CHILD_CREATE_RECOVERY_REQUIRED\n",
  );
  assert.equal(removedRecordCreate.stderr, "");

  // Simulate an interrupted private operation after its durable marker. The
  // next process must preserve the fixed recovery path rather than silently
  // minting a new upload identity.
  const interruptedStateBase = join(root, "interrupted-state");
  const interruptedJournalDirectory = join(
    interruptedStateBase,
    "app-usagemonitor",
    "linux-credential-mutex-v1",
  );
  const accountlessJournalPath = join(
    interruptedJournalDirectory,
    "journal-4-v1",
  );
  await ownerOnlyDirectory(interruptedStateBase);
  await ownerOnlyDirectory(join(interruptedStateBase, "app-usagemonitor"));
  await ownerOnlyDirectory(interruptedJournalDirectory);
  await writeFile(
    accountlessJournalPath,
    "linux-credential-mutex-journal-v1:active\n",
    { mode: 0o600 },
  );
  await chmod(accountlessJournalPath, 0o600);
  const interruptedRecovery = runChild("accountless-read", 0, {
    ...process.env,
    XDG_STATE_HOME: interruptedStateBase,
  });
  assert.equal(interruptedRecovery.error, undefined);
  assert.equal(interruptedRecovery.signal, null);
  assert.equal(interruptedRecovery.status, 0);
  assert.equal(
    interruptedRecovery.stdout,
    "LINUX_ACCOUNTLESS_CREDENTIAL_CHILD_READ_RECOVERY_REQUIRED\n",
  );
  assert.equal(interruptedRecovery.stderr, "");

  const leaseContext = createLinuxCredentialMutationLeaseContext({
    mutexContext: createLinuxCredentialMutationMutexContext(),
  });
  await assert.rejects(
    leaseContext.withLease(
      EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation,
      { operation: "replace" },
      async () => {
        throw new Error("synthetic callback failure");
      },
    ),
    /synthetic callback failure/u,
  );
  assert.throws(
    () => leaseContext.acquire(
      EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation,
      { operation: "replace" },
    ),
    (error) => error instanceof LinuxCredentialMutationLeaseError
      && error.code === "linux_credential_mutation_lease_recovery_required",
  );
  leaseContext.close();

  holder = await startHolder(2, process.env);
  await killHolder(holder);

  // A logout/reboot clears the runtime namespace, but not an interrupted
  // transaction journal in the persistent application state tree.
  await rm(runtimeOne, { recursive: true, force: true });
  process.env.XDG_RUNTIME_DIR = runtimeTwo;
  const afterRestart = binding.acquireCredentialMutex(2);
  assert.equal(afterRestart.abandoned, true);
  binding.releaseCredentialMutex(afterRestart.lease);
  const mutexContext = createLinuxCredentialMutationMutexContext();
  assert.throws(
    () => mutexContext.acquire(2),
    (error) => error instanceof LinuxCredentialMutationLeaseError
      && error.code === "linux_credential_mutation_lease_recovery_required",
  );
  const stillMarked = binding.acquireCredentialMutex(2);
  assert.equal(stillMarked.abandoned, true);
  binding.abandonCredentialMutex(stillMarked.lease);

  const replacement = binding.acquireCredentialMutex(3);
  const journalPath = join(
    stateBase,
    "app-usagemonitor",
    "linux-credential-mutex-v1",
    "journal-3-v1",
  );
  await rename(journalPath, `${journalPath}.displaced`);
  await writeFile(journalPath, "foreign journal bytes\n", { mode: 0o600 });
  await chmod(journalPath, 0o600);
  assert.throws(
    () => binding.releaseCredentialMutex(replacement.lease),
    (error) => error?.code === "LINUX_CREDENTIAL_MUTEX_RELEASE_FAILED",
  );
  assert.equal(await readFile(journalPath, "utf8"), "foreign journal bytes\n");
  assert.throws(
    () => binding.acquireCredentialMutex(3),
    (error) => error?.code === "LINUX_CREDENTIAL_MUTEX_STATE_INVALID",
  );
});
