import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Duplex } from "node:stream";
import test from "node:test";

import {
  LINUX_SECRET_SERVICE_BROKER_INTEGRATION_STATUS as PARENT_INTEGRATION_STATUS,
  attachDesktopLinuxSecretServiceBroker,
} from "../desktop-linux-secret-service-broker.js";
import { createCompanionSupervisor } from "../companion-supervisor.js";
import {
  LINUX_SECRET_SERVICE_BROKER_CAPABILITIES,
  LINUX_SECRET_SERVICE_BROKER_FD_ENV,
  LINUX_SECRET_SERVICE_BROKER_INTEGRATION_STATUS as CHILD_INTEGRATION_STATUS,
  LinuxSecretServiceBrokerError,
  createLinuxSecretServiceBrokerBackend,
  createLinuxSecretServiceBrokerBackendFromEnvironment,
  createLinuxSecretServiceBrokerTransport,
  linuxSecretServiceBrokerConfiguration,
} from "../../../src/platform/linux-secret-service-broker.js";
import {
  LinuxSecretServiceError,
  isLinuxSecretServiceError,
} from "../../../src/platform/linux-secret-service.js";

function pair() {
  let client;
  let parent;
  const side = (peer) => new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      queueMicrotask(() => { peer().push(Buffer.from(chunk)); done(); });
    },
    destroy(error, done) { peer()?.push(null); done(error); },
  });
  client = side(() => parent);
  parent = side(() => client);
  return { client, parent };
}

function capabilityKey(capability) {
  if (capability === LINUX_SECRET_SERVICE_BROKER_CAPABILITIES.exportIdentity) {
    return "export_identity";
  }
  if (capability === LINUX_SECRET_SERVICE_BROKER_CAPABILITIES.accountObservation) {
    return "account_observation";
  }
  assert.fail("unexpected capability");
}

function assertSyntheticSecret(value) {
  assert.equal(Buffer.isBuffer(value), true);
  assert.equal(value.byteLength, 32);
}

function createSyntheticLinuxBackend({ failRead = null } = {}) {
  const values = new Map();
  const leases = new WeakMap();
  const calls = [];
  let closeCalls = 0;
  let closed = false;

  function assertOpen() {
    assert.equal(closed, false, "synthetic Linux backend must remain open while the broker is live");
  }

  function assertLease(lease, capability, operation) {
    assert.deepEqual(leases.get(lease), { capability, operation });
  }

  const backend = Object.freeze({
    crossProcessSafe: true,
    crashRecoveryComplete: false,
    productionSafe: false,
    async read(capability) {
      assertOpen();
      const key = capabilityKey(capability);
      calls.push(["read", key]);
      if (failRead !== null) throw failRead;
      const current = values.get(key);
      return current === undefined ? null : Buffer.from(current);
    },
    async withOperationLease(capability, options, callback) {
      assertOpen();
      const key = capabilityKey(capability);
      assert.equal(Object.keys(options).join(","), "operation");
      assert.ok(["create", "replace", "delete"].includes(options.operation));
      const lease = Object.freeze(Object.create(null));
      leases.set(lease, { capability, operation: options.operation });
      calls.push(["lease", key, options.operation]);
      return callback(lease);
    },
    async createIfMissing(capability, secret, lease) {
      assertOpen();
      const key = capabilityKey(capability);
      assertLease(lease, capability, "create");
      assertSyntheticSecret(secret);
      calls.push(["create", key]);
      if (values.has(key)) return "existing";
      values.set(key, Buffer.from(secret));
      return "created";
    },
    async replaceExact(capability, expected, replacement, lease) {
      assertOpen();
      const key = capabilityKey(capability);
      assertLease(lease, capability, "replace");
      assertSyntheticSecret(expected);
      assertSyntheticSecret(replacement);
      calls.push(["replace", key]);
      const current = values.get(key);
      if (current === undefined) return "missing";
      if (!current.equals(expected)) return "conflict";
      values.set(key, Buffer.from(replacement));
      return "replaced";
    },
    async deleteExact(capability, expected, lease) {
      assertOpen();
      const key = capabilityKey(capability);
      assertLease(lease, capability, "delete");
      assertSyntheticSecret(expected);
      calls.push(["delete", key]);
      const current = values.get(key);
      if (current === undefined) return "missing";
      if (!current.equals(expected)) return "conflict";
      values.delete(key);
      return "deleted";
    },
    close() {
      if (closed) return;
      closed = true;
      closeCalls += 1;
    },
  });
  return Object.freeze({
    backend,
    calls,
    values,
    get closeCalls() { return closeCalls; },
    get closed() { return closed; },
  });
}

