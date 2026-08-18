import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createWindowsFilesystemAdapter,
} from "../src/platform/windows-filesystem.js";
import {
  WINDOWS_PROTECTED_STATE_STORE_DEFAULT_MAX_BYTES,
  WINDOWS_PROTECTED_STATE_STORE_NATIVE_READ_BOUNDED,
  WINDOWS_PROTECTED_STATE_STORE_ROOT_BINDING_SAFE,
  createWindowsProtectedStateStore,
  isWindowsProtectedStateStore,
  isWindowsProtectedStateStoreError,
} from "../src/platform/windows-protected-state-store.js";

const ROOT = "C:\\Users\\tester\\AppData\\Local\\TiboTattle\\state";
const IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "00112233445566778899aabbccddeeff",
  linkCount: 1,
});

function error(code) {
  const failure = new Error("Windows filesystem operation failed");
  failure.code = `WINDOWS_FILESYSTEM_${code}`;
  return failure;
}

function cloneIdentity(number) {
  return Object.freeze({
    volumeSerialNumber: IDENTITY.volumeSerialNumber,
    fileId: number.toString(16).padStart(32, "0"),
    linkCount: 1,
  });
}

function sameIdentity(left, right) {
  return left?.volumeSerialNumber === right?.volumeSerialNumber
    && left?.fileId === right?.fileId
    && left?.linkCount === right?.linkCount;
}

function securityMetadata(entry) {
  return {
    identity: entry.identity,
    isDirectory: entry.directory === true,
    isRegularFile: entry.directory !== true,
    isReparsePoint: entry.reparse === true,
    ownerMatches: entry.ownerMatches !== false,
    nullDacl: entry.nullDacl === true,
    daclProtected: entry.daclProtected !== false,
    broadAccess: entry.broadAccess === true,
    nonOwnerAllow: entry.nonOwnerAllow === true,
    unrecognizedAce: entry.unrecognizedAce === true,
    finalPathResolved: entry.finalPathResolved !== false,
  };
}

