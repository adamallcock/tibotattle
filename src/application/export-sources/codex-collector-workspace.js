import {
  createSupplementalSourcePlan,
  normalizeSupplementalSourcePlan,
  stableJson,
} from "../../export/index.js";
import { safeCount, validSha256 } from "./source-validation.js";

export function createCodexCollectorWorkspaceContext(configuration) {
const {
  bufferByteLength,
  codexCollectorExport,
  createHash,
  normalizeCodexCollectorQuotaCandidate,
  resolvePath: resolve,
  supplementalSourceCheckpointBatchSha256,
} = configuration;
const {
  CODEX_COLLECTOR_SOURCE_CURSOR_VERSION,
  CODEX_COLLECTOR_SOURCE_PLAN_VERSION,
  CodexCollectorExportSourceError,
  createCodexCollectorExportCursor,
  createCodexCollectorExportSourcePlan,
  scanCodexCollectorExportSource,
  verifyCodexCollectorExportSourcePlan,
} = codexCollectorExport;

const CODEX_COLLECTOR_WORKSPACE_SOURCE_VERSION = "codex-collector-workspace-source-v0.1";
const DEFAULT_CODEX_COLLECTOR_CANDIDATES_PER_BATCH = 1_000;
const CODEX_COLLECTOR_DIAGNOSTIC_REGISTRY_CODES = Object.freeze([
  ["emptyLines", "collector_empty_lines"],
  ["irrelevantRecords", "collector_irrelevant_records"],
  ["unsupportedSchemaRecords", "collector_unsupported_schema_records"],
  ["unsupportedSourceRecords", "collector_unsupported_source_records"],
  ["outOfBoundsRecords", "collector_out_of_bounds_records"],
  ["oversizedIrrelevantLines", "collector_oversized_irrelevant_lines"],
]);

const CODEX_COLLECTOR_DIAGNOSTIC_FIELDS = Object.freeze([
  "linesSeen", "candidatesEmitted", "emptyLines", "irrelevantRecords", "malformedJsonLines",
  "malformedRecordShapes", "unsupportedSchemaRecords", "unsupportedSourceRecords", "malformedWindows",
  "malformedAccountScopes", "outOfBoundsRecords", "oversizedIrrelevantLines",
]);

const MAXIMUM_BATCH_RECORDS = 1_000;
const SAFE_CODES = new Set(["configuration", "source_integrity"]);

class CodexCollectorWorkspaceSourceError extends Error {
  constructor(code) {
    if (!SAFE_CODES.has(code)) throw new TypeError("Unknown Codex collector workspace source failure code");
    super(`Codex collector workspace source failed (${code})`);
    this.name = "CodexCollectorWorkspaceSourceError";
    this.code = `codex_collector_workspace_source_${code}`;
  }
}

function fail(code) {
  throw new CodexCollectorWorkspaceSourceError(code);
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function codexCollectorWorkspaceSourceKey(sourcePlanSha256) {
  if (!validSha256(sourcePlanSha256)) fail("configuration");
  return createHash("sha256")
    .update("app-usagemonitor/codex-collector-workspace-source-key/v1\0")
    .update(sourcePlanSha256)
    .digest("hex");
}

function sourcePlanDigest(plan) {
  const material = JSON.stringify({
    schemaVersion: CODEX_COLLECTOR_SOURCE_PLAN_VERSION,
    startAt: plan.startAt,
    endAt: plan.endAt,
    path: plan.path,
    device: plan.device,
    inode: plan.inode,
    birthtimeMs: plan.birthtimeMs,
    prefixBytes: plan.prefixBytes,
    prefixLines: plan.prefixLines,
    prefixSha256: plan.prefixSha256,
  });
  return createHash("sha256")
    .update("app-usagemonitor/codex-collector-source-plan/v0.1\0")
    .update(material)
    .digest("hex");
}

function cursorFromJson(cursorJson) {
  let cursor;
  try {
    cursor = JSON.parse(cursorJson);
  } catch {
    fail("source_integrity");
  }
  if (stableJson(cursor) !== cursorJson
      || !exactKeys(cursor, [
        "schemaVersion", "sourcePlanSha256", "nextByte", "nextLineOrdinal", "nextWindowOrdinal",
        "frozenPrefixLines",
      ])
      || cursor.schemaVersion !== CODEX_COLLECTOR_SOURCE_CURSOR_VERSION
      || !validSha256(cursor.sourcePlanSha256)
      || !safeCount(cursor.nextByte) || !Number.isSafeInteger(cursor.nextLineOrdinal)
      || cursor.nextLineOrdinal < 1 || !safeCount(cursor.nextWindowOrdinal)
      || !safeCount(cursor.frozenPrefixLines)) {
    fail("source_integrity");
  }
  return cursor;
}

function exportCursorFromWorkspaceCursor(cursor) {
  return {
    schemaVersion: cursor.schemaVersion,
    sourcePlanSha256: cursor.sourcePlanSha256,
    nextByte: cursor.nextByte,
    nextLineOrdinal: cursor.nextLineOrdinal,
    nextWindowOrdinal: cursor.nextWindowOrdinal,
  };
}

function workspaceCursorJson(cursor, frozenPrefixLines) {
  if (!safeCount(frozenPrefixLines)) fail("source_integrity");
  return stableJson({ ...cursor, frozenPrefixLines });
}

function sourceFromCollectorPlan(plan, ordinal) {
  const cursor = createCodexCollectorExportCursor(plan);
  return {
    ordinal,
    sourceKey: codexCollectorWorkspaceSourceKey(plan.sourcePlanSha256),
    kind: "codex_collector_ledger",
    parserVersion: CODEX_COLLECTOR_SOURCE_CURSOR_VERSION,
    binding: {
      kind: "file_prefix",
      device: plan.device,
      inode: plan.inode,
      birthtimeMs: plan.birthtimeMs,
      prefixBytes: plan.prefixBytes,
      prefixSha256: plan.prefixSha256,
    },
    // This immutable, descriptor-bound cursor carries the frozen line count
    // needed to reconstruct the collector plan on restart without replaying
    // the entire prefix solely to count newlines.
    initialCursorJson: workspaceCursorJson(cursor, plan.prefixLines),
  };
}

async function createCodexCollectorWorkspaceSource({
  collectorPath,
  startAt,
  endAt,
  resourceGuard,
} = {}) {
  try {
    const collectorPlan = await createCodexCollectorExportSourcePlan({
      collectorPath,
      startAt,
      endAt,
      resourceGuard,
    });
    return { collectorPlan, source: sourceFromCollectorPlan(collectorPlan, 0) };
  } catch (error) {
    if (error instanceof CodexCollectorExportSourceError) throw error;
    throw error;
  }
}

function appendCodexCollectorWorkspaceSource(supplementalSourcePlan, collectorPlan) {
  let base;
  try {
    base = normalizeSupplementalSourcePlan(supplementalSourcePlan);
  } catch {
    fail("configuration");
  }
  if (base.sources.some((source) => source.kind === "codex_collector_ledger")) fail("configuration");
  return createSupplementalSourcePlan({
    sources: [
      ...base.sources,
      sourceFromCollectorPlan(collectorPlan, base.sources.length),
    ],
  });
}

function collectorScanGuard(resourceGuard, source) {
  return {
    limits: resourceGuard.limits,
    assertCoveredInterval: resourceGuard.assertCoveredInterval.bind(resourceGuard),
    checkRuntime: resourceGuard.checkRuntime.bind(resourceGuard),
    observeLine: resourceGuard.observeLine.bind(resourceGuard),
    observeSourcePlan(fileCount, byteCount) {
      if (fileCount !== 1 || byteCount !== source.binding.prefixBytes) fail("source_integrity");
      resourceGuard.checkRuntime();
    },
    // Candidate bytes are not a durable contract.  The caller charges the
    // normalized quota snapshots immediately before their atomic commit.
    observeOutputRecord() {
      resourceGuard.checkRuntime();
    },
  };
}

function collectorPlanningGuard(resourceGuard) {
  if (!resourceGuard || !resourceGuard.limits) fail("configuration");
  return {
    limits: resourceGuard.limits,
    assertCoveredInterval: resourceGuard.assertCoveredInterval.bind(resourceGuard),
    checkRuntime: resourceGuard.checkRuntime.bind(resourceGuard),
    // Source selection is committed once as the combined workspace plan after
    // Codex rollout and collector inputs have both been frozen.  Planning still
    // charges elapsed time and RSS to the invocation that owns that selection.
    observeSourcePlan(fileCount, byteCount) {
      if (fileCount !== 1 || !safeCount(byteCount)) fail("configuration");
      resourceGuard.checkRuntime();
    },
  };
}

function checkpointExpected(checkpoint) {
  return {
    checkpointSeq: checkpoint.checkpointSeq,
    status: checkpoint.status,
    cursorJson: checkpoint.cursorJson,
  };
}

function resourceDelta(before, after) {
  const delta = (key) => Math.max(0, after[key] - before[key]);
  return {
    directoryEntries: delta("directoryEntries"),
    lines: delta("lines"),
    oversizedIrrelevantLines: delta("oversizedIrrelevantLines"),
    cumulativeElapsedMs: delta("cumulativeElapsedMs"),
    peakRssBytes: after.peakRssBytes,
  };
}

function summarizeCodexCollectorDiagnostics(diagnostics) {
  if (!exactKeys(diagnostics, CODEX_COLLECTOR_DIAGNOSTIC_FIELDS)) fail("source_integrity");
  const malformedLines = diagnostics.malformedJsonLines;
  const malformedRateLimits = diagnostics.malformedRecordShapes
    + diagnostics.malformedWindows + diagnostics.malformedAccountScopes;
  if (![malformedLines, malformedRateLimits, ...CODEX_COLLECTOR_DIAGNOSTIC_REGISTRY_CODES.map(([field]) => diagnostics[field])]
    .every(safeCount)) fail("source_integrity");
  return {
    reviewed: [
      ...(malformedLines > 0 ? [{ code: "malformed_lines", count: malformedLines }] : []),
      ...(malformedRateLimits > 0 ? [{ code: "malformed_rate_limit_records", count: malformedRateLimits }] : []),
      ...CODEX_COLLECTOR_DIAGNOSTIC_REGISTRY_CODES
        .map(([field, code]) => ({ code, count: diagnostics[field] }))
        .filter((row) => row.count > 0),
    ],
    missingRegistryRows: [],
  };
}

function completedBatch(value) {
  return { ...value, batchSha256: supplementalSourceCheckpointBatchSha256(value) };
}

function missingRegistryRows(workspace, sourceKey) {
  if (typeof workspace.supplementalDiagnosticRegistryGaps !== "function") fail("source_integrity");
  return workspace.supplementalDiagnosticRegistryGaps(sourceKey).map((item) => ({
    field: item.field,
    requiredRegistryCode: item.requiredRegistryCode,
    count: item.count,
  }));
}

async function resolveCodexCollectorWorkspaceSource({
  workspace,
  collectorPath,
  resourceGuard,
} = {}) {
  if (!workspace || typeof collectorPath !== "string" || collectorPath.length === 0 || !resourceGuard) {
    fail("configuration");
  }
  const descriptor = workspace.getDescriptor();
  const sourcePlan = workspace.loadSupplementalSourcePlan();
  const sources = sourcePlan.sources.filter((source) => source.kind === "codex_collector_ledger");
  if (sources.length !== 1) fail("configuration");
  const [source] = sources;
  if (source.parserVersion !== CODEX_COLLECTOR_SOURCE_CURSOR_VERSION || source.binding.kind !== "file_prefix") {
    fail("source_integrity");
  }
  const initialCursor = cursorFromJson(source.initialCursorJson);
  const collectorPlan = {
    schemaVersion: CODEX_COLLECTOR_SOURCE_PLAN_VERSION,
    startAt: descriptor.coveredAt.startAt,
    endAt: descriptor.coveredAt.endAt,
    path: resolve(collectorPath),
    device: source.binding.device,
    inode: source.binding.inode,
    birthtimeMs: source.binding.birthtimeMs,
    prefixBytes: source.binding.prefixBytes,
    prefixLines: initialCursor.frozenPrefixLines,
    prefixSha256: source.binding.prefixSha256,
  };
  collectorPlan.sourcePlanSha256 = sourcePlanDigest(collectorPlan);
  if (collectorPlan.sourcePlanSha256 !== initialCursor.sourcePlanSha256
      || source.sourceKey !== codexCollectorWorkspaceSourceKey(collectorPlan.sourcePlanSha256)) {
    fail("source_integrity");
  }
  return { source, initialCursor, collectorPlan: Object.freeze(collectorPlan) };
}

async function populateCodexCollectorWorkspaceSource({
  workspace,
  collectorPath,
  secret,
  resourceGuard,
  maximumCandidateRecords = DEFAULT_CODEX_COLLECTOR_CANDIDATES_PER_BATCH,
  failpoint = async () => {},
} = {}) {
  if (!workspace || !secret || !resourceGuard || !Number.isSafeInteger(maximumCandidateRecords)
      || maximumCandidateRecords < 1 || maximumCandidateRecords > MAXIMUM_BATCH_RECORDS) {
    throw new TypeError("Codex collector workspace scan requires bounded inputs");
  }
  let resolved;
  try {
    resolved = await resolveCodexCollectorWorkspaceSource({ workspace, collectorPath, resourceGuard });
    for (;;) {
      const checkpoint = workspace.loadSupplementalSourceCheckpoint(resolved.source.sourceKey);
      if (checkpoint.status === "complete") {
        return { checkpoint, missingRegistryRows: missingRegistryRows(workspace, resolved.source.sourceKey) };
      }
      const checkpointCursor = cursorFromJson(checkpoint.cursorJson);
      if (checkpointCursor.frozenPrefixLines !== resolved.initialCursor.frozenPrefixLines
          || checkpointCursor.sourcePlanSha256 !== resolved.collectorPlan.sourcePlanSha256) {
        fail("source_integrity");
      }
      const resourceBefore = resourceGuard.durableSnapshot();
      const scanned = await scanCodexCollectorExportSource(resolved.collectorPlan, {
        cursor: exportCursorFromWorkspaceCursor(checkpointCursor),
        maximumCandidateRecords,
        resourceGuard: collectorScanGuard(resourceGuard, resolved.source),
        verifyWholePrefix: false,
      });
      // The scanner's per-batch descriptor checks reject unsafe replacement
      // and boundary changes. Rehash/recount the complete frozen prefix only
      // once, immediately before its terminal checkpoint becomes durable.
      if (scanned.complete) {
        await verifyCodexCollectorExportSourcePlan(resolved.collectorPlan, {
          resourceGuard: collectorScanGuard(resourceGuard, resolved.source),
        });
      }
      const records = scanned.candidates.map((candidate) => ({
        recordType: "quotaSnapshot",
        record: normalizeCodexCollectorQuotaCandidate(secret, candidate),
      }));
      for (const envelope of records) {
        resourceGuard.observeOutputRecord(bufferByteLength(stableJson(envelope.record), "utf8"));
      }
      const resourceAfter = resourceGuard.durableSnapshot();
      const diagnosticSummary = summarizeCodexCollectorDiagnostics(scanned.diagnostics);
      const batch = completedBatch({
        sourceKey: resolved.source.sourceKey,
        expected: checkpointExpected(checkpoint),
        next: {
          status: scanned.complete ? "complete" : "pending",
          cursorJson: workspaceCursorJson(scanned.cursor, resolved.initialCursor.frozenPrefixLines),
        },
        records,
        diagnosticDeltas: diagnosticSummary.reviewed,
        registryGapDeltas: diagnosticSummary.missingRegistryRows,
        resourceDeltas: resourceDelta(resourceBefore, resourceAfter),
      });
      const committed = await workspace.commitSupplementalSourceBatch(batch);
      await failpoint("after_collector_checkpoint_batch", committed.checkpoint);
      if (records.length > 0) await failpoint("after_record_batch", committed.checkpoint);
      if (committed.checkpoint.status === "complete") {
        return {
          checkpoint: committed.checkpoint,
          missingRegistryRows: missingRegistryRows(workspace, resolved.source.sourceKey),
        };
      }
    }
  } catch (error) {
    if (error instanceof CodexCollectorExportSourceError) {
      workspace.markPoisoned("source_integrity");
      fail("source_integrity");
    }
    if (error instanceof CodexCollectorWorkspaceSourceError) {
      workspace.markPoisoned("source_integrity");
    }
    throw error;
  }
}

return Object.freeze({
  CODEX_COLLECTOR_WORKSPACE_SOURCE_VERSION,
  DEFAULT_CODEX_COLLECTOR_CANDIDATES_PER_BATCH,
  CODEX_COLLECTOR_DIAGNOSTIC_REGISTRY_CODES,
  CodexCollectorWorkspaceSourceError,
  appendCodexCollectorWorkspaceSource,
  codexCollectorWorkspaceSourceKey,
  collectorPlanningGuard,
  createCodexCollectorWorkspaceSource,
  populateCodexCollectorWorkspaceSource,
  resolveCodexCollectorWorkspaceSource,
  summarizeCodexCollectorDiagnostics,
});
}
