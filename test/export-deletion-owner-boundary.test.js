import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalExportDeletion } from "../src/application/index.js";
import { stableJson } from "../src/export/index.js";
import { LEGACY_EXPORT_DELETION_INTERNAL } from "../src/export-deletion-compatibility-internal.js";
import * as deletionShim from "../src/export-deletion.js";
import * as executorShim from "../src/export-deletion-executor.js";
import * as schemaShim from "../src/export-deletion-schema.js";
import {
  createOwnerOnlyExportDeletionPreflightInspector,
  createOwnerOnlyExportDeletionStorage,
} from "../src/platform/index.js";

const CANARY = "/private/deletion-owner-canary";
const DELETION_EXPORTS = Object.freeze([
  "EXPORT_DELETION_COMMIT_MARKER_BASENAME",
  "EXPORT_DELETION_JOURNAL_BASENAME",
  "EXPORT_DELETION_RECEIPT_BASENAME",
  "ExportDeletionError",
  "buildLocalExportDeletionPlan",
  "planLocalExportDeletion",
]);
const EXECUTOR_EXPORTS = Object.freeze([
  "ExportDeletionExecutionError",
  "deleteLocalExport",
  "recoverLocalExportDeletion",
]);
const SCHEMA_EXPORTS = Object.freeze([
  "EXPORT_DELETION_COMMIT_MARKER_SCHEMA_SHA256",
  "EXPORT_DELETION_COMMIT_MARKER_VERSION",
  "EXPORT_DELETION_CONFIRMATION_TOKEN_PATTERN",
  "EXPORT_DELETION_INVENTORY_ROLES",
  "EXPORT_DELETION_JOURNAL_SCHEMA_SHA256",
  "EXPORT_DELETION_JOURNAL_VERSION",
  "EXPORT_DELETION_ORDER_VERSION",
  "EXPORT_DELETION_PLAN_VERSION",
  "EXPORT_DELETION_PREFLIGHT_SCHEMA_SHA256",
  "EXPORT_DELETION_PREFLIGHT_VERSION",
  "EXPORT_DELETION_RECEIPT_SCHEMA_SHA256",
  "EXPORT_DELETION_RECEIPT_VERSION",
  "MAXIMUM_EXPORT_DELETION_INVENTORY_ROWS",
  "assertValidExportDeletionCommitMarker",
  "assertValidExportDeletionJournal",
  "assertValidExportDeletionPreflight",
  "assertValidExportDeletionReceipt",
  "exportDeletionCommitMarkerSchema",
  "exportDeletionJournalSchema",
  "exportDeletionPreflightSchema",
  "exportDeletionReceiptSchema",
  "validateExportDeletionCommitMarker",
  "validateExportDeletionJournal",
  "validateExportDeletionPreflight",
  "validateExportDeletionReceipt",
]);

class FakeExecutionError extends Error {}

function fakePreflightFactory() {
  return Object.freeze({
    async inspectDirectory(path) {
      const workspace = path.includes("workspace");
      return {
        path,
        stats: { dev: workspace ? 1 : 2, ino: workspace ? 11 : 22 },
        parent: { path: "/tmp", stats: { dev: 1, ino: 2 } },
        entries: workspace ? ["workspace.sqlite3"] : [],
      };
    },
    async hashOwnerOnlyFile() {
      return { device: 1, inode: 1, fileType: "regular_file", linkCount: 1, byteSize: 2, sha256: "0".repeat(64) };
    },
    async readCanonicalManifest() {
      return {
        manifest: { chunks: [] },
        text: "{}",
        evidence: { device: 2, inode: 2, fileType: "regular_file", linkCount: 1, byteSize: 2, sha256: "0".repeat(64) },
      };
    },
    async assertDirectoryStable() {},
  });
}

function fakeStorageFactory() {
  return Object.freeze({
    ExportDeletionExecutionError: FakeExecutionError,
    async deleteLocalExport() { return {}; },
    async recoverLocalExportDeletion() { return {}; },
  });
}

