import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isProxy } from "node:util/types";

import * as legacyPreflight from "../src/export-workspace-discard.js";
import * as legacyExecution from "../src/export-workspace-discard-executor.js";
import { createLocalExportWorkspaceDiscard } from "../src/application/index.js";
import {
  createOwnerOnlyExportWorkspaceDiscardPreflight,
  createOwnerOnlyExportWorkspaceDiscardStorage,
} from "../src/platform/index.js";
import { LEGACY_EXPORT_WORKSPACE_DISCARD_INTERNAL } from "../src/export-workspace-discard-compatibility-internal.js";
import { DEFAULT_EXPORT_RESOURCE_LIMITS, ExportResourceLimitError } from "../src/export/index.js";

const ROLES = Object.freeze({
  sqliteJournal: "workspace_sqlite_journal",
  sqliteWal: "workspace_sqlite_wal",
  sqliteShm: "workspace_sqlite_shm",
  database: "workspace_database",
});

function preflightConfiguration(overrides = {}) {
  return {
    workspaceDatabaseBasename: "workspace.sqlite3",
    maximumWorkspaceBytes: 1024 * 1024,
    async readBoundedDirectoryEntries() { return []; },
    isTrustedResourceLimitError() { return false; },
    async inspectExportWorkspaceDiscardState() {
      return { hasManifestState: false, poisoned: false, scanComplete: false, chunkCount: 0 };
    },
    stableJson: JSON.stringify,
    assertValidExportWorkspaceDiscardJournal() {},
    assertValidExportWorkspaceDiscardPreflight() {},
    journalVersion: "journal-v1",
    orderVersion: "order-v1",
    planVersion: "plan-v1",
    preflightVersion: "preflight-v1",
    roles: { ...ROLES },
    journalBasename: ".journal",
    markerBasename: ".marker",
    receiptBasename: "receipt.json",
    quarantinePrefix: ".quarantine-",
    workspaceLockBasename: ".lock",
    transactionBasename: ".transaction",
    ...overrides,
  };
}

function storageConfiguration(overrides = {}) {
  return {
    async buildLocalExportWorkspaceDiscardPlan() {},
    async planLocalExportWorkspaceDiscard() {},
    workspaceDiscardDirectoryIdentityToken() { return "identity"; },
    workspaceDiscardEvidenceToken() { return "evidence"; },
    stableJson: JSON.stringify,
    async readBoundedDirectoryEntries() { return []; },
    async withExistingExportWorkspaceLease(directory, callback) { return callback(directory); },
    assertValidExportWorkspaceDiscardCommitMarker() {},
    assertValidExportWorkspaceDiscardJournal() {},
    assertValidExportWorkspaceDiscardPreflight() {},
    assertValidExportWorkspaceDiscardReceipt() {},
    commitMarkerVersion: "marker-v1",
    confirmationTokenPattern: "^[A-Z]{16}$",
    orderVersion: "order-v1",
    planVersion: "plan-v1",
    receiptVersion: "receipt-v1",
    roles: { ...ROLES },
    workspaceDatabaseBasename: "workspace.sqlite3",
    journalBasename: ".journal",
    markerBasename: ".marker",
    receiptBasename: "receipt.json",
    quarantinePrefix: ".quarantine-",
    workspaceLockBasename: ".lock",
    transactionBasename: ".transaction",
    ...overrides,
  };
}

