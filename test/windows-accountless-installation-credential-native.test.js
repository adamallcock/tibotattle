import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  link,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createWindowsAccountlessInstallationCredentialBackend,
  WindowsAccountlessInstallationCredentialError,
} from "../src/platform/windows-accountless-installation-credential.js";
import {
  createWindowsFilesystemAdapter,
  loadWindowsFilesystemBinding,
} from "../src/platform/windows-filesystem.js";

const NATIVE_WINDOWS = process.platform === "win32" && process.arch === "x64";
const NATIVE_SKIP = NATIVE_WINDOWS ? false : "native Windows x64 only";
const CHILD = fileURLToPath(new URL(
  "./fixtures/windows-accountless-installation-credential-child.mjs",
  import.meta.url,
));
const RECORD_NAME = "accountless-installation-credential-v1.bin";
const JOURNAL_NAME = ".accountless-installation-credential-v1.journal";
const ACTIVE_JOURNAL = Buffer.from(
  "windows-accountless-installation-credential-v1:active\n",
  "utf8",
);
const SECRET = Buffer.alloc(32, 73);

function accountlessError(code) {
  return (error) => {
    assert.equal(error instanceof WindowsAccountlessInstallationCredentialError, true);
    assert.equal(error.code, `windows_accountless_installation_credential_${code}`);
    assert.equal(error.message, "Windows accountless installation credential backend failed");
    return true;
  };
}

function nativeError(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

function backend(adapter, rootPath) {
  return createWindowsAccountlessInstallationCredentialBackend({
    platform: "win32",
    architecture: "x64",
    adapter,
    rootPath,
  });
}

async function withSyntheticRoot(run) {
  const parent = await mkdtemp(join(tmpdir(), "tibotattle-windows-accountless-native-"));
  const rootPath = join(parent, "private");
  const adapter = createWindowsFilesystemAdapter();
  try {
    return await run({ adapter, parent, rootPath });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function startChild(mode, rootPath) {
  const childArguments = rootPath === undefined ? [CHILD, mode] : [CHILD, mode, rootPath];
  const child = spawn(process.execPath, childArguments, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = once(child, "close").then(([code, signal]) => ({
    code,
    signal,
    stderr,
    stdout,
  }));
  return Object.freeze({ child, closed, output: () => stdout });
}

async function waitForChildLine(child, expected) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.output().includes(`${expected}\n`)) return;
    const result = await Promise.race([
      child.closed.then((value) => ({ closed: value })),
      new Promise((resolve) => setTimeout(resolve, 25, null)),
    ]);
    if (result?.closed) {
      assert.fail(`WINDOWS_ACCOUNTLESS_CREDENTIAL_CHILD_UNEXPECTED_EXIT_${result.closed.code}`);
    }
  }
  assert.fail("WINDOWS_ACCOUNTLESS_CREDENTIAL_CHILD_TIMEOUT");
}

async function releaseChild(child) {
  child.child.stdin.end("release\n");
  const result = await child.closed;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "WINDOWS_ACCOUNTLESS_CREDENTIAL_CHILD_HELD\n");
  assert.equal(result.stderr, "");
}

function injectedAdapter(overrides) {
  const native = loadWindowsFilesystemBinding();
  const binding = Object.create(native);
  Object.assign(binding, overrides(native));
  return createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding,
  });
}

test("native fixed accountless record supports exact lifecycle and opaque lease release", {
  skip: NATIVE_SKIP,
}, () => withSyntheticRoot(async ({ adapter, rootPath }) => {
  const selected = backend(adapter, rootPath);
  assert.deepEqual(Object.keys(selected).sort(), ["createIfMissing", "deleteExact", "read"]);
  assert.equal(await selected.read(), null);
  assert.equal(await selected.createIfMissing(SECRET), "created");
  assert.deepEqual(await selected.read(), SECRET);
  assert.equal(await selected.createIfMissing(Buffer.alloc(32, 21)), "existing");
  assert.equal(await selected.deleteExact(Buffer.alloc(32, 22)), "mismatch");
  assert.equal(await selected.deleteExact(SECRET), "deleted");
  assert.equal(await selected.read(), null);

  const acquired = adapter.acquireAccountlessInstallationCredentialMutex();
  assert.throws(
    () => adapter.releaseAccountlessInstallationCredentialMutex(Object.create(null)),
    nativeError("WINDOWS_FILESYSTEM_ACCOUNTLESS_INSTALLATION_CREDENTIAL_MUTEX_FOREIGN"),
  );
  adapter.releaseAccountlessInstallationCredentialMutex(acquired.lease);
  assert.throws(
    () => adapter.releaseAccountlessInstallationCredentialMutex(acquired.lease),
    nativeError("WINDOWS_FILESYSTEM_ACCOUNTLESS_INSTALLATION_CREDENTIAL_MUTEX_FOREIGN"),
  );
}));

