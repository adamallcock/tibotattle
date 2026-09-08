import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
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
const DEFAULT_STATE_TEST_NAME =
  "native Linux credential state bootstrap creates the absent passwd-home default only in the isolated lane";
const DEFAULT_STATE_TEST_SUCCESS_MARKER =
  "LINUX_CREDENTIAL_MUTEX_DEFAULT_STATE_BOOTSTRAP_PASSED";
// The passwd-home fallback must never be exercised against the GitHub runner
// or a developer's real home. Root enables this only for the existing
// network-isolated packaged Docker lane, whose disposable owner-private tmpfs
// is fixed at /home/node and whose XDG_STATE_HOME is intentionally omitted for
// this one first-run check.
const DEFAULT_STATE_TEST_ENABLED = NATIVE_TEST_ENABLED
  && process.env.USAGE_MONITOR_LINUX_CREDENTIAL_MUTEX_DEFAULT_STATE_TEST === "1"
  && process.env.TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED === "1"
  && process.env.XDG_STATE_HOME === undefined
  && process.env.HOME === "/home/node"
  && typeof process.getuid === "function"
  && process.getuid() === 1_000;
const ACCOUNTLESS_OPERATION_JOURNAL = "accountless-operation-4-v2";
const ACCOUNTLESS_CREATE_TEMPORARY = ".accountless-create-4-v2";
const ACCOUNTLESS_DELETE_TEMPORARY = ".accountless-delete-4-v2";
const ACCOUNTLESS_OPERATION_MAGIC = Buffer.from([
  0x54, 0x49, 0x42, 0x4f, 0x54, 0x41, 0x54, 0x54,
  0x4c, 0x45, 0x2d, 0x46, 0x44, 0x33, 0x00, 0x00,
]);
const ACCOUNTLESS_OPERATION_CREATE = 1;
const ACCOUNTLESS_OPERATION_DELETE = 2;

function fixedAccountlessOperationJournal(operation, value) {
  assert.equal(Buffer.isBuffer(value), true);
  assert.equal(value.length, 32);
  const journal = Buffer.alloc(64);
  ACCOUNTLESS_OPERATION_MAGIC.copy(journal, 0);
  journal[16] = 2;
  journal[17] = operation;
  value.copy(journal, 32);
  return journal;
}

function accountlessFixturePaths(stateBase) {
  const applicationDirectory = join(stateBase, "app-usagemonitor");
  const mutexDirectory = join(applicationDirectory, "linux-credential-mutex-v1");
  const credentialDirectory = join(
    applicationDirectory,
    "linux-accountless-installation-credential-v1",
  );
  return {
    applicationDirectory,
    mutexDirectory,
    credentialDirectory,
    legacyJournal: join(mutexDirectory, "journal-4-v1"),
    operationJournal: join(mutexDirectory, ACCOUNTLESS_OPERATION_JOURNAL),
    record: join(credentialDirectory, "accountless-installation-credential-v1"),
    createTemporary: join(credentialDirectory, ACCOUNTLESS_CREATE_TEMPORARY),
    deleteTemporary: join(credentialDirectory, ACCOUNTLESS_DELETE_TEMPORARY),
  };
}

async function prepareFixedAccountlessFixture(binding, stateBase) {
  const paths = accountlessFixturePaths(stateBase);
  await Promise.all([
    ownerOnlyDirectory(stateBase),
    ownerOnlyDirectory(paths.applicationDirectory),
    ownerOnlyDirectory(paths.mutexDirectory),
    ownerOnlyDirectory(paths.credentialDirectory),
  ]);
  process.env.XDG_STATE_HOME = stateBase;
  assert.equal(binding.readAccountlessInstallationCredential(), null);
  assert.equal(
    await readFile(paths.legacyJournal, "utf8"),
    "linux-credential-mutex-journal-v1:normal\n",
  );
  return paths;
}

async function writeOwnerOnlyFile(path, bytes) {
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, 0o600);
}

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

async function assertOwnerOnlyDirectory(path) {
  const metadata = await stat(path);
  assert.equal(metadata.isDirectory(), true);
  assert.equal(metadata.mode & 0o777, 0o700);
}

async function assertMissing(path) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
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