function applicationConfiguration(overrides = {}) {
  return {
    verifyExportSet: async () => {},
    openExportWorkspace: async () => { throw new Error("unused"); },
    withExistingExportWorkspaceLease: async () => { throw new Error("unused"); },
    isTrustedExportWorkspaceLockError: () => false,
    workspaceDatabaseBasename: "workspace.sqlite3",
    createPreflightInspector: fakePreflightFactory,
    createDeletionStorage: fakeStorageFactory,
    ...overrides,
  };
}

function fixedErrorCode(code) {
  return (error) => error?.code === code && !String(error.message).includes(CANARY);
}

test("deletion compatibility shims retain their exact historical surfaces and one internal singleton", () => {
  assert.deepEqual(Object.keys(deletionShim).sort(), [...DELETION_EXPORTS].sort());
  assert.deepEqual(Object.keys(executorShim).sort(), [...EXECUTOR_EXPORTS].sort());
  assert.deepEqual(Object.keys(schemaShim).sort(), [...SCHEMA_EXPORTS].sort());
  for (const name of DELETION_EXPORTS.filter((name) => !name.startsWith("EXPORT_"))) {
    assert.equal(deletionShim[name], LEGACY_EXPORT_DELETION_INTERNAL[name]);
  }
  for (const name of EXECUTOR_EXPORTS) {
    assert.equal(executorShim[name], LEGACY_EXPORT_DELETION_INTERNAL[name]);
  }
  assert.equal("deleteLocalExport" in deletionShim, false);
  assert.equal("buildLocalExportDeletionPlan" in executorShim, false);
});

test("every deletion application configuration port rejects accessors without invoking them", () => {
  const baseline = applicationConfiguration();
  let touched = 0;
  for (const key of Object.keys(baseline)) {
    const candidate = { ...baseline };
    Object.defineProperty(candidate, key, {
      enumerable: true,
      get() { touched += 1; throw new Error(CANARY); },
    });
    assert.throws(
      () => createLocalExportDeletion(candidate),
      (error) => error instanceof TypeError && !error.message.includes(CANARY),
      key,
    );
  }
  const proxy = new Proxy({}, {
    get() { touched += 1; throw new Error(CANARY); },
    getOwnPropertyDescriptor() { touched += 1; throw new Error(CANARY); },
  });
  assert.throws(() => createLocalExportDeletion(proxy), TypeError);
  assert.equal(touched, 0);
});

test("deletion factories and returned method ports collapse raw failures without reading canaries", () => {
  for (const key of ["createPreflightInspector", "createDeletionStorage"]) {
    assert.throws(
      () => createLocalExportDeletion(applicationConfiguration({
        [key]() { throw new Error(CANARY); },
      })),
      (error) => error instanceof TypeError
        && error.message === "Local export deletion configuration is invalid",
      key,
    );
  }

  let touched = 0;
  const trappedMethods = {};
  Object.defineProperty(trappedMethods, "inspectDirectory", {
    enumerable: true,
    get() { touched += 1; throw new Error(CANARY); },
  });
  assert.throws(
    () => createLocalExportDeletion(applicationConfiguration({
      createPreflightInspector: () => trappedMethods,
    })),
    (error) => error instanceof TypeError && !error.message.includes(CANARY),
  );
  const proxyResult = new Proxy({}, {
    get() { touched += 1; throw new Error(CANARY); },
    getOwnPropertyDescriptor() { touched += 1; throw new Error(CANARY); },
  });
  assert.throws(
    () => createLocalExportDeletion(applicationConfiguration({ createDeletionStorage: () => proxyResult })),
    TypeError,
  );
  assert.equal(touched, 0);
});

