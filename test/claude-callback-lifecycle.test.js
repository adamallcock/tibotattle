import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeCallbackLifecycleError,
  buildManagedClaudeStatusLine,
  inspectClaudeCallbackLifecycle,
  installClaudeCallback,
  planManagedClaudeCallbackCapabilityRemoval,
  readClaudeCallbackRuntimeConfiguration,
  recoverClaudeCallbackLifecycle,
  removeManagedClaudeCallbackCapability,
  rotateManagedClaudeCallbackCapability,
  uninstallClaudeCallback,
} from "../src/claude-callback-lifecycle.js";
import { EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES } from "../src/export-identity-keychain.js";

const CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym;
const EXISTING_COMMAND = "printf 'existing status'";

function memoryBackend(initial = null) {
  let value = initial && Buffer.from(initial);
  let createCalls = 0;
  return {
    get createCalls() { return createCalls; },
    current: () => value && Buffer.from(value),
    async read(capability) {
      assert.equal(capability, CAPABILITY);
      return value && Buffer.from(value);
    },
    async createIfMissing(capability, secret) {
      assert.equal(capability, CAPABILITY);
      createCalls += 1;
      if (value) return "existing";
      value = Buffer.from(secret);
      return "created";
    },
    async replaceExact(capability, expected, replacement) {
      assert.equal(capability, CAPABILITY);
      if (!value) return "missing";
      if (!value.equals(expected)) return "conflict";
      value = Buffer.from(replacement);
      return "replaced";
    },
    async deleteExact(capability, expected) {
      assert.equal(capability, CAPABILITY);
      if (!value) return "missing";
      if (!value.equals(expected)) return "conflict";
      value.fill(0);
      value = null;
      return "deleted";
    },
  };
}

async function fixture(settings = {
  theme: "dark",
  statusLine: { type: "command", command: EXISTING_COMMAND },
}) {
  const created = await mkdtemp(join(tmpdir(), "claude-callback-lifecycle-"));
  await chmod(created, 0o700);
  const root = await realpath(created);
  const claude = join(root, ".claude");
  const lifecycleDirectory = join(root, "private-state", "callback");
  const settingsFile = join(claude, "settings.json");
  await mkdir(claude, { mode: 0o700 });
  await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return {
    root,
    settingsFile,
    lifecycleDirectory,
    installedStatusLine: buildManagedClaudeStatusLine({
      nodeExecutable: "/safe/node",
      runtimeScript: "/safe/runtime.js",
    }),
  };
}