function base32(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function discardJournalToken(text) {
  return base32(createHash("sha256")
    .update("app-usagemonitor/export-workspace-discard-journal/v1")
    .update("\0")
    .update(text)
    .digest());
}

async function directoryBytes(directory) {
  return await Promise.all((await readdir(directory)).sort().map(async (name) => [
    name,
    await readFile(join(directory, name)),
  ]));
}

test("workspace discard keeps its legacy bindings while local-review enters reviewed owners", async () => {
  assert.deepEqual(Object.keys(legacyPreflight).sort(), [
    "EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_BASENAME",
    "EXPORT_WORKSPACE_DISCARD_JOURNAL_BASENAME",
    "EXPORT_WORKSPACE_DISCARD_QUARANTINE_PREFIX",
    "EXPORT_WORKSPACE_DISCARD_RECEIPT_BASENAME",
    "ExportWorkspaceDiscardError",
    "buildLocalExportWorkspaceDiscardPlan",
    "planLocalExportWorkspaceDiscard",
    "workspaceDiscardConfirmationToken",
    "workspaceDiscardDirectoryIdentityToken",
    "workspaceDiscardEvidenceToken",
  ]);
  assert.deepEqual(Object.keys(legacyExecution).sort(), [
    "ExportWorkspaceDiscardExecutionError",
    "discardLocalExportWorkspace",
    "recoverLocalExportWorkspaceDiscard",
  ]);
  const localReview = await readFile(resolve("local-review/cli.js"), "utf8");
  assert.equal(localReview.includes("../src/export-workspace-discard.js"), false);
  assert.equal(localReview.includes("../src/export-workspace-discard-executor.js"), false);
  assert.equal(legacyPreflight.ExportWorkspaceDiscardError,
    LEGACY_EXPORT_WORKSPACE_DISCARD_INTERNAL.ExportWorkspaceDiscardError);
  assert.equal(legacyPreflight.buildLocalExportWorkspaceDiscardPlan,
    LEGACY_EXPORT_WORKSPACE_DISCARD_INTERNAL.buildLocalExportWorkspaceDiscardPlan);
  assert.equal(legacyPreflight.planLocalExportWorkspaceDiscard,
    LEGACY_EXPORT_WORKSPACE_DISCARD_INTERNAL.planLocalExportWorkspaceDiscard);
  assert.equal(legacyPreflight.workspaceDiscardEvidenceToken,
    LEGACY_EXPORT_WORKSPACE_DISCARD_INTERNAL.workspaceDiscardEvidenceToken);
  assert.equal(legacyPreflight.workspaceDiscardDirectoryIdentityToken,
    LEGACY_EXPORT_WORKSPACE_DISCARD_INTERNAL.workspaceDiscardDirectoryIdentityToken);
  assert.equal(legacyPreflight.workspaceDiscardConfirmationToken,
    LEGACY_EXPORT_WORKSPACE_DISCARD_INTERNAL.workspaceDiscardConfirmationToken);
  assert.equal(legacyExecution.ExportWorkspaceDiscardExecutionError,
    LEGACY_EXPORT_WORKSPACE_DISCARD_INTERNAL.ExportWorkspaceDiscardExecutionError);
  assert.equal(legacyExecution.discardLocalExportWorkspace,
    LEGACY_EXPORT_WORKSPACE_DISCARD_INTERNAL.discardLocalExportWorkspace);
  assert.equal(legacyExecution.recoverLocalExportWorkspaceDiscard,
    LEGACY_EXPORT_WORKSPACE_DISCARD_INTERNAL.recoverLocalExportWorkspaceDiscard);
});

test("ordinary accessor options are rejected by every public discard operation without invocation", async () => {
  for (const operation of [
    legacyPreflight.buildLocalExportWorkspaceDiscardPlan,
    legacyPreflight.planLocalExportWorkspaceDiscard,
    legacyExecution.discardLocalExportWorkspace,
    legacyExecution.recoverLocalExportWorkspaceDiscard,
  ]) {
    let touched = false;
    const options = {};
    Object.defineProperty(options, "workspaceDirectory", {
      enumerable: true,
      get() { touched = true; throw new Error("PRIVATE_OPTION_ACCESSOR_CANARY"); },
    });
    await assert.rejects(operation(options), (error) => !error.message.includes("PRIVATE_OPTION_ACCESSOR_CANARY"));
    assert.equal(touched, false);
  }
});

test("public discard token helpers snapshot structured inputs without invoking accessors or Proxy traps", () => {
  for (const [operation, args] of [
    [legacyPreflight.workspaceDiscardEvidenceToken, ["plan", "role"]],
    [legacyPreflight.workspaceDiscardDirectoryIdentityToken, ["plan"]],
  ]) {
    let touched = false;
    const accessorInput = {};
    Object.defineProperty(accessorInput, "private", {
      enumerable: true,
      get() { touched = true; throw new Error("PRIVATE_TOKEN_ACCESSOR_CANARY"); },
    });
    assert.throws(() => operation(...args, accessorInput), (error) =>
      /configuration is invalid/i.test(error.message)
        && !error.message.includes("PRIVATE_TOKEN_ACCESSOR_CANARY"));
    assert.equal(touched, false);

    const proxiedInput = new Proxy({}, {
      get() { touched = true; throw new Error("PRIVATE_TOKEN_PROXY_CANARY"); },
      getOwnPropertyDescriptor() { touched = true; throw new Error("PRIVATE_TOKEN_PROXY_CANARY"); },
    });
    assert.throws(() => operation(...args, proxiedInput), (error) =>
      /configuration is invalid/i.test(error.message)
        && !error.message.includes("PRIVATE_TOKEN_PROXY_CANARY"));
    assert.equal(touched, false);
  }
  assert.equal(typeof legacyPreflight.workspaceDiscardConfirmationToken("plan"), "string");
});

test("preflight and storage factories reject each configuration accessor and callable Proxy without invocation", () => {
  for (const [factory, makeConfiguration, callableKeys] of [
    [createOwnerOnlyExportWorkspaceDiscardPreflight, preflightConfiguration, [
      "readBoundedDirectoryEntries", "isTrustedResourceLimitError", "inspectExportWorkspaceDiscardState",
      "stableJson", "assertValidExportWorkspaceDiscardJournal", "assertValidExportWorkspaceDiscardPreflight",
    ]],
    [createOwnerOnlyExportWorkspaceDiscardStorage, storageConfiguration, [
      "buildLocalExportWorkspaceDiscardPlan", "planLocalExportWorkspaceDiscard",
      "workspaceDiscardDirectoryIdentityToken", "workspaceDiscardEvidenceToken", "stableJson",
      "readBoundedDirectoryEntries", "withExistingExportWorkspaceLease",
      "assertValidExportWorkspaceDiscardCommitMarker", "assertValidExportWorkspaceDiscardJournal",
      "assertValidExportWorkspaceDiscardPreflight", "assertValidExportWorkspaceDiscardReceipt",
    ]],
  ]) {
    for (const key of Object.keys(makeConfiguration())) {
      const configuration = makeConfiguration();
      let touched = false;
      Object.defineProperty(configuration, key, {
        enumerable: true,
        get() { touched = true; throw new Error("PRIVATE_OWNER_CONFIG_ACCESSOR_CANARY"); },
      });
      assert.throws(() => factory(configuration), (error) =>
        /configuration is invalid/i.test(error.message) && !error.message.includes("PRIVATE_OWNER_CONFIG_ACCESSOR_CANARY"));
      assert.equal(touched, false, key);
    }
    for (const key of callableKeys) {
      const configuration = makeConfiguration();
      let touched = false;
      configuration[key] = new Proxy(() => {}, {
        apply() { touched = true; throw new Error("PRIVATE_OWNER_CALLABLE_PROXY_CANARY"); },
      });
      assert.throws(() => factory(configuration), /configuration is invalid/i);
      assert.equal(touched, false, key);
    }
  }
});

test("nested discard roles reject Proxy and accessors without evaluating traps", () => {
  for (const [factory, makeConfiguration] of [
    [createOwnerOnlyExportWorkspaceDiscardPreflight, preflightConfiguration],
    [createOwnerOnlyExportWorkspaceDiscardStorage, storageConfiguration],
  ]) {
    let touched = false;
    const proxyConfiguration = makeConfiguration({
      roles: new Proxy({}, { getOwnPropertyDescriptor() { touched = true; throw new Error("PRIVATE_ROLES_PROXY_CANARY"); } }),
    });
    assert.throws(() => factory(proxyConfiguration), /configuration is invalid/i);
    assert.equal(touched, false);
    for (const key of Object.keys(ROLES)) {
      const roles = { ...ROLES };
      Object.defineProperty(roles, key, {
        enumerable: true,
        get() { touched = true; throw new Error("PRIVATE_ROLES_ACCESSOR_CANARY"); },
      });
      assert.throws(() => factory(makeConfiguration({ roles })), /configuration is invalid/i);
      assert.equal(touched, false, key);
    }
  }
});

test("workspace discard owner factories reject Proxy configuration without invoking traps", () => {
  for (const factory of [
    createLocalExportWorkspaceDiscard,
    createOwnerOnlyExportWorkspaceDiscardPreflight,
    createOwnerOnlyExportWorkspaceDiscardStorage,
  ]) {
    let touched = false;
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor() { touched = true; throw new Error("private configuration getter"); },
      get() { touched = true; throw new Error("private configuration getter"); },
    });
    assert.throws(() => factory(hostile), /configuration is invalid/i);
    assert.equal(touched, false);
  }
});