function fixture(options = {}) {
  const wires = pair();
  const synthetic = createSyntheticLinuxBackend(options);
  const server = attachDesktopLinuxSecretServiceBroker({
    stream: wires.parent,
    createBackend: () => synthetic.backend,
    isBackendError: isLinuxSecretServiceError,
  });
  const transport = createLinuxSecretServiceBrokerTransport({
    fd: 4,
    connect: () => wires.client,
    timeoutMs: 1_000,
  });
  return Object.freeze({
    ...wires,
    synthetic,
    server,
    backend: createLinuxSecretServiceBrokerBackend({ transport }),
  });
}

function transportSocket(onWrite) {
  let socket;
  socket = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      onWrite(String(chunk), socket);
      done();
    },
  });
  return socket;
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function readAndAssert(backend, capability, expected) {
  const value = await backend.read(capability);
  try {
    assert.deepEqual(value, expected);
  } finally {
    value?.fill(0);
  }
}

test("Linux broker is explicitly dormant and exposes only two capability identities", async () => {
  assert.equal(PARENT_INTEGRATION_STATUS, "dormant");
  assert.equal(CHILD_INTEGRATION_STATUS, "dormant");
  assert.deepEqual(Object.keys(LINUX_SECRET_SERVICE_BROKER_CAPABILITIES).sort(), [
    "accountObservation",
    "exportIdentity",
  ]);
  assert.equal(linuxSecretServiceBrokerConfiguration({}), null);
  assert.deepEqual(linuxSecretServiceBrokerConfiguration({
    [LINUX_SECRET_SERVICE_BROKER_FD_ENV]: "4",
  }), { fd: 4 });
  for (const value of ["0", "3", "5", "04", "4 ", 4]) {
    assert.deepEqual(linuxSecretServiceBrokerConfiguration({
      [LINUX_SECRET_SERVICE_BROKER_FD_ENV]: value,
    }), { fd: null });
  }
  assert.deepEqual(linuxSecretServiceBrokerConfiguration({
    [LINUX_SECRET_SERVICE_BROKER_FD_ENV]: "4",
    USAGE_MONITOR_KEYCHAIN_BROKER_FD: "4",
  }), { fd: null });
  assert.throws(
    () => createLinuxSecretServiceBrokerTransport({ fd: 3 }),
    (error) => error?.code === "linux_secret_service_broker_invalid_configuration",
  );
  const environment = { [LINUX_SECRET_SERVICE_BROKER_FD_ENV]: "4" };
  assert.equal(
    createLinuxSecretServiceBrokerBackendFromEnvironment(environment),
    createLinuxSecretServiceBrokerBackendFromEnvironment(environment),
  );
  const unavailable = createLinuxSecretServiceBrokerBackendFromEnvironment({
    [LINUX_SECRET_SERVICE_BROKER_FD_ENV]: "3",
  });
  assert.deepEqual(
    await unavailable.describe(LINUX_SECRET_SERVICE_BROKER_CAPABILITIES.exportIdentity),
    { backend: "linux_secret_service_broker", status: "unavailable" },
  );
  await assert.rejects(
    unavailable.read(LINUX_SECRET_SERVICE_BROKER_CAPABILITIES.exportIdentity),
    (error) => error?.code === "linux_secret_service_broker_invalid_configuration",
  );
  let nullDescriptorConnects = 0;
  const nullDescriptorTransport = createLinuxSecretServiceBrokerTransport({
    fd: null,
    connect() {
      nullDescriptorConnects += 1;
      throw new Error("must not construct an unconnected socket");
    },
  });
  await assert.rejects(
    nullDescriptorTransport.request({ op: "read", capability: "export_identity" }),
    (error) => error?.code === "linux_secret_service_broker_invalid_configuration",
  );
  assert.equal(nullDescriptorConnects, 0);
  const childSource = await readFile(
    new URL("../../../src/platform/linux-secret-service-broker.js", import.meta.url),
    "utf8",
  );
  assert.equal(childSource.includes("./linux-secret-service.js"), false);
  assert.equal(childSource.includes("./export-identity-keychain.js"), false);
});