test("application verification, workspace, and nested inspector port failures map to fixed codes", async () => {
  const verificationFailure = createLocalExportDeletion(applicationConfiguration({
    verifyExportSet: async () => { throw new Error(CANARY); },
  }));
  await assert.rejects(
    verificationFailure.buildLocalExportDeletionPlan({ workspaceDirectory: "/tmp/workspace", outputDirectory: "/tmp/output" }),
    fixedErrorCode("export_deletion_set_state"),
  );

  const workspaceFailure = createLocalExportDeletion(applicationConfiguration({
    openExportWorkspace: async () => { throw new Error(CANARY); },
  }));
  await assert.rejects(
    workspaceFailure.buildLocalExportDeletionPlan({ workspaceDirectory: "/tmp/workspace", outputDirectory: "/tmp/output" }),
    fixedErrorCode("export_deletion_workspace_state"),
  );

  let touched = 0;
  const nestedInspectorFailure = createLocalExportDeletion(applicationConfiguration({
    createPreflightInspector: () => ({
      ...fakePreflightFactory(),
      async inspectDirectory() {
        const result = {};
        Object.defineProperty(result, "path", {
          enumerable: true,
          get() { touched += 1; throw new Error(CANARY); },
        });
        return result;
      },
    }),
  }));
  await assert.rejects(
    nestedInspectorFailure.buildLocalExportDeletionPlan({ workspaceDirectory: "/tmp/workspace", outputDirectory: "/tmp/output" }),
    fixedErrorCode("export_deletion_directory"),
  );
  assert.equal(touched, 0);
});

test("public build, delete, and recover options reject Proxy/accessor traps with fixed errors", async () => {
  let touched = 0;
  const proxy = new Proxy({}, {
    get() { touched += 1; throw new Error(CANARY); },
    getOwnPropertyDescriptor() { touched += 1; throw new Error(CANARY); },
  });
  await assert.rejects(
    deletionShim.buildLocalExportDeletionPlan(proxy),
    fixedErrorCode("export_deletion_paths_required"),
  );
  await assert.rejects(
    executorShim.deleteLocalExport(proxy),
    fixedErrorCode("export_deletion_execute_confirmation"),
  );
  await assert.rejects(
    executorShim.recoverLocalExportDeletion(proxy),
    fixedErrorCode("export_deletion_execute_journal_missing"),
  );
  const accessor = {};
  Object.defineProperty(accessor, "workspaceDirectory", {
    enumerable: true,
    get() { touched += 1; throw new Error(CANARY); },
  });
  await assert.rejects(
    deletionShim.planLocalExportDeletion(accessor),
    fixedErrorCode("export_deletion_paths_required"),
  );
  assert.equal(touched, 0);
});