test("workspace discard public operations reject hostile option objects without evaluating accessors", async () => {
  const operations = [
    legacyPreflight.buildLocalExportWorkspaceDiscardPlan,
    legacyPreflight.planLocalExportWorkspaceDiscard,
    legacyExecution.discardLocalExportWorkspace,
    legacyExecution.recoverLocalExportWorkspaceDiscard,
  ];
  for (const operation of operations) {
    let touched = false;
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor() { touched = true; throw new Error("PRIVATE_ACCESSOR_CANARY"); },
      get() { touched = true; throw new Error("PRIVATE_ACCESSOR_CANARY"); },
    });
    await assert.rejects(operation(hostile), (error) => {
      assert.equal(error.message.includes("PRIVATE_ACCESSOR_CANARY"), false);
      return typeof error.code === "string" && error.code.startsWith("export_workspace_discard_");
    });
    assert.equal(touched, false);
  }
});

test("application discard composition snapshots every returned port without receiver leakage", () => {
  const configuration = {
    workspaceDatabaseBasename: "workspace.sqlite3",
    inspectExportWorkspaceDiscardState() {},
    readBoundedDirectoryEntries() {},
    withExistingExportWorkspaceLease() {},
    createPreflight() {
      return new Proxy({}, {
        getOwnPropertyDescriptor() { throw new Error("PRIVATE_FACTORY_PORT_CANARY"); },
        get() { throw new Error("PRIVATE_FACTORY_PORT_CANARY"); },
      });
    },
    createStorage() { throw new Error("must not be called"); },
  };
  assert.throws(() => createLocalExportWorkspaceDiscard(configuration), (error) =>
    /configuration is invalid/i.test(error.message) && !error.message.includes("PRIVATE_FACTORY_PORT_CANARY"));
  assert.equal(isProxy(configuration), false);
});

