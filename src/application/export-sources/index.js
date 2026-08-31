import {
  assertValidExportRecord,
  createCodexCheckpointStateContext,
  createExportResourceGuard,
  createSafeRecordsContext,
  ExportResourceLimitError,
  stableJson,
} from "../../export/index.js";
import { validateClaudeStatusSnapshot } from "../../providers/claude/statusline.js";
import {
  createLocalCodexLogScanner,
  validateLocalProxyDetector,
} from "../local-codex-log-scanner.js";

import { createClaudeStatusExportContext } from "./claude-status-export.js";
import { createClaudeStatusWorkspaceContext } from "./claude-status-workspace.js";
import { createClaudeTranscriptExportContext } from "./claude-transcript-export.js";
import { createClaudeTranscriptWorkspaceContext } from "./claude-transcript-workspace.js";
import { createCodexCheckpointContext } from "./codex-checkpoint.js";
import { createCodexCollectorExportContext } from "./codex-collector-export.js";
import { createCodexCollectorWorkspaceContext } from "./codex-collector-workspace.js";
import { createCodexSourcePlanContext } from "./codex-source-plan.js";
import { createLocalExportSetController } from "./controller.js";
import { createSourcePlanBundleContext } from "./source-plan-bundle.js";

function invalid() {
  throw new TypeError("local export-source pipeline configuration is invalid");
}

const SOURCE_PORT_FUNCTION_KEYS = Object.freeze([
  "allocUnsafe",
  "bufferByteLength",
  "bufferFrom",
  "bufferIsBuffer",
  "clock",
  "createHash",
  "createHmac",
  "currentUid",
  "defaultClaudeStatusStateDirectory",
  "deriveAccountScopeId",
  "deriveEventOccurrenceId",
  "deriveMarkerOccurrenceId",
  "deriveModelFingerprint",
  "deriveParticipantId",
  "deriveQuotaStateId",
  "deriveSessionScopeId",
  "deriveSnapshotObservationId",
  "inspectClaudeStatusLedgerDirectoriesForExport",
  "joinPath",
  "lstat",
  "open",
  "openDirectory",
  "readBoundedUtf8LineEntries",
  "realpath",
  "revalidateClaudeStatusLedgerDirectoriesForExport",
  "resolvePath",
  "resolveRealpath",
  "rss",
]);
const SOURCE_PORT_DATA_KEYS = Object.freeze([
  "defaultHomeDirectory",
  "platform",
  "DEFAULT_CLAUDE_STATUS_MAX_LEDGER_BYTES",
  "DEFAULT_CLAUDE_STATUS_MAX_RECORDS",
  "MAX_CLAUDE_STATUS_RECORD_BYTES",
]);
const SOURCE_PORT_OBJECT_KEYS = Object.freeze(["codexLogPorts", "fsConstants"]);
const SOURCE_PORT_KEYS = Object.freeze([
  ...SOURCE_PORT_FUNCTION_KEYS,
  ...SOURCE_PORT_DATA_KEYS,
  ...SOURCE_PORT_OBJECT_KEYS,
]);
const CODEX_FILESYSTEM_FUNCTION_KEYS = Object.freeze([
  "defaultCodexHome",
  "joinPath",
  "currentUid",
  "readSelectedRolloutNames",
  "openDirectory",
  "statPath",
  "lstatPath",
  "openReadOnlyNoFollow",
  "createSha256",
  "readUtf8Range",
  "readUtf8LinesRange",
]);

function objectOwner(value, isProxy) {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)) invalid();
  return value;
}

function exactOwnDataDescriptors(owner, keys) {
  let ownKeys;
  try {
    ownKeys = Reflect.ownKeys(owner);
  } catch {
    invalid();
  }
  if (ownKeys.length !== keys.length
      || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) invalid();
  const descriptors = {};
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
      descriptors[key] = descriptor;
    }
  } catch {
    invalid();
  }
  return descriptors;
}

function snapshotCallableOwner(owner, keys, isProxy) {
  const descriptors = exactOwnDataDescriptors(objectOwner(owner, isProxy), keys);
  const snapshot = {};
  for (const key of keys) {
    const value = descriptors[key].value;
    if (typeof value !== "function" || isProxy(value)) invalid();
    snapshot[key] = value;
  }
  return Object.freeze(snapshot);
}

function snapshotCodexLogPorts(codexLogPorts, isProxy) {
  const descriptors = exactOwnDataDescriptors(
    objectOwner(codexLogPorts, isProxy),
    ["filesystem", "lineReader"],
  );
  return Object.freeze({
    filesystem: snapshotCallableOwner(
      descriptors.filesystem.value,
      CODEX_FILESYSTEM_FUNCTION_KEYS,
      isProxy,
    ),
    lineReader: snapshotCallableOwner(
      descriptors.lineReader.value,
      ["readBoundedUtf8Lines"],
      isProxy,
    ),
  });
}

