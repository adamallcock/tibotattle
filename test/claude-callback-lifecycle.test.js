import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { createWindowsFilesystemAdapter } from "../src/platform/windows-filesystem.js";
import {
  createWindowsProtectedStateStore,
  isWindowsProtectedStateStore,
} from "../src/platform/windows-protected-state-store.js";
import { WINDOWS_PRODUCTION_READINESS } from "../src/platform/windows-production-readiness.js";

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

const WINDOWS_LIFECYCLE_ROOT = "C:\\Users\\tester\\AppData\\Local\\TiboTattle\\callback";
const WINDOWS_SETTINGS_ROOT = "C:\\Users\\tester\\.claude";
const WINDOWS_SETTINGS_FILE = `${WINDOWS_SETTINGS_ROOT}\\settings.json`;
const WINDOWS_IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "00112233445566778899aabbccddeeff",
  linkCount: 1,
});

function windowsStoreFixture(settings = {
  theme: "dark",
  statusLine: { type: "command", command: EXISTING_COMMAND },
}) {
  const entries = new Map();
  const calls = [];
  let nextFileId = 2;
  const identity = (number) => Object.freeze({
    volumeSerialNumber: WINDOWS_IDENTITY.volumeSerialNumber,
    fileId: number.toString(16).padStart(32, "0"),
    linkCount: 1,
  });
  const same = (left, right) => left?.volumeSerialNumber === right?.volumeSerialNumber
    && left?.fileId === right?.fileId
    && left?.linkCount === right?.linkCount;
  const metadata = (entry) => ({
    identity: entry.identity,
    isDirectory: entry.directory === true,
    isRegularFile: entry.directory !== true,
    isReparsePoint: false,
    ownerMatches: true,
    nullDacl: false,
    daclProtected: true,
    broadAccess: false,
    nonOwnerAllow: false,
    unrecognizedAce: false,
    finalPathResolved: true,
  });
  const addDirectory = (path, entry = {}) => {
    entries.set(path, { directory: true, identity: entry.identity ?? identity(nextFileId++), ...entry });
  };
  addDirectory(WINDOWS_LIFECYCLE_ROOT, { identity: WINDOWS_IDENTITY });
  addDirectory(WINDOWS_SETTINGS_ROOT, { identity: identity(nextFileId++) });
  const failure = (code) => {
    const error = new Error("Windows filesystem operation failed");
    error.code = `WINDOWS_FILESYSTEM_${code}`;
    return error;
  };
  const binding = {
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    sqliteStateLeaseContractVersion: "windows-sqlite-state-lease-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    productionSafe: false,
    pathWalkRaceSafe: false,
    credentialMutexSafe: true,
    credentialAuditFileGuardSafe: true,
    sqliteStateLeaseSafe: false,
    inspectPath(path) {
      calls.push(["inspectPath", path]);
      const entry = entries.get(path);
      if (!entry) throw failure("NOT_FOUND");
      return metadata(entry);
    },
    ensureDirectory(path) {
      calls.push(["ensureDirectory", path]);
      const entry = entries.get(path);
      if (entry) {
        if (!entry.directory) throw failure("NOT_DIRECTORY");
        return entry.identity;
      }
      addDirectory(path);
      return entries.get(path).identity;
    },
    readFile(path) {
      calls.push(["readFile", path]);
      const entry = entries.get(path);
      if (!entry) throw failure("NOT_FOUND");
      if (entry.directory) throw failure("NOT_REGULAR_FILE");
      return { data: Buffer.from(entry.data), identity: entry.identity };
    },
    readFileBounded(path, maximumBytes) {
      const result = this.readFile(path);
      if (result.data.byteLength > maximumBytes) throw failure("FILE_TOO_LARGE");
      return result;
    },
    createFile(path, data) {
      calls.push(["createFile", path]);
      if (entries.has(path)) throw failure("ALREADY_EXISTS");
      const file = { directory: false, data: Buffer.from(data), identity: identity(nextFileId++) };
      entries.set(path, file);
      return file.identity;
    },
    deleteFile(path, expectedIdentity) {
      calls.push(["deleteFile", path]);
      const entry = entries.get(path);
      if (!entry) throw failure("NOT_FOUND");
      if (!same(entry.identity, expectedIdentity)) throw failure("IDENTITY_MISMATCH");
      entries.delete(path);
      return { deleted: true, identity: entry.identity };
    },
    replaceFile(path, expectedIdentity, data) {
      calls.push(["replaceFile", path]);
      const entry = entries.get(path);
      if (!entry) throw failure("NOT_FOUND");
      if (entry.directory || !same(entry.identity, expectedIdentity)) throw failure("IDENTITY_MISMATCH");
      entry.data = Buffer.from(data);
      entry.identity = identity(nextFileId++);
      return entry.identity;
    },
    inspectProtectedChild(rootPath, _rootIdentity, childPath) {
      return this.inspectPath(`${rootPath}\\${childPath}`);
    },
    readProtectedChild(rootPath, _rootIdentity, childPath, maximumBytes) {
      return this.readFileBounded(`${rootPath}\\${childPath}`, maximumBytes);
    },
    createProtectedChild(rootPath, _rootIdentity, childPath, data) {
      return this.createFile(`${rootPath}\\${childPath}`, data);
    },
    deleteProtectedChild(rootPath, _rootIdentity, childPath, expectedIdentity) {
      return this.deleteFile(`${rootPath}\\${childPath}`, expectedIdentity);
    },
    replaceProtectedChild(rootPath, _rootIdentity, childPath, expectedIdentity, data) {
      return this.replaceFile(`${rootPath}\\${childPath}`, expectedIdentity, data);
    },
    acquireCredentialAuditFileGuard() { return { guard: {}, identity: WINDOWS_IDENTITY }; },
    releaseCredentialAuditFileGuard() {},
    acquireCredentialMutex() { return { lease: {}, abandoned: false }; },
    releaseCredentialMutex() {},
    acquireSqliteStateLease() {
      return {
        lease: {},
        databaseIdentity: WINDOWS_IDENTITY,
        journalIdentity: WINDOWS_IDENTITY,
      };
    },
    releaseSqliteStateLease() {},
  };
  const adapter = createWindowsFilesystemAdapter({ platform: "win32", architecture: "x64", binding });
  const lifecycleStore = createWindowsProtectedStateStore({
    adapter,
    rootPath: WINDOWS_LIFECYCLE_ROOT,
  });
  const settingsStore = createWindowsProtectedStateStore({
    adapter,
    rootPath: WINDOWS_SETTINGS_ROOT,
  });
  settingsStore.createJson("settings.json", settings);
  return {
    adapter,
    calls,
    entries,
    lifecycleStore,
    settingsStore,
    settingsFile: WINDOWS_SETTINGS_FILE,
    lifecycleDirectory: WINDOWS_LIFECYCLE_ROOT,
  };
}