test("Linux broker bounds each frame while accepting legal coalesced frames", async () => {
  const wires = pair();
  const synthetic = createSyntheticLinuxBackend();
  const server = attachDesktopLinuxSecretServiceBroker({
    stream: wires.parent,
    createBackend: () => synthetic.backend,
    isBackendError: isLinuxSecretServiceError,
  });
  try {
    wires.parent.emit("data", [
      { v: 1, id: 1, op: "read", capability: "export_identity" },
      { v: 1, id: 2, op: "read", capability: "account_observation" },
    ].map((frame) => `${JSON.stringify(frame)}\n`).join(""));
    await nextTurn();
    assert.deepEqual(
      synthetic.calls.filter(([operation]) => operation === "read"),
      [["read", "export_identity"], ["read", "account_observation"]],
    );
    assert.equal(wires.parent.destroyed, false);
    wires.parent.emit("data", "x".repeat(4_097));
    assert.equal(wires.parent.destroyed, true);
  } finally {
    server.dispose();
    wires.client.destroy();
  }
});

test("Linux child transport preserves ordered IDs across local refusal and poisons malformed replies", async () => {
  const writes = [];
  let connects = 0;
  const socket = transportSocket((frame, stream) => {
    const request = JSON.parse(frame);
    writes.push(request);
    queueMicrotask(() => stream.push(`${JSON.stringify({
      id: request.id,
      ok: true,
      secret: null,
    })}\n`));
  });
  const transport = createLinuxSecretServiceBrokerTransport({
    fd: 4,
    connect: () => {
      connects += 1;
      return socket;
    },
    timeoutMs: 1_000,
  });
  await assert.rejects(
    transport.request({
      op: "create_if_missing",
      capability: "export_identity",
      secret: "a".repeat(4_096),
    }),
    (error) => error?.code === "linux_secret_service_broker_invalid_configuration",
  );
  assert.equal(connects, 0);
  assert.deepEqual(
    await transport.request({ op: "read", capability: "export_identity" }),
    { ok: true, secret: null },
  );
  assert.equal(connects, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, 1);
  socket.destroy();

  let malformedWrites = 0;
  const malformedSocket = transportSocket((frame, stream) => {
    malformedWrites += 1;
    const request = JSON.parse(frame);
    queueMicrotask(() => stream.push(`${JSON.stringify({
      id: request.id,
      ok: true,
      secret: "not/canonical",
    })}\n`));
  });
  const malformed = createLinuxSecretServiceBrokerTransport({
    fd: 4,
    connect: () => malformedSocket,
    timeoutMs: 1_000,
  });
  const request = { op: "read", capability: "export_identity" };
  await assert.rejects(
    malformed.request(request),
    (error) => error?.code === "linux_secret_service_broker_protocol",
  );
  await assert.rejects(
    malformed.request(request),
    (error) => error?.code === "linux_secret_service_broker_protocol",
  );
  assert.equal(malformedWrites, 1);
});