test("preflight never inspects forged error fields and only rethrows an exact trusted error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deletion-preflight-error-"));
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, stableJson({}), { mode: 0o600 });
  try {
    let touched = 0;
    const forged = {};
    Object.defineProperty(forged, "code", {
      get() { touched += 1; throw new Error(CANARY); },
    });
    const inspector = createOwnerOnlyExportDeletionPreflightInspector({
      fail(code) { throw new Error(`fixed:${code}`); },
      isTrustedDeletionError: () => false,
      stableJson,
      assertValidExportSetManifest() { throw forged; },
      maximumDirectoryEntries: 8,
      maximumManifestBytes: 1024,
    });
    await assert.rejects(
      inspector.readCanonicalManifest(manifestPath),
      (error) => error.message === "fixed:set_state" && !error.message.includes(CANARY),
    );
    assert.equal(touched, 0);

    const trusted = new Error("fixed trusted error");
    const trustedInspector = createOwnerOnlyExportDeletionPreflightInspector({
      fail(code) { throw new Error(`unexpected:${code}`); },
      isTrustedDeletionError: (error) => error === trusted,
      stableJson,
      assertValidExportSetManifest() { throw trusted; },
      maximumDirectoryEntries: 8,
      maximumManifestBytes: 1024,
    });
    await assert.rejects(trustedInspector.readCanonicalManifest(manifestPath), (error) => error === trusted);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace close always runs, preserves an exact primary error, and maps close-only failures", async () => {
  let deletion;
  let closeCalls = 0;
  deletion = createLocalExportDeletion(applicationConfiguration({
    openExportWorkspace: async () => ({
      isScanComplete() { throw new deletion.ExportDeletionError("binding"); },
      isPoisoned() { return false; },
      getDescriptor() { return {}; },
      chunks() { return []; },
      manifestState() { return {}; },
      close() { closeCalls += 1; throw new Error(CANARY); },
    }),
  }));
  await assert.rejects(
    deletion.buildLocalExportDeletionPlan({ workspaceDirectory: "/tmp/workspace", outputDirectory: "/tmp/output" }),
    fixedErrorCode("export_deletion_binding"),
  );
  assert.equal(closeCalls, 1);

  closeCalls = 0;
  const closeOnly = createLocalExportDeletion(applicationConfiguration({
    openExportWorkspace: async () => ({
      isScanComplete() { return true; },
      isPoisoned() { return false; },
      getDescriptor() { return {}; },
      chunks() { return []; },
      manifestState() { return {}; },
      close() { closeCalls += 1; throw new Error(CANARY); },
    }),
  }));
  await assert.rejects(
    closeOnly.buildLocalExportDeletionPlan({ workspaceDirectory: "/tmp/workspace", outputDirectory: "/tmp/output" }),
    fixedErrorCode("export_deletion_workspace_state"),
  );
  assert.equal(closeCalls, 1);

  closeCalls = 0;
  let touched = 0;
  const invalidWorkspacePort = createLocalExportDeletion(applicationConfiguration({
    openExportWorkspace: async () => {
      const workspace = {
        close() { closeCalls += 1; },
        isPoisoned() { return false; },
        getDescriptor() { return {}; },
        chunks() { return []; },
        manifestState() { return {}; },
      };
      Object.defineProperty(workspace, "isScanComplete", {
        enumerable: true,
        get() { touched += 1; throw new Error(CANARY); },
      });
      return workspace;
    },
  }));
  await assert.rejects(
    invalidWorkspacePort.buildLocalExportDeletionPlan({ workspaceDirectory: "/tmp/workspace", outputDirectory: "/tmp/output" }),
    fixedErrorCode("export_deletion_workspace_state"),
  );
  assert.equal(closeCalls, 1);
  assert.equal(touched, 0);
});

test("forged, proxied, and subclassed application errors are never trusted", async () => {
  let deletion;
  let touched = 0;
  deletion = createLocalExportDeletion(applicationConfiguration({
    createPreflightInspector: () => ({
      ...fakePreflightFactory(),
      async inspectDirectory() {
        class ForgedDeletionError extends deletion.ExportDeletionError {
          constructor() { super("binding"); this.message = CANARY; }
        }
        throw new ForgedDeletionError();
      },
    }),
  }));
  await assert.rejects(
    deletion.buildLocalExportDeletionPlan({ workspaceDirectory: "/tmp/workspace", outputDirectory: "/tmp/output" }),
    fixedErrorCode("export_deletion_directory"),
  );

  const thrownProxy = new Proxy({}, {
    get() { touched += 1; throw new Error(CANARY); },
    getPrototypeOf() { touched += 1; throw new Error(CANARY); },
  });
  const proxyDeletion = createLocalExportDeletion(applicationConfiguration({
    createPreflightInspector: () => ({
      ...fakePreflightFactory(),
      async inspectDirectory() { throw thrownProxy; },
    }),
  }));
  await assert.rejects(
    proxyDeletion.buildLocalExportDeletionPlan({ workspaceDirectory: "/tmp/workspace", outputDirectory: "/tmp/output" }),
    fixedErrorCode("export_deletion_directory"),
  );
  assert.equal(touched, 0);
});