function windowsLifecycleOptions(value, extra = {}) {
  return {
    platform: "win32",
    settingsFile: value.settingsFile,
    lifecycleDirectory: value.lifecycleDirectory,
    windowsLifecycleStore: value.lifecycleStore,
    windowsSettingsStore: value.settingsStore,
    installedStatusLine: buildManagedClaudeStatusLine({
      nodeExecutable: "/safe/node",
      runtimeScript: "/safe/runtime.js",
    }),
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

test("Windows callback lifecycle state is blocked before touching settings, state, or locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-callback-windows-gate-"));
  const ownerUrl = new URL("../src/platform/claude-callback-lifecycle.js", import.meta.url).href;
  const script = `
    Object.defineProperty(process, "platform", { value: "win32" });
    const { createClaudeCallbackLifecycleContext } = await import(${JSON.stringify(ownerUrl)});
    const { join } = await import("node:path");
    class CapabilityError extends Error {}
    const calls = [];
    const context = createClaudeCallbackLifecycleContext({
      ClaudeCallbackCapabilityError: CapabilityError,
      ensureClaudeCallbackCapability: async () => { calls.push("ensure"); return { status: "created", secret: Buffer.alloc(32) }; },
      planClaudeCallbackCapabilityRemoval: async () => { calls.push("plan"); return { status: "missing", confirmationToken: null }; },
      removeClaudeCallbackCapability: async () => { calls.push("remove"); return { status: "removed", secureErasure: false }; },
      rotateClaudeCallbackCapability: async () => { calls.push("rotate"); return { status: "rotated" }; },
      runtimeScript: "/safe/runtime.js",
    });
    const options = {
      // A caller cannot downgrade a real Windows runtime into the POSIX
      // implementation by supplying a synthetic platform override.
      platform: "darwin",
      settingsFile: join(process.env.CLAUDE_WINDOWS_GATE_ROOT, "settings.json"),
      lifecycleDirectory: join(process.env.CLAUDE_WINDOWS_GATE_ROOT, "lifecycle"),
      installedStatusLine: context.buildManagedClaudeStatusLine({ nodeExecutable: "/safe/node" }),
      backend: {},
    };
    const operations = [
      () => context.inspectClaudeCallbackLifecycle(options),
      () => context.recoverClaudeCallbackLifecycle(options),
      () => context.installClaudeCallback(options),
      () => context.uninstallClaudeCallback(options),
      () => context.rotateManagedClaudeCallbackCapability(options),
      () => context.planManagedClaudeCallbackCapabilityRemoval(options),
      () => context.removeManagedClaudeCallbackCapability({ ...options, providedToken: "" }),
      () => context.readClaudeCallbackRuntimeConfiguration(options),
    ];
    const codes = [];
    for (const operation of operations) {
      try {
        await operation();
      } catch (error) {
        codes.push(error?.code ?? "unknown");
      }
    }
    process.stdout.write(JSON.stringify({ calls, codes }));
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, CLAUDE_WINDOWS_GATE_ROOT: root },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      calls: [],
      codes: Array.from({ length: 8 }, () => "claude_callback_lifecycle_windows_state_unqualified"),
    });
    await assert.rejects(lstat(join(root, "settings.json")), { code: "ENOENT" });
    await assert.rejects(lstat(join(root, "lifecycle")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit Windows composition routes settings, lifecycle state, pending state, and lease through branded stores", async () => {
  const value = windowsStoreFixture();
  const backend = memoryBackend();
  const options = windowsLifecycleOptions(value, {
    backend,
    generateSecret: () => Buffer.alloc(32, 7),
  });
  assert.equal(isWindowsProtectedStateStore(value.lifecycleStore), true);
  assert.equal(isWindowsProtectedStateStore(value.settingsStore), true);
  assert.deepEqual(await installClaudeCallback(options), {
    status: "installed",
    capability: "created",
  });
  assert.deepEqual(value.settingsStore.readJson("settings.json").value.statusLine, options.installedStatusLine);
  assert.equal(value.lifecycleStore.readJson("lifecycle-state.json").value.phase, "installed");
  assert.equal(value.entries.has(`${WINDOWS_LIFECYCLE_ROOT}\\operation.lock`), false);
  assert.equal(value.entries.has(`${WINDOWS_LIFECYCLE_ROOT}\\.lifecycle-state.pending`), false);
  assert.deepEqual(await readClaudeCallbackRuntimeConfiguration(options), {
    previousCommand: EXISTING_COMMAND,
  });
  assert.deepEqual(await uninstallClaudeCallback(options), {
    status: "uninstalled",
    capabilityPreserved: true,
  });
  assert.equal(value.settingsStore.readJson("settings.json").value.statusLine.command, EXISTING_COMMAND);
  assert.equal(value.lifecycleStore.readJson("lifecycle-state.json").value.phase, "uninstalled");
  assert.ok(value.calls.length > 0);
  assert.equal(value.calls.every(([, path]) => typeof path !== "string" || path.startsWith("C:\\")), true);
});

test("explicit Windows protected stores preserve prepared-phase crash recovery", async () => {
  const value = windowsStoreFixture();
  const backend = memoryBackend();
  const options = windowsLifecycleOptions(value, {
    backend,
    generateSecret: () => Buffer.alloc(32, 8),
    failpoint(point) {
      if (point === "after_install_state_prepared") throw new Error("simulated interruption");
    },
  });
  await assert.rejects(installClaudeCallback(options), /simulated interruption/u);
  assert.equal(value.lifecycleStore.readJson("lifecycle-state.json").value.phase, "install_prepared");
  const recovered = await recoverClaudeCallbackLifecycle(windowsLifecycleOptions(value, { backend }));
  assert.deepEqual(recovered.status, "installed");
  assert.equal(value.lifecycleStore.readJson("lifecycle-state.json").value.phase, "installed");
  assert.deepEqual(value.settingsStore.readJson("settings.json").value.statusLine, options.installedStatusLine);
});

test("an actual Windows runtime rejects branded unqualified stores and copied readiness", async () => {
  const value = windowsStoreFixture();
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const settingsBefore = Buffer.from(value.entries.get(WINDOWS_SETTINGS_FILE).data);
  const copiedReadiness = {
    ...WINDOWS_PRODUCTION_READINESS,
    status: "qualified",
    credentialMutexSafe: true,
    durableAuditSafe: true,
    protectedStatePathsSafe: true,
    authenticatedBindingSafe: true,
    bindingProvenance: {
      ...WINDOWS_PRODUCTION_READINESS.bindingProvenance,
      status: "qualified",
      source: "audited-signed-native-binding",
    },
    qualificationReceipt: "windows-fake",
    qualifiedAt: "2026-08-18T00:00:00.000Z",
  };
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  try {
    await assert.rejects(
      installClaudeCallback(windowsLifecycleOptions(value, {
        backend: memoryBackend(),
        generateSecret: () => Buffer.alloc(32, 10),
        windowsReadiness: copiedReadiness,
      })),
      fixedLifecycleError("windows_state_unqualified"),
    );
    assert.deepEqual(value.entries.get(WINDOWS_SETTINGS_FILE).data, settingsBefore);
    assert.equal(value.entries.has(`${WINDOWS_LIFECYCLE_ROOT}\\operation.lock`), false);
    assert.equal(value.entries.has(`${WINDOWS_LIFECYCLE_ROOT}\\lifecycle-state.json`), false);
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
});

test("Windows settings revalidation rejects same-identity content mutation", async () => {
  const value = windowsStoreFixture();
  const backend = memoryBackend();
  const options = windowsLifecycleOptions(value, {
    backend,
    generateSecret: () => Buffer.alloc(32, 9),
    failpoint(point) {
      if (point === "after_install_state_prepared") {
        const settings = value.entries.get(WINDOWS_SETTINGS_FILE);
        settings.data = Buffer.from(settings.data.toString("utf8").replace("dark", "dork"));
      }
    },
  });
  await assert.rejects(
    installClaudeCallback(options),
    fixedLifecycleError("settings_replaced"),
  );
  assert.equal(value.entries.get(WINDOWS_SETTINGS_FILE).identity.linkCount, 1);
  assert.equal(value.lifecycleStore.readJson("lifecycle-state.json").value.phase, "install_prepared");
});

test("Windows protected-store composition rejects missing, copied, and root-mismatched stores", async () => {
  const value = windowsStoreFixture();
  const backend = memoryBackend();
  const base = windowsLifecycleOptions(value, { backend });
  const cases = [
    { windowsLifecycleStore: undefined },
    { windowsSettingsStore: undefined },
    { windowsLifecycleStore: { ...value.lifecycleStore } },
    { windowsSettingsStore: { ...value.settingsStore } },
    { lifecycleDirectory: "C:\\Users\\tester\\AppData\\Local\\TiboTattle\\other" },
    { settingsFile: "C:\\Users\\tester\\.other\\settings.json" },
  ];
  for (const override of cases) {
    await assert.rejects(
      inspectClaudeCallbackLifecycle({ ...base, ...override }),
      fixedLifecycleError("windows_state_unqualified"),
    );
  }
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