function createFixture({
  root = ROOT,
  rootOverrides = {},
  bindingOverrides = {},
  deleteFailures = new Map(),
} = {}) {
  const entries = new Map();
  let nextIdentity = 2;
  const calls = [];
  entries.set(root, {
    directory: true,
    identity: IDENTITY,
    ...rootOverrides,
  });

  const binding = {
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    productionSafe: false,
    pathWalkRaceSafe: false,
    credentialMutexSafe: true,
    credentialAuditFileGuardSafe: true,
    inspectPath(path) {
      calls.push(["inspectPath", path]);
      const entry = entries.get(path);
      if (!entry) throw error("NOT_FOUND");
      return securityMetadata(entry);
    },
    ensureDirectory(path) {
      calls.push(["ensureDirectory", path]);
      const entry = entries.get(path);
      if (entry) {
        if (entry.directory !== true) throw error("NOT_DIRECTORY");
        return entry.identity;
      }
      const identity = cloneIdentity(nextIdentity++);
      entries.set(path, { directory: true, identity });
      return identity;
    },
    readFile(path) {
      calls.push(["readFile", path]);
      const entry = entries.get(path);
      if (!entry) throw error("NOT_FOUND");
      if (entry.directory) throw error("NOT_REGULAR_FILE");
      if (entry.reparse === true) throw error("REPARSE_POINT");
      if (entry.ownerMatches === false || entry.broadAccess === true) {
        throw error("SECURITY_POLICY");
      }
      return { data: Buffer.from(entry.data), identity: entry.identity };
    },
    readFileBounded(path, maximumBytes) {
      calls.push(["readFileBounded", path, maximumBytes]);
      return this.readFile(path);
    },
    createFile(path, data) {
      calls.push(["createFile", path, Buffer.from(data)]);
      if (entries.has(path)) throw error("ALREADY_EXISTS");
      const identity = cloneIdentity(nextIdentity++);
      entries.set(path, { data: Buffer.from(data), identity });
      return identity;
    },
    deleteFile(path, expectedIdentity) {
      calls.push(["deleteFile", path, expectedIdentity]);
      const entry = entries.get(path);
      if (!entry) throw error("NOT_FOUND");
      if (!sameIdentity(entry.identity, expectedIdentity)) throw error("IDENTITY_MISMATCH");
      const failuresRemaining = deleteFailures.get(path) ?? 0;
      if (failuresRemaining > 0) {
        deleteFailures.set(path, failuresRemaining - 1);
        throw error("OPERATION_FAILED");
      }
      entries.delete(path);
      return { deleted: true, identity: entry.identity };
    },
    replaceFile(path, expectedIdentity, data) {
      calls.push(["replaceFile", path, expectedIdentity, Buffer.from(data)]);
      const entry = entries.get(path);
      if (!entry) throw error("NOT_FOUND");
      if (!sameIdentity(entry.identity, expectedIdentity)) throw error("IDENTITY_MISMATCH");
      const identity = cloneIdentity(nextIdentity++);
      entries.set(path, { data: Buffer.from(data), identity });
      return identity;
    },
    // These methods model the native root-bound primitives directly.  They
    // intentionally do not delegate to the legacy path-only methods above:
    // tests must prove that the store never bypasses the root identity and
    // canonical relative-name contract.
    inspectProtectedChild(rootPath, rootIdentity, childPath) {
      calls.push(["inspectProtectedChild", rootPath, rootIdentity, childPath]);
      const rootEntry = entries.get(rootPath);
      if (!rootEntry || !sameIdentity(rootEntry.identity, rootIdentity)) {
        throw error("IDENTITY_MISMATCH");
      }
      const entry = entries.get(`${rootPath}\\${childPath}`);
      if (!entry) throw error("NOT_FOUND");
      return securityMetadata(entry);
    },
    readProtectedChild(rootPath, rootIdentity, childPath, maximumBytes) {
      calls.push(["readProtectedChild", rootPath, rootIdentity, childPath, maximumBytes]);
      const rootEntry = entries.get(rootPath);
      if (!rootEntry || !sameIdentity(rootEntry.identity, rootIdentity)) {
        throw error("IDENTITY_MISMATCH");
      }
      const entry = entries.get(`${rootPath}\\${childPath}`);
      if (!entry) throw error("NOT_FOUND");
      if (entry.directory) throw error("NOT_REGULAR_FILE");
      if (entry.reparse === true
          || entry.ownerMatches === false
          || entry.broadAccess === true) {
        throw error(entry.reparse === true ? "REPARSE_POINT" : "SECURITY_POLICY");
      }
      // The native contract rejects before materializing the returned bytes.
      if (!Number.isSafeInteger(maximumBytes) || entry.data.byteLength > maximumBytes) {
        throw error("FILE_TOO_LARGE");
      }
      return { data: Buffer.from(entry.data), identity: entry.identity };
    },
    createProtectedChild(rootPath, rootIdentity, childPath, data) {
      calls.push(["createProtectedChild", rootPath, rootIdentity, childPath]);
      const rootEntry = entries.get(rootPath);
      if (!rootEntry || !sameIdentity(rootEntry.identity, rootIdentity)) {
        throw error("IDENTITY_MISMATCH");
      }
      const path = `${rootPath}\\${childPath}`;
      if (entries.has(path)) throw error("ALREADY_EXISTS");
      const identity = cloneIdentity(nextIdentity++);
      entries.set(path, { data: Buffer.from(data), identity });
      return identity;
    },
    deleteProtectedChild(rootPath, rootIdentity, childPath, expectedIdentity) {
      calls.push(["deleteProtectedChild", rootPath, rootIdentity, childPath]);
      const rootEntry = entries.get(rootPath);
      if (!rootEntry || !sameIdentity(rootEntry.identity, rootIdentity)) {
        throw error("IDENTITY_MISMATCH");
      }
      const path = `${rootPath}\\${childPath}`;
      const entry = entries.get(path);
      if (!entry) throw error("NOT_FOUND");
      if (!sameIdentity(entry.identity, expectedIdentity)) throw error("IDENTITY_MISMATCH");
      const failuresRemaining = deleteFailures.get(path) ?? 0;
      if (failuresRemaining > 0) {
        deleteFailures.set(path, failuresRemaining - 1);
        throw error("OPERATION_FAILED");
      }
      entries.delete(path);
      return { deleted: true, identity: entry.identity };
    },
    replaceProtectedChild(rootPath, rootIdentity, childPath, expectedIdentity, data) {
      calls.push(["replaceProtectedChild", rootPath, rootIdentity, childPath]);
      const rootEntry = entries.get(rootPath);
      if (!rootEntry || !sameIdentity(rootEntry.identity, rootIdentity)) {
        throw error("IDENTITY_MISMATCH");
      }
      const path = `${rootPath}\\${childPath}`;
      const entry = entries.get(path);
      if (!entry) throw error("NOT_FOUND");
      if (!sameIdentity(entry.identity, expectedIdentity)) throw error("IDENTITY_MISMATCH");
      const identity = cloneIdentity(nextIdentity++);
      entry.data = Buffer.from(data);
      entry.identity = identity;
      return identity;
    },
    acquireCredentialMutex() {
      return { lease: {}, abandoned: false };
    },
    releaseCredentialMutex() {},
    acquireCredentialAuditFileGuard() {
      return { guard: {}, identity: IDENTITY };
    },
    releaseCredentialAuditFileGuard() {},
    ...bindingOverrides,
  };
  const adapter = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding,
  });
  return { adapter, entries, calls };
}