test("application configuration and returned ports reject every accessor or callable Proxy without invocation", () => {
  class PreflightError extends Error {}
  class ExecutionError extends Error {}
  const preflightPort = () => ({
    ExportWorkspaceDiscardError: PreflightError,
    async buildLocalExportWorkspaceDiscardPlan() {},
    async planLocalExportWorkspaceDiscard() {},
    workspaceDiscardEvidenceToken() {}, workspaceDiscardDirectoryIdentityToken() {},
    workspaceDiscardConfirmationToken() {}, isTrustedDiscardError() { return false; },
  });
  const storagePort = () => ({
    ExportWorkspaceDiscardExecutionError: ExecutionError,
    async discardLocalExportWorkspace() {}, async recoverLocalExportWorkspaceDiscard() {},
    isTrustedExecutionError() { return false; },
  });
  const base = () => ({
    workspaceDatabaseBasename: "workspace.sqlite3",
    inspectExportWorkspaceDiscardState() {}, readBoundedDirectoryEntries() {},
    withExistingExportWorkspaceLease() {}, createPreflight: preflightPort, createStorage: storagePort,
  });
  for (const key of Object.keys(base())) {
    const configuration = base();
    let touched = false;
    Object.defineProperty(configuration, key, {
      enumerable: true,
      get() { touched = true; throw new Error("PRIVATE_CONFIGURATION_ACCESSOR_CANARY"); },
    });
    assert.throws(() => createLocalExportWorkspaceDiscard(configuration), (error) =>
      /configuration is invalid/i.test(error.message) && !error.message.includes("PRIVATE_CONFIGURATION_ACCESSOR_CANARY"));
    assert.equal(touched, false, key);
  }
  for (const key of [
    "inspectExportWorkspaceDiscardState",
    "readBoundedDirectoryEntries",
    "withExistingExportWorkspaceLease",
    "createPreflight",
    "createStorage",
  ]) {
    const configuration = base();
    let touched = false;
    configuration[key] = new Proxy(() => {}, { apply() { touched = true; throw new Error("PRIVATE_CALLABLE_PROXY_CANARY"); } });
    assert.throws(() => createLocalExportWorkspaceDiscard(configuration), /configuration is invalid/i);
    assert.equal(touched, false, key);
  }
  const malformed = base();
  let touched = false;
  malformed.createPreflight = () => Object.defineProperty({}, "buildLocalExportWorkspaceDiscardPlan", {
    get() { touched = true; throw new Error("PRIVATE_PORT_ACCESSOR_CANARY"); },
  });
  assert.throws(() => createLocalExportWorkspaceDiscard(malformed), (error) =>
    /configuration is invalid/i.test(error.message) && !error.message.includes("PRIVATE_PORT_ACCESSOR_CANARY"));
  assert.equal(touched, false);
});

