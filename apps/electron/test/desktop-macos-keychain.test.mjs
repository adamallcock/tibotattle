import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDesktopMacOSAccountlessCredentialBackend,
  createDesktopMacOSCredentialBackend,
  loadDesktopMacOSCredentialBackend,
  loadDesktopMacOSCredentialBackends,
  macOSCredentialApplicationVerificationArguments,
} from "../desktop-macos-keychain.js";
import {
  MACOS_KEYCHAIN_ADAPTER_BROKER_CAPABILITIES,
  MACOS_KEYCHAIN_ADAPTER_CAPABILITIES,
  MACOS_KEYCHAIN_ADAPTER_CONTRACT_VERSION,
  MACOS_KEYCHAIN_ADAPTER_STARTUP_PREFLIGHT_CAPABILITIES,
} from "../../../native/macos-keychain/contract.js";
import { createProductionMacCredentialHandover } from "../main.js";
import { Duplex } from "node:stream";
import { PRODUCTION_ELECTRON_APP_ID } from "../desktop-updater.js";

const SECRET = Buffer.alloc(32, 7).toString("base64url");
const MACOS_CODESIGN_SKIP = process.platform === "darwin"
  ? false
  : "requires macOS codesign";

async function createAdHocApplicationFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-macos-keychain-codesign-")));
  const appBundle = join(root, "TiboTattle.app");
  const resourcesPath = join(appBundle, "Contents", "Resources");
  const executable = join(appBundle, "Contents", "MacOS", "TiboTattle");
  const binary = join(resourcesPath, "native", "macos-keychain.node");
  await Promise.all([
    mkdir(join(resourcesPath, "native"), { recursive: true }),
    mkdir(join(appBundle, "Contents", "MacOS"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(appBundle, "Contents", "Info.plist"), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      `<key>CFBundleIdentifier</key><string>${PRODUCTION_ELECTRON_APP_ID}</string>`,
      '<key>CFBundleExecutable</key><string>TiboTattle</string>',
      "</dict></plist>",
    ].join("\n")),
    writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 }),
    writeFile(join(resourcesPath, "app.asar"), "synthetic", { mode: 0o600 }),
    writeFile(binary, "synthetic", { mode: 0o700 }),
  ]);
  await chmod(executable, 0o700);
  assert.equal(await realpath(binary), binary);
  const signing = spawnSync("/usr/bin/codesign", [
    "--force", "--sign", "-", "--identifier", PRODUCTION_ELECTRON_APP_ID, appBundle,
  ], { encoding: "utf8", timeout: 15_000 });
  assert.equal(signing.error, undefined);
  assert.equal(signing.status, 0);
  return { appBundle, resourcesPath, root };
}

function bindingFixture() {
  const items = new Map();
  const calls = [];
  const buffers = [];
  const binding = {
    contractVersion: MACOS_KEYCHAIN_ADAPTER_CONTRACT_VERSION,
    capabilities: [...MACOS_KEYCHAIN_ADAPTER_CAPABILITIES],
    identityStatus: () => "valid",
    inspect: async () => "absent",
    async read(capability) {
      calls.push(["read", capability]);
      const value = items.has(capability) ? Buffer.from(items.get(capability)) : null;
      if (value) buffers.push(value);
      return { status: value ? "present" : "absent", value };
    },
    async store(capability, value) {
      calls.push(["store", capability]);
      items.set(capability, Buffer.from(value));
      buffers.push(value);
      return "stored";
    },
    async remove(capability) { items.delete(capability); return "deleted"; },
    async createIfMissing(capability, value) {
      calls.push(["createIfMissing", capability]);
      if (items.has(capability)) return "existing";
      items.set(capability, Buffer.from(value));
      buffers.push(value);
      return "created";
    },
    async deleteExact(capability, value) {
      calls.push(["deleteExact", capability]);
      if (!items.has(capability)) return "missing";
      if (!items.get(capability).equals(value)) return "mismatch";
      items.delete(capability);
      buffers.push(value);
      return "deleted";
    },
  };
  return { binding, items, calls, buffers };
}