function createStore(fixture, options = {}) {
  return createWindowsProtectedStateStore({
    adapter: fixture.adapter,
    rootPath: ROOT,
    ...options,
  });
}

function assertStoreError(code) {
  return (failure) => {
    assert.equal(isWindowsProtectedStateStoreError(failure), true);
    assert.equal(failure.code, `windows_protected_state_store_${code}`);
    return true;
  };
}

test("the store requires the branded adapter and does not import Node fs", () => {
  const fixture = createFixture();
  const store = createStore(fixture);
  assert.equal(isWindowsProtectedStateStore(store), true);
  assert.equal(WINDOWS_PROTECTED_STATE_STORE_DEFAULT_MAX_BYTES, 1024 * 1024);
  assert.equal(store.maxBytes, 1024 * 1024);
  assert.equal(store.rootBindingSafe, false);
  assert.equal(store.nativeReadBounded, false);
  assert.equal(WINDOWS_PROTECTED_STATE_STORE_ROOT_BINDING_SAFE, false);
  assert.equal(WINDOWS_PROTECTED_STATE_STORE_NATIVE_READ_BOUNDED, false);
  assert.throws(
    () => createWindowsProtectedStateStore({
      adapter: { ...fixture.adapter },
      rootPath: ROOT,
    }),
    assertStoreError("invalid_adapter"),
  );
  assert.throws(
    () => createWindowsProtectedStateStore({ adapter: {}, rootPath: ROOT }),
    assertStoreError("invalid_adapter"),
  );
  assert.throws(
    () => createStore(fixture, { maxBytes: 1024 * 1024 + 1 }),
    assertStoreError("invalid_configuration"),
  );
  const source = readFileSync(
    new URL("../src/platform/windows-protected-state-store.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /node:fs(?:\/promises)?/u);
  assert.doesNotMatch(source, /from\s+["'](?:fs|node:fs)/u);
});

test("the root is an absolute canonical drive path and child paths cannot escape", () => {
  const fixture = createFixture();
  for (const name of [
    "../outside",
    "nested\\..\\outside",
    "C:\\outside",
    "\\\\server\\share\\outside",
    "nested//",
  ]) {
    const store = createStore(fixture);
    assert.throws(() => store.create(name, Buffer.from("x")), assertStoreError(
      name.includes("..") || name.endsWith("//") ? "path_escape" : "invalid_path",
    ));
  }
  for (const rootPath of [
    "relative\\state",
    "\\\\server\\share\\state",
    "C:\\state\\..\\outside",
    "C:\\",
  ]) {
    assert.throws(
      () => createWindowsProtectedStateStore({ adapter: fixture.adapter, rootPath }),
      assertStoreError("invalid_root"),
    );
  }
  const result = createStore(fixture).create("nested\\state.json", Buffer.from("ok"));
  assert.equal(result.path, `${ROOT}\\nested\\state.json`);
});

test("the protected root rejects reparse points and weak security metadata", () => {
  for (const rootOverrides of [
    { reparse: true },
    { ownerMatches: false },
    { nullDacl: true },
    { daclProtected: false },
    { broadAccess: true },
    { nonOwnerAllow: true },
    { unrecognizedAce: true },
    { finalPathResolved: false },
    { identity: { ...IDENTITY, linkCount: 2 } },
  ]) {
    assert.throws(
      () => createStore(createFixture({ rootOverrides })),
      assertStoreError(rootOverrides.identity ? "invalid_identity" : "security_policy"),
    );
  }
});

test("reads, creates, replaces, and deletes are bounded and identity-bound", () => {
  const fixture = createFixture();
  const store = createStore(fixture, { maxBytes: 8 });
  const created = store.create("state.json", Buffer.from("one"));
  assert.deepEqual(store.read("state.json").data, Buffer.from("one"));
  assert.throws(
    () => store.replace("state.json", IDENTITY, Buffer.from("two")),
    assertStoreError("identity_mismatch"),
  );
  const replaced = store.replace("state.json", created.identity, Buffer.from("two"));
  assert.deepEqual(store.read("state.json").data, Buffer.from("two"));
  assert.throws(
    () => store.delete("state.json", created.identity),
    assertStoreError("identity_mismatch"),
  );
  assert.equal(store.delete("state.json", replaced.identity).deleted, true);
  assert.throws(
    () => store.create("too-large.bin", Buffer.alloc(9)),
    assertStoreError("too_large"),
  );
  const oversized = Buffer.alloc(9);
  fixture.entries.set(`${ROOT}\\oversized.bin`, {
    data: oversized,
    identity: cloneIdentity(99),
  });
  assert.throws(() => store.read("oversized.bin"), assertStoreError("too_large"));
  const createCall = fixture.calls.find(([method]) => method === "createProtectedChild");
  assert.deepEqual(createCall.slice(0, 4), ["createProtectedChild", ROOT, IDENTITY, "state.json"]);
  const readCall = fixture.calls.find(([method]) => method === "readProtectedChild");
  assert.deepEqual(readCall.slice(0, 4), ["readProtectedChild", ROOT, IDENTITY, "state.json"]);
  assert.equal(readCall[4], 8);
  const replaceCall = fixture.calls.find(([method]) => method === "replaceProtectedChild");
  assert.deepEqual(
    replaceCall.slice(0, 4),
    ["replaceProtectedChild", ROOT, IDENTITY, "state.json"],
  );
  assert.ok(fixture.calls.some(([method]) => method === "deleteProtectedChild"));
  assert.equal(fixture.calls.some(([method]) => method === "readFile"), false);
  assert.equal(fixture.calls.some(([method]) => method === "readFileBounded"), false);
  assert.equal(fixture.calls.some(([method]) => method === "createFile"), false);
  assert.equal(fixture.calls.some(([method]) => method === "replaceFile"), false);
  assert.equal(fixture.calls.some(([method]) => method === "deleteFile"), false);
  const oversizedCall = fixture.calls.find(
    ([method, , , child]) => method === "readProtectedChild" && child === "oversized.bin",
  );
  assert.equal(oversizedCall[4], 8);
});

test("child inspect uses the root identity and canonical relative name", () => {
  const fixture = createFixture();
  const store = createStore(fixture);
  const created = store.create("nested/state.json", Buffer.from("ok"));
  const inspected = store.inspect("nested/state.json");
  assert.equal(inspected.path, created.path);
  assert.equal(inspected.isDirectory, false);
  const inspectCall = fixture.calls.find(([method]) => method === "inspectProtectedChild");
  assert.deepEqual(
    inspectCall,
    ["inspectProtectedChild", ROOT, IDENTITY, "nested\\state.json"],
  );
  assert.equal(fixture.calls.some(([method]) => method === "readFile"), false);
});

test("the protected native child method rejects a root swap after preflight", () => {
  let entries;
  let callsForSwap;
  const fixture = createFixture({
    bindingOverrides: {
      createProtectedChild(rootPath, rootIdentity) {
        callsForSwap.push(["createProtectedChild", rootPath, rootIdentity, "state.json"]);
        entries.get(rootPath).identity = cloneIdentity(88);
        if (!sameIdentity(entries.get(rootPath).identity, rootIdentity)) {
          throw error("IDENTITY_MISMATCH");
        }
        throw error("OPERATION_FAILED");
      },
    },
  });
  entries = fixture.entries;
  callsForSwap = fixture.calls;
  const store = createStore(fixture);
  assert.throws(
    () => store.create("state.json", Buffer.from("x")),
    assertStoreError("identity_mismatch"),
  );
  const createCall = fixture.calls.find(([method]) => method === "createProtectedChild");
  assert.deepEqual(createCall.slice(0, 4), ["createProtectedChild", ROOT, IDENTITY, "state.json"]);
});

test("child reparse and security failures remain fail-closed through the adapter", () => {
  const fixture = createFixture();
  const store = createStore(fixture);
  const reparse = store.create("reparse.bin", Buffer.from("x"));
  fixture.entries.get(reparse.path).reparse = true;
  assert.throws(() => store.read("reparse.bin"), assertStoreError("security_policy"));
  const broad = store.create("broad.bin", Buffer.from("x"));
  fixture.entries.get(broad.path).broadAccess = true;
  assert.throws(() => store.read("broad.bin"), assertStoreError("security_policy"));
});

test("stable JSON helpers produce bounded deterministic bytes", () => {
  const fixture = createFixture();
  const store = createStore(fixture, { maxBytes: 128 });
  const created = store.createJson("state.json", { z: 1, nested: { b: true, a: "x" }, a: [2, 1] });
  assert.deepEqual(
    fixture.entries.get(created.path).data,
    Buffer.from('{"a":[2,1],"nested":{"a":"x","b":true},"z":1}\n'),
  );
  const read = store.readJson("state.json");
  assert.deepEqual(read.value, { a: [2, 1], nested: { a: "x", b: true }, z: 1 });
  assert.throws(
    () => store.createJson("invalid.json", { value: Number.NaN }),
    assertStoreError("invalid_configuration"),
  );
});

test("pending cleanup is identity-bound and does not recover stale locks", () => {
  const fixture = createFixture();
  const store = createStore(fixture);
  assert.deepEqual(store.cleanupPending("state.pending"), {
    deleted: false,
    path: `${ROOT}\\state.pending`,
  });
  const pending = store.create("state.pending", Buffer.from("pending"));
  fixture.entries.get(pending.path).identity = cloneIdentity(77);
  assert.throws(
    () => store.cleanupPending("state.pending", pending.identity),
    assertStoreError("identity_mismatch"),
  );
  assert.throws(() => store.cleanupPending("state.json"), assertStoreError("invalid_path"));
  assert.equal(store.staleRecoveryAvailable, false);
});

test("exclusive leases fail fast, release once in finally, and preserve callback failures", async () => {
  const fixture = createFixture();
  const auditEvents = [];
  const store = createStore(fixture, {
    audit(event) {
      auditEvents.push(event.event);
    },
    idFactory: () => "lease-id",
  });
  const first = store.acquireOperationLease("operation.lock");
  assert.throws(
    () => store.acquireOperationLease("operation.lock"),
    assertStoreError("contended"),
  );
  assert.throws(
    () => store.releaseOperationLease({ ...first }),
    assertStoreError("lease_foreign"),
  );
  store.releaseOperationLease(first);
  assert.throws(() => store.releaseOperationLease(first), assertStoreError("lease_released"));
  const deleteCallsAfterExplicitRelease = fixture.calls.filter(
    ([method, , , child]) => method === "deleteProtectedChild" && child === "operation.lock",
  ).length;
  assert.equal(deleteCallsAfterExplicitRelease, 1);

  await assert.rejects(
    store.withOperationLease("callback.lock", async (lease) => {
      assert.equal(lease.version, "windows-protected-state-store-lease-v1");
      assert.equal(lease.path, `${ROOT}\\callback.lock`);
      throw new Error("callback failure");
    }),
    /callback failure/u,
  );
  assert.equal(fixture.entries.has(`${ROOT}\\callback.lock`), false);
  assert.equal(auditEvents.includes("lease_acquired"), true);
  assert.equal(auditEvents.includes("lease_released"), true);
});

test("audit failure during lease acquisition cleans the lock and never enables stale takeover", () => {
  const fixture = createFixture();
  const store = createStore(fixture, {
    audit() {
      throw new Error("audit failure");
    },
  });
  assert.throws(
    () => store.acquireOperationLease("audit.lock"),
    assertStoreError("audit_failed"),
  );
  assert.equal(fixture.entries.has(`${ROOT}\\audit.lock`), false);
  assert.equal(
    fixture.calls.filter(([method, , , child]) => method === "deleteProtectedChild"
      && child === "audit.lock").length,
    1,
  );
});

test("audit failure during finally still releases the exact lease once", async () => {
  const fixture = createFixture();
  const store = createStore(fixture, {
    audit(event) {
      if (event.event === "lease_released") throw new Error("audit release failure");
    },
  });
  await assert.rejects(
    store.withOperationLease("release-audit.lock", () => "completed"),
    assertStoreError("audit_failed"),
  );
  const path = `${ROOT}\\release-audit.lock`;
  assert.equal(fixture.entries.has(path), false);
  assert.equal(
    fixture.calls.filter(([method, , , child]) => method === "deleteProtectedChild"
      && child === "release-audit.lock").length,
    1,
  );
});

test("a failed lease release remains retryable and succeeds with the same identity", () => {
  const path = `${ROOT}\\retry.lock`;
  const fixture = createFixture({ deleteFailures: new Map([[path, 1]]) });
  const store = createStore(fixture);
  const lease = store.acquireOperationLease("retry.lock");
  assert.throws(
    () => store.releaseOperationLease(lease),
    assertStoreError("lease_release_failed"),
  );
  assert.equal(fixture.entries.has(path), true);
  store.releaseOperationLease(lease);
  assert.equal(fixture.entries.has(path), false);
  assert.throws(() => store.releaseOperationLease(lease), assertStoreError("lease_released"));
  assert.equal(
    fixture.calls.filter(([method, , , child]) => method === "deleteProtectedChild"
      && child === "retry.lock").length,
    2,
  );
});

test("failed audit cleanup reports release failure and retains the original fixed audit cause", () => {
  const path = `${ROOT}\\audit-cleanup-failure.lock`;
  const fixture = createFixture({ deleteFailures: new Map([[path, 1]]) });
  const store = createStore(fixture, {
    audit() {
      throw new Error("audit failure");
    },
  });
  assert.throws(
    () => store.acquireOperationLease("audit-cleanup-failure.lock"),
    (failure) => {
      assert.equal(failure.code, "windows_protected_state_store_lease_release_failed");
      assert.equal(failure.cause?.code, "windows_protected_state_store_audit_failed");
      return true;
    },
  );
  assert.equal(fixture.entries.has(path), true);
});

test("callback failure remains primary while a fixed release failure is attached", async () => {
  const path = `${ROOT}\\callback-release-failure.lock`;
  const fixture = createFixture({ deleteFailures: new Map([[path, 1]]) });
  const store = createStore(fixture);
  let lease;
  const callbackFailure = new Error("callback failure");
  await assert.rejects(
    store.withOperationLease("callback-release-failure.lock", (held) => {
      lease = held;
      throw callbackFailure;
    }),
    (failure) => {
      assert.equal(failure, callbackFailure);
      assert.equal(failure.cause?.code, "windows_protected_state_store_lease_release_failed");
      return true;
    },
  );
  assert.equal(fixture.entries.has(path), true);
  store.releaseOperationLease(lease);
  assert.equal(fixture.entries.has(path), false);
});
