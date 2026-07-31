import { createHash } from "node:crypto";
import { join, sep } from "node:path";
import { isProxy } from "node:util/types";
import {
  assertValidExportDeletionJournal,
  assertValidExportDeletionPreflight,
  assertValidExportDeletionCommitMarker,
  assertValidExportDeletionReceipt,
  assertValidExportSetManifest,
  combinedSourcePlanCommitment,
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  ExportResourceLimitError,
  EXPORT_DELETION_COMMIT_MARKER_BASENAME,
  EXPORT_DELETION_COMMIT_MARKER_VERSION,
  EXPORT_DELETION_CONFIRMATION_TOKEN_PATTERN,
  EXPORT_DELETION_DESTINATION_LOCK_BASENAME,
  EXPORT_DELETION_DESTINATION_TRANSACTION_BASENAME,
  EXPORT_DELETION_INVENTORY_ROLES,
  EXPORT_DELETION_JOURNAL_BASENAME,
  EXPORT_DELETION_JOURNAL_VERSION,
  EXPORT_DELETION_ORDER_VERSION,
  EXPORT_DELETION_PLAN_VERSION,
  EXPORT_DELETION_PREFLIGHT_VERSION,
  EXPORT_DELETION_QUARANTINE_PREFIX,
  EXPORT_DELETION_RECEIPT_BASENAME,
  EXPORT_DELETION_RECEIPT_VERSION,
  EXPORT_DELETION_WORKSPACE_LOCK_BASENAME,
  EXPORT_SET_MANIFEST_BASENAME,
  EXPORT_SET_MANIFEST_RECEIPT_BASENAME,
  exportSetChunkBasenames,
  stableJson,
} from "../export/index.js";

function invalid() { throw new TypeError("Local export deletion configuration is invalid"); }
function own(object, key) {
  if (!object || typeof object !== "object" || Array.isArray(object) || isProxy(object)) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
  return descriptor.value;
}
function callable(value) {
  if (typeof value !== "function" || isProxy(value)) invalid();
  return value;
}

function portResultError() {
  throw new TypeError("Local export deletion port result is invalid");
}

function snapshotOwnOptions(value, keys, reject) {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) reject();
  const result = {};
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if (!Object.hasOwn(descriptor, "value")) reject();
      result[key] = descriptor.value;
    }
  } catch {
    reject();
  }
  return Object.freeze(result);
}

function snapshotJsonData(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || isProxy(value) || seen.has(value)) portResultError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) portResultError();
  if (Object.getOwnPropertySymbols(value).length > 0) portResultError();
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0) portResultError();
      const result = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, "value")) portResultError();
        result.push(snapshotJsonData(descriptor.value, seen));
      }
      return Object.freeze(result);
    }
    const result = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) continue;
      if (!Object.hasOwn(descriptor, "value")) portResultError();
      result[key] = snapshotJsonData(descriptor.value, seen);
    }
    return Object.freeze(result);
  } finally {
    seen.delete(value);
  }
}

function snapshotMethodPort(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) invalid();
  const methods = {};
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
      methods[key] = callable(descriptor.value);
    }
  } catch {
    invalid();
  }
  return Object.freeze({ receiver: value, methods: Object.freeze(methods) });
}

/**
 * Reviewed deletion application facade. It owns preflight orchestration and
 * injects workspace, verification, directory, and durable platform ports.
 */