async function withFixture(fn, settings) {
  const value = await fixture(settings);
  try {
    return await fn(value);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
}

async function readSettings(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function lifecycleOptions(value, extra = {}) {
  return {
    settingsFile: value.settingsFile,
    lifecycleDirectory: value.lifecycleDirectory,
    installedStatusLine: value.installedStatusLine,
    ...extra,
  };
}

function fixedLifecycleError(code) {
  return (error) => {
    assert.equal(error instanceof ClaudeCallbackLifecycleError, true);
    assert.equal(error.code, `claude_callback_lifecycle_${code}`);
    assert.equal(error.message, "Claude callback lifecycle operation failed");
    assert.equal(error.message.includes(EXISTING_COMMAND), false);
    return true;
  };
}

test("install composes a supported existing command, stores private state, and uninstall restores it exactly", async () => {
  await withFixture(async (value) => {
    const backend = memoryBackend();
    assert.deepEqual(await installClaudeCallback(lifecycleOptions(value, {
      backend,
      generateSecret: () => Buffer.alloc(32, 1),
    })), { status: "installed", capability: "created" });
    const installed = await readSettings(value.settingsFile);
    assert.deepEqual(installed.statusLine, value.installedStatusLine);
    assert.equal(installed.statusLine.command, "'/safe/node' '/safe/runtime.js'");
    assert.equal(JSON.stringify(installed).includes(Buffer.alloc(32, 1).toString("base64url")), false);
    assert.equal(installed.theme, "dark");
    assert.equal((await lstat(value.lifecycleDirectory)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(value.lifecycleDirectory, "lifecycle-state.json"))).mode & 0o777, 0o600);
    assert.equal(
      (await readFile(join(value.lifecycleDirectory, "lifecycle-state.json"), "utf8"))
        .includes(Buffer.alloc(32, 1).toString("base64url")),
      false,
    );
    assert.deepEqual(await inspectClaudeCallbackLifecycle(lifecycleOptions(value)), {
      status: "installed",
      targetBinding: (await inspectClaudeCallbackLifecycle(lifecycleOptions(value))).targetBinding,
    });
    const runtime = await readClaudeCallbackRuntimeConfiguration(lifecycleOptions(value));
    assert.equal(runtime.previousCommand, EXISTING_COMMAND);

    installed.theme = "light";
    installed.unrelated = true;
    await writeFile(value.settingsFile, `${JSON.stringify(installed, null, 2)}\n`, { mode: 0o600 });
    assert.deepEqual(await uninstallClaudeCallback(lifecycleOptions(value)), {
      status: "uninstalled",
      capabilityPreserved: true,
    });
    assert.deepEqual(await readSettings(value.settingsFile), {
      theme: "light",
      statusLine: { type: "command", command: EXISTING_COMMAND },
      unrelated: true,
    });
    assert.deepEqual(backend.current(), Buffer.alloc(32, 1));
  });
});

test("unsupported existing status-line shapes fail before creating a capability", async () => {
  await withFixture(async (value) => {
    const backend = memoryBackend();
    await assert.rejects(
      installClaudeCallback(lifecycleOptions(value, { backend })),
      fixedLifecycleError("coexistence_unsupported"),
    );
    assert.equal(backend.createCalls, 0);
    assert.equal(backend.current(), null);
  }, { statusLine: { type: "command", command: EXISTING_COMMAND, padding: 1 } });
});

test("inspection binding never hashes or exposes the private existing command", async () => {
  await withFixture(async (value) => {
    const first = await inspectClaudeCallbackLifecycle(lifecycleOptions(value));
    await writeFile(value.settingsFile, `${JSON.stringify({
      theme: "dark",
      statusLine: { type: "command", command: "printf 'a completely different private value'" },
    }, null, 2)}\n`, { mode: 0o600 });
    const second = await inspectClaudeCallbackLifecycle(lifecycleOptions(value));
    assert.equal(first.status, "not_installed");
    assert.equal(second.status, "not_installed");
    assert.equal(first.targetBinding, second.targetBinding);
    assert.match(first.targetBinding, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(first).includes(EXISTING_COMMAND), false);
  });
});

test("install and uninstall prepared phases recover deterministically after interruptions", async () => {
  for (const point of ["after_install_state_prepared", "after_install_settings_written"]) {
    await withFixture(async (value) => {
      const backend = memoryBackend();
      await assert.rejects(installClaudeCallback(lifecycleOptions(value, {
        backend,
        generateSecret: () => Buffer.alloc(32, 2),
        failpoint(seen) { if (seen === point) throw new Error("simulated interruption"); },
      })));
      const recovered = await recoverClaudeCallbackLifecycle(lifecycleOptions(value));
      assert.equal(recovered.status, "installed");
      assert.deepEqual((await readSettings(value.settingsFile)).statusLine, value.installedStatusLine);
    });
  }

  for (const point of ["after_uninstall_state_prepared", "after_uninstall_settings_written"]) {
    await withFixture(async (value) => {
      const backend = memoryBackend();
      await installClaudeCallback(lifecycleOptions(value, {
        backend,
        generateSecret: () => Buffer.alloc(32, 3),
      }));
      await assert.rejects(uninstallClaudeCallback(lifecycleOptions(value, {
        failpoint(seen) { if (seen === point) throw new Error("simulated interruption"); },
      })));
      const recovered = await recoverClaudeCallbackLifecycle(lifecycleOptions(value));
      assert.equal(recovered.status, "not_installed");
      assert.deepEqual((await readSettings(value.settingsFile)).statusLine, {
        type: "command",
        command: EXISTING_COMMAND,
      });
      assert.deepEqual(backend.current(), Buffer.alloc(32, 3));
    });
  }
});

test("rotation and permanent removal are separate, explicit lifecycle operations", async () => {
  await withFixture(async (value) => {
    const backend = memoryBackend();
    await installClaudeCallback(lifecycleOptions(value, {
      backend,
      generateSecret: () => Buffer.alloc(32, 4),
    }));
    await assert.rejects(
      planManagedClaudeCallbackCapabilityRemoval(lifecycleOptions(value, { backend })),
      fixedLifecycleError("not_uninstalled"),
    );
    await rotateManagedClaudeCallbackCapability(lifecycleOptions(value, {
      backend,
      confirm: true,
      generateSecret: () => Buffer.alloc(32, 5),
    }));
    assert.deepEqual(backend.current(), Buffer.alloc(32, 5));
    await uninstallClaudeCallback(lifecycleOptions(value));
    const plan = await planManagedClaudeCallbackCapabilityRemoval(lifecycleOptions(value, { backend }));
    assert.match(plan.confirmationToken, /^[A-F0-9]{20}$/);
    await assert.rejects(removeManagedClaudeCallbackCapability(lifecycleOptions(value, {
      backend,
      providedToken: "0".repeat(20),
    })));
    assert.deepEqual(backend.current(), Buffer.alloc(32, 5));
    assert.deepEqual(await removeManagedClaudeCallbackCapability(lifecycleOptions(value, {
      backend,
      providedToken: plan.confirmationToken,
    })), { status: "removed", secureErasure: false });
    assert.equal(backend.current(), null);
  });
});

test("settings symlinks, hardlinks, unsafe modes, and replacement races fail closed", async () => {
  await withFixture(async (value) => {
    const original = join(value.root, "original.json");
    await rename(value.settingsFile, original);
    await symlink(original, value.settingsFile);
    await assert.rejects(
      installClaudeCallback(lifecycleOptions(value, { backend: memoryBackend() })),
      fixedLifecycleError("settings_type"),
    );
  });
  await withFixture(async (value) => {
    await link(value.settingsFile, join(value.root, "second-link.json"));
    await assert.rejects(
      installClaudeCallback(lifecycleOptions(value, { backend: memoryBackend() })),
      fixedLifecycleError("settings_links"),
    );
  });
  await withFixture(async (value) => {
    await chmod(value.settingsFile, 0o666);
    await assert.rejects(
      installClaudeCallback(lifecycleOptions(value, { backend: memoryBackend() })),
      fixedLifecycleError("settings_mode"),
    );
  });
  await withFixture(async (value) => {
    const replacement = join(value.root, "replacement.json");
    await writeFile(replacement, '{"replacement":true}\n', { mode: 0o600 });
    await assert.rejects(installClaudeCallback(lifecycleOptions(value, {
      backend: memoryBackend(),
      failpoint: async (point) => {
        if (point === "before_settings_replace") await rename(replacement, value.settingsFile);
      },
    })), fixedLifecycleError("settings_replaced"));
    assert.deepEqual(await readSettings(value.settingsFile), { replacement: true });
  });
});

test("lifecycle state rejects symlink, hardlink, and unsafe-mode substitutions", async () => {
  for (const attack of ["symlink", "hardlink", "mode"]) {
    await withFixture(async (value) => {
      await installClaudeCallback(lifecycleOptions(value, {
        backend: memoryBackend(),
        generateSecret: () => Buffer.alloc(32, 6),
      }));
      const state = join(value.lifecycleDirectory, "lifecycle-state.json");
      if (attack === "mode") await chmod(state, 0o644);
      if (attack === "hardlink") await link(state, join(value.root, "state-copy"));
      if (attack === "symlink") {
        const original = join(value.root, "state-original");
        await rename(state, original);
        await symlink(original, state);
      }
      await assert.rejects(inspectClaudeCallbackLifecycle(lifecycleOptions(value)));
    });
  }
});

test("operation lock recovers dead or stale crash residue and rejects live or unsafe locks", async () => {
  await withFixture(async (value) => {
    await mkdir(value.lifecycleDirectory, { recursive: true, mode: 0o700 });
    const lock = join(value.lifecycleDirectory, "operation.lock");
    await writeFile(lock, "999999\n", { mode: 0o600 });
    await installClaudeCallback(lifecycleOptions(value, {
      backend: memoryBackend(),
      processExists: () => false,
    }));
    assert.deepEqual((await readSettings(value.settingsFile)).statusLine, value.installedStatusLine);
  });
  await withFixture(async (value) => {
    await mkdir(value.lifecycleDirectory, { recursive: true, mode: 0o700 });
    const lock = join(value.lifecycleDirectory, "operation.lock");
    await writeFile(lock, "", { mode: 0o600 });
    await assert.rejects(
      installClaudeCallback(lifecycleOptions(value, { backend: memoryBackend() })),
      fixedLifecycleError("busy"),
    );
    await utimes(lock, new Date(0), new Date(0));
    await installClaudeCallback(lifecycleOptions(value, { backend: memoryBackend() }));
  });
  await withFixture(async (value) => {
    await mkdir(value.lifecycleDirectory, { recursive: true, mode: 0o700 });
    const lock = join(value.lifecycleDirectory, "operation.lock");
    await writeFile(lock, `${process.pid}\n`, { mode: 0o600 });
    await assert.rejects(
      installClaudeCallback(lifecycleOptions(value, { backend: memoryBackend() })),
      fixedLifecycleError("busy"),
    );
  });
  await withFixture(async (value) => {
    await mkdir(value.lifecycleDirectory, { recursive: true, mode: 0o700 });
    const outside = join(value.root, "outside-lock");
    await writeFile(outside, "999999\n", { mode: 0o600 });
    await symlink(outside, join(value.lifecycleDirectory, "operation.lock"));
    await assert.rejects(
      installClaudeCallback(lifecycleOptions(value, { backend: memoryBackend(), processExists: () => false })),
      fixedLifecycleError("busy"),
    );
  });
});

test("an existing unsafe or aliased lifecycle directory is never chmod-repaired or followed", async () => {
  await withFixture(async (value) => {
    await mkdir(value.lifecycleDirectory, { recursive: true, mode: 0o755 });
    await chmod(value.lifecycleDirectory, 0o755);
    await assert.rejects(
      installClaudeCallback(lifecycleOptions(value, { backend: memoryBackend() })),
      fixedLifecycleError("state_directory"),
    );
    assert.equal((await lstat(value.lifecycleDirectory)).mode & 0o777, 0o755);
  });
  await withFixture(async (value) => {
    const target = join(value.root, "target-state");
    await mkdir(join(value.root, "private-state"), { mode: 0o700 });
    await mkdir(target, { mode: 0o700 });
    await symlink(target, value.lifecycleDirectory);
    await assert.rejects(
      installClaudeCallback(lifecycleOptions(value, { backend: memoryBackend() })),
      fixedLifecycleError("state_directory"),
    );
  });
});
