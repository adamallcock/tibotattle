import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LINUX_ACCOUNT_OBSERVATION_BROKER_INTEGRATION_STATUS as PARENT_INTEGRATION_STATUS,
  attachDesktopLinuxAccountObservationBroker,
} from "../desktop-linux-account-observation-broker.js";
import {
  createAccountObservationSecretLoader,
} from "../../../src/account-observation-secret.js";
import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "../../../src/platform/keychain-capabilities.js";
import {
  LINUX_ACCOUNT_OBSERVATION_BROKER_INTEGRATION_STATUS as CHILD_INTEGRATION_STATUS,
  LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_ENV,
  LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER,
  LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA,
  LINUX_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION,
  LINUX_ACCOUNT_OBSERVATION_BROKER_REQUEST_KIND,
  LinuxAccountObservationBrokerError,
  createLinuxAccountObservationBrokerBackend,
  createLinuxAccountObservationBrokerBackendFromEnvironment,
  createLinuxAccountObservationBrokerTransport,
  isLinuxAccountObservationBrokerBackend,
  linuxAccountObservationBrokerConfiguration,
} from "../../../src/platform/linux-account-observation-broker.js";
import {
  LinuxAccountObservationCredentialError,
  createLinuxAccountObservationCredentialBackend,
  isLinuxAccountObservationCredentialBackend,
} from "../../../src/platform/linux-account-observation-credential.js";

const ACCOUNT_CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation;

function channelPair() {
  const parent = new EventEmitter();
  const child = new EventEmitter();
  parent.connected = true;
  child.connected = true;

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
      return true;
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
  return Object.freeze({ parent, child });
}

function nativeBinding({ readFailure = null } = {}) {
  let stored = null;
  const calls = [];
  const nativeCandidates = [];
  const binding = Object.freeze({
    credentialMutexContractVersion: "linux-credential-mutex-v1",
    credentialMutexCrossProcessSafe: true,
    credentialMutexSameNetworkNamespaceOnly: true,
    credentialMutexDurableMarker: true,
    productionSafe: false,
    async readAccountObservationCredential() {
      calls.push("read");
      if (readFailure !== null) throw readFailure;
      return stored === null ? null : Buffer.from(stored);
    },
    async createAccountObservationCredentialIfMissing(candidate) {
      assert.equal(Buffer.isBuffer(candidate), true);
      assert.equal(candidate.byteLength, 32);
      calls.push("create");
      nativeCandidates.push(candidate);
      if (stored !== null) return "existing";
      stored = Buffer.from(candidate);
      return "created";
    },
  });
  return Object.freeze({
    binding,
    calls,
    nativeCandidates,
    stored() { return stored === null ? null : Buffer.from(stored); },
  });
}

function brokerFixture(options = {}) {
  const wires = channelPair();
  const native = nativeBinding(options);
  const credential = createLinuxAccountObservationCredentialBackend({
    platform: "linux",
    architecture: "x64",
    binding: native.binding,
  });
  const server = attachDesktopLinuxAccountObservationBroker({
    channel: wires.parent,
    createBackend: () => credential,
  });
  const transport = createLinuxAccountObservationBrokerTransport({
    channel: wires.child,
    timeoutMs: 1_000,
  });
  return Object.freeze({
    ...wires,
    native,
    credential,
    server,
    transport,
    backend: createLinuxAccountObservationBrokerBackend({ transport }),
  });
}

function disposeFixture(fixture) {
  fixture.server.dispose();
  fixture.transport.dispose();
  fixture.child.disconnect();
}