test("application canonicalizes bounded directory options at the resource ceiling and preserves sort", async () => {
  class PreflightError extends Error {}
  class ExecutionError extends Error {}
  let boundedReader;
  const calls = [];
  createLocalExportWorkspaceDiscard({
    workspaceDatabaseBasename: "workspace.sqlite3",
    inspectExportWorkspaceDiscardState() {},
    async readBoundedDirectoryEntries(directory, options) {
      calls.push({ directory, options });
      return [];
    },
    withExistingExportWorkspaceLease() {},
    createPreflight(configuration) {
      boundedReader = configuration.readBoundedDirectoryEntries;
      return {
        ExportWorkspaceDiscardError: PreflightError,
        async buildLocalExportWorkspaceDiscardPlan() {},
        async planLocalExportWorkspaceDiscard() {},
        workspaceDiscardEvidenceToken() {},
        workspaceDiscardDirectoryIdentityToken() {},
        workspaceDiscardConfirmationToken() {},
        isTrustedDiscardError() { return false; },
      };
    },
    createStorage() {
      return {
        ExportWorkspaceDiscardExecutionError: ExecutionError,
        async discardLocalExportWorkspace() {},
        async recoverLocalExportWorkspaceDiscard() {},
        isTrustedExecutionError() { return false; },
      };
    },
  });

  const ceiling = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries;
  await boundedReader("default");
  await boundedReader("sorted", { sort: true });
  await boundedReader("unsorted", { maximumEntries: ceiling, sort: false });
  assert.deepEqual(calls.map(({ directory, options }) => ({ directory, options })), [
    { directory: "default", options: { maximumEntries: ceiling, sort: false } },
    { directory: "sorted", options: { maximumEntries: ceiling, sort: true } },
    { directory: "unsorted", options: { maximumEntries: ceiling, sort: false } },
  ]);
  assert.equal(calls.every(({ options }) => Object.isFrozen(options)), true);

  let touched = false;
  const accessor = {};
  Object.defineProperty(accessor, "sort", {
    enumerable: true,
    get() { touched = true; throw new Error("PRIVATE_BOUNDED_OPTION_ACCESSOR_CANARY"); },
  });
  await assert.rejects(boundedReader("accessor", accessor), (error) =>
    /configuration is invalid/i.test(error.message)
      && !error.message.includes("PRIVATE_BOUNDED_OPTION_ACCESSOR_CANARY"));
  assert.equal(touched, false);
  await assert.rejects(boundedReader("extra", { sort: true, extra: true }), /configuration is invalid/i);
  await assert.rejects(boundedReader("above-ceiling", {
    maximumEntries: ceiling + 1,
    sort: true,
  }), /configuration is invalid/i);
  assert.equal(calls.length, 3);
});

test("application snapshots every preflight and storage port class and method", () => {
  class PreflightError extends Error {}
  class ExecutionError extends Error {}
  const preflight = () => ({
    ExportWorkspaceDiscardError: PreflightError,
    async buildLocalExportWorkspaceDiscardPlan() {}, async planLocalExportWorkspaceDiscard() {},
    workspaceDiscardEvidenceToken() {}, workspaceDiscardDirectoryIdentityToken() {},
    workspaceDiscardConfirmationToken() {}, isTrustedDiscardError() { return false; },
  });
  const storage = () => ({
    ExportWorkspaceDiscardExecutionError: ExecutionError,
    async discardLocalExportWorkspace() {}, async recoverLocalExportWorkspaceDiscard() {},
    isTrustedExecutionError() { return false; },
  });
  const configuration = (createPreflight = preflight, createStorage = storage) => ({
    workspaceDatabaseBasename: "workspace.sqlite3",
    inspectExportWorkspaceDiscardState() {}, readBoundedDirectoryEntries() {},
    withExistingExportWorkspaceLease() {}, createPreflight, createStorage,
  });
  for (const [portName, keys] of [
    ["preflight", Object.keys(preflight())],
    ["storage", Object.keys(storage())],
  ]) {
    for (const key of keys) {
      let touched = false;
      const makePort = portName === "preflight" ? preflight : storage;
      const hostileFactory = () => {
        const returned = makePort();
        Object.defineProperty(returned, key, {
          enumerable: true,
          get() { touched = true; throw new Error("PRIVATE_RETURNED_PORT_ACCESSOR_CANARY"); },
        });
        return returned;
      };
      assert.throws(() => createLocalExportWorkspaceDiscard(configuration(
        portName === "preflight" ? hostileFactory : preflight,
        portName === "storage" ? hostileFactory : storage,
      )), (error) => /configuration is invalid/i.test(error.message)
        && !error.message.includes("PRIVATE_RETURNED_PORT_ACCESSOR_CANARY"));
      assert.equal(touched, false, `${portName}.${key}`);

      const proxiedFactory = () => ({ ...makePort(), [key]: new Proxy(() => {}, {
        apply() { touched = true; throw new Error("PRIVATE_RETURNED_PORT_PROXY_CANARY"); },
      }) });
      assert.throws(() => createLocalExportWorkspaceDiscard(configuration(
        portName === "preflight" ? proxiedFactory : preflight,
        portName === "storage" ? proxiedFactory : storage,
      )), /configuration is invalid/i);
      assert.equal(touched, false, `${portName}.${key}`);
    }
  }
});

