import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertValidExportRecord,
  createExportWorkspaceContract,
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  EXPORT_CHECKPOINT_PARSER_VERSION,
  EXPORT_DIAGNOSTIC_CODES,
  EXPORT_RESOURCE_POLICY_VERSION,
  normalizeExportResourceLimits,
  stableJson,
} from "../src/export/index.js";
import {
  createOwnerOnlyExportWorkspaceLeaseContext,
  createOwnerOnlyExportWorkspaceStorageContext,
  sha256Hex,
} from "../src/platform/index.js";
import { createLocalExportWorkspaceContext } from "../src/application/index.js";
import {
  localCodexCheckpointState,
  localExportWorkspace,
} from "../src/local-node-runtime.js";
import { EXPORT_SOURCE_PLAN_VERSION, summarizeExportSourcePlan } from "../src/export-source-plan.js";
import {
  assertCanonicalSupplementalCursorJson,
  createEmptySupplementalSourcePlan,
  EXPORT_SUPPLEMENTAL_SOURCE_PLAN_VERSION,
  normalizeSupplementalSourcePlan,
  summarizeSupplementalSourcePlan,
} from "../src/export-supplemental-source-plan.js";
import { isProxy } from "node:util/types";
const {
  createEmptyCodexCheckpointState,
  normalizeCodexCheckpointState,
  serializeCodexCheckpointState,
} = localCodexCheckpointState;

const WORKSPACE_SHIM_EXPORTS = Object.freeze([
  "DEFAULT_EXPORT_WORKSPACE_BATCH_RECORDS",
  "DEFAULT_EXPORT_WORKSPACE_MAXIMUM_BYTES",
  "EXPORT_WORKSPACE_DATABASE_BASENAME",
  "EXPORT_WORKSPACE_VERSION",
  "ExportWorkspaceError",
  "buildExportWorkspaceDescriptor",
  "createExportWorkspace",
  "inspectExportWorkspaceDiscardState",
  "openExportWorkspace",
  "sourceCheckpointBatchSha256",
  "supplementalSourceCheckpointBatchSha256",
]);

const WORKSPACE_LOCK_SHIM_EXPORTS = Object.freeze([
  "ExportWorkspaceLockError",
  "withExistingExportWorkspaceLease",
  "withExportWorkspaceLease",
]);

function contractConfiguration(overrides = {}) {
  return {
    isProxy,
    stableJson,
    sha256Hex,
    platformName: () => "macos",
    assertValidExportRecord,
    EXPORT_DIAGNOSTIC_CODES,
    EXPORT_CHECKPOINT_PARSER_VERSION,
    createEmptyCodexCheckpointState,
    normalizeCodexCheckpointState,
    serializeCodexCheckpointState,
    DEFAULT_EXPORT_RESOURCE_LIMITS,
    EXPORT_RESOURCE_POLICY_VERSION,
    normalizeExportResourceLimits,
    EXPORT_SOURCE_PLAN_VERSION,
    summarizeExportSourcePlan,
    assertCanonicalSupplementalCursorJson,
    createEmptySupplementalSourcePlan,
    EXPORT_SUPPLEMENTAL_SOURCE_PLAN_VERSION,
    normalizeSupplementalSourcePlan,
    summarizeSupplementalSourcePlan,
    ...overrides,
  };
}

