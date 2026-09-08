import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopWindowsAccountlessCredentialBackend,
  createDesktopWindowsNormalCandidateAccountlessCredentialBackend,
  createWindowsNormalCandidateCredentialHandoverForTest,
} from "../desktop-windows-accountless-credential.js";

const SECRET = Buffer.alloc(32, 29);

function nativeError(code) {
  return Object.assign(new Error("native detail must never leave the Electron adapter"), {
    code,
    nativeWindowsAccountlessError: true,
  });
}

function fixtureOptions(overrides = {}) {
  const adapter = Object.freeze({ name: "synthetic-windows-filesystem-adapter" });
  const context = Object.freeze({
    qualificationOnly: true,
    productionSafe: false,
    stateRoot: "C:\\synthetic\\state",
  });
  return {
    platform: "win32",
    architecture: "x64",
    adapter,
    rootPath: "C:\\synthetic\\state\\accountless",
    resourceRoot: "C:\\synthetic\\resources",
    windowsQualificationModeContext: context,
    ...overrides,
  };
}

function dependencies({ backend, context = true } = {}) {
  const calls = [];
  return {
    calls,
    createNativeBackend(options) {
      calls.push({ kind: "factory", options });
      return backend;
    },
    isNativeError(error) {
      return error?.nativeWindowsAccountlessError === true;
    },
    isQualificationContextFor(options) {
      calls.push({ kind: "context", options });
      return context;
    },
  };
}

test("desktop Windows adapter exposes only the fixed FD3 credential operations", async () => {
  const calls = [];
  let stored = null;
  let nativeReturned = null;
  const native = {
    async read() {
      calls.push(["read", arguments.length]);
      nativeReturned = stored === null ? null : Buffer.from(stored);
      return nativeReturned;
    },
    async createIfMissing(value) {
      calls.push(["create", arguments.length, Buffer.from(value)]);
      if (stored !== null) return "existing";
      stored = Buffer.from(value);
      value.fill(0);
      return "created";
    },
    async deleteExact(value) {
      calls.push(["delete", arguments.length, Buffer.from(value)]);
      if (stored === null) return "missing";
      if (!stored.equals(value)) return "mismatch";
      stored.fill(0);
      stored = null;
      value.fill(0);
      return "deleted";
    },
  };
  const options = fixtureOptions();
  const injected = dependencies({ backend: native });
  const backend = createDesktopWindowsAccountlessCredentialBackend(options, injected);
  assert.deepEqual(Object.keys(backend).sort(), ["createIfMissing", "deleteExact", "read"]);
  assert.deepEqual(injected.calls[0], {
    kind: "context",
    options: {
      context: options.windowsQualificationModeContext,
      adapter: options.adapter,
      stateRoot: "C:\\synthetic\\state",
      resourceRoot: "C:\\synthetic\\resources",
    },
  });
  assert.deepEqual(Object.keys(injected.calls[1].options).sort(), [
    "adapter",
    "architecture",
    "platform",
    "resourceRoot",
    "rootPath",
    "windowsQualificationModeContext",
  ]);
  assert.equal(injected.calls[1].kind, "factory");
  assert.equal(injected.calls[1].options.context, undefined);
  assert.equal(injected.calls[1].options.capability, undefined);
  assert.equal(injected.calls[1].options.legacyCredentialProbe, undefined);

  const supplied = Buffer.from(SECRET);
  assert.equal(await backend.read(), null);
  assert.equal(await backend.createIfMissing(supplied), "created");
  assert.deepEqual(supplied, SECRET, "native mutation must not alter the FD3 caller buffer");
  const read = await backend.read();
  assert.deepEqual(read, SECRET);
  assert.deepEqual(nativeReturned, Buffer.alloc(32), "native read result is wiped after copying");
  read.fill(0);
  assert.equal(await backend.deleteExact(Buffer.alloc(32, 3)), "mismatch");
  assert.equal(await backend.deleteExact(SECRET), "deleted");
  assert.deepEqual(calls.map(([operation, count]) => [operation, count]), [
    ["read", 0], ["create", 1], ["read", 0], ["delete", 1], ["delete", 1],
  ]);
  assert.deepEqual(calls[1][2], SECRET);
  assert.deepEqual(calls[3][2], Buffer.alloc(32, 3));
  assert.deepEqual(calls[4][2], SECRET);
});