test("native Linux accountless v2 journal replays only modeled fixed-record states", {
  skip: !NATIVE_TEST_ENABLED,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-linux-accountless-v2-"));
  const previousState = process.env.XDG_STATE_HOME;
  t.after(async () => {
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    await rm(root, { recursive: true, force: true });
  });

  const binding = loadLinuxCredentialMutexBinding();

  async function fixture(name) {
    return prepareFixedAccountlessFixture(binding, join(root, name, "state"));
  }

  async function assertFixedRecoveryRefusal(paths) {
    assert.throws(
      () => binding.readAccountlessInstallationCredential(),
      (error) => error?.code === "LINUX_ACCOUNTLESS_CREDENTIAL_RECOVERY_REQUIRED",
    );
    assert.equal(
      await readFile(paths.legacyJournal, "utf8"),
      "linux-credential-mutex-journal-v1:active\n",
    );
  }

  async function assertCreateReplay(name, stage) {
    const paths = await fixture(name);
    const candidate = Buffer.alloc(32, 0x41 + stage.length);
    const journal = fixedAccountlessOperationJournal(
      ACCOUNTLESS_OPERATION_CREATE,
      candidate,
    );
    await writeOwnerOnlyFile(paths.operationJournal, journal);
    journal.fill(0);
    if (stage === "temporary") {
      await writeOwnerOnlyFile(paths.createTemporary, candidate);
    } else if (stage === "published") {
      await writeOwnerOnlyFile(paths.record, candidate);
    } else {
      assert.equal(stage, "prepared");
    }
    const recovered = binding.readAccountlessInstallationCredential();
    assert.deepEqual(recovered, candidate);
    recovered.fill(0);
    assert.deepEqual(await readFile(paths.record), candidate);
    await Promise.all([
      assertMissing(paths.operationJournal),
      assertMissing(paths.createTemporary),
      assertMissing(paths.deleteTemporary),
    ]);
    candidate.fill(0);
  }

  async function assertDeleteReplay(name, stage) {
    const paths = await fixture(name);
    const expected = Buffer.alloc(32, 0x61 + stage.length);
    const journal = fixedAccountlessOperationJournal(
      ACCOUNTLESS_OPERATION_DELETE,
      expected,
    );
    await writeOwnerOnlyFile(paths.operationJournal, journal);
    journal.fill(0);
    if (stage === "before-rename") {
      await writeOwnerOnlyFile(paths.record, expected);
    } else if (stage === "after-rename") {
      await writeOwnerOnlyFile(paths.deleteTemporary, expected);
    } else {
      assert.equal(stage, "after-unlink");
    }
    assert.equal(binding.readAccountlessInstallationCredential(), null);
    await Promise.all([
      assertMissing(paths.operationJournal),
      assertMissing(paths.record),
      assertMissing(paths.createTemporary),
      assertMissing(paths.deleteTemporary),
    ]);
    expected.fill(0);
  }

  await t.test("replays create before temporary creation", async () => {
    await assertCreateReplay("create-prepared", "prepared");
  });
  await t.test("replays create after temporary creation", async () => {
    await assertCreateReplay("create-temporary", "temporary");
  });
  await t.test("settles create after publication", async () => {
    await assertCreateReplay("create-published", "published");
  });
  await t.test("replays delete before rename", async () => {
    await assertDeleteReplay("delete-before-rename", "before-rename");
  });
  await t.test("replays delete after rename", async () => {
    await assertDeleteReplay("delete-after-rename", "after-rename");
  });
  await t.test("settles delete after unlink", async () => {
    await assertDeleteReplay("delete-after-unlink", "after-unlink");
  });

  await t.test("refuses either orphaned fixed residue without a v2 intent", async () => {
    for (const [name, property] of [
      ["orphan-create", "createTemporary"],
      ["orphan-delete", "deleteTemporary"],
    ]) {
      const paths = await fixture(name);
      const residue = Buffer.alloc(32, name.length);
      await writeOwnerOnlyFile(paths[property], residue);
      assert.throws(
        () => binding.readAccountlessInstallationCredential(),
        (error) => error?.code === "LINUX_ACCOUNTLESS_CREDENTIAL_RECOVERY_REQUIRED",
      );
      assert.equal(
        await readFile(paths.legacyJournal, "utf8"),
        "linux-credential-mutex-journal-v1:active\n",
      );
      assert.deepEqual(await readFile(paths[property]), residue);
      residue.fill(0);
    }
  });

  await t.test("retains mismatched or cross-operation v2 state for refusal", async () => {
    const mismatch = await fixture("mismatched-v2");
    const intended = Buffer.alloc(32, 0x7a);
    const foreign = Buffer.alloc(32, 0x7b);
    const mismatchJournal = fixedAccountlessOperationJournal(
      ACCOUNTLESS_OPERATION_CREATE,
      intended,
    );
    await writeOwnerOnlyFile(mismatch.operationJournal, mismatchJournal);
    await writeOwnerOnlyFile(mismatch.record, foreign);
    assert.throws(
      () => binding.readAccountlessInstallationCredential(),
      (error) => error?.code === "LINUX_ACCOUNTLESS_CREDENTIAL_RECOVERY_REQUIRED",
    );
    assert.deepEqual(await readFile(mismatch.operationJournal), mismatchJournal);
    assert.equal(
      await readFile(mismatch.legacyJournal, "utf8"),
      "linux-credential-mutex-journal-v1:active\n",
    );
    mismatchJournal.fill(0);
    intended.fill(0);
    foreign.fill(0);

    const crossOperation = await fixture("cross-operation-v2");
    const candidate = Buffer.alloc(32, 0x7c);
    const crossJournal = fixedAccountlessOperationJournal(
      ACCOUNTLESS_OPERATION_CREATE,
      candidate,
    );
    await writeOwnerOnlyFile(crossOperation.operationJournal, crossJournal);
    await writeOwnerOnlyFile(crossOperation.deleteTemporary, candidate);
    assert.throws(
      () => binding.readAccountlessInstallationCredential(),
      (error) => error?.code === "LINUX_ACCOUNTLESS_CREDENTIAL_RECOVERY_REQUIRED",
    );
    assert.deepEqual(await readFile(crossOperation.operationJournal), crossJournal);
    assert.equal(
      await readFile(crossOperation.legacyJournal, "utf8"),
      "linux-credential-mutex-journal-v1:active\n",
    );
    crossJournal.fill(0);
    candidate.fill(0);
  });

  await t.test("refuses malformed v2 intent without clearing it", async () => {
    const paths = await fixture("malformed-v2");
    const malformed = Buffer.alloc(64);
    ACCOUNTLESS_OPERATION_MAGIC.copy(malformed, 0);
    malformed[16] = 2;
    malformed[17] = ACCOUNTLESS_OPERATION_CREATE;
    malformed[18] = 1;
    await writeOwnerOnlyFile(paths.operationJournal, malformed);
    assert.throws(
      () => binding.readAccountlessInstallationCredential(),
      (error) => error?.code === "LINUX_ACCOUNTLESS_CREDENTIAL_RECOVERY_REQUIRED",
    );
    assert.deepEqual(await readFile(paths.operationJournal), malformed);
    assert.equal(
      await readFile(paths.legacyJournal, "utf8"),
      "linux-credential-mutex-journal-v1:active\n",
    );
    malformed.fill(0);
  });

  await t.test("refuses torn or noncanonical v2 journal bytes without clearing them", async () => {
    const seed = Buffer.alloc(32, 0x65);
    const canonical = fixedAccountlessOperationJournal(
      ACCOUNTLESS_OPERATION_CREATE,
      seed,
    );
    const cases = [
      ["truncated", Buffer.from(canonical.subarray(0, 63))],
      ["extra-byte", Buffer.concat([canonical, Buffer.from([0])])],
      ["bad-version", Buffer.from(canonical)],
      ["reserved", Buffer.from(canonical)],
    ];
    cases[2][1][16] = 3;
    cases[3][1][31] = 1;
    for (const [name, bytes] of cases) {
      const paths = await fixture(`journal-${name}`);
      await writeOwnerOnlyFile(paths.operationJournal, bytes);
      await assertFixedRecoveryRefusal(paths);
      assert.deepEqual(await readFile(paths.operationJournal), bytes);
      bytes.fill(0);
    }
    canonical.fill(0);
    seed.fill(0);
  });

  await t.test("refuses unsafe v2 journal inode and mode states without clearing evidence", async () => {
    const seed = Buffer.alloc(32, 0x66);
    const canonical = fixedAccountlessOperationJournal(
      ACCOUNTLESS_OPERATION_CREATE,
      seed,
    );

    const modePaths = await fixture("journal-mode");
    await writeOwnerOnlyFile(modePaths.operationJournal, canonical);
    await chmod(modePaths.operationJournal, 0o640);
    await assertFixedRecoveryRefusal(modePaths);
    assert.equal((await stat(modePaths.operationJournal)).mode & 0o777, 0o640);

    const hardLinkPaths = await fixture("journal-hard-link");
    await writeOwnerOnlyFile(hardLinkPaths.operationJournal, canonical);
    const hardLinkPath = join(hardLinkPaths.mutexDirectory, "operation-journal-linked");
    await link(hardLinkPaths.operationJournal, hardLinkPath);
    await assertFixedRecoveryRefusal(hardLinkPaths);
    assert.equal((await stat(hardLinkPaths.operationJournal)).nlink, 2);
    assert.deepEqual(await readFile(hardLinkPaths.operationJournal), canonical);

    const symlinkPaths = await fixture("journal-symlink");
    const target = join(symlinkPaths.mutexDirectory, "operation-journal-target");
    await writeOwnerOnlyFile(target, canonical);
    await symlink(target, symlinkPaths.operationJournal);
    await assertFixedRecoveryRefusal(symlinkPaths);
    assert.equal((await lstat(symlinkPaths.operationJournal)).isSymbolicLink(), true);
    assert.deepEqual(await readFile(target), canonical);

    canonical.fill(0);
    seed.fill(0);
  });

  await t.test("refuses malformed or unsafe fixed residue without an intent", async () => {
    const malformedPaths = await fixture("residue-malformed");
    const malformed = Buffer.alloc(31, 0x67);
    await writeOwnerOnlyFile(malformedPaths.createTemporary, malformed);
    await assertFixedRecoveryRefusal(malformedPaths);
    assert.deepEqual(await readFile(malformedPaths.createTemporary), malformed);
    malformed.fill(0);

    const modePaths = await fixture("residue-mode");
    const unsafeMode = Buffer.alloc(32, 0x68);
    await writeOwnerOnlyFile(modePaths.deleteTemporary, unsafeMode);
    await chmod(modePaths.deleteTemporary, 0o640);
    await assertFixedRecoveryRefusal(modePaths);
    assert.equal((await stat(modePaths.deleteTemporary)).mode & 0o777, 0o640);
    assert.deepEqual(await readFile(modePaths.deleteTemporary), unsafeMode);
    unsafeMode.fill(0);
  });

  await t.test("refuses later access after modeled settlement uncertainty", async () => {
    const paths = await fixture("settlement-uncertain");
    const finalValue = Buffer.alloc(32, 0x7d);
    // Model the only safe observable postcondition after v2 unlink succeeded
    // but its directory fsync or descriptor close was uncertain: no v2 name,
    // an exact final record, and the retained legacy refusal marker. This does
    // not claim a process-kill or power-loss simulation.
    await writeOwnerOnlyFile(paths.record, finalValue);
    await writeOwnerOnlyFile(
      paths.legacyJournal,
      "linux-credential-mutex-journal-v1:active\n",
    );
    await assertMissing(paths.operationJournal);
    assert.throws(
      () => binding.readAccountlessInstallationCredential(),
      (error) => error?.code === "LINUX_ACCOUNTLESS_CREDENTIAL_RECOVERY_REQUIRED",
    );
    assert.deepEqual(await readFile(paths.record), finalValue);
    assert.equal(
      await readFile(paths.legacyJournal, "utf8"),
      "linux-credential-mutex-journal-v1:active\n",
    );
    finalValue.fill(0);
  });
});