test("workspace ownership layers reject Proxy/getter configuration without evaluating it", () => {
  const getter = {};
  Object.defineProperty(getter, "workspaceContract", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.throws(
    () => createOwnerOnlyExportWorkspaceStorageContext(getter),
    /Owner-only export workspace storage configuration is invalid/,
  );
  assert.throws(
    () => createOwnerOnlyExportWorkspaceStorageContext(new Proxy({}, {})),
    /Owner-only export workspace storage configuration is invalid/,
  );
  const leaseGetter = {};
  Object.defineProperty(leaseGetter, "stableJson", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.throws(
    () => createOwnerOnlyExportWorkspaceLeaseContext(leaseGetter),
    /Owner-only export workspace lease configuration is invalid/,
  );
  assert.throws(
    () => createLocalExportWorkspaceContext({}),
    /Local export workspace configuration is invalid/,
  );
  assert.throws(
    () => createExportWorkspaceContract(new Proxy({}, {})),
    /Export workspace contract configuration is invalid/,
  );
});

test("workspace contracts reject nested proxy data without invoking a trap or retaining mutations", () => {
  let trapHits = 0;
  const trappedLimits = new Proxy({}, {
    get() { trapHits += 1; throw new Error("must not run"); },
    ownKeys() { trapHits += 1; throw new Error("must not run"); },
  });
  assert.throws(
    () => createExportWorkspaceContract(contractConfiguration({ DEFAULT_EXPORT_RESOURCE_LIMITS: trappedLimits })),
    /Export workspace contract configuration is invalid/,
  );
  assert.equal(trapHits, 0);

  let getterHits = 0;
  const getterLimits = {};
  Object.defineProperty(getterLimits, "maximumWorkspaceBytes", {
    enumerable: true,
    get() { getterHits += 1; throw new Error("must not run"); },
  });
  assert.throws(
    () => createExportWorkspaceContract(contractConfiguration({ DEFAULT_EXPORT_RESOURCE_LIMITS: getterLimits })),
    /Export workspace contract configuration is invalid/,
  );
  assert.equal(getterHits, 0);

  const mutableLimits = { ...DEFAULT_EXPORT_RESOURCE_LIMITS };
  const contract = createExportWorkspaceContract(contractConfiguration({ DEFAULT_EXPORT_RESOURCE_LIMITS: mutableLimits }));
  const originalMaximum = contract.DEFAULT_EXPORT_RESOURCE_LIMITS.maximumWorkspaceBytes;
  mutableLimits.maximumWorkspaceBytes = 1;
  assert.equal(contract.DEFAULT_EXPORT_RESOURCE_LIMITS.maximumWorkspaceBytes, originalMaximum);

  trapHits = 0;
  const forgedContract = {
    ...contract,
    DEFAULT_EXPORT_RESOURCE_LIMITS: new Proxy({}, {
      get() { trapHits += 1; throw new Error("must not run"); },
      ownKeys() { trapHits += 1; throw new Error("must not run"); },
    }),
  };
  assert.throws(
    () => createOwnerOnlyExportWorkspaceStorageContext({ workspaceContract: forgedContract }),
    /Owner-only export workspace storage configuration is invalid/,
  );
  assert.equal(trapHits, 0);

  getterHits = 0;
  const forgedGetterContract = { ...contract };
  Object.defineProperty(forgedGetterContract, "DEFAULT_EXPORT_RESOURCE_LIMITS", {
    enumerable: true,
    get() { getterHits += 1; throw new Error("must not run"); },
  });
  assert.throws(
    () => createOwnerOnlyExportWorkspaceStorageContext({ workspaceContract: forgedGetterContract }),
    /Owner-only export workspace storage configuration is invalid/,
  );
  assert.equal(getterHits, 0);
});

test("workspace platform owners import no higher-level owner or legacy storage", async () => {
  for (const path of [
    new URL("../src/platform/owner-only-export-workspace-storage.js", import.meta.url),
    new URL("../src/platform/owner-only-export-workspace-lease.js", import.meta.url),
  ]) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /from ["']\.\.\/(?:export|application)\//);
    assert.doesNotMatch(source, /storage\.js/);
  }
});

test("workspace and lease operations share one exact local runtime context", () => {
  assert.deepEqual(
    Object.keys(localExportWorkspace).sort(),
    [...WORKSPACE_SHIM_EXPORTS, ...WORKSPACE_LOCK_SHIM_EXPORTS,
      "isTrustedExportWorkspaceLockError"].sort(),
  );
});
