import {
  ExportResourceLimitError,
  createSupplementalSourcePlan,
  normalizeSupplementalSourcePlan,
  stableJson,
} from "../../export/index.js";
import { safeCount, validSha256 } from "./source-validation.js";

export function createClaudeStatusWorkspaceContext(configuration) {
const {
  bufferByteLength,
  claudeStatusExport,
  createHash,
  joinPath: join,
  normalizeClaudeStatusQuotaSnapshots,
  resolvePath: resolve,
  revalidateClaudeStatusLedgerDirectoriesForExport,
  supplementalSourceCheckpointBatchSha256,
} = configuration;
const {
  CLAUDE_STATUS_LEDGER_SOURCE_CURSOR_VERSION,
  ClaudeStatusLedgerExportSourceError,
  createClaudeStatusLedgerExportCursor,
  createClaudeStatusLedgerExportSourcePlan,
  scanClaudeStatusLedgerExportSource,
} = claudeStatusExport;

const CLAUDE_STATUS_WORKSPACE_SOURCE_VERSION = "claude-status-workspace-source-v0.1";
const CLAUDE_STATUS_WORKSPACE_CURSOR_VERSION = "claude-status-workspace-cursor-v0.1";
const DEFAULT_CLAUDE_STATUS_RECORDS_PER_BATCH = 500;

const MAXIMUM_BATCH_INPUT_RECORDS = 500;
const SAFE_CODES = new Set(["configuration", "source_integrity"]);

class ClaudeStatusWorkspaceSourceError extends Error {
  constructor(code) {
    if (!SAFE_CODES.has(code)) throw new TypeError("Unknown Claude status workspace source failure code");
    super(`Claude status workspace source failed (${code})`);
    this.name = "ClaudeStatusWorkspaceSourceError";
    this.code = `claude_status_workspace_source_${code}`;
  }
}

function fail(code) {
  throw new ClaudeStatusWorkspaceSourceError(code);
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function claudeStatusWorkspaceSourceKey(ledgerSourceKey) {
  if (typeof ledgerSourceKey !== "string" || !/^claude-ledger-source:v1:[A-Za-z0-9_-]{43}$/u.test(ledgerSourceKey)) {
    fail("configuration");
  }
  return createHash("sha256")
    .update("app-usagemonitor/claude-status-workspace-source-key/v1\0")
    .update(ledgerSourceKey)
    .digest("hex");
}

function cursorFromJson(cursorJson, sourceKey) {
  let cursor;
  try {
    cursor = JSON.parse(cursorJson);
  } catch {
    fail("source_integrity");
  }
  if (stableJson(cursor) !== cursorJson
      || !exactKeys(cursor, ["schemaVersion", "sourceKey", "nextRecordIndex"])
      || cursor.schemaVersion !== CLAUDE_STATUS_WORKSPACE_CURSOR_VERSION
      || cursor.sourceKey !== sourceKey || !safeCount(cursor.nextRecordIndex)) {
    fail("source_integrity");
  }
  return cursor;
}

function workspaceCursor(sourceKey, nextRecordIndex) {
  if (!validSha256(sourceKey) || !safeCount(nextRecordIndex)) fail("source_integrity");
  return {
    schemaVersion: CLAUDE_STATUS_WORKSPACE_CURSOR_VERSION,
    sourceKey,
    nextRecordIndex,
  };
}

function sourceFromClaudePlan(plan) {
  const sourceKey = claudeStatusWorkspaceSourceKey(plan.sourceKey);
  return {
    ordinal: 0,
    sourceKey,
    kind: "claude_status_snapshot",
    parserVersion: CLAUDE_STATUS_WORKSPACE_CURSOR_VERSION,
    binding: {
      kind: "frozen_inventory",
      inventoryEntries: plan.recordCount,
      inventoryBytes: plan.totalBytes,
      inventorySha256: plan.inventorySha256,
    },
    initialCursorJson: stableJson(workspaceCursor(sourceKey, 0)),
  };
}

async function createClaudeStatusWorkspaceSource({
  stateDirectory,
  startAt,
  endAt,
  secret,
  resourceGuard,
} = {}) {
  const claudePlan = await createClaudeStatusLedgerExportSourcePlan({
    stateDirectory,
    startAt,
    endAt,
    secret,
    resourceGuard,
  });
  const source = sourceFromClaudePlan(claudePlan);
  return {
    claudePlan,
    source,
    privatePlan: { sourceKey: source.sourceKey, valueJson: stableJson(claudePlan) },
  };
}

function appendClaudeStatusWorkspaceSource(supplementalSourcePlan, claudePlan) {
  let base;
  try {
    base = normalizeSupplementalSourcePlan(supplementalSourcePlan);
  } catch {
    fail("configuration");
  }
  const source = sourceFromClaudePlan(claudePlan);
  // The controller and resolver intentionally support exactly one Claude
  // status inventory per workspace. Reject a second inventory at planning
  // time even when it would have a distinct opaque key.
  if (base.sources.some((existing) => existing.sourceKey === source.sourceKey
      || existing.kind === "claude_status_snapshot")) fail("configuration");
  return createSupplementalSourcePlan({
    sources: [...base.sources, { ...source, ordinal: base.sources.length }],
  });
}

function claudeScanGuard(resourceGuard, source) {
  return {
    limits: resourceGuard.limits,
    assertCoveredInterval: resourceGuard.assertCoveredInterval.bind(resourceGuard),
    checkRuntime: resourceGuard.checkRuntime.bind(resourceGuard),
    observeLine: resourceGuard.observeLine.bind(resourceGuard),
    observeSourcePlan(fileCount, byteCount) {
      if (fileCount !== source.binding.inventoryEntries || byteCount !== source.binding.inventoryBytes) {
        fail("source_integrity");
      }
      resourceGuard.checkRuntime();
    },
    // Scanner candidates are safe but not the export contract. Charge the
    // normalized one-or-two quota snapshots just before their atomic commit.
    observeOutputRecord() {
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

function completedBatch(value) {
  return { ...value, batchSha256: supplementalSourceCheckpointBatchSha256(value) };
}

async function resolveClaudeStatusWorkspaceSource({
  workspace,
  stateDirectory,
  secret,
  resourceGuard,
} = {}) {
  if (!workspace || typeof stateDirectory !== "string" || stateDirectory.length === 0 || !secret || !resourceGuard) {
    fail("configuration");
  }
  const sourcePlan = workspace.loadSupplementalSourcePlan();
  const sources = sourcePlan.sources.filter((source) => source.kind === "claude_status_snapshot");
  if (sources.length !== 1) fail("configuration");
  const [source] = sources;
  if (source.parserVersion !== CLAUDE_STATUS_WORKSPACE_CURSOR_VERSION || source.binding.kind !== "frozen_inventory") {
    fail("source_integrity");
  }
  cursorFromJson(source.initialCursorJson, source.sourceKey);
  let claudePlan;
  try {
    claudePlan = workspace.loadSupplementalPrivatePlan(source.sourceKey);
  } catch {
    fail("source_integrity");
  }
  if (!claudePlan || typeof claudePlan !== "object" || Array.isArray(claudePlan)
      || typeof claudePlan.stateDirectory !== "string" || resolve(stateDirectory) !== claudePlan.stateDirectory
      || claudeStatusWorkspaceSourceKey(claudePlan.sourceKey) !== source.sourceKey
      || claudePlan.recordCount !== source.binding.inventoryEntries
      || claudePlan.totalBytes !== source.binding.inventoryBytes
      || claudePlan.inventorySha256 !== source.binding.inventorySha256) {
    fail("source_integrity");
  }
  try {
    // This validates the complete HMAC-bound plan without rereading every
    // frozen record on each recovery invocation. The scanner below rechecks
    // the root/records boundary and verifies each selected record immediately
    // before it is normalized and checkpointed.
    createClaudeStatusLedgerExportCursor(claudePlan, { secret });
    resourceGuard.assertCoveredInterval(Date.parse(claudePlan.startAt), Date.parse(claudePlan.endAt));
    await revalidateClaudeStatusLedgerDirectoriesForExport({
      root: claudePlan.stateDirectory,
      recordsDirectory: join(claudePlan.stateDirectory, "records"),
      rootIdentity: claudePlan.rootIdentity,
      recordsIdentity: claudePlan.recordsDirectoryIdentity,
    });
    resourceGuard.checkRuntime();
  } catch (error) {
    if (error instanceof ExportResourceLimitError) throw error;
    fail("source_integrity");
  }
  return { source, claudePlan };
}

async function populateClaudeStatusWorkspaceSource({
  workspace,
  stateDirectory,
  secret,
  resourceGuard,
  maximumRecords = DEFAULT_CLAUDE_STATUS_RECORDS_PER_BATCH,
  failpoint = async () => {},
} = {}) {
  if (!workspace || !secret || !resourceGuard || !Number.isSafeInteger(maximumRecords)
      || maximumRecords < 1 || maximumRecords > MAXIMUM_BATCH_INPUT_RECORDS) {
    throw new TypeError("Claude status workspace scan requires bounded inputs");
  }
  try {
    const resolved = await resolveClaudeStatusWorkspaceSource({ workspace, stateDirectory, secret, resourceGuard });
    for (;;) {
      const checkpoint = workspace.loadSupplementalSourceCheckpoint(resolved.source.sourceKey);
      if (checkpoint.status === "complete") return { checkpoint };
      const cursor = cursorFromJson(checkpoint.cursorJson, resolved.source.sourceKey);
      if (cursor.nextRecordIndex > resolved.claudePlan.recordCount) fail("source_integrity");
      const resourceBefore = resourceGuard.durableSnapshot();
      const scanned = await scanClaudeStatusLedgerExportSource(resolved.claudePlan, {
        secret,
        cursor: {
          schemaVersion: CLAUDE_STATUS_LEDGER_SOURCE_CURSOR_VERSION,
          sourceKey: resolved.claudePlan.sourceKey,
          nextRecordIndex: cursor.nextRecordIndex,
        },
        maximumRecords,
        resourceGuard: claudeScanGuard(resourceGuard, resolved.source),
        failpoint,
      });
      const records = scanned.records.flatMap((item) => normalizeClaudeStatusQuotaSnapshots(secret, item.snapshot, {
        physicalOccurrenceMaterial: item.physicalOccurrenceMaterial,
      })).map((record) => ({ recordType: "quotaSnapshot", record }));
      for (const envelope of records) {
        resourceGuard.observeOutputRecord(bufferByteLength(stableJson(envelope.record), "utf8"));
      }
      const resourceAfter = resourceGuard.durableSnapshot();
      const nextCursor = workspaceCursor(resolved.source.sourceKey, scanned.cursor.nextRecordIndex);
      const batch = completedBatch({
        sourceKey: resolved.source.sourceKey,
        expected: checkpointExpected(checkpoint),
        next: {
          status: scanned.complete ? "complete" : "pending",
          cursorJson: stableJson(nextCursor),
        },
        records,
        diagnosticDeltas: [],
        registryGapDeltas: [],
        resourceDeltas: resourceDelta(resourceBefore, resourceAfter),
      });
      const committed = await workspace.commitSupplementalSourceBatch(batch);
      await failpoint("after_claude_status_checkpoint_batch", committed.checkpoint);
      if (records.length > 0) await failpoint("after_record_batch", committed.checkpoint);
      if (committed.checkpoint.status === "complete") return { checkpoint: committed.checkpoint };
    }
  } catch (error) {
    if (error instanceof ClaudeStatusLedgerExportSourceError
        || error instanceof ClaudeStatusWorkspaceSourceError) {
      workspace.markPoisoned("source_integrity");
    }
    throw error;
  }
}

return Object.freeze({
  CLAUDE_STATUS_WORKSPACE_SOURCE_VERSION,
  CLAUDE_STATUS_WORKSPACE_CURSOR_VERSION,
  DEFAULT_CLAUDE_STATUS_RECORDS_PER_BATCH,
  ClaudeStatusWorkspaceSourceError,
  appendClaudeStatusWorkspaceSource,
  claudeStatusWorkspaceSourceKey,
  createClaudeStatusWorkspaceSource,
  populateClaudeStatusWorkspaceSource,
  resolveClaudeStatusWorkspaceSource,
});
}