function brokerError(code) {
  return (error) => {
    assert.equal(error instanceof LinuxAccountObservationBrokerError, true);
    assert.equal(error.code, `linux_account_observation_broker_${code}`);
    assert.equal(error.message, "Linux account observation broker operation failed");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}

function equalSecret(actual, expected) {
  assert.equal(Buffer.isBuffer(actual), true);
  assert.equal(actual.byteLength, 32);
  assert.equal(Buffer.compare(actual, expected), 0);
}

test("Linux observation IPC is qualification-only, fixed, and rejects generic broker announcements", async () => {
  assert.equal(PARENT_INTEGRATION_STATUS, "qualification_only");
  assert.equal(CHILD_INTEGRATION_STATUS, "qualification_only");
  assert.equal(linuxAccountObservationBrokerConfiguration({}), null);
  assert.deepEqual(linuxAccountObservationBrokerConfiguration({
    [LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_ENV]: LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER,
  }), { ipc: true });
  for (const value of ["0", "2", "1 ", 1]) {
    assert.deepEqual(linuxAccountObservationBrokerConfiguration({
      [LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_ENV]: value,
    }), { ipc: false });
  }
  for (const collision of [
    "USAGE_MONITOR_KEYCHAIN_BROKER_FD",
    "USAGE_MONITOR_LINUX_SECRET_SERVICE_BROKER_FD",
    "USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC",
    "USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_BROKER_FD",
  ]) {
    assert.deepEqual(linuxAccountObservationBrokerConfiguration({
      [LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_ENV]: LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER,
      [collision]: "4",
    }), { ipc: false });
  }

  const unavailable = createLinuxAccountObservationBrokerBackendFromEnvironment({
    [LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_ENV]: "invalid",
  }, channelPair().child);
  assert.deepEqual(await unavailable.describe(ACCOUNT_CAPABILITY), {
    backend: "linux_account_observation_broker",
    status: "unavailable",
  });
  await assert.rejects(unavailable.read(ACCOUNT_CAPABILITY), brokerError("unavailable"));
  assert.equal(createLinuxAccountObservationBrokerBackendFromEnvironment({
    USAGE_MONITOR_LINUX_SECRET_SERVICE_BROKER_FD: "4",
  }, channelPair().child), null);

  const source = await readFile(
    new URL("../../../src/platform/linux-account-observation-broker.js", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes("linux-secret-service-broker"), false);
  assert.equal(source.includes("linux-account-observation-credential"), false);
  assert.equal(source.includes('from "node:net"'), false);
  assert.equal(source.includes("replaceExact"), false);
  assert.equal(source.includes("deleteExact"), false);

  const platformFacade = await readFile(
    new URL("../../../src/platform/index.js", import.meta.url),
    "utf8",
  );
  assert.equal(platformFacade.includes("./linux-account-observation-credential.js"), false);
});

test("Linux observation IPC carries only read/create through the parent fixed facade", async () => {
  const f = brokerFixture();
  const candidate = Buffer.alloc(32, 71);
  try {
    assert.equal(isLinuxAccountObservationCredentialBackend(f.credential), true);
    assert.equal(isLinuxAccountObservationCredentialBackend({ read() {}, createIfMissing() {} }), false);
    assert.equal(isLinuxAccountObservationBrokerBackend(f.backend), true);
    assert.deepEqual(Object.keys(f.backend).sort(), ["available", "createIfMissing", "describe", "read"]);
    assert.equal(Object.hasOwn(f.backend, "replaceExact"), false);
    assert.equal(Object.hasOwn(f.backend, "deleteExact"), false);

    assert.deepEqual(await Promise.all([
      f.backend.read(ACCOUNT_CAPABILITY),
      f.backend.read(ACCOUNT_CAPABILITY),
    ]), [null, null]);
    assert.equal(await f.backend.createIfMissing(ACCOUNT_CAPABILITY, candidate), "created");
    const observed = await f.backend.read(ACCOUNT_CAPABILITY);
    equalSecret(observed, candidate);
    observed.fill(0);
    assert.equal(await f.backend.createIfMissing(ACCOUNT_CAPABILITY, candidate), "existing");
    assert.deepEqual(f.native.calls, ["read", "read", "create", "read", "create"]);
    assert.equal(f.native.nativeCandidates.length, 2);
    assert.equal(f.native.nativeCandidates.every((value) => value.every((byte) => byte === 0)), true);

    await assert.rejects(
      f.backend.read({ ...ACCOUNT_CAPABILITY }),
      brokerError("invalid_configuration"),
    );
    assert.deepEqual(f.native.calls, ["read", "read", "create", "read", "create"]);
  } finally {
    candidate.fill(0);
    disposeFixture(f);
  }
});

test("Linux observation IPC satisfies the existing read/create loader contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-linux-observation-broker-"));
  const f = brokerFixture();
  const candidate = Buffer.alloc(32, 91);
  try {
    const load = createAccountObservationSecretLoader({
      backend: f.backend,
      capability: ACCOUNT_CAPABILITY,
      operationLockFile: join(root, "account-observation.lock"),
      generateSecret: () => Buffer.from(candidate),
    });
    const first = await load();
    const second = await load();
    equalSecret(first, candidate);
    equalSecret(second, candidate);
    first.fill(0);
    second.fill(0);
    assert.deepEqual(f.native.calls, ["read", "create", "read", "read"]);
  } finally {
    candidate.fill(0);
    disposeFixture(f);
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux observation IPC serializes parent failures and refuses malformed mutation widening", async () => {
  const recovery = new LinuxAccountObservationCredentialError("recovery_required");
  const f = brokerFixture({ readFailure: recovery });
  try {
    await assert.rejects(f.backend.read(ACCOUNT_CAPABILITY), brokerError("recovery_required"));
  } finally {
    disposeFixture(f);
  }

  const wires = channelPair();
  const native = nativeBinding();
  const credential = createLinuxAccountObservationCredentialBackend({
    platform: "linux",
    architecture: "x64",
    binding: native.binding,
  });
  const server = attachDesktopLinuxAccountObservationBroker({
    channel: wires.parent,
    createBackend: () => credential,
  });
  try {
    wires.child.send(Object.freeze({
      schemaVersion: LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA,
      kind: LINUX_ACCOUNT_OBSERVATION_BROKER_REQUEST_KIND,
      v: LINUX_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION,
      id: 1,
      op: "replace_exact",
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(wires.parent.listenerCount("message"), 0);
    assert.deepEqual(native.calls, []);
  } finally {
    server.dispose();
    wires.child.disconnect();
  }
});