test("native Linux credential state bootstrap creates only fixed absent paths and refuses unsafe state", {
  skip: !NATIVE_TEST_ENABLED,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-linux-credential-state-"));
  const previousState = process.env.XDG_STATE_HOME;
  const previousHome = process.env.HOME;
  t.after(async () => {
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });

  const binding = loadLinuxCredentialMutexBinding();
  const configuredState = join(root, "configured-state");
  const configuredApplication = join(configuredState, "app-usagemonitor");
  const configuredMutex = join(configuredApplication, "linux-credential-mutex-v1");
  const configuredAccountless = join(
    configuredApplication,
    "linux-accountless-installation-credential-v1",
  );
  process.env.XDG_STATE_HOME = configuredState;
  process.env.HOME = join(root, "injected-home-must-not-be-used");
  assert.equal(binding.prepareLinuxCredentialState(), undefined);
  await Promise.all([
    assertOwnerOnlyDirectory(configuredState),
    assertOwnerOnlyDirectory(configuredApplication),
    assertOwnerOnlyDirectory(configuredMutex),
    assertOwnerOnlyDirectory(configuredAccountless),
    assertMissing(join(configuredMutex, "journal-0-v1")),
    assertMissing(join(configuredAccountless, "accountless-installation-credential-v1")),
    assertMissing(process.env.HOME),
  ]);
  // A safe, already-complete root is only reopened and revalidated.
  assert.equal(binding.prepareLinuxCredentialState(), undefined);
  assert.throws(
    () => binding.prepareLinuxCredentialState("caller-selected-path"),
    (error) => error?.code === "LINUX_CREDENTIAL_MUTEX_STATE_INVALID",
  );

  // A previous interruption may leave an owner-private base and application
  // directory but no fixed descendants. A later call must reopen and complete
  // only the absent descendants; it does not create a journal or record.
  const partialState = join(root, "partial-state");
  const partialApplication = join(partialState, "app-usagemonitor");
  await ownerOnlyDirectory(partialApplication);
  process.env.XDG_STATE_HOME = partialState;
  assert.equal(binding.prepareLinuxCredentialState(), undefined);
  await Promise.all([
    assertOwnerOnlyDirectory(join(partialApplication, "linux-credential-mutex-v1")),
    assertOwnerOnlyDirectory(join(
      partialApplication,
      "linux-accountless-installation-credential-v1",
    )),
  ]);

  // A configured base may be created only under its safe, existing direct
  // parent. It never recursively invents arbitrary missing ancestors.
  const missingParentState = join(root, "missing-parent", "state");
  process.env.XDG_STATE_HOME = missingParentState;
  assert.throws(
    () => binding.prepareLinuxCredentialState(),
    (error) => error?.code === "LINUX_CREDENTIAL_MUTEX_STATE_UNAVAILABLE",
  );
  await assertMissing(join(root, "missing-parent"));

  // An existing configured base still requires its direct parent to be safe;
  // preparation must not use a private leaf to bypass a replaceable parent.
  const unsafeParent = join(root, "unsafe-direct-parent");
  const unsafeParentBase = join(unsafeParent, "existing-state");
  await ownerOnlyDirectory(unsafeParentBase);
  await chmod(unsafeParent, 0o777);
  process.env.XDG_STATE_HOME = unsafeParentBase;
  assert.throws(
    () => binding.prepareLinuxCredentialState(),
    (error) => error?.code === "LINUX_CREDENTIAL_MUTEX_STATE_UNAVAILABLE",
  );
  await assertMissing(join(unsafeParentBase, "app-usagemonitor"));

  // An unsafe existing base is refused without repairing its mode or creating
  // application-owned descendants beneath it.
  const unsafeBase = join(root, "unsafe-base-state");
  await ownerOnlyDirectory(unsafeBase);
  await chmod(unsafeBase, 0o777);
  process.env.XDG_STATE_HOME = unsafeBase;
  assert.throws(
    () => binding.prepareLinuxCredentialState(),
    (error) => error?.code === "LINUX_CREDENTIAL_MUTEX_STATE_UNAVAILABLE",
  );
  assert.equal((await stat(unsafeBase)).mode & 0o777, 0o777);
  await assertMissing(join(unsafeBase, "app-usagemonitor"));

  // Preflight both fixed descendants before mutation. An unsafe mutex sibling
  // must leave the otherwise absent accountless sibling absent and unchanged.
  const unsafeState = join(root, "unsafe-existing-state");
  const unsafeApplication = join(unsafeState, "app-usagemonitor");
  const unsafeMutex = join(unsafeApplication, "linux-credential-mutex-v1");
  const unsafeAccountless = join(
    unsafeApplication,
    "linux-accountless-installation-credential-v1",
  );
  await ownerOnlyDirectory(unsafeMutex);
  await chmod(unsafeMutex, 0o755);
  process.env.XDG_STATE_HOME = unsafeState;
  assert.throws(
    () => binding.prepareLinuxCredentialState(),
    (error) => error?.code === "LINUX_CREDENTIAL_MUTEX_STATE_INVALID",
  );
  assert.equal((await stat(unsafeMutex)).mode & 0o777, 0o755);
  await assertMissing(unsafeAccountless);

  // A no-symlink root check must reject a link before it can create its fixed
  // descendants in the link target.
  const symlinkTarget = join(root, "symlink-target");
  const symlinkState = join(root, "state-link");
  await ownerOnlyDirectory(symlinkTarget);
  await symlink(symlinkTarget, symlinkState, "dir");
  process.env.XDG_STATE_HOME = symlinkState;
  assert.throws(
    () => binding.prepareLinuxCredentialState(),
    (error) => error?.code === "LINUX_CREDENTIAL_MUTEX_STATE_UNAVAILABLE",
  );
  await assertMissing(join(symlinkTarget, "app-usagemonitor"));

  // A privileged Linux qualification runner can also prove foreign-owner
  // refusal directly. Unprivileged runners retain the source-contract check
  // for OwnerUid and avoid changing any real account-owned state.
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    const foreignState = join(root, "foreign-owner-state");
    await ownerOnlyDirectory(foreignState);
    await chown(foreignState, 1, 1);
    process.env.XDG_STATE_HOME = foreignState;
    assert.throws(
      () => binding.prepareLinuxCredentialState(),
      (error) => error?.code === "LINUX_CREDENTIAL_MUTEX_STATE_UNAVAILABLE",
    );
    await assertMissing(join(foreignState, "app-usagemonitor"));
  }
});