test("trusted preflight and execution errors require constructor provenance and exact prototypes", () => {
  for (const [context, ErrorClass, code] of [
    [createOwnerOnlyExportWorkspaceDiscardPreflight(preflightConfiguration()), null, "workspace_required"],
    [createOwnerOnlyExportWorkspaceDiscardStorage(storageConfiguration()), null, "replacement"],
  ].map(([context, , code]) => [context, context.ExportWorkspaceDiscardError
    ?? context.ExportWorkspaceDiscardExecutionError, code])) {
    const recognizer = context.isTrustedDiscardError ?? context.isTrustedExecutionError;
    const genuine = new ErrorClass(code);
    assert.equal(recognizer(genuine), true);
    class Subclass extends ErrorClass {}
    assert.equal(recognizer(new Subclass(code)), false);
    assert.equal(recognizer(Object.create(ErrorClass.prototype)), false);
    let touched = false;
    const proxied = new Proxy(genuine, {
      get() { touched = true; throw new Error("PRIVATE_ERROR_PROXY_CANARY"); },
      getPrototypeOf() { touched = true; throw new Error("PRIVATE_ERROR_PROXY_CANARY"); },
    });
    assert.equal(recognizer(proxied), false);
    assert.equal(touched, false);
    assert.equal(recognizer({ code: genuine.code }), false);
  }
});

test("application rebrands only an exact resource-limit error before preflight trusts it", async () => {
  class PreflightError extends Error {}
  class ExecutionError extends Error {}
  let original = new ExportResourceLimitError("directory_entries");
  const context = createLocalExportWorkspaceDiscard({
    workspaceDatabaseBasename: "workspace.sqlite3",
    inspectExportWorkspaceDiscardState() {},
    readBoundedDirectoryEntries() {
      throw original;
    },
    withExistingExportWorkspaceLease() {},
    createPreflight(configuration) {
      const plan = async () => {
        try { await configuration.readBoundedDirectoryEntries("ignored"); }
        catch (error) {
          if (configuration.isTrustedResourceLimitError(error)) throw error;
          throw new PreflightError("fixed preflight failure");
        }
        return { confirmationToken: "AAAAAAAAAAAAAAAA" };
      };
      return {
        ExportWorkspaceDiscardError: PreflightError,
        buildLocalExportWorkspaceDiscardPlan: plan,
        planLocalExportWorkspaceDiscard: plan,
        workspaceDiscardEvidenceToken() { return "safe"; },
        workspaceDiscardDirectoryIdentityToken() { return "safe"; },
        workspaceDiscardConfirmationToken() { return "AAAAAAAAAAAAAAAA"; },
        isTrustedDiscardError() { return false; },
      };
    },
    createStorage() {
      return {
        ExportWorkspaceDiscardExecutionError: ExecutionError,
        async discardLocalExportWorkspace() {},
        async recoverLocalExportWorkspaceDiscard() {},
        isTrustedExecutionError() { return false; },
      };
    },
  });
  await assert.rejects(context.planLocalExportWorkspaceDiscard({ workspaceDirectory: "safe" }), (error) => {
    assert.equal(error instanceof ExportResourceLimitError, true);
    assert.equal(error.code, "export_resource_directory_entries");
    assert.notEqual(error, original);
    return true;
  });
  class Subclass extends ExportResourceLimitError {}
  const forgery = Object.create(ExportResourceLimitError.prototype);
  Object.defineProperty(forgery, "code", { value: "export_resource_directory_entries" });
  let touched = false;
  const genuine = new ExportResourceLimitError("directory_entries");
  const proxied = new Proxy(genuine, {
    get() { touched = true; throw new Error("PRIVATE_RESOURCE_PROXY_CANARY"); },
    getPrototypeOf() { touched = true; throw new Error("PRIVATE_RESOURCE_PROXY_CANARY"); },
  });
  for (const candidate of [
    new Subclass("directory_entries"), forgery, proxied,
    { code: "export_resource_directory_entries" }, Object.assign(new Error("foreign"), {
      code: "export_resource_directory_entries",
    }),
  ]) {
    original = candidate;
    await assert.rejects(context.planLocalExportWorkspaceDiscard({ workspaceDirectory: "safe" }), (error) =>
      error instanceof PreflightError && error.message === "fixed preflight failure"
        && !error.message.includes("PRIVATE_"));
  }
  assert.equal(touched, false);
});

test("resource-limit provenance rejects exact-prototype forgeries, subclasses, Proxies, and foreign errors", async () => {
  const genuine = new ExportResourceLimitError("directory_entries");
  assert.equal(ExportResourceLimitError.isTrustedExact(genuine), true);
  class Subclass extends ExportResourceLimitError {}
  const subclass = new Subclass("directory_entries");
  const forgery = Object.create(ExportResourceLimitError.prototype);
  Object.defineProperty(forgery, "code", { value: "export_resource_directory_entries" });
  let touched = false;
  const proxied = new Proxy(genuine, {
    get() { touched = true; throw new Error("PRIVATE_RESOURCE_PROXY_CANARY"); },
    getPrototypeOf() { touched = true; throw new Error("PRIVATE_RESOURCE_PROXY_CANARY"); },
  });
  for (const candidate of [subclass, forgery, proxied, { code: "export_resource_directory_entries" },
    Object.assign(new Error("foreign"), { code: "export_resource_directory_entries" })]) {
    assert.equal(ExportResourceLimitError.isTrustedExact(candidate), false);
  }
  assert.equal(touched, false);
  assert.equal(genuine.name, "ExportResourceLimitError");
  assert.equal(genuine.message, "Local export stopped at the directory_entries resource limit");
  assert.equal(genuine.code, "export_resource_directory_entries");
});