export function createLocalExportDeletion(configuration = {}) {
  const verifyExportSet = callable(own(configuration, "verifyExportSet"));
  const openExportWorkspace = callable(own(configuration, "openExportWorkspace"));
  const withExistingExportWorkspaceLease = callable(own(configuration, "withExistingExportWorkspaceLease"));
  const isTrustedExportWorkspaceLockError = callable(own(configuration, "isTrustedExportWorkspaceLockError"));
  const createPreflightInspector = callable(own(configuration, "createPreflightInspector"));
  const createDeletionStorage = callable(own(configuration, "createDeletionStorage"));
  const workspaceDatabaseBasename = own(configuration, "workspaceDatabaseBasename");
  if (typeof workspaceDatabaseBasename !== "string" || workspaceDatabaseBasename.length === 0) invalid();
  const WORKSPACE_LOCK_BASENAME = EXPORT_DELETION_WORKSPACE_LOCK_BASENAME;
  const DESTINATION_LOCK_BASENAME = EXPORT_DELETION_DESTINATION_LOCK_BASENAME;
  const DESTINATION_TRANSACTION_BASENAME = EXPORT_DELETION_DESTINATION_TRANSACTION_BASENAME;
  const DELETION_QUARANTINE_PREFIX = EXPORT_DELETION_QUARANTINE_PREFIX;

const WORKSPACE_SIDECARS = Object.freeze([
  [`${workspaceDatabaseBasename}-journal`, EXPORT_DELETION_INVENTORY_ROLES.workspaceSqliteJournal],
  [`${workspaceDatabaseBasename}-wal`, EXPORT_DELETION_INVENTORY_ROLES.workspaceSqliteWal],
  [`${workspaceDatabaseBasename}-shm`, EXPORT_DELETION_INVENTORY_ROLES.workspaceSqliteShm],
]);
const SAFE_CODES = new Set([
  "paths_required", "directory", "directory_relation", "directory_changed", "active_control",
  "workspace_entries", "workspace_state", "set_state", "binding", "artifact_missing",
  "artifact_type", "artifact_owner", "artifact_permissions", "artifact_links", "artifact_size",
  "artifact_changed", "artifact_read",
]);

const trustedDeletionErrors = new WeakSet();

class ExportDeletionError extends Error {
  constructor(code) {
    if (!SAFE_CODES.has(code)) throw new TypeError("Unknown export-deletion code");
    super(`Local export deletion preflight failed (${code})`);
    this.name = "ExportDeletionError";
    this.code = `export_deletion_${code}`;
    trustedDeletionErrors.add(this);
  }
}

function isTrustedDeletionError(error) {
  return Boolean(error && trustedDeletionErrors.has(error)
    && Object.getPrototypeOf(error) === ExportDeletionError.prototype);
}

function deletionError(code) {
  return new ExportDeletionError(code);
}

function fail(code) {
  throw deletionError(code);
}

let preflightPort;
try {
  const preflightInspector = Reflect.apply(createPreflightInspector, undefined, [Object.freeze({
    fail,
    isTrustedDeletionError,
    stableJson,
    assertValidExportSetManifest,
    maximumDirectoryEntries: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries,
    maximumManifestBytes: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumManifestBytes,
  })]);
  preflightPort = snapshotMethodPort(preflightInspector, [
    "inspectDirectory",
    "hashOwnerOnlyFile",
    "readCanonicalManifest",
    "assertDirectoryStable",
  ]);
} catch {
  invalid();
}

async function callPreflightPort(name, args, failureCode, { snapshot = true } = {}) {
  try {
    const result = await Reflect.apply(preflightPort.methods[name], preflightPort.receiver, args);
    return snapshot ? snapshotJsonData(result) : result;
  } catch (error) {
    if (isTrustedDeletionError(error)) throw error;
    fail(failureCode);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertSeparateDirectories(workspace, output) {
  if (workspace.path === output.path
      || workspace.path.startsWith(`${output.path}${sep}`)
      || output.path.startsWith(`${workspace.path}${sep}`)) fail("directory_relation");
}

function expectedChunkMetadata(manifest, entry) {
  return {
    index: entry.index,
    bundleId: entry.bundleId,
    participantId: manifest.participantId,
    createdAt: manifest.createdAt,
    coveredAt: manifest.coveredAt,
    bundleSha256: entry.bundleSha256,
    bundleBytes: entry.bundleBytes,
    ...(manifest.schemaVersion.endsWith("v0.2") ? {
      contentEncoding: entry.contentEncoding,
      compressionProfile: entry.compressionProfile,
      artifactSha256: entry.artifactSha256,
      artifactBytes: entry.artifactBytes,
    } : {}),
    receiptSha256: entry.receiptSha256,
    receiptBytes: entry.receiptBytes,
    recordStart: entry.recordStart,
    recordEndExclusive: entry.recordEndExclusive,
    recordCounts: entry.recordCounts,
  };
}

function assertWorkspaceBinding(descriptor, chunks, manifestState, manifest, manifestText) {
  let combinedSourcePlan;
  try {
    combinedSourcePlan = combinedSourcePlanCommitment(descriptor);
  } catch {
    fail("binding");
  }
  const descriptorView = {
    compatibility: descriptor.compatibility,
    participantId: descriptor.participantId,
    createdAt: descriptor.createdAt,
    coveredAt: descriptor.coveredAt,
    sourceProviders: descriptor.sourceProviders,
    clientPlatform: descriptor.clientPlatform,
    sourcePlan: {
      sha256: combinedSourcePlan.sha256,
      sourceFiles: combinedSourcePlan.sourceFiles,
      sourceBytes: combinedSourcePlan.sourceBytes,
    },
  };
  const manifestView = {
    compatibility: manifest.compatibility,
    participantId: manifest.participantId,
    createdAt: manifest.createdAt,
    coveredAt: manifest.coveredAt,
    sourceProviders: manifest.sourceProviders,
    clientPlatform: manifest.clientPlatform,
    sourcePlan: manifest.sourcePlan,
  };
  if (stableJson(descriptorView) !== stableJson(manifestView)) fail("binding");
  const expectedManifestState = {
    exportSetId: manifest.exportSetId,
    manifestSha256: sha256(manifestText),
    manifestBytes: Buffer.byteLength(manifestText),
    chunkCount: manifest.chunks.length,
  };
  if (stableJson(manifestState) !== stableJson(expectedManifestState)
      || chunks.length !== manifest.chunks.length) fail("binding");
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.index !== index || chunk.status !== "verified"
        || stableJson(chunk.metadata) !== stableJson(expectedChunkMetadata(manifest, manifest.chunks[index]))) {
      fail("binding");
    }
  }
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

function confirmationToken(planSha256) {
  return base32(createHash("sha256")
    .update("app-usagemonitor/export-deletion-confirmation/v1\0")
    .update(planSha256)
    .digest().subarray(0, 10));
}

async function buildLocalExportDeletionPlan(options) {
  const selected = snapshotOwnOptions(
    options,
    ["workspaceDirectory", "outputDirectory", "allowLeaseControls"],
    () => fail("paths_required"),
  );
  const {
    workspaceDirectory,
    outputDirectory,
    allowLeaseControls = false,
  } = selected;
  if (!workspaceDirectory || !outputDirectory) fail("paths_required");
  if (typeof workspaceDirectory !== "string" || typeof outputDirectory !== "string"
      || typeof allowLeaseControls !== "boolean") fail("paths_required");
  const workspaceDirectoryInfo = await callPreflightPort("inspectDirectory", [workspaceDirectory], "directory");
  const outputDirectoryInfo = await callPreflightPort("inspectDirectory", [outputDirectory], "directory");
  assertSeparateDirectories(workspaceDirectoryInfo, outputDirectoryInfo);

  const forbiddenOutputControls = [
    DESTINATION_TRANSACTION_BASENAME,
    EXPORT_DELETION_JOURNAL_BASENAME,
    EXPORT_DELETION_COMMIT_MARKER_BASENAME,
    EXPORT_DELETION_RECEIPT_BASENAME,
    ...(!allowLeaseControls ? [DESTINATION_LOCK_BASENAME] : []),
  ];
  if (forbiddenOutputControls.some((name) => outputDirectoryInfo.entries.includes(name))
      || outputDirectoryInfo.entries.some((name) => name.startsWith(DELETION_QUARANTINE_PREFIX))) {
    fail("active_control");
  }

  const allowedWorkspace = new Set([
    workspaceDatabaseBasename,
    ...WORKSPACE_SIDECARS.map(([name]) => name),
    ...(allowLeaseControls ? [WORKSPACE_LOCK_BASENAME] : []),
  ]);
  if (workspaceDirectoryInfo.entries.some((name) => !allowedWorkspace.has(name))
      || !workspaceDirectoryInfo.entries.includes(workspaceDatabaseBasename)
      || (!allowLeaseControls && workspaceDirectoryInfo.entries.includes(WORKSPACE_LOCK_BASENAME))) {
    fail("workspace_entries");
  }

  try {
    await Reflect.apply(verifyExportSet, undefined, [Object.freeze({ directory: outputDirectoryInfo.path })]);
  } catch (error) {
    if (isTrustedDeletionError(error)) throw error;
    fail("set_state");
  }
  const manifestPath = join(outputDirectoryInfo.path, EXPORT_SET_MANIFEST_BASENAME);
  const { manifest, text: manifestText, evidence: manifestEvidence } = await callPreflightPort(
    "readCanonicalManifest",
    [manifestPath],
    "set_state",
  );

  let workspacePort;
  let workspaceClosePort;
  let descriptor;
  let chunks;
  let manifestState;
  let primaryError;
  try {
    const workspace = await Reflect.apply(openExportWorkspace, undefined, [Object.freeze({
      directory: workspaceDirectoryInfo.path,
    })]);
    workspaceClosePort = snapshotMethodPort(workspace, ["close"]);
    workspacePort = snapshotMethodPort(workspace, [
      "close", "isScanComplete", "isPoisoned", "getDescriptor", "chunks", "manifestState",
    ]);
    if (!Reflect.apply(workspacePort.methods.isScanComplete, workspacePort.receiver, [])
        || Reflect.apply(workspacePort.methods.isPoisoned, workspacePort.receiver, [])) fail("workspace_state");
    descriptor = snapshotJsonData(Reflect.apply(workspacePort.methods.getDescriptor, workspacePort.receiver, []));
    chunks = snapshotJsonData(Reflect.apply(workspacePort.methods.chunks, workspacePort.receiver, []));
    manifestState = snapshotJsonData(Reflect.apply(workspacePort.methods.manifestState, workspacePort.receiver, []));
  } catch (error) {
    primaryError = isTrustedDeletionError(error) ? error : deletionError("workspace_state");
  } finally {
    if (workspaceClosePort) {
      try {
        await Reflect.apply(workspaceClosePort.methods.close, workspaceClosePort.receiver, []);
      } catch {
        if (!primaryError) primaryError = deletionError("workspace_state");
      }
    }
  }
  if (primaryError) throw primaryError;
  assertWorkspaceBinding(descriptor, chunks, manifestState, manifest, manifestText);

  const inventoryDefinitions = [
    {
      role: EXPORT_DELETION_INVENTORY_ROLES.setManifest,
      chunkIndex: null,
      path: manifestPath,
      maximumBytes: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumManifestBytes,
      evidence: manifestEvidence,
      scope: "output",
    },
    ...manifest.chunks.map((entry) => {
      const names = exportSetChunkBasenames(entry.index, manifest.schemaVersion);
      return {
        role: EXPORT_DELETION_INVENTORY_ROLES.chunkArtifact,
        chunkIndex: entry.index,
        path: join(outputDirectoryInfo.path, names.bundle),
        maximumBytes: manifest.schemaVersion.endsWith("v0.2") ? entry.artifactBytes : entry.bundleBytes,
        scope: "output",
      };
    }),
    ...WORKSPACE_SIDECARS
      .filter(([name]) => workspaceDirectoryInfo.entries.includes(name))
      .map(([name, role]) => ({
        role,
        chunkIndex: null,
        path: join(workspaceDirectoryInfo.path, name),
        maximumBytes: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumWorkspaceBytes,
        scope: "workspace",
      })),
    {
      role: EXPORT_DELETION_INVENTORY_ROLES.workspaceDatabase,
      chunkIndex: null,
      path: join(workspaceDirectoryInfo.path, workspaceDatabaseBasename),
      maximumBytes: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumWorkspaceBytes,
      scope: "workspace",
    },
    ...manifest.chunks.map((entry) => {
      const names = exportSetChunkBasenames(entry.index, manifest.schemaVersion);
      return {
        role: EXPORT_DELETION_INVENTORY_ROLES.chunkReceipt,
        chunkIndex: entry.index,
        path: join(outputDirectoryInfo.path, names.receipt),
        maximumBytes: 1024 * 1024,
        scope: "output",
      };
    }),
    {
      role: EXPORT_DELETION_INVENTORY_ROLES.setManifestReceipt,
      chunkIndex: null,
      path: join(outputDirectoryInfo.path, EXPORT_SET_MANIFEST_RECEIPT_BASENAME),
      maximumBytes: 1024 * 1024,
      scope: "output",
    },
  ];

  const inventory = [];
  const paths = [];
  for (const [ordinal, definition] of inventoryDefinitions.entries()) {
    const evidence = definition.evidence ?? await callPreflightPort(
      "hashOwnerOnlyFile",
      [definition.path, definition.maximumBytes],
      "artifact_read",
    );
    inventory.push({
      ordinal,
      role: definition.role,
      chunkIndex: definition.chunkIndex,
      ...evidence,
    });
    paths.push({ path: definition.path, scope: definition.scope });
  }

  const exportSetBytes = inventoryDefinitions.reduce((sum, definition, index) =>
    sum + (definition.scope === "output" ? inventory[index].byteSize : 0), 0);
  const workspaceBytes = inventoryDefinitions.reduce((sum, definition, index) =>
    sum + (definition.scope === "workspace" ? inventory[index].byteSize : 0), 0);
  const chunkCount = manifest.chunks.length;
  const journalCore = {
    schemaVersion: EXPORT_DELETION_JOURNAL_VERSION,
    planVersion: EXPORT_DELETION_PLAN_VERSION,
    deletionOrderVersion: EXPORT_DELETION_ORDER_VERSION,
    exportSetManifestVersion: manifest.schemaVersion,
    directoryIdentities: {
      workspace: {
        device: Number(workspaceDirectoryInfo.stats.dev),
        inode: Number(workspaceDirectoryInfo.stats.ino),
      },
      output: {
        device: Number(outputDirectoryInfo.stats.dev),
        inode: Number(outputDirectoryInfo.stats.ino),
      },
    },
    state: "prepared",
    inventoryCounts: {
      chunkArtifacts: chunkCount,
      chunkReceipts: chunkCount,
      controlFiles: 2,
      workspaceFiles: inventory.filter((row) => row.role.startsWith("workspace_")).length,
      totalFiles: inventory.length,
      totalBytes: exportSetBytes + workspaceBytes,
    },
    inventory,
    transportReady: false,
  };
  const planSha256 = sha256(stableJson({
    domain: "app-usagemonitor/export-deletion-plan/v1",
    journal: journalCore,
  }));
  const journal = { ...journalCore, planSha256 };
  assertValidExportDeletionJournal(journal);
  const summary = {
    schemaVersion: EXPORT_DELETION_PREFLIGHT_VERSION,
    planVersion: EXPORT_DELETION_PLAN_VERSION,
    artifactClass: "complete_local_export_set",
    readiness: "ready",
    fileCounts: {
      chunkArtifacts: chunkCount,
      chunkReceipts: chunkCount,
      controlFiles: 2,
      workspaceFiles: journal.inventoryCounts.workspaceFiles,
      totalFiles: inventory.length,
    },
    byteCounts: { exportSetBytes, workspaceBytes, totalBytes: exportSetBytes + workspaceBytes },
    confirmationRequired: true,
    confirmationToken: confirmationToken(planSha256),
    networkActivity: "absent",
    secureErasureClaimed: false,
    transportReady: false,
  };
  assertValidExportDeletionPreflight(summary);
  await callPreflightPort("assertDirectoryStable", [workspaceDirectoryInfo], "directory_changed", { snapshot: false });
  await callPreflightPort("assertDirectoryStable", [outputDirectoryInfo], "directory_changed", { snapshot: false });
  return {
    summary,
    journal,
    paths,
    directories: {
      workspace: workspaceDirectoryInfo.path,
      output: outputDirectoryInfo.path,
    },
  };
}

async function planLocalExportDeletion(options = {}) {
  return (await buildLocalExportDeletionPlan(options)).summary;
}

  let ownerPort;
  try {
    const owner = Reflect.apply(createDeletionStorage, undefined, [Object.freeze({
      buildLocalExportDeletionPlan,
      planLocalExportDeletion,
      withExistingExportWorkspaceLease,
      isTrustedDeletionError,
      isTrustedExportWorkspaceLockError,
      workspaceDatabaseBasename,
      semantics: Object.freeze({
      stableJson,
      assertValidExportDeletionCommitMarker,
      assertValidExportDeletionJournal,
      assertValidExportDeletionReceipt,
      ExportResourceLimitError,
      exportSetChunkBasenames,
      DEFAULT_EXPORT_RESOURCE_LIMITS,
      EXPORT_DELETION_COMMIT_MARKER_VERSION,
      EXPORT_DELETION_CONFIRMATION_TOKEN_PATTERN,
      EXPORT_DELETION_INVENTORY_ROLES,
      EXPORT_DELETION_PLAN_VERSION,
      EXPORT_DELETION_RECEIPT_VERSION,
      EXPORT_SET_MANIFEST_BASENAME,
      EXPORT_SET_MANIFEST_RECEIPT_BASENAME,
      EXPORT_DELETION_COMMIT_MARKER_BASENAME,
      EXPORT_DELETION_DESTINATION_LOCK_BASENAME,
      EXPORT_DELETION_DESTINATION_TRANSACTION_BASENAME,
      EXPORT_DELETION_JOURNAL_BASENAME,
      EXPORT_DELETION_QUARANTINE_PREFIX,
      EXPORT_DELETION_RECEIPT_BASENAME,
      EXPORT_DELETION_WORKSPACE_LOCK_BASENAME,
      }),
    })]);
    ownerPort = snapshotMethodPort(owner, [
      "ExportDeletionExecutionError", "deleteLocalExport", "recoverLocalExportDeletion",
    ]);
  } catch {
    invalid();
  }
  const ExportDeletionExecutionError = ownerPort.methods.ExportDeletionExecutionError;
  const deleteLocalExport = ownerPort.methods.deleteLocalExport;
  const recoverLocalExportDeletion = ownerPort.methods.recoverLocalExportDeletion;
  return Object.freeze({
    ExportDeletionError,
    ExportDeletionExecutionError,
    buildLocalExportDeletionPlan,
    planLocalExportDeletion,
    deleteLocalExport,
    recoverLocalExportDeletion,
  });
}