test("desktop Windows adapter requires the branded qualification-only context before native construction", () => {
  let factoryCalls = 0;
  assert.throws(() => createDesktopWindowsAccountlessCredentialBackend(
    fixtureOptions({ windowsQualificationModeContext: Object.freeze({
      qualificationOnly: true,
      productionSafe: true,
      stateRoot: "C:\\synthetic\\state",
    }) }),
    {
      createNativeBackend() { factoryCalls += 1; return {}; },
      isNativeError: () => false,
      isQualificationContextFor: () => true,
    },
  ), { code: "contribution_device_credential_unavailable" });
  assert.equal(factoryCalls, 0);

  assert.throws(() => createDesktopWindowsAccountlessCredentialBackend({
    ...fixtureOptions(),
    capability: "FD4",
  }, {
    createNativeBackend() { factoryCalls += 1; return {}; },
    isNativeError: () => false,
    isQualificationContextFor: () => true,
  }), { code: "contribution_device_credential_unavailable" });
  assert.equal(factoryCalls, 0);
});

test("desktop Windows adapter maps only fixed native failures and preserves FD3 uncertainty", async () => {
  const recovery = createDesktopWindowsAccountlessCredentialBackend(fixtureOptions(), dependencies({
    backend: {
      async read() {
        throw nativeError("windows_accountless_installation_credential_recovery_required");
      },
      async createIfMissing() { return "created"; },
      async deleteExact() { return "missing"; },
    },
  }));
  await assert.rejects(recovery.read(), (error) => error?.code
    === "contribution_device_credential_recovery_required"
    && error?.retryable === false);

  const unavailable = createDesktopWindowsAccountlessCredentialBackend(fixtureOptions(), dependencies({
    backend: {
      async read() { return null; },
      async createIfMissing() {
        throw nativeError("windows_accountless_installation_credential_unavailable");
      },
      async deleteExact() { return "missing"; },
    },
  }));
  await assert.rejects(unavailable.createIfMissing(SECRET), (error) => error?.code
    === "contribution_device_credential_unavailable"
    && error?.retryable === true
    && error?.knownNonMutation === true);

  const unknown = createDesktopWindowsAccountlessCredentialBackend(fixtureOptions(), dependencies({
    backend: {
      async read() { return null; },
      async createIfMissing() { throw new Error("private native message"); },
      async deleteExact() { return "missing"; },
    },
  }));
  await assert.rejects(unknown.createIfMissing(SECRET), (error) => error?.code
    === "contribution_device_credential_unavailable"
    && error?.retryable === false
    && error?.knownNonMutation === undefined
    && error?.message === "Installation credential unavailable");
});

test("desktop Windows adapter rejects malformed FD3 secrets before native access", async () => {
  const native = {
    async read() { return null; },
    async createIfMissing() { assert.fail("must not invoke native create"); },
    async deleteExact() { assert.fail("must not invoke native delete"); },
  };
  const backend = createDesktopWindowsAccountlessCredentialBackend(
    fixtureOptions(),
    dependencies({ backend: native }),
  );
  await assert.rejects(backend.createIfMissing(Buffer.alloc(31)), {
    code: "contribution_device_credential_unavailable",
  });
  await assert.rejects(backend.deleteExact("not-a-buffer"), {
    code: "contribution_device_credential_unavailable",
  });
});

test("normal Windows candidate FD3 adapter accepts only its internally derived protected root", async () => {
  let stored = null;
  const nativeCalls = [];
  const native = {
    async read() {
      nativeCalls.push(["read"]);
      return stored === null ? null : Buffer.from(stored);
    },
    async createIfMissing(value) {
      nativeCalls.push(["create", Buffer.from(value)]);
      if (stored !== null) return "existing";
      stored = Buffer.from(value);
      return "created";
    },
    async deleteExact(value) {
      nativeCalls.push(["delete", Buffer.from(value)]);
      if (stored === null) return "missing";
      if (!stored.equals(value)) return "mismatch";
      stored.fill(0);
      stored = null;
      return "deleted";
    },
  };
  const options = Object.freeze({
    platform: "win32",
    architecture: "x64",
    rootPath: "C:\\synthetic\\desktop-settings",
  });
  const backend = createDesktopWindowsNormalCandidateAccountlessCredentialBackend(options, {
    createNativeBackend(actual) {
      assert.deepEqual(actual, options);
      return native;
    },
    isNativeError: () => false,
  });
  const candidate = Buffer.from(SECRET);
  try {
    assert.equal(await backend.read(), null);
    assert.equal(await backend.createIfMissing(candidate), "created");
    assert.deepEqual(await backend.read(), SECRET);
    assert.equal(await backend.deleteExact(SECRET), "deleted");
  } finally {
    candidate.fill(0);
    stored?.fill(0);
  }
  assert.deepEqual(nativeCalls.map(([operation]) => operation), ["read", "create", "read", "delete"]);
  assert.throws(
    () => createDesktopWindowsNormalCandidateAccountlessCredentialBackend({
      ...options,
      windowsQualificationModeContext: {},
    }, {
      createNativeBackend() { assert.fail("must not construct native FD3"); },
      isNativeError: () => false,
    }),
    { code: "contribution_device_credential_unavailable" },
  );
});