test("native bytes retain the existing identity through the fixed broker port", async () => {
  const f = bindingFixture();
  f.items.set("export_identity", Buffer.from(SECRET, "base64url"));
  const backend = createDesktopMacOSCredentialBackend({ binding: f.binding });
  await backend.preflight();
  assert.deepEqual(f.calls, MACOS_KEYCHAIN_ADAPTER_STARTUP_PREFLIGHT_CAPABILITIES
    .map((cap) => ["read", cap]));
  assert.equal(await backend.get("export_identity"), SECRET);
  await backend.set("account_observation", SECRET);
  assert.equal(await backend.get("account_observation"), SECRET);
  assert.ok(f.buffers.every((buffer) => buffer.every((byte) => byte === 0)));
  await backend.delete("account_observation");
  assert.equal(await backend.get("account_observation"), null);
  await assert.rejects(backend.set("export_identity", "a".repeat(43)));
  await assert.rejects(backend.get("unknown"));
  await assert.rejects(backend.get("accountless_installation"));
});

test("main-only accountless credentials use native conditional operations and preserve legacy recovery", async () => {
  const f = bindingFixture();
  const secret = Buffer.alloc(32, 19);
  const accountless = createDesktopMacOSAccountlessCredentialBackend({
    binding: f.binding,
    legacyCredentialProbe: async () => "absent",
  });
  assert.equal(await accountless.read(), null);
  assert.equal(await accountless.createIfMissing(secret), "created");
  assert.deepEqual(await accountless.read(), secret);
  assert.equal(await accountless.createIfMissing(Buffer.alloc(32, 20)), "existing");
  assert.equal(await accountless.deleteExact(Buffer.alloc(32, 21)), "mismatch");
  assert.equal(await accountless.deleteExact(secret), "deleted");
  assert.equal(await accountless.read(), null);
  assert.equal(f.calls.some(([operation]) => operation === "store"), false);
  assert.equal(f.calls.some(([operation, capability]) => operation === "createIfMissing"
    && capability === "accountless_installation"), true);
  assert.ok(f.buffers.every((buffer) => buffer.every((byte) => byte === 0)));

  const blocked = createDesktopMacOSAccountlessCredentialBackend({
    binding: f.binding,
    legacyCredentialProbe: async () => "present",
  });
  const callsBeforeBlockedRead = f.calls.length;
  await assert.rejects(blocked.read(), {
    code: "contribution_device_credential_recovery_required",
  });
  await assert.rejects(blocked.createIfMissing(secret), {
    code: "contribution_device_credential_recovery_required",
  });
  assert.equal(f.calls.length, callsBeforeBlockedRead,
    "legacy recovery must block native reads and writes without replacing identity");
});

test("locked accountless credentials are retryable while denial and recovery remain terminal", async () => {
  for (const [status, code, retryable] of [
    ["locked", "contribution_device_credential_unavailable", true],
    ["denied", "contribution_device_credential_unavailable", false],
    ["migration_required", "contribution_device_credential_recovery_required", false],
  ]) {
    const f = bindingFixture();
    f.binding.read = async () => ({ status, value: null });
    const accountless = createDesktopMacOSAccountlessCredentialBackend({
      binding: f.binding,
      legacyCredentialProbe: async () => "absent",
    });
    await assert.rejects(accountless.read(), (error) => error?.code === code
      && error.retryable === retryable);
  }

  const f = bindingFixture();
  f.binding.createIfMissing = async () => "locked";
  const accountless = createDesktopMacOSAccountlessCredentialBackend({
    binding: f.binding,
    legacyCredentialProbe: async () => "absent",
  });
  await assert.rejects(accountless.createIfMissing(Buffer.alloc(32, 9)),
    (error) => error?.code === "contribution_device_credential_unavailable"
      && error.retryable === true
      && error.knownNonMutation === true);
  assert.equal(f.items.size, 0, "a locked conditional write must not mint a replacement identity");
});

test("startup preflight remains read-only and blocks unavailable active credentials", async () => {
  for (const [status, code] of [["locked", "KEYCHAIN_LOCKED"], ["denied", "KEYCHAIN_DENIED"], ["unknown", "broker_unavailable"], ["migration_required", "KEYCHAIN_MIGRATION_REQUIRED"]]) {
    for (const blockedCapability of MACOS_KEYCHAIN_ADAPTER_STARTUP_PREFLIGHT_CAPABILITIES) {
      const f = bindingFixture();
      f.binding.read = async (capability) => {
        f.calls.push(["read", capability]);
        return {
          status: capability === blockedCapability ? status : "absent",
          value: null,
        };
      };
      const backend = createDesktopMacOSCredentialBackend({ binding: f.binding });
      await assert.rejects(backend.preflight(), { code });
      assert.equal(f.items.size, 0);
      assert.equal(f.calls.some(([operation]) => operation === "store"), false);
      assert.equal(f.calls.some(([, capability]) => !MACOS_KEYCHAIN_ADAPTER_STARTUP_PREFLIGHT_CAPABILITIES
        .includes(capability)), false);
    }
  }
});

