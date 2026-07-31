import { isProxy } from "node:util/types";
import { createHash } from "node:crypto";
import {
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  EXPORT_CHECKPOINT_PARSER_VERSION,
  EXPORT_DIAGNOSTIC_CODES,
  EXPORT_RESOURCE_POLICY_VERSION,
  EXPORT_SOURCE_PLAN_VERSION,
  EXPORT_SUPPLEMENTAL_SOURCE_PLAN_VERSION,
  assertCanonicalSupplementalCursorJson,
  assertValidExportRecord,
  createCodexCheckpointStateContext,
  createEmptySupplementalSourcePlan,
  createExportWorkspaceContract,
  normalizeExportResourceLimits,
  normalizeSupplementalSourcePlan,
  stableJson,
  summarizeExportSourcePlan,
  summarizeSupplementalSourcePlan,
} from "../export/workspace-runtime.js";

function invalid() {
  throw new TypeError("Local export workspace configuration is invalid");
}

function own(configuration, key) {
  try {
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)
        || isProxy(configuration) || !Object.hasOwn(configuration, key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(configuration, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
    return descriptor.value;
  } catch { invalid(); }
}

function callable(value) {
  if (typeof value !== "function" || isProxy(value)) invalid();
  return value;
}

/**
 * Reviewed application facade: it snapshots the pure contract and two
 * platform factories once, then exposes the historical workspace/lease API.
 */
export function createLocalExportWorkspaceContext(configuration = {}) {
  const workspaceContract = own(configuration, "workspaceContract");
  const createStorage = callable(own(configuration, "createStorage"));
  const createLease = callable(own(configuration, "createLease"));
  if (!workspaceContract || typeof workspaceContract !== "object" || Array.isArray(workspaceContract)
      || isProxy(workspaceContract)) invalid();
  const requiredContract = [
    "EXPORT_WORKSPACE_VERSION", "DEFAULT_EXPORT_WORKSPACE_MAXIMUM_BYTES",
    "DEFAULT_EXPORT_WORKSPACE_BATCH_RECORDS", "EXPORT_WORKSPACE_DATABASE_BASENAME",
    "ExportWorkspaceError", "sourceCheckpointBatchSha256",
    "supplementalSourceCheckpointBatchSha256", "buildExportWorkspaceDescriptor",
  ];
  const contract = {};
  for (const name of requiredContract) contract[name] = own(workspaceContract, name);
  if (typeof contract.ExportWorkspaceError !== "function"
      || ["sourceCheckpointBatchSha256", "supplementalSourceCheckpointBatchSha256", "buildExportWorkspaceDescriptor"]
        .some((name) => typeof contract[name] !== "function" || isProxy(contract[name]))) invalid();
  let storage;
  let lease;
  try {
    storage = createStorage({ workspaceContract });
    lease = createLease({ stableJson: own(workspaceContract, "stableJson") });
  } catch { invalid(); }
  if (!storage || typeof storage !== "object" || isProxy(storage)
      || !lease || typeof lease !== "object" || isProxy(lease)) invalid();
  const createExportWorkspace = callable(own(storage, "createExportWorkspace"));
  const openExportWorkspace = callable(own(storage, "openExportWorkspace"));
  const inspectExportWorkspaceDiscardState = callable(own(storage, "inspectExportWorkspaceDiscardState"));
  const ExportWorkspaceLockError = callable(own(lease, "ExportWorkspaceLockError"));
  const isTrustedExportWorkspaceLockError = callable(own(lease, "isTrustedExportWorkspaceLockError"));
  const withExportWorkspaceLease = callable(own(lease, "withExportWorkspaceLease"));
  const withExistingExportWorkspaceLease = callable(own(lease, "withExistingExportWorkspaceLease"));
  return Object.freeze({
    ...contract,
    createExportWorkspace,
    openExportWorkspace,
    inspectExportWorkspaceDiscardState,
    ExportWorkspaceLockError,
    isTrustedExportWorkspaceLockError,
    withExportWorkspaceLease,
    withExistingExportWorkspaceLease,
  });
}

/** Small lease-only facade for the legacy lock entry point. */
export function createLocalExportWorkspaceLeaseContext(configuration = {}) {
  const createLease = callable(own(configuration, "createLease"));
  const stableJson = callable(own(configuration, "stableJson"));
  let lease;
  try { lease = createLease({ stableJson }); } catch { invalid(); }
  if (!lease || typeof lease !== "object" || isProxy(lease)) invalid();
  return Object.freeze({
    ExportWorkspaceLockError: callable(own(lease, "ExportWorkspaceLockError")),
    isTrustedExportWorkspaceLockError: callable(own(lease, "isTrustedExportWorkspaceLockError")),
    withExportWorkspaceLease: callable(own(lease, "withExportWorkspaceLease")),
    withExistingExportWorkspaceLease: callable(own(lease, "withExistingExportWorkspaceLease")),
  });
}

/**
 * Build the reviewed workspace contract once from export-owned semantics and
 * caller-supplied platform mechanics. No legacy workspace composition leaks
 * into application consumers.
 */
export function createLocalExportWorkspaceRuntimeContext(configuration = {}) {
  const createStorage = callable(own(configuration, "createStorage"));
  const createLease = callable(own(configuration, "createLease"));
  const sha256Hex = callable(own(configuration, "sha256Hex"));
  const platformName = callable(own(configuration, "platformName"));
  const checkpoint = createCodexCheckpointStateContext({ createHash, isProxy });
  const workspaceContract = createExportWorkspaceContract({
    isProxy,
    stableJson,
    sha256Hex,
    platformName,
    assertValidExportRecord,
    EXPORT_DIAGNOSTIC_CODES,
    EXPORT_CHECKPOINT_PARSER_VERSION,
    createEmptyCodexCheckpointState: checkpoint.createEmptyCodexCheckpointState,
    normalizeCodexCheckpointState: checkpoint.normalizeCodexCheckpointState,
    serializeCodexCheckpointState: checkpoint.serializeCodexCheckpointState,
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
  });
  return createLocalExportWorkspaceContext({ workspaceContract, createStorage, createLease });
}