test("normal Windows handover exposes only fixed FD3 and fixed FD4 parent routes", () => {
  const calls = [];
  const accountlessBackend = Object.freeze({
    async read() { return null; },
    async createIfMissing() { return "created"; },
    async deleteExact() { return "missing"; },
  });
  const handover = createWindowsNormalCandidateCredentialHandoverForTest({
    platform: "win32",
    architecture: "x64",
    createAccountlessCredentialBackend(options) {
      calls.push(["fd3", options]);
      return accountlessBackend;
    },
    createAccountObservationCredentialBackend() {
      calls.push(["fd4-factory"]);
      return Object.freeze({});
    },
    isAccountObservationBackendError(error) {
      return error?.trusted === true;
    },
    attachBroker(options) {
      calls.push(["fd4", options]);
      return Object.freeze({ close() {} });
    },
  });
  assert.deepEqual(Object.keys(handover).sort(), [
    "attachWindowsAccountObservationBroker",
    "createAccountlessCredentialBackend",
  ]);
  const legacyCredentialProbe = async () => "absent";
  assert.equal(handover.createAccountlessCredentialBackend({
    rootPath: "C:\\synthetic\\desktop-settings",
    legacyCredentialProbe,
  }), accountlessBackend);
  assert.deepEqual(calls, [["fd3", {
    platform: "win32",
    architecture: "x64",
    rootPath: "C:\\synthetic\\desktop-settings",
  }]]);

  const channel = Object.freeze({ kind: "supervisor-owned-ipc" });
  handover.attachWindowsAccountObservationBroker(channel);
  assert.equal(calls[1][0], "fd4");
  assert.equal(calls[1][1].channel, channel);
  assert.notEqual(calls[1][1].createBackend, handover.createAccountlessCredentialBackend);
  assert.equal(typeof calls[1][1].createBackend, "function");
  assert.equal(calls[1][1].isBackendError({ trusted: true }), true);
  assert.equal(calls[1][1].isBackendError({ trusted: false }), false);
  assert.deepEqual(calls[1][1].createBackend(), {});
  assert.deepEqual(calls.map(([name]) => name), ["fd3", "fd4", "fd4-factory"]);
});

test("normal Windows handover refuses alternate platforms, generic controls, and malformed FD3 input", () => {
  for (const overrides of [
    { platform: "linux" },
    { architecture: "arm64" },
    { unexpected: true },
  ]) {
    let calls = 0;
    assert.throws(
      () => createWindowsNormalCandidateCredentialHandoverForTest({
        platform: "win32",
        architecture: "x64",
        createAccountlessCredentialBackend() { calls += 1; },
        createAccountObservationCredentialBackend() { calls += 1; },
        isAccountObservationBackendError: () => false,
        attachBroker() { calls += 1; },
        ...overrides,
      }),
      { code: "contribution_device_credential_unavailable" },
    );
    assert.equal(calls, 0);
  }
  const handover = createWindowsNormalCandidateCredentialHandoverForTest({
    platform: "win32",
    architecture: "x64",
    createAccountlessCredentialBackend() { assert.fail("must reject malformed FD3 input"); },
    createAccountObservationCredentialBackend() { assert.fail("must not construct FD4"); },
    isAccountObservationBackendError: () => false,
    attachBroker() { assert.fail("must not attach FD4"); },
  });
  assert.throws(
    () => handover.createAccountlessCredentialBackend({
      rootPath: "C:\\synthetic\\desktop-settings",
      legacyCredentialProbe: async () => "absent",
      capability: "generic",
    }),
    { code: "contribution_device_credential_unavailable" },
  );
});