test("optional broker migrations do not block startup and remain visible at first use", async () => {
  const f = bindingFixture();
  const optionalCapabilities = MACOS_KEYCHAIN_ADAPTER_BROKER_CAPABILITIES.filter(
    (capability) => !MACOS_KEYCHAIN_ADAPTER_STARTUP_PREFLIGHT_CAPABILITIES.includes(capability),
  );
  f.binding.read = async (capability) => {
    f.calls.push(["read", capability]);
    return {
      status: optionalCapabilities.includes(capability) ? "migration_required" : "absent",
      value: null,
    };
  };
  f.binding.store = async (capability) => {
    f.calls.push(["store", capability]);
    return optionalCapabilities.includes(capability) ? "migration_required" : "stored";
  };

  const backend = createDesktopMacOSCredentialBackend({ binding: f.binding });
  await backend.preflight();
  assert.deepEqual(f.calls, MACOS_KEYCHAIN_ADAPTER_STARTUP_PREFLIGHT_CAPABILITIES
    .map((capability) => ["read", capability]));
  for (const capability of optionalCapabilities) {
    await assert.rejects(backend.get(capability), { code: "KEYCHAIN_MIGRATION_REQUIRED" });
    await assert.rejects(backend.set(capability, SECRET), { code: "KEYCHAIN_MIGRATION_REQUIRED" });
  }
  assert.equal(f.items.size, 0, "optional migration must not mint replacement credentials");
});

const APP_BUNDLE = "/Applications/TiboTattle.app";
const RESOURCES = `${APP_BUNDLE}/Contents/Resources`;
const METADATA = { isFile: () => true, isSymbolicLink: () => false, nlink: 1,
  size: 1024, mode: 0o755, dev: 1, ino: 5, mtimeMs: 10, ctimeMs: 10 };

test("production application verification supplies a codesign requirement expression", () => {
  assert.deepEqual([...macOSCredentialApplicationVerificationArguments(APP_BUNDLE)], [
    "--verify",
    "--deep",
    "--strict",
    `-R=identifier "${PRODUCTION_ELECTRON_APP_ID}" and anchor apple generic and certificate leaf[subject.OU] = "43RTH622SB"`,
    "--",
    APP_BUNDLE,
  ]);
});

test("the default application verifier uses native codesign requirement syntax", {
  skip: MACOS_CODESIGN_SKIP,
}, async (t) => {
  const fixture = await createAdHocApplicationFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  // This disposable ad-hoc bundle deliberately cannot satisfy the production
  // Developer ID requirement. Native codesign must nevertheless parse the
  // expression, rather than treating it as a requirement-file path.
  const nativeVerification = spawnSync("/usr/bin/codesign",
    macOSCredentialApplicationVerificationArguments(fixture.appBundle), {
      encoding: "utf8",
      timeout: 15_000,
    });
  assert.equal(nativeVerification.error, undefined);
  assert.notEqual(nativeVerification.status, 0);
  assert.equal(
    /No such file or directory|invalid requirement specification/iu.test(
      `${nativeVerification.stdout ?? ""}${nativeVerification.stderr ?? ""}`,
    ),
    false,
  );

  let bindingLoaded = false;
  await assert.rejects(loadDesktopMacOSCredentialBackend({
    app: { isPackaged: true, getAppPath: () => join(fixture.resourcesPath, "app.asar") },
    resourcesPath: fixture.resourcesPath,
    platform: "darwin",
    architecture: process.arch,
    requireBinding() {
      bindingLoaded = true;
      return bindingFixture().binding;
    },
  }), { code: "broker_unavailable" });
  assert.equal(bindingLoaded, false,
    "the real default verifier must refuse before loading a native credential adapter");
});