test("storage snapshots every configuration and nested semantic binding without invoking accessors", () => {
  let captured;
  createLocalExportDeletion(applicationConfiguration({
    createDeletionStorage(configuration) {
      captured = configuration;
      return fakeStorageFactory();
    },
  }));
  let touched = 0;
  for (const key of Object.keys(captured)) {
    const candidate = { ...captured };
    Object.defineProperty(candidate, key, {
      enumerable: true,
      get() { touched += 1; throw new Error(CANARY); },
    });
    assert.throws(() => createOwnerOnlyExportDeletionStorage(candidate), TypeError, key);
  }
  for (const key of Object.keys(captured.semantics)) {
    const semantics = { ...captured.semantics };
    Object.defineProperty(semantics, key, {
      enumerable: true,
      get() { touched += 1; throw new Error(CANARY); },
    });
    assert.throws(
      () => createOwnerOnlyExportDeletionStorage({ ...captured, semantics }),
      TypeError,
      key,
    );
  }
  assert.equal(touched, 0);
});

test("storage snapshots nested plan results and normalizes raw lease and forged execution errors", async () => {
  let captured;
  createLocalExportDeletion(applicationConfiguration({
    createDeletionStorage(configuration) {
      captured = configuration;
      return fakeStorageFactory();
    },
  }));
  let touched = 0;
  const rawPlanOwner = createOwnerOnlyExportDeletionStorage({
    ...captured,
    planLocalExportDeletion: async () => { throw new Error(CANARY); },
  });
  await assert.rejects(
    rawPlanOwner.deleteLocalExport({
      workspaceDirectory: "/tmp/workspace",
      outputDirectory: "/tmp/output",
      confirmationToken: "AAAAAAAAAAAA",
    }),
    fixedErrorCode("export_deletion_execute_confirmation"),
  );

  const accessorPreview = {};
  Object.defineProperty(accessorPreview, "confirmationToken", {
    enumerable: true,
    get() { touched += 1; throw new Error(CANARY); },
  });
  const accessorOwner = createOwnerOnlyExportDeletionStorage({
    ...captured,
    planLocalExportDeletion: async () => accessorPreview,
  });
  await assert.rejects(
    accessorOwner.deleteLocalExport({
      workspaceDirectory: "/tmp/workspace",
      outputDirectory: "/tmp/output",
      confirmationToken: "AAAAAAAAAAAA",
    }),
    fixedErrorCode("export_deletion_execute_confirmation"),
  );
  assert.equal(touched, 0);

  const forged = {};
  Object.defineProperty(forged, "code", {
    get() { touched += 1; throw new Error(CANARY); },
  });
  const forgedOwner = createOwnerOnlyExportDeletionStorage({
    ...captured,
    planLocalExportDeletion: async () => ({ confirmationToken: "AAAAAAAAAAAA" }),
    withExistingExportWorkspaceLease: async () => { throw forged; },
  });
  await assert.rejects(
    forgedOwner.deleteLocalExport({
      workspaceDirectory: "/tmp/workspace",
      outputDirectory: "/tmp/output",
      confirmationToken: "AAAAAAAAAAAA",
    }),
    fixedErrorCode("export_deletion_execute_replacement"),
  );
  assert.equal(touched, 0);

  let subclassOwner;
  subclassOwner = createOwnerOnlyExportDeletionStorage({
    ...captured,
    planLocalExportDeletion: async () => ({ confirmationToken: "AAAAAAAAAAAA" }),
    withExistingExportWorkspaceLease: async () => {
      class ForgedExecutionError extends subclassOwner.ExportDeletionExecutionError {
        constructor() { super("replacement"); this.message = CANARY; }
      }
      throw new ForgedExecutionError();
    },
  });
  await assert.rejects(
    subclassOwner.deleteLocalExport({
      workspaceDirectory: "/tmp/workspace",
      outputDirectory: "/tmp/output",
      confirmationToken: "AAAAAAAAAAAA",
    }),
    fixedErrorCode("export_deletion_execute_replacement"),
  );
});