test("native Linux credential state bootstrap fails closed for an owner-bit-masking child umask", {
  skip: !NATIVE_TEST_ENABLED,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-linux-credential-umask-"));
  const stateBase = join(root, "state");
  const application = join(stateBase, "app-usagemonitor");
  const mutexJournal = join(
    application,
    "linux-credential-mutex-v1",
    "journal-0-v1",
  );
  const accountlessRecord = join(
    application,
    "linux-accountless-installation-credential-v1",
    "accountless-installation-credential-v1",
  );
  t.after(async () => {
    // The partial directory is intentionally never chmod-repaired. It is
    // empty, so removing it only needs access to the owned parent directory.
    try {
      await rmdir(stateBase);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rm(root, { recursive: true, force: true });
  });

  const child = runChild("prepare-owner-masked-umask", 0, {
    ...process.env,
    XDG_STATE_HOME: stateBase,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0);
  assert.equal(
    child.stdout,
    "LINUX_CREDENTIAL_MUTEX_CHILD_OWNER_MASKED_UMASK_REFUSED\n",
  );
  assert.equal(child.stderr, "");

  // The child retries under a compatible umask. The synthetic base remains
  // unsafe and unchanged, and no credential operation or durable journal can
  // have started before this state-root refusal.
  const metadata = await stat(stateBase);
  assert.equal(metadata.isDirectory(), true);
  assert.equal(metadata.mode & 0o777, 0o500);
  await Promise.all([
    assertMissing(application),
    assertMissing(mutexJournal),
    assertMissing(accountlessRecord),
  ]);
});

test("a skipped default-state native test cannot emit success evidence", () => {
  const environment = { ...process.env };
  delete environment.USAGE_MONITOR_LINUX_CREDENTIAL_MUTEX_DEFAULT_STATE_TEST;
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "--test",
    "--test-reporter=tap",
    `--test-name-pattern=^${DEFAULT_STATE_TEST_NAME}$`,
    fileURLToPath(import.meta.url),
  ], {
    encoding: "utf8",
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /# SKIP/u);
  assert.equal(
    result.stdout.split(/\r?\n/u)
      .filter((line) => line === `# ${DEFAULT_STATE_TEST_SUCCESS_MARKER}`).length,
    0,
  );
});

test(DEFAULT_STATE_TEST_NAME, {
  skip: !DEFAULT_STATE_TEST_ENABLED,
}, async () => {
  const localDirectory = "/home/node/.local";
  const stateBase = "/home/node/.local/state";
  const application = join(stateBase, "app-usagemonitor");
  const injectedHome = "/home/node/injected-home-must-not-be-used";
  const previousHome = process.env.HOME;
  await assertMissing(localDirectory);
  await assertMissing(stateBase);
  process.env.HOME = injectedHome;
  try {
    const binding = loadLinuxCredentialMutexBinding();
    assert.equal(binding.prepareLinuxCredentialState(), undefined);
    await Promise.all([
      assertOwnerOnlyDirectory(localDirectory),
      assertOwnerOnlyDirectory(stateBase),
      assertOwnerOnlyDirectory(application),
      assertOwnerOnlyDirectory(join(application, "linux-credential-mutex-v1")),
      assertOwnerOnlyDirectory(join(
        application,
        "linux-accountless-installation-credential-v1",
      )),
      assertMissing(injectedHome),
      assertMissing(join(application, "linux-credential-mutex-v1", "journal-0-v1")),
      assertMissing(join(
        application,
        "linux-accountless-installation-credential-v1",
        "accountless-installation-credential-v1",
      )),
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  process.stdout.write(`${DEFAULT_STATE_TEST_SUCCESS_MARKER}\n`);
});
