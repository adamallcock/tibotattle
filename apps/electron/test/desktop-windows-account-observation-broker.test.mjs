import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
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
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_INTEGRATION_STATUS as CHILD_INTEGRATION_STATUS,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_REQUEST_KIND,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_RESPONSE_KIND,
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
const ACCOUNTLESS_SCHEMA = "accountless-process-v1";

function channelPair({ childSendReturnsFalse = false, parentSendReturnsFalse = false } = {}) {
  const parent = new EventEmitter();
  const child = new EventEmitter();
  parent.connected = true;
  child.connected = true;
  parent.sendReturnsFalse = parentSendReturnsFalse;
  child.sendReturnsFalse = childSendReturnsFalse;

  function wire(sender, recipient) {
    sender.send = (message, callback = undefined) => {
      if (sender.connected === false || recipient.connected === false) {
        queueMicrotask(() => callback?.(new Error("channel unavailable")));
        return false;
      }
      queueMicrotask(() => {
        if (recipient.connected !== false) recipient.emit("message", message);
        callback?.(recipient.connected === false ? new Error("channel unavailable") : null);
      });
      return sender.sendReturnsFalse !== true;
    };
    sender.disconnect = () => {
      if (sender.connected === false) return;
      sender.connected = false;
      recipient.connected = false;
      sender.emit("disconnect");
      recipient.emit("disconnect");
    };
  }
  wire(parent, child);
  wire(child, parent);
  return Object.freeze({ child, parent });
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

function request(id, operation = "read", secret = undefined) {
  const frame = {
    schemaVersion: WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA,
    kind: WINDOWS_ACCOUNT_OBSERVATION_BROKER_REQUEST_KIND,
    v: WINDOWS_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION,
    id,
    op: operation,
  };
  if (secret !== undefined) frame.secret = secret;
  return Object.freeze(frame);
}

function response(id, value = { ok: true, secret: null }) {
  return Object.freeze({
    schemaVersion: WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA,
    kind: WINDOWS_ACCOUNT_OBSERVATION_BROKER_RESPONSE_KIND,
    v: WINDOWS_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION,
    id,
    ...value,
  });
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
    assert.equal(closed, false, "synthetic manager must stay open while owned IPC is live");
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
  const wires = channelPair(options.channelOptions);
  const synthetic = createSyntheticManager(options);
  const parentCredential = createWindowsAccountObservationCredentialBackend({
    platform: "win32",
    architecture: "x64",
    createCredentialManagerBackend: () => synthetic.manager,
  });
  const server = attachDesktopWindowsAccountObservationBroker({
    channel: wires.parent,
    createBackend: () => parentCredential,
  });
  const transport = createWindowsAccountObservationBrokerTransport({
    channel: wires.child,
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
}

test("Windows account-observation IPC is dormant, exact, and unavailable without explicit composition", async () => {
  assert.equal(PARENT_INTEGRATION_STATUS, "dormant");
  assert.equal(CHILD_INTEGRATION_STATUS, "dormant");
  assert.equal(windowsAccountObservationBrokerConfiguration({}), null);
  assert.deepEqual(windowsAccountObservationBrokerConfiguration({
    [WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV]: WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER,
  }), { ipc: true });
  for (const value of ["0", "2", "1 ", 1]) {
    assert.deepEqual(windowsAccountObservationBrokerConfiguration({
      [WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV]: value,
    }), { ipc: false });
  }
  for (const collision of [
    "USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_BROKER_FD",
    "USAGE_MONITOR_KEYCHAIN_BROKER_FD",
    "USAGE_MONITOR_LINUX_SECRET_SERVICE_BROKER_FD",
  ]) {
    assert.deepEqual(windowsAccountObservationBrokerConfiguration({
      [WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV]: WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER,
      [collision]: "4",
    }), { ipc: false });
  }

  let requests = 0;
  const unavailable = createWindowsAccountObservationBrokerBackend({
    transport: { async request() { requests += 1; } },
    available: false,
  });
  assert.deepEqual(await unavailable.describe(ACCOUNT_CAPABILITY), {
    backend: "windows_account_observation_broker",
    status: "unavailable",
  });
  await assert.rejects(unavailable.read(ACCOUNT_CAPABILITY), assertBrokerError("unavailable"));
  assert.equal(requests, 0);

  const malformed = createWindowsAccountObservationBrokerBackendFromEnvironment({
    [WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV]: "not-ipc",
  }, channelPair().child);
  assert.deepEqual(await malformed.describe(ACCOUNT_CAPABILITY), {
    backend: "windows_account_observation_broker",
    status: "unavailable",
  });
  await assert.rejects(malformed.createIfMissing(ACCOUNT_CAPABILITY, Buffer.alloc(32, 2)),
    assertBrokerError("unavailable"));
  assert.equal(createWindowsAccountObservationBrokerBackendFromEnvironment({
    USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_BROKER_FD: "4",
  }, channelPair().child), null);

  assert.throws(() => createWindowsAccountObservationBrokerTransport({ channel: null }),
    assertBrokerError("invalid_configuration"));

  const disconnected = channelPair();
  disconnected.parent.connected = false;
  let constructed = false;
  assert.throws(() => attachDesktopWindowsAccountObservationBroker({
    channel: disconnected.parent,
    createBackend() {
      constructed = true;
      throw new Error("must not construct for a disconnected child");
    },
  }), assertBrokerError("invalid_configuration"));
  assert.equal(constructed, false);
  assert.equal(disconnected.parent.listenerCount("message"), 0);
  assert.equal(disconnected.parent.listenerCount("disconnect"), 0);

  const source = await readFile(
    new URL("../../../src/platform/windows-account-observation-broker.js", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes('from "node:net"'), false);
  assert.equal(source.includes('from "./windows-credential-manager.js"'), false);
  assert.equal(source.includes('from "keytar"'), false);
});

test("Windows observation IPC keeps fixed capability, parent mutation lease, and secret cleanup end to end", async () => {
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

test("Windows observation IPC redacts parent failures and closes a rejected parent factory", async () => {
  for (const [failure, code, canary] of [
    [new WindowsCredentialManagerError("locked"), "locked", null],
    [Object.assign(new Error("WINDOWS-IPC-PRIVATE-CANARY"), { code: "private_canary" }), "unavailable", "WINDOWS-IPC-PRIVATE-CANARY"],
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

  const wires = channelPair();
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
    channel: wires.parent,
    createBackend: () => rejected,
  }), assertBrokerError("invalid_configuration"));
  assert.equal(closeCalls, 1);
});

test("Windows observation IPC preserves ordered replies, ignores accountless frames, and honors callback delivery over send backpressure", async () => {
  const writes = [];
  const channel = new EventEmitter();
  channel.connected = true;
  channel.send = (frame, callback) => {
    writes.push(frame);
    if (writes.length === 2) {
      queueMicrotask(() => {
        channel.emit("message", Object.freeze({
          schemaVersion: ACCOUNTLESS_SCHEMA,
          kind: "response",
          id: 1,
          ok: true,
          value: null,
        }));
        for (const item of writes) channel.emit("message", response(item.id));
      });
    }
    queueMicrotask(() => callback?.(null));
    return false;
  };
  const ordered = createWindowsAccountObservationBrokerTransport({ channel, timeoutMs: 1_000 });
  assert.deepEqual(await Promise.all([
    ordered.request({ op: "read" }),
    ordered.request({ op: "read" }),
  ]), [{ ok: true, secret: null }, { ok: true, secret: null }]);
  assert.deepEqual(writes.map((entry) => entry.id), [1, 2]);
  assert.equal(channel.connected, true);
  ordered.dispose();

  const malformedChannel = new EventEmitter();
  malformedChannel.connected = true;
  malformedChannel.send = (frame, callback) => {
    queueMicrotask(() => {
      malformedChannel.emit("message", response(frame.id + 1));
      callback?.(null);
    });
    return true;
  };
  const malformed = createWindowsAccountObservationBrokerTransport({
    channel: malformedChannel,
    timeoutMs: 1_000,
  });
  await assert.rejects(malformed.request({ op: "read" }), assertBrokerError("protocol"));
  await assert.rejects(malformed.request({ op: "read" }), assertBrokerError("protocol"));
  assert.equal(malformedChannel.connected, true);

  const silentChannel = new EventEmitter();
  silentChannel.connected = true;
  silentChannel.send = (_frame, callback) => { queueMicrotask(() => callback?.(null)); return true; };
  const timeout = createWindowsAccountObservationBrokerTransport({
    channel: silentChannel,
    timeoutMs: 5,
  });
  const keepAlive = setInterval(() => {}, 50);
  try {
    await assert.rejects(timeout.request({ op: "read" }), assertBrokerError("timeout"));
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(silentChannel.connected, true);

  const disposableChannel = new EventEmitter();
  disposableChannel.connected = true;
  disposableChannel.send = (_frame, callback) => { queueMicrotask(() => callback?.(null)); return true; };
  const disposable = createWindowsAccountObservationBrokerTransport({
    channel: disposableChannel,
    timeoutMs: 1_000,
  });
  const pending = disposable.request({ op: "read" });
  disposable.dispose();
  await assert.rejects(pending, assertBrokerError("unavailable"));
  await assert.rejects(disposable.request({ op: "read" }), assertBrokerError("unavailable"));
  assert.equal(disposableChannel.connected, true);
});

test("Windows observation IPC parent bounds queued requests, leaves accountless listeners intact, and never responds after disposal", async () => {
  const malformed = fixture();
  let accountlessMessages = 0;
  malformed.parent.on("message", (frame) => {
    if (frame?.schemaVersion === ACCOUNTLESS_SCHEMA) accountlessMessages += 1;
  });
  try {
    malformed.child.send(Object.freeze({
      schemaVersion: ACCOUNTLESS_SCHEMA,
      kind: "request",
      id: 1,
      operation: "read",
      value: null,
    }));
    await nextTurn();
    assert.equal(accountlessMessages, 1);
    assert.equal(malformed.synthetic.calls.length, 0);
    malformed.child.send(Object.freeze({
      schemaVersion: WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA,
      kind: WINDOWS_ACCOUNT_OBSERVATION_BROKER_REQUEST_KIND,
      v: WINDOWS_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION,
      id: 1,
      op: "read",
      capability: "export_identity",
    }));
    await nextTurn();
    assert.equal(malformed.parent.connected, true);
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
  f.child.on("message", (value) => {
    if (value?.schemaVersion === WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA) replies.push(value);
  });
  try {
    f.child.send(request(1));
    await readStarted;
    for (let id = 2; id <= 33; id += 1) f.child.send(request(id));
    await nextTurn();
    assert.equal(f.parent.connected, true);
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