test("preflight snapshots hostile state results before field access", async () => {
  const root = await mkdtemp(join(tmpdir(), "discard-state-owner-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  await writeFile(join(workspace, "workspace.sqlite3"), "database", { mode: 0o600 });
  let touched = false;
  const state = {};
  Object.defineProperty(state, "hasManifestState", {
    enumerable: true,
    get() { touched = true; throw new Error("PRIVATE_STATE_ACCESSOR_CANARY"); },
  });
  const context = createOwnerOnlyExportWorkspaceDiscardPreflight(preflightConfiguration({
    async readBoundedDirectoryEntries(directory) { return (await readdir(directory)).sort(); },
    async inspectExportWorkspaceDiscardState() { return state; },
  }));
  try {
    await assert.rejects(context.planLocalExportWorkspaceDiscard({ workspaceDirectory: workspace }), (error) =>
      error.code === "export_workspace_discard_workspace_state"
        && !error.message.includes("PRIVATE_STATE_ACCESSOR_CANARY"));
    assert.equal(touched, false);
    assert.deepEqual(await readdir(workspace), ["workspace.sqlite3"]);
    const mutableState = { hasManifestState: false, poisoned: false, scanComplete: false, chunkCount: 0 };
    const mutableContext = createOwnerOnlyExportWorkspaceDiscardPreflight(preflightConfiguration({
      async readBoundedDirectoryEntries(directory) { return (await readdir(directory)).sort(); },
      async inspectExportWorkspaceDiscardState() { return mutableState; },
    }));
    const summary = await mutableContext.planLocalExportWorkspaceDiscard({ workspaceDirectory: workspace });
    mutableState.hasManifestState = true;
    mutableState.poisoned = true;
    assert.equal(summary.eligibility, "scan_incomplete");
    assert.equal(summary.readiness, "ready");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("storage rejects hostile preview, build, journal, lease, and nested arrays before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "discard-storage-owner-"));
  const confirmationToken = "A".repeat(16);
  const validSummary = { confirmationToken, valid: true };
  const validJournal = { valid: true, inventory: [] };
  const validate = (value) => { if (value?.valid !== true) throw new Error("PRIVATE_SCHEMA_VALIDATOR_CANARY"); };
  const run = async ({ preview = validSummary, build = { summary: validSummary, journal: validJournal }, withLease } = {}) => {
    const context = createOwnerOnlyExportWorkspaceDiscardStorage(storageConfiguration({
      async planLocalExportWorkspaceDiscard() { return preview; },
      async buildLocalExportWorkspaceDiscardPlan() { return build; },
      assertValidExportWorkspaceDiscardPreflight: validate,
      assertValidExportWorkspaceDiscardJournal: validate,
      ...(withLease ? { withExistingExportWorkspaceLease: withLease } : {}),
    }));
    await assert.rejects(context.discardLocalExportWorkspace({
      workspaceDirectory: root,
      confirmationToken,
    }), (error) => error.code === "export_workspace_discard_execute_replacement"
      && !error.message.includes("PRIVATE_"));
    assert.deepEqual(await readdir(root), []);
  };
  let touched = false;
  try {
    await run({ preview: new Proxy({}, { getOwnPropertyDescriptor() { touched = true; throw new Error("PRIVATE_PREVIEW_PROXY"); } }) });
    assert.equal(touched, false);
    const previewAccessor = {};
    Object.defineProperty(previewAccessor, "confirmationToken", {
      enumerable: true, get() { touched = true; throw new Error("PRIVATE_PREVIEW_ACCESSOR"); },
    });
    await run({ preview: previewAccessor });
    assert.equal(touched, false);
    await run({ build: new Proxy({}, { getOwnPropertyDescriptor() { touched = true; throw new Error("PRIVATE_BUILD_PROXY"); } }) });
    assert.equal(touched, false);
    const journalAccessor = {};
    Object.defineProperty(journalAccessor, "valid", {
      enumerable: true, get() { touched = true; throw new Error("PRIVATE_JOURNAL_ACCESSOR"); },
    });
    await run({ build: { summary: validSummary, journal: journalAccessor } });
    assert.equal(touched, false);
    const arraySubclass = new (class extends Array {})(validJournal);
    await run({ build: { summary: validSummary, journal: { valid: true, inventory: arraySubclass } } });
    const hole = new Array(1);
    await run({ build: { summary: validSummary, journal: { valid: true, inventory: hole } } });
    const mapAccessor = [];
    Object.defineProperty(mapAccessor, "map", {
      get() { touched = true; throw new Error("PRIVATE_ARRAY_MAP_ACCESSOR"); },
    });
    await run({ build: { summary: validSummary, journal: { valid: true, inventory: mapAccessor } } });
    assert.equal(touched, false);
    const extra = [];
    extra.extra = "rejected";
    await run({ build: { summary: validSummary, journal: { valid: true, inventory: extra } } });
    const symbolic = [];
    symbolic[Symbol("private-array-symbol")] = "rejected";
    await run({ build: { summary: validSummary, journal: { valid: true, inventory: symbolic } } });
    await run({ build: { summary: validSummary, journal: { valid: false, inventory: [] } } });
    const leaseError = new Proxy(new Error("PRIVATE_LEASE_PROXY"), {
      get() { touched = true; throw new Error("PRIVATE_LEASE_PROXY_CANARY"); },
      getPrototypeOf() { touched = true; throw new Error("PRIVATE_LEASE_PROXY_CANARY"); },
    });
    await run({ withLease: async () => { throw leaseError; } });
    assert.equal(touched, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pristine recovery sanitizes hostile rebuild results before any workspace mutation", async () => {
  for (const kind of ["proxy", "accessor", "malformed-journal"]) {
    const root = await mkdtemp(join(tmpdir(), `discard-pristine-recovery-${kind}-`));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { mode: 0o700 });
    const journal = {
      valid: true,
      planToken: "PLAN",
      directoryIdentityToken: "DIRECTORY",
      inventory: [{ ordinal: 0, role: ROLES.database }],
    };
    const journalText = JSON.stringify(journal);
    const marker = {
      planToken: journal.planToken,
      directoryIdentityToken: journal.directoryIdentityToken,
      journalToken: discardJournalToken(journalText),
    };
    await writeFile(join(workspace, "workspace.sqlite3"), "database", { mode: 0o600 });
    await writeFile(join(workspace, ".journal"), journalText, { mode: 0o600 });
    await writeFile(join(workspace, ".marker"), JSON.stringify(marker), { mode: 0o600 });

    let touched = false;
    let reachedPristineRebuild = false;
    let hostile;
    if (kind === "proxy") {
      hostile = {
        summary: new Proxy({}, {
          get() { touched = true; throw new Error("PRIVATE_RECOVERY_BUILD_PROXY_CANARY"); },
          getOwnPropertyDescriptor() { touched = true; throw new Error("PRIVATE_RECOVERY_BUILD_PROXY_CANARY"); },
        }),
        journal: { valid: true },
      };
    } else if (kind === "accessor") {
      hostile = { journal: { valid: true } };
      Object.defineProperty(hostile, "summary", {
        enumerable: true,
        get() { touched = true; throw new Error("PRIVATE_RECOVERY_BUILD_ACCESSOR_CANARY"); },
      });
    } else {
      hostile = {
        summary: { confirmationToken: "A".repeat(16), valid: true },
        journal: { valid: false, inventory: [] },
      };
    }
    const validate = (value) => {
      if (!value || value.valid !== true) throw new Error("PRIVATE_RECOVERY_SCHEMA_CANARY");
    };
    const context = createOwnerOnlyExportWorkspaceDiscardStorage(storageConfiguration({
      async buildLocalExportWorkspaceDiscardPlan(options) {
        reachedPristineRebuild = options.allowCommittedControls === true
          && options.allowLeaseControls === true;
        return hostile;
      },
      async readBoundedDirectoryEntries(directory) { return (await readdir(directory)).sort(); },
      async withExistingExportWorkspaceLease(directory, callback) { return callback(directory); },
      assertValidExportWorkspaceDiscardJournal: validate,
      assertValidExportWorkspaceDiscardPreflight: validate,
    }));
    const before = await directoryBytes(workspace);
    try {
      await assert.rejects(context.recoverLocalExportWorkspaceDiscard({
        workspaceDirectory: workspace,
      }), (error) => error.code === "export_workspace_discard_execute_replacement"
        && !error.message.includes("PRIVATE_"));
      assert.equal(reachedPristineRebuild, true, kind);
      assert.equal(touched, false, kind);
      assert.deepEqual(await directoryBytes(workspace), before, kind);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