function snapshotFsConstants(fsConstants, isProxy) {
  const descriptors = exactOwnDataDescriptors(
    objectOwner(fsConstants, isProxy),
    ["O_NOFOLLOW", "O_RDONLY"],
  );
  const noFollow = descriptors.O_NOFOLLOW.value;
  const readOnly = descriptors.O_RDONLY.value;
  if ((noFollow !== undefined && !Number.isSafeInteger(noFollow))
      || !Number.isSafeInteger(readOnly)) invalid();
  return Object.freeze({ O_NOFOLLOW: noFollow, O_RDONLY: readOnly });
}

function snapshotSourcePorts(sourcePorts, isProxy) {
  const descriptors = exactOwnDataDescriptors(
    objectOwner(sourcePorts, isProxy),
    SOURCE_PORT_KEYS,
  );
  const snapshot = {};
  for (const key of SOURCE_PORT_FUNCTION_KEYS) {
    const value = descriptors[key].value;
    if (typeof value !== "function" || isProxy(value)) invalid();
    snapshot[key] = value;
  }
  const defaultHomeDirectory = descriptors.defaultHomeDirectory.value;
  const platform = descriptors.platform.value;
  if (typeof defaultHomeDirectory !== "string" || typeof platform !== "string") invalid();
  snapshot.defaultHomeDirectory = defaultHomeDirectory;
  snapshot.platform = platform;
  for (const key of SOURCE_PORT_DATA_KEYS.slice(2)) {
    const value = descriptors[key].value;
    if (!Number.isSafeInteger(value) || value < 0) invalid();
    snapshot[key] = value;
  }
  snapshot.codexLogPorts = snapshotCodexLogPorts(descriptors.codexLogPorts.value, isProxy);
  snapshot.fsConstants = snapshotFsConstants(descriptors.fsConstants.value, isProxy);
  return Object.freeze(snapshot);
}

function own(configuration, key, isProxy) {
  try {
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)
        || isProxy(configuration)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(configuration, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
    return descriptor.value;
  } catch {
    invalid();
  }
}

function snapshotWorkspace(workspace, isProxy) {
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace) || isProxy(workspace)) invalid();
  const functionKeys = new Set([
    "ExportWorkspaceError",
    "buildExportWorkspaceDescriptor",
    "createExportWorkspace",
    "openExportWorkspace",
    "sourceCheckpointBatchSha256",
    "supplementalSourceCheckpointBatchSha256",
    "withExportWorkspaceLease",
  ]);
  const keys = [
    "DEFAULT_EXPORT_WORKSPACE_BATCH_RECORDS",
    ...functionKeys,
  ];
  const snapshot = {};
  try {
    const thenDescriptor = Object.getOwnPropertyDescriptor(workspace, "then");
    if (thenDescriptor !== undefined) invalid();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(workspace, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
      const value = descriptor.value;
      if (functionKeys.has(key) && (typeof value !== "function" || isProxy(value))) invalid();
      snapshot[key] = value;
    }
  } catch {
    invalid();
  }
  return Object.freeze(snapshot);
}