test("Linux child transport accepts coalesced replies and rejects one oversized tail", async () => {
  const writes = [];
  const socket = transportSocket((frame, stream) => {
    writes.push(JSON.parse(frame));
    if (writes.length === 2) {
      queueMicrotask(() => stream.push(writes.map((request) => `${JSON.stringify({
        id: request.id,
        ok: true,
        secret: null,
      })}\n`).join("")));
    }
  });
  const transport = createLinuxSecretServiceBrokerTransport({
    fd: 4,
    connect: () => socket,
    timeoutMs: 1_000,
  });
  assert.deepEqual(await Promise.all([
    transport.request({ op: "read", capability: "export_identity" }),
    transport.request({ op: "read", capability: "account_observation" }),
  ]), [{ ok: true, secret: null }, { ok: true, secret: null }]);
  socket.destroy();

  const oversizedSocket = transportSocket((_frame, stream) => {
    queueMicrotask(() => stream.push("x".repeat(4_097)));
  });
  const oversized = createLinuxSecretServiceBrokerTransport({
    fd: 4,
    connect: () => oversizedSocket,
    timeoutMs: 1_000,
  });
  await assert.rejects(
    oversized.request({ op: "read", capability: "export_identity" }),
    (error) => error?.code === "linux_secret_service_broker_protocol",
  );
  await assert.rejects(
    oversized.request({ op: "read", capability: "export_identity" }),
    (error) => error?.code === "linux_secret_service_broker_protocol",
  );
});

test("Linux broker preserves conditional capability mutations under the parent lease", async () => {
  const f = fixture();
  try {
    for (const [offset, capability] of [
      LINUX_SECRET_SERVICE_BROKER_CAPABILITIES.exportIdentity,
      LINUX_SECRET_SERVICE_BROKER_CAPABILITIES.accountObservation,
    ].entries()) {
      const original = Buffer.alloc(32, offset + 1);
      const replacement = Buffer.alloc(32, offset + 11);
      const conflicting = Buffer.alloc(32, offset + 21);
      assert.equal(await f.backend.read(capability), null);
      assert.equal(await f.backend.createIfMissing(capability, original), "created");
      assert.equal(await f.backend.createIfMissing(capability, original), "existing");
      await readAndAssert(f.backend, capability, original);
      assert.equal(await f.backend.replaceExact(capability, conflicting, replacement), "conflict");
      assert.equal(await f.backend.replaceExact(capability, original, replacement), "replaced");
      assert.equal(await f.backend.deleteExact(capability, conflicting), "conflict");
      assert.equal(await f.backend.deleteExact(capability, replacement), "deleted");
      assert.equal(await f.backend.read(capability), null);
      original.fill(0);
      replacement.fill(0);
      conflicting.fill(0);
    }
    assert.equal(f.synthetic.calls.some(([operation]) => operation === "get" || operation === "set"), false);
    assert.deepEqual(
      f.synthetic.calls.filter(([operation]) => operation === "lease").map((entry) => entry.slice(1)),
      [
        ["export_identity", "create"], ["export_identity", "create"],
        ["export_identity", "replace"], ["export_identity", "replace"],
        ["export_identity", "delete"], ["export_identity", "delete"],
        ["account_observation", "create"], ["account_observation", "create"],
        ["account_observation", "replace"], ["account_observation", "replace"],
        ["account_observation", "delete"], ["account_observation", "delete"],
      ],
    );
  } finally {
    f.server.dispose();
    f.client.destroy();
  }
  assert.equal(f.synthetic.closeCalls, 1);
});

test("Linux broker rejects capability widening, malformed frames, and generic legacy adapters", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.backend.read({ service: "arbitrary", account: "arbitrary" }),
      (error) => error?.code === "linux_secret_service_broker_invalid_configuration",
    );
    f.parent.emit("data", `${JSON.stringify({
      v: 1,
      id: 1,
      op: "read",
      capability: "contribution_device",
    })}\n`);
    assert.equal(f.parent.destroyed, true);
    assert.equal(f.synthetic.calls.length, 0);
  } finally {
    f.server.dispose();
    f.client.destroy();
  }

  const wires = pair();
  assert.throws(
    () => attachDesktopLinuxSecretServiceBroker({
      stream: wires.parent,
      createBackend: () => ({
        async get() {}, async set() {}, async delete() {},
      }),
      isBackendError: isLinuxSecretServiceError,
    }),
    (error) => error?.code === "linux_secret_service_broker_invalid_configuration",
  );
  wires.client.destroy();
  wires.parent.destroy();
});