test("both Mac targets verify the enclosing application before loading and preflight", async () => {
  for (const architecture of ["arm64", "x64"]) {
    const f = bindingFixture();
    const order = [];
    const backend = await loadDesktopMacOSCredentialBackend({
      app: { isPackaged: true, getAppPath: () => `${RESOURCES}/app.asar` },
      resourcesPath: RESOURCES, platform: "darwin", architecture,
      inspectFile: async () => METADATA,
      resolveRealPath: async (path) => path,
      verifyApplication: async (path) => { assert.equal(path, APP_BUNDLE); order.push("verify"); return true; },
      requireBinding(path) { assert.equal(path, `${RESOURCES}/native/macos-keychain.node`); order.push("load"); return f.binding; },
    });
    assert.deepEqual(order, ["verify", "load"]);
    assert.equal(f.calls.length, MACOS_KEYCHAIN_ADAPTER_STARTUP_PREFLIGHT_CAPABILITIES.length);
    assert.equal(await backend.get("export_identity"), null);
  }
});

test("verified adapter loading exposes a separate accountless factory without preflighting it", async () => {
  const f = bindingFixture();
  const backends = await loadDesktopMacOSCredentialBackends({
    app: { isPackaged: true, getAppPath: () => `${RESOURCES}/app.asar` },
    resourcesPath: RESOURCES, platform: "darwin", architecture: "arm64",
    inspectFile: async () => METADATA,
    resolveRealPath: async (path) => path,
    verifyApplication: async () => true,
    requireBinding: () => f.binding,
  });
  assert.equal(f.calls.length, MACOS_KEYCHAIN_ADAPTER_STARTUP_PREFLIGHT_CAPABILITIES.length);
  const accountless = backends.createAccountlessCredentialBackend({
    legacyCredentialProbe: async () => "absent",
  });
  assert.equal(await accountless.createIfMissing(Buffer.alloc(32, 3)), "created");
  assert.equal(f.calls.filter((call) => call[0] === "read").length,
    MACOS_KEYCHAIN_ADAPTER_STARTUP_PREFLIGHT_CAPABILITIES.length);
});

test("unsigned, replaced, linked, development and wrong-target candidates cannot load native code", async () => {
  const base = {
    app: { isPackaged: true, getAppPath: () => `${RESOURCES}/app.asar` },
    resourcesPath: RESOURCES, platform: "darwin", architecture: "arm64",
    inspectFile: async () => METADATA,
    resolveRealPath: async (path) => path,
    verifyApplication: async () => true,
  };
  let reads = 0;
  for (const patch of [
    { verifyApplication: async () => false },
    { inspectFile: async () => ({ ...METADATA, nlink: 2 }) },
    { resolveRealPath: async () => "/outside/adapter.node" },
    { app: { ...base.app, isPackaged: false } },
    { platform: "linux" },
    { architecture: "ia32" },
    { app: { isPackaged: true } },
    { app: { isPackaged: true, getAppPath: () => null } },
    { app: { isPackaged: true, getAppPath: () => "relative/app.asar" } },
    { inspectFile: async () => ({ ...METADATA, ino: ++reads }) },
  ]) {
    let loaded = false;
    await assert.rejects(loadDesktopMacOSCredentialBackend({ ...base, ...patch,
      requireBinding() { loaded = true; return bindingFixture().binding; },
    }), { code: "broker_unavailable" });
    assert.equal(loaded, false);
  }
});

test("production composition establishes credentials before touching the predecessor and serves only afterwards", async () => {
  const order = [];
  const app = {};
  let completeHandover;
  const accountless = { read: async () => null, createIfMissing: async () => "created",
    deleteExact: async () => "missing" };
  const bridge = createProductionMacCredentialHandover({
    app, resourcesPath: RESOURCES,
    async loadBackend(options) {
      assert.deepEqual(options, { app, resourcesPath: RESOURCES });
      order.push("credentials");
      return {
        broker: { get: async () => null, set: async () => {}, delete: async () => {} },
        createAccountlessCredentialBackend(options) {
          assert.equal(typeof options.legacyCredentialProbe, "function");
          return accountless;
        },
      };
    },
    async runHandover(options) {
      assert.deepEqual(options, { electronApp: app, resourcesPath: RESOURCES, homeDirectory: "/synthetic/home" });
      order.push("handover");
      return new Promise((done) => { completeHandover = done; });
    },
  });
  const stream = new Duplex({ read() {}, write(chunk, encoding, done) { done(); } });
  assert.throws(() => bridge.attachCredentialBroker(stream));
  assert.throws(() => bridge.createAccountlessCredentialBackend({
    legacyCredentialProbe: async () => "absent",
  }));
  const preparation = bridge.prepareNativeHandover({ homeDirectory: "/synthetic/home" });
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(order, ["credentials", "handover"]);
  assert.throws(() => bridge.attachCredentialBroker(stream));
  completeHandover({ status: "migrated" });
  assert.deepEqual(await preparation, { status: "migrated" });
  bridge.attachCredentialBroker(stream).dispose();
  assert.equal(stream.destroyed, true);
  assert.equal(bridge.createAccountlessCredentialBackend({
    legacyCredentialProbe: async () => "absent",
  }), accountless);
});

