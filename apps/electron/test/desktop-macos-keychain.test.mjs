import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopMacOSCredentialBackend, loadDesktopMacOSCredentialBackend } from "../desktop-macos-keychain.js";
import { MACOS_KEYCHAIN_ADAPTER_CAPABILITIES, MACOS_KEYCHAIN_ADAPTER_CONTRACT_VERSION } from "../../../native/macos-keychain/contract.js";
import { createProductionMacCredentialHandover } from "../main.js";
import { Duplex } from "node:stream";

const SECRET = Buffer.alloc(32, 7).toString("base64url");
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
  };
  return { binding, items, calls, buffers };
}

test("native bytes retain the existing identity through the fixed broker port", async () => {
  const f = bindingFixture();
  f.items.set("export_identity", Buffer.from(SECRET, "base64url"));
  const backend = createDesktopMacOSCredentialBackend({ binding: f.binding });
  await backend.preflight();
  assert.deepEqual(f.calls, MACOS_KEYCHAIN_ADAPTER_CAPABILITIES.map((cap) => ["read", cap]));
  assert.equal(await backend.get("export_identity"), SECRET);
  await backend.set("account_observation", SECRET);
  assert.equal(await backend.get("account_observation"), SECRET);
  assert.ok(f.buffers.every((buffer) => buffer.every((byte) => byte === 0)));
  await backend.delete("account_observation");
  assert.equal(await backend.get("account_observation"), null);
  await assert.rejects(backend.set("export_identity", "a".repeat(43)));
  await assert.rejects(backend.get("unknown"));
});

test("preflight remains read-only and blocks unavailable or migration-required credentials", async () => {
  for (const [status, code] of [["locked", "KEYCHAIN_LOCKED"], ["denied", "KEYCHAIN_DENIED"], ["unknown", "broker_unavailable"], ["migration_required", "KEYCHAIN_MIGRATION_REQUIRED"]]) {
    const f = bindingFixture();
    f.binding.read = async () => ({ status, value: null });
    const backend = createDesktopMacOSCredentialBackend({ binding: f.binding });
    await assert.rejects(backend.preflight(), { code });
    assert.equal(f.items.size, 0);
    assert.equal(f.calls.some(([operation]) => operation === "store"), false);
  }
});

const APP_BUNDLE = "/Applications/TiboTattle.app";
const RESOURCES = `${APP_BUNDLE}/Contents/Resources`;
const METADATA = { isFile: () => true, isSymbolicLink: () => false, nlink: 1,
  size: 1024, mode: 0o755, dev: 1, ino: 5, mtimeMs: 10, ctimeMs: 10 };

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
    assert.equal(f.calls.length, 4);
    assert.equal(await backend.get("export_identity"), null);
  }
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
    }));
    assert.equal(loaded, false);
  }
});

test("production composition establishes credentials before touching the predecessor and serves only afterwards", async () => {
  const order = [];
  const app = {};
  let completeHandover;
  const bridge = createProductionMacCredentialHandover({
    app, resourcesPath: RESOURCES,
    async loadBackend(options) {
      assert.deepEqual(options, { app, resourcesPath: RESOURCES });
      order.push("credentials");
      return { get: async () => null, set: async () => {}, delete: async () => {} };
    },
    async runHandover(options) {
      assert.deepEqual(options, { electronApp: app, resourcesPath: RESOURCES, homeDirectory: "/synthetic/home" });
      order.push("handover");
      return new Promise((done) => { completeHandover = done; });
    },
  });
  const stream = new Duplex({ read() {}, write(chunk, encoding, done) { done(); } });
  assert.throws(() => bridge.attachCredentialBroker(stream));
  const preparation = bridge.prepareNativeHandover({ homeDirectory: "/synthetic/home" });
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(order, ["credentials", "handover"]);
  assert.throws(() => bridge.attachCredentialBroker(stream));
  completeHandover({ status: "migrated" });
  assert.deepEqual(await preparation, { status: "migrated" });
  bridge.attachCredentialBroker(stream).dispose();
  assert.equal(stream.destroyed, true);
});

test("credential refusal and failed handover never open a child credential channel", async () => {
  for (const failureMode of ["credentials", "handover", "blocked"]) {
    let handovers = 0;
    const bridge = createProductionMacCredentialHandover({
      async loadBackend() {
        if (failureMode === "credentials") throw Object.assign(new Error("Unavailable"), { code: "KEYCHAIN_LOCKED" });
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
    assert.equal(handovers, failureMode === "credentials" ? 0 : 1);
    assert.throws(() => bridge.attachCredentialBroker({}));
  }
});
