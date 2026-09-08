import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Duplex } from "node:stream";
import test from "node:test";

import {
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_INTEGRATION_STATUS as PARENT_INTEGRATION_STATUS,
  attachDesktopWindowsAccountObservationBroker,
} from "../desktop-windows-account-observation-broker.js";
import {
  AccountObservationSecretError,
  createAccountObservationSecretLoader,
} from "../../../src/account-observation-secret.js";
import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "../../../src/export-identity-keychain.js";
import {
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_FD_ENV,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_INTEGRATION_STATUS as CHILD_INTEGRATION_STATUS,
  WindowsAccountObservationBrokerError,
  createWindowsAccountObservationBrokerBackend,
  createWindowsAccountObservationBrokerBackendFromEnvironment,
  createWindowsAccountObservationBrokerTransport,
  windowsAccountObservationBrokerConfiguration,
} from "../../../src/platform/windows-account-observation-broker.js";
import {
  createWindowsAccountObservationCredentialBackend,
} from "../../../src/platform/windows-account-observation-credential.js";
import {
  WindowsCredentialManagerError,
} from "../../../src/platform/windows-credential-manager.js";

const ACCOUNT_CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation;

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

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function assertBrokerError(code) {
  return (error) => {
    assert.equal(error instanceof WindowsAccountObservationBrokerError, true);
    assert.equal(error.code, `windows_account_observation_broker_${code}`);
    assert.equal(error.message, "Windows account observation broker operation failed");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}

function createSyntheticManager({ initial = null, readFailure = null, readGate = null, onRead = null } = {}) {
  let stored = initial === null ? null : Buffer.from(initial);
  let closeCalls = 0;
  let closed = false;
  const calls = [];
  const leases = new WeakMap();
  const rawReadValues = [];
  const receivedCandidates = [];

  function assertOpen() {
    assert.equal(closed, false, "synthetic manager must stay open while FD4 is live");
  }

  const manager = Object.freeze({
    crossProcessSafe: true,
    auditDurable: true,
    auditFilesystemProtected: true,
    startupRecoveryComplete: true,
    productionSafe: false,
    async read(capability) {
      assertOpen();
      assert.equal(capability, ACCOUNT_CAPABILITY);
      calls.push(["read"]);
      onRead?.();
      if (readFailure !== null) throw readFailure;
      if (readGate !== null) await readGate;
      if (stored === null) return null;
      const value = Buffer.from(stored);
      rawReadValues.push(value);
      return value;
    },
    async withOperationLease(capability, options, callback) {
      assertOpen();
      assert.equal(capability, ACCOUNT_CAPABILITY);
      assert.deepEqual(options, { operation: "create" });
      const lease = Object.freeze(Object.create(null));
      leases.set(lease, { capability, operation: options.operation });
      calls.push(["lease", options.operation]);
      return callback(lease);
    },
    async createIfMissing(capability, candidate, lease) {
      assertOpen();
      assert.equal(capability, ACCOUNT_CAPABILITY);
      assert.deepEqual(leases.get(lease), { capability, operation: "create" });
      assert.equal(Buffer.isBuffer(candidate), true);
      assert.equal(candidate.byteLength, 32);
      calls.push(["create"]);
      receivedCandidates.push(candidate);
      if (stored !== null) return "existing";
      stored = Buffer.from(candidate);
      return "created";
    },
    close() {
      if (closed) return;
      closed = true;
      closeCalls += 1;
    },
  });

  return Object.freeze({
    manager,
    calls,
    rawReadValues,
    receivedCandidates,
    stored() { return stored === null ? null : Buffer.from(stored); },
    get closeCalls() { return closeCalls; },
    get closed() { return closed; },
  });
}

function fixture(options = {}) {
  const wires = pair();
  const synthetic = createSyntheticManager(options);
  const parentCredential = createWindowsAccountObservationCredentialBackend({
    platform: "win32",
    architecture: "x64",
    createCredentialManagerBackend: () => synthetic.manager,
  });
  const server = attachDesktopWindowsAccountObservationBroker({
    stream: wires.parent,
    createBackend: () => parentCredential,
  });
  const transport = createWindowsAccountObservationBrokerTransport({
    fd: 4,
    connect: () => wires.client,
    timeoutMs: 1_000,
  });
  return Object.freeze({
    ...wires,
    synthetic,
    server,
    transport,
    backend: createWindowsAccountObservationBrokerBackend({ transport }),
  });
}

function disposeFixture(value) {
  value.server.dispose();
  value.transport.dispose();
  value.client.destroy();
  value.parent.destroy();
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

test("Windows FD4 is dormant, exact, and unavailable without its explicitly composed descriptor", async () => {
  assert.equal(PARENT_INTEGRATION_STATUS, "dormant");
  assert.equal(CHILD_INTEGRATION_STATUS, "dormant");
  assert.equal(windowsAccountObservationBrokerConfiguration({}), null);
  assert.deepEqual(windowsAccountObservationBrokerConfiguration({
    [WINDOWS_ACCOUNT_OBSERVATION_BROKER_FD_ENV]: "4",
  }), { fd: 4 });
  for (const value of ["0", "3", "5", "04", "4 ", 4]) {
    assert.deepEqual(windowsAccountObservationBrokerConfiguration({
      [WINDOWS_ACCOUNT_OBSERVATION_BROKER_FD_ENV]: value,
    }), { fd: null });
  }
  for (const collision of ["USAGE_MONITOR_KEYCHAIN_BROKER_FD", "USAGE_MONITOR_LINUX_SECRET_SERVICE_BROKER_FD"]) {
    assert.deepEqual(windowsAccountObservationBrokerConfiguration({
      [WINDOWS_ACCOUNT_OBSERVATION_BROKER_FD_ENV]: "4",
      [collision]: "4",
    }), { fd: null });
  }

  let connects = 0;
  const unavailable = createWindowsAccountObservationBrokerBackend({
    transport: { async request() { connects += 1; } },
    available: false,
  });
  assert.deepEqual(await unavailable.describe(ACCOUNT_CAPABILITY), {
    backend: "windows_account_observation_broker",
    status: "unavailable",
  });
  await assert.rejects(unavailable.read(ACCOUNT_CAPABILITY), assertBrokerError("unavailable"));
  assert.equal(connects, 0);

  const malformed = createWindowsAccountObservationBrokerBackendFromEnvironment({
    [WINDOWS_ACCOUNT_OBSERVATION_BROKER_FD_ENV]: "3",
  });
  assert.deepEqual(await malformed.describe(ACCOUNT_CAPABILITY), {
    backend: "windows_account_observation_broker",
    status: "unavailable",
  });
  await assert.rejects(malformed.createIfMissing(ACCOUNT_CAPABILITY, Buffer.alloc(32, 2)),
    assertBrokerError("unavailable"));

  let nullDescriptorConnects = 0;
  const nullDescriptorTransport = createWindowsAccountObservationBrokerTransport({
    fd: null,
    connect() {
      nullDescriptorConnects += 1;
      throw new Error("must not create an unannounced descriptor");
    },
  });
  await assert.rejects(nullDescriptorTransport.request({ op: "read" }),
    assertBrokerError("invalid_configuration"));
  assert.equal(nullDescriptorConnects, 0);

  const source = await readFile(
    new URL("../../../src/platform/windows-account-observation-broker.js", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes('from "./windows-credential-manager.js"'), false);
  assert.equal(source.includes('from "keytar"'), false);
});

test("Windows FD4 keeps the fixed capability, parent mutation lease, and secret cleanup end to end", async () => {
  const f = fixture();
  const source = Buffer.alloc(32, 71);
  let generated = null;
  try {
    const firstReads = await Promise.all([
      f.backend.read(ACCOUNT_CAPABILITY),
      f.backend.read(ACCOUNT_CAPABILITY),
    ]);
    assert.deepEqual(firstReads, [null, null]);

    assert.throws(() => createAccountObservationSecretLoader({
      backend: f.backend,
      capability: ACCOUNT_CAPABILITY,
      parentAuthoritativeMutationLease: true,
      operationLockFile: "/private/tmp/must-not-create-account-observation.lock",
    }), (error) => error instanceof AccountObservationSecretError
      && error.code === "account_observation_credential_invalid");

    const load = createAccountObservationSecretLoader({
      backend: f.backend,
      capability: ACCOUNT_CAPABILITY,
      parentAuthoritativeMutationLease: true,
      generateSecret() {
        generated = Buffer.from(source);
        return generated;
      },
    });
    const observed = await load();
    assert.deepEqual(observed, source);
    observed.fill(0);
    assert.deepEqual(f.synthetic.stored(), source);
    assert.deepEqual(f.synthetic.calls, [
      ["read"], ["read"], ["read"], ["lease", "create"], ["create"], ["read"],
    ]);
    assert.equal(generated.every((byte) => byte === 0), true);
    assert.equal(f.synthetic.receivedCandidates.every((value) => value.every((byte) => byte === 0)), true);
    assert.equal(f.synthetic.rawReadValues.every((value) => value.every((byte) => byte === 0)), true);
    await assert.rejects(
      f.backend.read(EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity),
      assertBrokerError("invalid_configuration"),
    );
  } finally {
    source.fill(0);
    disposeFixture(f);
  }
  assert.equal(f.synthetic.closeCalls, 1);
});

test("Windows FD4 redacts parent failures and closes a rejected parent factory", async () => {
  for (const [failure, code, canary] of [
    [new WindowsCredentialManagerError("locked"), "locked", null],
    [Object.assign(new Error("WINDOWS-FD4-PRIVATE-CANARY"), { code: "private_canary" }), "unavailable", "WINDOWS-FD4-PRIVATE-CANARY"],
  ]) {
    const f = fixture({ readFailure: failure });
    try {
      await assert.rejects(f.backend.read(ACCOUNT_CAPABILITY), (error) => {
        assert.equal(assertBrokerError(code)(error), true);
        assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes(canary ?? "different-canary"), false);
        return true;
      });
    } finally {
      disposeFixture(f);
    }
    assert.equal(f.synthetic.closeCalls, 1);
  }

  const wires = pair();
  let closeCalls = 0;
  const rejected = Object.freeze({
    close() { closeCalls += 1; },
    read() {},
    createIfMissing() {},
    crossProcessSafe: false,
    auditDurable: false,
    auditFilesystemProtected: false,
    startupRecoveryComplete: false,
    productionSafe: false,
  });
  assert.throws(() => attachDesktopWindowsAccountObservationBroker({
    stream: wires.parent,
    createBackend: () => rejected,
  }), assertBrokerError("invalid_configuration"));
  assert.equal(closeCalls, 1);
  wires.client.destroy();
  wires.parent.destroy();
});

test("Windows FD4 transport preserves ordering and poisons malformed, timed-out, or disposed channels", async () => {
  const writes = [];
  const orderedSocket = transportSocket((wire, stream) => {
    const request = JSON.parse(wire);
    writes.push(request);
    if (writes.length === 2) {
      queueMicrotask(() => stream.push(writes.map((entry) => `${JSON.stringify({
        id: entry.id,
        ok: true,
        secret: null,
      })}\n`).join("")));
    }
  });
  const ordered = createWindowsAccountObservationBrokerTransport({
    fd: 4,
    connect: () => orderedSocket,
    timeoutMs: 1_000,
  });
  assert.deepEqual(await Promise.all([
    ordered.request({ op: "read" }),
    ordered.request({ op: "read" }),
  ]), [{ ok: true, secret: null }, { ok: true, secret: null }]);
  assert.deepEqual(writes.map((entry) => entry.id), [1, 2]);
  ordered.dispose();

  const malformedSocket = transportSocket((wire, stream) => {
    const request = JSON.parse(wire);
    queueMicrotask(() => stream.push(`${JSON.stringify({
      id: request.id + 1,
      ok: true,
      secret: null,
    })}\n`));
  });
  const malformed = createWindowsAccountObservationBrokerTransport({
    fd: 4,
    connect: () => malformedSocket,
    timeoutMs: 1_000,
  });
  await assert.rejects(malformed.request({ op: "read" }), assertBrokerError("protocol"));
  await assert.rejects(malformed.request({ op: "read" }), assertBrokerError("protocol"));
  assert.equal(malformedSocket.destroyed, true);

  const silentSocket = transportSocket(() => {});
  const timeout = createWindowsAccountObservationBrokerTransport({
    fd: 4,
    connect: () => silentSocket,
    timeoutMs: 5,
  });
  const keepAlive = setInterval(() => {}, 50);
  try {
    await assert.rejects(timeout.request({ op: "read" }), assertBrokerError("timeout"));
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(silentSocket.destroyed, true);

  const disposableSocket = transportSocket(() => {});
  const disposable = createWindowsAccountObservationBrokerTransport({
    fd: 4,
    connect: () => disposableSocket,
    timeoutMs: 1_000,
  });
  const pending = disposable.request({ op: "read" });
  disposable.dispose();
  await assert.rejects(pending, assertBrokerError("unavailable"));
  await assert.rejects(disposable.request({ op: "read" }), assertBrokerError("unavailable"));
  assert.equal(disposableSocket.destroyed, true);
});

test("Windows FD4 parent bounds queued requests and never responds after disposal", async () => {
  const malformed = fixture();
  try {
    malformed.parent.emit("data", `${JSON.stringify({
      v: 1,
      id: 1,
      op: "read",
      capability: "export_identity",
    })}\n`);
    assert.equal(malformed.parent.destroyed, true);
    assert.deepEqual(malformed.synthetic.calls, []);
  } finally {
    disposeFixture(malformed);
  }
  assert.equal(malformed.synthetic.closeCalls, 1);

  let releaseRead;
  let observedRead;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  const readStarted = new Promise((resolve) => { observedRead = resolve; });
  const f = fixture({ readGate, onRead: observedRead });
  const replies = [];
  f.client.on("data", (value) => replies.push(String(value)));
  try {
    f.parent.emit("data", `${JSON.stringify({ v: 1, id: 1, op: "read" })}\n`);
    await readStarted;
    for (let id = 2; id <= 33; id += 1) {
      f.parent.emit("data", `${JSON.stringify({ v: 1, id, op: "read" })}\n`);
    }
    assert.equal(f.parent.destroyed, true);
    assert.deepEqual(f.synthetic.calls, [["read"]]);
    releaseRead();
    await nextTurn();
    assert.deepEqual(replies, []);
  } finally {
    releaseRead?.();
    disposeFixture(f);
  }
  assert.equal(f.synthetic.closeCalls, 1);
});