test("production composition permits unused optional migrations but preserves their visible guard", async () => {
  const f = bindingFixture();
  const optionalCapability = MACOS_KEYCHAIN_ADAPTER_BROKER_CAPABILITIES.find(
    (capability) => !MACOS_KEYCHAIN_ADAPTER_STARTUP_PREFLIGHT_CAPABILITIES.includes(capability),
  );
  let broker;
  let handovers = 0;
  f.binding.read = async (capability) => {
    f.calls.push(["read", capability]);
    return {
      status: capability === optionalCapability ? "migration_required" : "absent",
      value: null,
    };
  };
  const bridge = createProductionMacCredentialHandover({
    async loadBackend() {
      broker = createDesktopMacOSCredentialBackend({ binding: f.binding });
      await broker.preflight();
      return { broker };
    },
    async runHandover() {
      handovers += 1;
      return { status: "no_legacy_state" };
    },
  });

  assert.deepEqual(await bridge.prepareNativeHandover({ homeDirectory: "/synthetic/home" }), {
    status: "no_legacy_state",
  });
  assert.equal(handovers, 1);
  await assert.rejects(broker.get(optionalCapability), { code: "KEYCHAIN_MIGRATION_REQUIRED" });
  assert.equal(f.items.size, 0);
  assert.equal(f.calls.some(([operation]) => operation === "store"), false);
});

test("production composition blocks a required credential before handover or writes", async () => {
  const f = bindingFixture();
  let handovers = 0;
  f.binding.read = async (capability) => {
    f.calls.push(["read", capability]);
    return {
      status: capability === "account_observation" ? "migration_required" : "absent",
      value: null,
    };
  };
  const bridge = createProductionMacCredentialHandover({
    async loadBackend() {
      const broker = createDesktopMacOSCredentialBackend({ binding: f.binding });
      await broker.preflight();
      return { broker };
    },
    async runHandover() {
      handovers += 1;
      return { status: "migrated" };
    },
  });

  assert.deepEqual(await bridge.prepareNativeHandover({ homeDirectory: "/synthetic/home" }), {
    status: "credential_preflight_blocked",
  });
  assert.equal(handovers, 0);
  assert.equal(f.items.size, 0);
  assert.equal(f.calls.some(([operation]) => operation === "store"), false);
  assert.deepEqual(f.calls, [["read", "account_observation"]]);
});

test("fixed credential preflight failures never start handover or open a child credential channel", async () => {
  for (const code of [
    "KEYCHAIN_LOCKED",
    "KEYCHAIN_DENIED",
    "KEYCHAIN_MIGRATION_REQUIRED",
    "broker_timeout",
    "broker_unavailable",
  ]) {
    let handovers = 0;
    const bridge = createProductionMacCredentialHandover({
      async loadBackend() {
        throw Object.assign(new Error("Unavailable"), { code });
      },
      async runHandover() {
        handovers += 1;
        return { status: "migration_blocked" };
      },
    });
    assert.deepEqual(await bridge.prepareNativeHandover({ homeDirectory: "/synthetic/home" }), {
      status: "credential_preflight_blocked",
    });
    assert.equal(handovers, 0);
    assert.throws(() => bridge.attachCredentialBroker({}));
  }
});

test("failed or blocked state handover never opens a child credential channel", async () => {
  for (const failureMode of ["handover", "blocked"]) {
    let handovers = 0;
    const bridge = createProductionMacCredentialHandover({
      async loadBackend() {
        return { get: async () => null, set: async () => {}, delete: async () => {} };
      },
      async runHandover() {
        handovers += 1;
        if (failureMode === "handover") throw new Error("Unavailable");
        return { status: "migration_blocked" };
      },
    });
    const preparation = bridge.prepareNativeHandover({ homeDirectory: "/synthetic/home" });
    if (failureMode === "blocked") assert.deepEqual(await preparation, { status: "migration_blocked" });
    else await assert.rejects(preparation);
    assert.equal(handovers, 1);
    assert.throws(() => bridge.attachCredentialBroker({}));
  }
});