test("Linux broker collapses parent failures to fixed child errors", async () => {
  const f = fixture({ failRead: new LinuxSecretServiceError("locked") });
  try {
    await assert.rejects(
      f.backend.read(LINUX_SECRET_SERVICE_BROKER_CAPABILITIES.exportIdentity),
      (error) => error?.code === "linux_secret_service_broker_locked"
        && !String(error.message).includes("LINUX_SECRET_SERVICE"),
    );
  } finally {
    f.server.dispose();
    f.client.destroy();
  }
});

test("owned supervisor supplies only the Linux FD4 marker to a real synthetic child", {
  skip: process.platform === "win32" ? "inherited socketpair descriptor requires POSIX coverage" : false,
}, async () => {
  const brokerUrl = new URL("../../../src/platform/linux-secret-service-broker.js", import.meta.url).href;
  const synthetic = createSyntheticLinuxBackend();
  const supervisor = createCompanionSupervisor({
    command: process.execPath,
    args: ["--input-type=module", "--eval", `
      import assert from 'node:assert/strict';
      import {
        LINUX_SECRET_SERVICE_BROKER_CAPABILITIES,
        createLinuxSecretServiceBrokerBackendFromEnvironment,
      } from ${JSON.stringify(brokerUrl)};
      assert.equal(process.env.${LINUX_SECRET_SERVICE_BROKER_FD_ENV}, '4');
      assert.equal(process.env.USAGE_MONITOR_KEYCHAIN_BROKER_FD, undefined);
      const backend = createLinuxSecretServiceBrokerBackendFromEnvironment();
      assert.notEqual(backend, null);
      for (const [capability, first, second] of [
        [LINUX_SECRET_SERVICE_BROKER_CAPABILITIES.exportIdentity, 31, 32],
        [LINUX_SECRET_SERVICE_BROKER_CAPABILITIES.accountObservation, 41, 42],
      ]) {
        const initial = Buffer.alloc(32, first);
        const replacement = Buffer.alloc(32, second);
        assert.equal(await backend.createIfMissing(capability, initial), 'created');
        const observed = await backend.read(capability);
        assert.deepEqual(observed, initial);
        observed.fill(0);
        assert.equal(await backend.replaceExact(capability, initial, replacement), 'replaced');
        assert.equal(await backend.deleteExact(capability, replacement), 'deleted');
        initial.fill(0);
        replacement.fill(0);
      }
      process.stdout.write('USAGE_MONITOR_READY http://127.0.0.1:4545/\\n');
      setInterval(() => {}, 1_000);
    `],
    environment: {
      USAGE_MONITOR_KEYCHAIN_BROKER_FD: "99",
      [LINUX_SECRET_SERVICE_BROKER_FD_ENV]: "88",
    },
    attachLinuxSecretServiceBroker: (stream) => attachDesktopLinuxSecretServiceBroker({
      stream,
      createBackend: () => synthetic.backend,
      isBackendError: isLinuxSecretServiceError,
    }),
  });
  try {
    await supervisor.start();
    assert.deepEqual([...synthetic.values.keys()], []);
    assert.equal(synthetic.closed, false);
  } finally {
    await supervisor.stop();
  }
  assert.equal(synthetic.closeCalls, 1);
  assert.equal(synthetic.calls.filter(([operation]) => operation === "lease").length, 6);
});

test("supervisor refuses simultaneous macOS and Linux FD4 brokers", () => {
  assert.throws(
    () => createCompanionSupervisor({
      attachCredentialBroker: () => ({ dispose() {} }),
      attachLinuxSecretServiceBroker: () => ({ dispose() {} }),
    }),
    /mutually exclusive/u,
  );
});
