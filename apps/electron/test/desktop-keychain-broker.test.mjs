import test from "node:test";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { attachDesktopKeychainBroker } from "../desktop-keychain-broker.js";
import { createCompanionSupervisor } from "../companion-supervisor.js";
import { createContributionDeviceKeychainBrokerTransport, createMacOSKeychainBrokerBinding } from "../../../src/contribution-device-keychain-broker.js";
import { EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES } from "../../../src/platform/index.js";

function pair() {
  let client;
  let parent;
  const side = (peer) => new Duplex({
    read() {},
    write(chunk, encoding, done) {
      queueMicrotask(() => { peer().push(Buffer.from(chunk)); done(); });
    },
    destroy(error, done) { peer()?.push(null); done(error); },
  });
  client = side(() => parent);
  parent = side(() => client);
  return { client, parent };
}

function fixture(backend) {
  const { client, parent } = pair();
  const server = attachDesktopKeychainBroker({ stream: parent, backend });
  const transport = createContributionDeviceKeychainBrokerTransport({ fd: 4, connect: () => client, timeoutMs: 1000 });
  return { client, parent, server, transport, binding: createMacOSKeychainBrokerBinding({ transport }) };
}

test("Electron serves the existing companion binding without changing logical capabilities", async () => {
  const values = new Map();
  const seen = [];
  const f = fixture({
    async get(capability) { seen.push(capability); return values.get(capability) ?? null; },
    async set(capability, secret) { values.set(capability, secret); },
    async delete(capability) { values.delete(capability); },
  });
  try {
    for (const capability of ["exportIdentity", "accountObservation", "claudeSessionPseudonym", "contributionDevice"]) {
      const { service, account } = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES[capability];
      assert.equal(await f.binding.getPassword(service, account), null);
      await f.binding.setPassword(service, account, "a".repeat(43));
      assert.equal(await f.binding.getPassword(service, account), "a".repeat(43));
      await f.binding.deletePassword(service, account);
      assert.equal(await f.binding.getPassword(service, account), null);
    }
    assert.deepEqual([...new Set(seen)], ["export_identity", "account_observation", "claude_session_pseudonym", "contribution_device"]);
    await assert.rejects(f.binding.getPassword("arbitrary_service", "installation"), { code: "invalid_configuration" });
  } finally { f.server.dispose(); f.client.destroy(); }
});

test("denied, locked and missing migration authority never become absent credentials", async () => {
  for (const code of ["KEYCHAIN_DENIED", "KEYCHAIN_LOCKED", "KEYCHAIN_MIGRATION_REQUIRED"]) {
    let writes = 0;
    const f = fixture({
      async get() { throw Object.assign(new Error("SYNTHETIC_PRIVATE_ERROR"), { code }); },
      async set() { writes += 1; },
      async delete() { writes += 1; },
    });
    try {
      const capability = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity;
      await assert.rejects(f.binding.getPassword(capability.service, capability.account), { code });
      assert.equal(writes, 0);
    } finally { f.server.dispose(); f.client.destroy(); }
  }
});

test("malformed, replayed, oversized and queued requests close the private channel", async () => {
  const valid = { v: 2, id: 1, op: "get", capability: "export_identity" };
  for (const wire of [
    JSON.stringify({ ...valid, service: "injected" }) + "\n",
    JSON.stringify({ ...valid, capability: "unknown" }) + "\n",
    JSON.stringify({ ...valid, id: 0 }) + "\n",
    "x".repeat(4097),
  ]) {
    let calls = 0;
    const f = fixture({ get: async () => { calls += 1; return null; }, set: async () => {}, delete: async () => {} });
    f.parent.emit("data", wire);
    assert.equal(f.parent.destroyed, true);
    assert.equal(calls, 0);
    f.client.destroy();
  }
  const replay = fixture({ get: async () => null, set: async () => {}, delete: async () => {} });
  replay.parent.emit("data", `${JSON.stringify(valid)}\n${JSON.stringify(valid)}\n`);
  assert.equal(replay.parent.destroyed, true);
  replay.client.destroy();
  let finish;
  let calls = 0;
  const f = fixture({ get: async () => { calls += 1; await new Promise((resolve) => { finish = resolve; }); return null; }, set: async () => {}, delete: async () => {} });
  for (let id = 1; id <= 33; id += 1) f.parent.emit("data", `${JSON.stringify({ ...valid, id })}\n`);
  assert.equal(f.parent.destroyed, true);
  assert.equal(calls, 1);
  finish();
  f.client.destroy();
});

test("owned child uses its own credential descriptor with sharing on or off", {
  skip: process.platform === "win32" ? "macOS credential transport uses a POSIX descriptor" : false,
}, async () => {
  const brokerUrl = new URL("../../../src/contribution-device-keychain-broker.js", import.meta.url).href;
  for (const sharing of [false, true]) {
    const values = new Map();
    let requests = 0;
    const backend = {
      async get(capability) { requests += 1; return values.get(capability) ?? null; },
      async set(capability, secret) { requests += 1; values.set(capability, secret); },
      async delete(capability) { values.delete(capability); },
    };
    const supervisor = createCompanionSupervisor({
      command: process.execPath,
      args: ["--input-type=module", "--eval", `
        import { createMacOSKeychainBrokerBindingFromEnvironment } from ${JSON.stringify(brokerUrl)};
        import assert from 'node:assert/strict';
        assert.equal(process.env.USAGE_MONITOR_KEYCHAIN_BROKER_FD, '4');
        for (const name of ['account-observation', 'export-identity', 'claude-session-pseudonym', 'contribution-device']) {
          // Separate consumer factories must share the descriptor and request
          // sequence, just as the production credential consumers do.
          const binding = createMacOSKeychainBrokerBindingFromEnvironment();
          const service = 'app-usagemonitor.' + name + '.v1';
          assert.equal(await binding.getPassword(service, 'installation'), null);
          await binding.setPassword(service, 'installation', 'a'.repeat(43));
          assert.equal(await binding.getPassword(service, 'installation'), 'a'.repeat(43));
        }
        process.stdout.write('USAGE_MONITOR_READY http://127.0.0.1:4545/\\n');
        setInterval(() => {}, 1000);
      `],
      environment: { USAGE_MONITOR_KEYCHAIN_BROKER_FD: "99" },
      attachCredentialBroker: (stream) => attachDesktopKeychainBroker({ stream, backend }),
      ...(sharing ? { attachPrivateChannel: () => ({ dispose() {}, invalidate() {} }) } : {}),
    });
    try {
      await supervisor.start();
      assert.equal(requests, 12);
      assert.equal(values.size, 4);
    } finally { await supervisor.stop(); }
  }
});

test("shutdown discards queued operations and sends no late credential response", async () => {
  let finish;
  const calls = [];
  const f = fixture({
    get: async () => { calls.push("get"); await new Promise((resolve) => { finish = resolve; }); return "a".repeat(43); },
    set: async () => { calls.push("set"); }, delete: async () => {},
  });
  f.parent.emit("data", JSON.stringify({ v: 2, id: 1, op: "get", capability: "export_identity" }) + "\n");
  f.parent.emit("data", JSON.stringify({ v: 2, id: 2, op: "set", capability: "export_identity", secret: "b".repeat(43) }) + "\n");
  f.server.dispose();
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["get"]);
  assert.equal(f.parent.destroyed, true);
  f.client.destroy();
});