test("native unsafe, reparse, and malformed fixed records durably latch recovery", {
  skip: NATIVE_SKIP,
}, async (t) => {
  await t.test("hard-link record", async () => withSyntheticRoot(async ({ adapter, rootPath }) => {
    const selected = backend(adapter, rootPath);
    await selected.read();
    const source = join(rootPath, "synthetic-accountless-source.bin");
    const record = join(rootPath, RECORD_NAME);
    await writeFile(source, Buffer.alloc(32, 12));
    await link(source, record);
    await assert.rejects(selected.read(), accountlessError("recovery_required"));
    await assert.rejects(backend(adapter, rootPath).createIfMissing(SECRET), accountlessError("recovery_required"));
  }));

  await t.test("reparse-point record", async () => withSyntheticRoot(async ({ adapter, rootPath }) => {
    const selected = backend(adapter, rootPath);
    await selected.read();
    const source = join(rootPath, "synthetic-accountless-source.bin");
    const record = join(rootPath, RECORD_NAME);
    await writeFile(source, Buffer.alloc(32, 13));
    // Qualification must prove this path is refused on the hosted Windows
    // runner; do not skip a missing reparse-point capability.
    await symlink(source, record, "file");
    await assert.rejects(selected.read(), accountlessError("recovery_required"));
    await assert.rejects(backend(adapter, rootPath).createIfMissing(SECRET), accountlessError("recovery_required"));
  }));

  await t.test("malformed record remains latched after external removal", async () => withSyntheticRoot(async ({ adapter, rootPath }) => {
    const selected = backend(adapter, rootPath);
    await selected.read();
    const record = join(rootPath, RECORD_NAME);
    await writeFile(record, Buffer.alloc(31, 14));
    await assert.rejects(selected.read(), accountlessError("recovery_required"));
    await unlink(record);
    await assert.rejects(backend(adapter, rootPath).read(), accountlessError("recovery_required"));
    await assert.rejects(backend(adapter, rootPath).createIfMissing(SECRET), accountlessError("recovery_required"));
  }));
});

test("native post-mutation ambiguity latches while known pre-mutation refusal remains retryable", {
  skip: NATIVE_SKIP,
}, async (t) => {
  await t.test("post-create failure", async () => withSyntheticRoot(async ({ adapter, rootPath }) => {
    const injected = injectedAdapter((native) => {
      const create = native.createProtectedChild.bind(native);
      return {
        createProtectedChild(root, identity, child, data) {
          const result = create(root, identity, child, data);
          if (child === RECORD_NAME) {
            const error = new Error("injected native failure");
            error.code = "WINDOWS_FILESYSTEM_OPERATION_FAILED";
            throw error;
          }
          return result;
        },
      };
    });
    await assert.rejects(
      backend(injected, rootPath).createIfMissing(SECRET),
      accountlessError("recovery_required"),
    );
    await assert.rejects(backend(adapter, rootPath).read(), accountlessError("recovery_required"));
  }));

  await t.test("pre-mutation read failure", async () => withSyntheticRoot(async ({ adapter, rootPath }) => {
    let failRecordRead = true;
    const injected = injectedAdapter((native) => {
      const read = native.readProtectedChild.bind(native);
      return {
        readProtectedChild(root, identity, child, maximumBytes) {
          if (child === RECORD_NAME && failRecordRead) {
            failRecordRead = false;
            const error = new Error("injected native failure");
            error.code = "WINDOWS_FILESYSTEM_OPERATION_FAILED";
            throw error;
          }
          return read(root, identity, child, maximumBytes);
        },
      };
    });
    await assert.rejects(
      backend(injected, rootPath).createIfMissing(SECRET),
      accountlessError("unavailable"),
    );
    assert.equal(await backend(adapter, rootPath).createIfMissing(SECRET), "created");
  }));
});

test("native private mutex serializes a peer and interrupted mutation durably latches recovery", {
  skip: NATIVE_SKIP,
}, () => withSyntheticRoot(async ({ adapter, rootPath }) => {
  const selected = backend(adapter, rootPath);
  const holder = startChild("hold");
  await waitForChildLine(holder, "WINDOWS_ACCOUNTLESS_CREDENTIAL_CHILD_HELD");
  try {
    await assert.rejects(selected.read(), accountlessError("unavailable"));
  } finally {
    await releaseChild(holder);
  }
  assert.equal(await selected.read(), null);

  const interrupted = startChild("interrupt-create", rootPath);
  await waitForChildLine(interrupted, "WINDOWS_ACCOUNTLESS_CREDENTIAL_CHILD_RECORD_PUBLISHED");
  const interruptedResult = await interrupted.closed;
  assert.equal(interruptedResult.code, 17);
  assert.equal(interruptedResult.signal, null);
  assert.equal(
    interruptedResult.stdout,
    "WINDOWS_ACCOUNTLESS_CREDENTIAL_CHILD_RECORD_PUBLISHED\n",
  );
  assert.equal(interruptedResult.stderr, "");
  // The child exits only after the real fixed record has been created, while
  // the durable journal remains active. Recovery therefore does not depend on
  // an ephemeral WAIT_ABANDONED result after the last mutex handle closes.
  assert.deepEqual(await readFile(join(rootPath, RECORD_NAME)), SECRET);
  assert.deepEqual(await readFile(join(rootPath, JOURNAL_NAME)), ACTIVE_JOURNAL);
  await assert.rejects(selected.read(), accountlessError("recovery_required"));
  await assert.rejects(backend(adapter, rootPath).createIfMissing(SECRET), accountlessError("recovery_required"));
}));