export function createLocalExportSourcePipelineContext(proxyDetector, sourcePorts, configuration = {}) {
  let isProxy;
  try {
    isProxy = validateLocalProxyDetector(proxyDetector);
  } catch {
    invalid();
  }
  const ports = snapshotSourcePorts(sourcePorts, isProxy);
  const configuredWorkspace = own(configuration, "workspace", isProxy);
  const exportCompatibilityTuple = own(configuration, "exportCompatibilityTuple", isProxy);
  const workspace = snapshotWorkspace(configuredWorkspace, isProxy);
  if (typeof exportCompatibilityTuple !== "function" || isProxy(exportCompatibilityTuple)) invalid();

  function createRuntimeResourceGuard(options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      return createExportResourceGuard(options);
    }
    return createExportResourceGuard({
      ...options,
      ...(Object.hasOwn(options, "clock") ? {} : { clock: ports.clock }),
      ...(Object.hasOwn(options, "rss") ? {} : { rss: ports.rss }),
    });
  }
  const runtimeSourcePorts = Object.freeze({
    ...ports,
    readBoundedUtf8LineEntries(path, options = {}) {
      return ports.readBoundedUtf8LineEntries(path, {
        ...options,
        createLimitError: (code) => new ExportResourceLimitError(code),
      });
    },
  });

  const scanner = createLocalCodexLogScanner(ports.codexLogPorts);
  const checkpointState = createCodexCheckpointStateContext({
    createHash: ports.createHash,
    isProxy,
  });
  const safeRecords = createSafeRecordsContext({
    isProxy,
    createHash: ports.createHash,
    scanCodexLogEvents: scanner.scanCodexLogEvents,
    validateClaudeStatusSnapshot,
    deriveAccountScopeId: ports.deriveAccountScopeId,
    deriveEventOccurrenceId: ports.deriveEventOccurrenceId,
    deriveMarkerOccurrenceId: ports.deriveMarkerOccurrenceId,
    deriveModelFingerprint: ports.deriveModelFingerprint,
    deriveQuotaStateId: ports.deriveQuotaStateId,
    deriveSessionScopeId: ports.deriveSessionScopeId,
    deriveSnapshotObservationId: ports.deriveSnapshotObservationId,
    exportCompatibilityTuple,
    assertValidExportRecord,
    stableJson,
    createExportResourceGuard: createRuntimeResourceGuard,
    createEmptyCodexCheckpointState: checkpointState.createEmptyCodexCheckpointState,
    normalizeCodexCheckpointState: checkpointState.normalizeCodexCheckpointState,
  });

  const codexSourcePlan = createCodexSourcePlanContext(runtimeSourcePorts);
  const codexCollectorExport = createCodexCollectorExportContext({
    ...runtimeSourcePorts,
    createExportResourceGuard: createRuntimeResourceGuard,
  });
  const claudeTranscriptExport = createClaudeTranscriptExportContext({
    ...runtimeSourcePorts,
    safeExportModelDeclaration: safeRecords.safeExportModelDeclaration,
  });
  const claudeStatusExport = createClaudeStatusExportContext({
    ...runtimeSourcePorts,
    createExportResourceGuard: createRuntimeResourceGuard,
    validateClaudeStatusSnapshot,
  });
  const codexCollectorWorkspace = createCodexCollectorWorkspaceContext({
    ...runtimeSourcePorts,
    codexCollectorExport,
    normalizeCodexCollectorQuotaCandidate: safeRecords.normalizeCodexCollectorQuotaCandidate,
    supplementalSourceCheckpointBatchSha256: workspace.supplementalSourceCheckpointBatchSha256,
  });
  const claudeStatusWorkspace = createClaudeStatusWorkspaceContext({
    ...runtimeSourcePorts,
    claudeStatusExport,
    normalizeClaudeStatusQuotaSnapshots: safeRecords.normalizeClaudeStatusQuotaSnapshots,
    supplementalSourceCheckpointBatchSha256: workspace.supplementalSourceCheckpointBatchSha256,
  });
  const claudeTranscriptWorkspace = createClaudeTranscriptWorkspaceContext({
    ...runtimeSourcePorts,
    claudeTranscriptExport,
    normalizeClaudeTranscriptUsageCandidate: safeRecords.normalizeClaudeTranscriptUsageCandidate,
    supplementalSourceCheckpointBatchSha256: workspace.supplementalSourceCheckpointBatchSha256,
  });
  const sourcePlanBundle = createSourcePlanBundleContext({
    ...runtimeSourcePorts,
    isProxy,
    claudeStatusExport,
    claudeStatusWorkspace,
    claudeTranscriptExport,
    claudeTranscriptWorkspace,
    codexCollectorExport,
    codexCollectorWorkspace,
    codexSourcePlan,
    normalizeExportBounds: safeRecords.normalizeExportBounds,
  });
  const codexCheckpoint = createCodexCheckpointContext({
    ...runtimeSourcePorts,
    codexSourcePlan,
    createCodexCheckpointStateContext: checkpointState,
    safeRecords,
    workspace,
  });
  const controller = createLocalExportSetController({
    ...runtimeSourcePorts,
    claudeStatusWorkspace,
    claudeTranscriptExport,
    claudeTranscriptWorkspace,
    codexCheckpoint,
    codexCollectorWorkspace,
    codexSourcePlan,
    createExportResourceGuard: createRuntimeResourceGuard,
    exportCompatibilityTuple,
    safeRecords,
    sourcePlanBundle,
    workspace,
  });

  return Object.freeze({
    claudeStatusExport,
    claudeStatusWorkspace,
    claudeTranscriptExport,
    claudeTranscriptWorkspace,
    codexCheckpoint,
    codexCollectorExport,
    codexCollectorWorkspace,
    codexSourcePlan,
    controller,
    sourcePlanBundle,
  });
}

export { createLocalExportSetController } from "./controller.js";
