import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportCompatibilityTuple } from "../src/export-contract.js";
import { createEmptyCodexCheckpointState } from "../src/export-checkpoint-state.js";
import { deriveParticipantId } from "../src/export-identity.js";
import { EXPORT_RESOURCE_POLICY_VERSION } from "../src/export-resource-policy.js";
import { createCodexExportSourcePlan } from "../src/export-source-plan.js";
import {
  buildExportWorkspaceDescriptor,
  createExportWorkspace,
  ExportWorkspaceError,
  openExportWorkspace,
  sourceCheckpointBatchSha256,
} from "../src/export-workspace.js";

const SECRET = Buffer.alloc(32, 73);

function privateKey(label) {
  return createHash("sha256").update(`checkpoint-workspace-test:${label}`).digest("hex");
}

function usageRecord(id = "A", tokens = 10) {
  return {
    schemaVersion: "usage-event-v0.1",
    eventTime: "2026-07-24T12:30:00.000Z",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    modelRecognition: "recognized",
    modelFingerprint: null,
    billingSurface: "chatgpt_subscription",
    speedMode: "standard",
    apiServiceTier: "unknown",
    reasoningEffort: "unknown",
    components: {
      inputUncachedTokens: tokens,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      inputCacheWrite5mTokens: null,
      inputCacheWrite1hTokens: null,
      outputTextTokens: 1,
      outputReasoningTokens: 0,
      outputCombinedTokens: null,
    },
    totalInputContextTokens: tokens,
    surface: "local_interactive_unclassified",
    agentScope: "root",
    lineageDisposition: "standalone",
    toolClassCounts: {
      webSearch: 0, fileSearch: 0, codeInterpreter: 0, hostedShell: 0, computerUse: 0,
      mcp: 0, applyPatch: 0, localShell: 0, subagent: 0, toolGateway: 0, other: 0, unknown: 0,
    },
    outcome: "unknown",
    eventId: `event:v2:${id.repeat(43)}`,
    sessionScopeId: `session:v1:${"S".repeat(43)}`,
    accountScopeId: "unattributed",
  };
}

async function fixture({ fork = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-checkpoint-workspace-"));
  const home = join(root, "codex-home");
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const parentPath = join(home, "sessions", "rollout-2026-07-24T12-00-00-parent.jsonl");
  await writeFile(parentPath, `${JSON.stringify({
    timestamp: "2026-07-24T12:00:00.000Z",
    type: "session_meta",
    payload: { id: "PRIVATE_PARENT_SESSION", prompt: "PRIVATE_PARENT_PROMPT" },
  })}\n`);
  if (fork) {
    const childPath = join(home, "sessions", "rollout-2026-07-24T12-01-00-child.jsonl");
    await writeFile(childPath, `${JSON.stringify({
      timestamp: "2026-07-24T12:01:00.000Z",
      type: "session_meta",
      payload: { id: "PRIVATE_CHILD_SESSION", forked_from_id: "PRIVATE_PARENT_SESSION" },
    })}\n`);
  }
  const sourcePlan = await createCodexExportSourcePlan({
    codexHome: home,
    startAt: "2026-07-24T11:00:00.000Z",
    endAt: "2026-07-24T13:00:00.000Z",
  });
  const descriptor = buildExportWorkspaceDescriptor({
    participantId: deriveParticipantId(SECRET),
    createdAt: "2026-07-24T13:00:00.000Z",
    coveredAt: { startAt: sourcePlan.startAt, endAt: sourcePlan.endAt },
    compatibility: exportCompatibilityTuple(),
    sourcePlan,
    activityPlan: {
      recordCount: 0,
      recordsSha256: createHash("sha256")
        .update("app-usagemonitor/export-activity-plan/v1\0")
        .update("[]")
        .digest("hex"),
    },
  });
  return { root, sourcePlan, descriptor, workspace: join(root, "workspace") };
}

function finalizedBatch(batch) {
  return { ...batch, batchSha256: sourceCheckpointBatchSha256(batch) };
}

function batchFor({
  sourceKey,
  expected,
  next,
  records = [],
  seenOccurrences = [],
  localSnapshots = [],
  tierEvents = [],
  openTaskAdds = [],
  openTaskDeletes = [],
  diagnosticDeltas = [],
  resourceDeltas = {},
}) {
  return finalizedBatch({
    sourceKey,
    expected: {
      checkpointSeq: expected.checkpointSeq,
      phase: expected.phase,
      byteOffset: expected.byteOffset,
      lineOrdinal: expected.lineOrdinal,
    },
    next,
    records,
    seenOccurrences,
    localSnapshots,
    tierEvents,
    openTaskAdds,
    openTaskDeletes,
    diagnosticDeltas,
    resourceDeltas,
  });
}

function sameCheckpointShape(checkpoint) {
  return {
    sourceKey: checkpoint.sourceKey,
    phase: checkpoint.phase,
    byteOffset: checkpoint.byteOffset,
    lineOrdinal: checkpoint.lineOrdinal,
    checkpointSeq: checkpoint.checkpointSeq,
    parserVersion: checkpoint.parserVersion,
    parserState: checkpoint.parserState,
    lastBatchSha256: checkpoint.lastBatchSha256,
    parentSourceKey: checkpoint.parentSourceKey,
    isFork: checkpoint.isFork,
    parentMissing: checkpoint.parentMissing,
    prefixBytes: checkpoint.prefixBytes,
  };
}

test("checkpoint workspace atomically persists an initial tier batch and rejects replay or stale progress", async () => {
  const value = await fixture();
  let workspace;
  try {
    workspace = await createExportWorkspace({
      directory: value.workspace,
      descriptor: value.descriptor,
      sourcePlan: value.sourcePlan,
    });
    const source = value.sourcePlan.sources[0];
    const initial = workspace.loadSourceCheckpoint(source.sourceKey);
    assert.deepEqual(sameCheckpointShape(initial), {
      sourceKey: source.sourceKey,
      phase: "tier_scan",
      byteOffset: 0,
      lineOrdinal: 0,
      checkpointSeq: 0,
      parserVersion: "codex-checkpoint-state-v0.1",
      parserState: createEmptyCodexCheckpointState(),
      lastBatchSha256: null,
      parentSourceKey: null,
      isFork: false,
      parentMissing: false,
      prefixBytes: source.prefixBytes,
    });
    assert.deepEqual(workspace.resourceUsage(), {
      policyVersion: EXPORT_RESOURCE_POLICY_VERSION,
      sourceFiles: 1,
      sourceBytes: source.prefixBytes,
      directoryEntries: 0,
      lines: 0,
      oversizedIrrelevantLines: 0,
      outputRecords: 0,
      expandedRecordBytes: 0,
      cumulativeElapsedMs: 0,
      peakRssBytes: 0,
      workspaceHighWaterBytes: 0,
      recoveryReservations: 0,
    });
    assert.deepEqual(workspace.beginInvocation({ nowMs: 100 }), {
      recoveredStaleInvocation: false,
      recoveryReservationMs: 0,
    });
    assert.deepEqual(workspace.beginInvocation({ nowMs: 101, recoveryReservationMs: 250 }), {
      recoveredStaleInvocation: true,
      recoveryReservationMs: 250,
    });
    assert.equal(workspace.resourceUsage().cumulativeElapsedMs, 250);
    assert.equal(workspace.resourceUsage().recoveryReservations, 1);
    workspace.finishInvocation();

    const occurrenceKey = privateKey("usage-occurrence");
    const snapshotKey = privateKey("cumulative-snapshot");
    const taskKey = privateKey("open-task");
    const parserState = createEmptyCodexCheckpointState();
    parserState.tier = { timelineIndex: 1, speedMode: "fast", apiServiceTier: "priority" };
    const batch = batchFor({
      sourceKey: source.sourceKey,
      expected: initial,
      next: {
        phase: "record_scan", byteOffset: 0, lineOrdinal: 0, parserState,
        completedPhaseCursor: { byteOffset: source.prefixBytes, lineOrdinal: 1 },
      },
      records: [{ recordType: "usageEvent", record: usageRecord("A", 10) }],
      seenOccurrences: [{ kind: "usage_event", occurrenceKey, lineOrdinal: 1 }],
      localSnapshots: [{ kind: "cumulative_usage", snapshotKey }],
      tierEvents: [{
        tierIndex: 0,
        eventTimeMs: Date.parse("2026-07-24T12:00:00.000Z"),
        lineOrdinal: 1,
        tierState: { timelineIndex: 1, speedMode: "fast", apiServiceTier: "priority" },
      }],
      openTaskAdds: [taskKey],
      diagnosticDeltas: [{ code: "malformed_lines", count: 2 }],
      resourceDeltas: {
        directoryEntries: 3,
        lines: 1,
        oversizedIrrelevantLines: 0,
        cumulativeElapsedMs: 17,
        peakRssBytes: 4096,
      },
    });
    const committed = await workspace.commitSourceBatch(batch);
    assert.equal(committed.alreadyCommitted, false);
    assert.equal(committed.checkpoint.phase, "record_scan");
    assert.equal(committed.checkpoint.checkpointSeq, 1);
    assert.equal(committed.checkpoint.lastBatchSha256, batch.batchSha256);
    assert.deepEqual(committed.checkpoint.parserState, parserState);
    assert.deepEqual(workspace.counts(), { usageEvents: 1, quotaSnapshots: 0, activityMarkers: 0 });
    assert.equal(workspace.hasSeenOccurrence("usage_event", occurrenceKey), true);
    assert.deepEqual(workspace.sourceTierEvents(source.sourceKey), [{
      tierIndex: 0,
      eventTimeMs: Date.parse("2026-07-24T12:00:00.000Z"),
      lineOrdinal: 1,
      tierState: { timelineIndex: 1, speedMode: "fast", apiServiceTier: "priority" },
    }]);
    assert.deepEqual(workspace.sourceOpenTaskKeys(source.sourceKey), [taskKey]);
    assert.deepEqual(workspace.diagnostics(), [{ code: "malformed_lines", count: 2 }]);
    const usage = workspace.resourceUsage();
    assert.equal(usage.directoryEntries, 3);
    assert.equal(usage.lines, 1);
    assert.equal(usage.outputRecords, 1);
    assert.ok(usage.expandedRecordBytes > 0);
    assert.equal(usage.cumulativeElapsedMs, 267);
    assert.equal(usage.peakRssBytes, 4096);

    const replay = await workspace.commitSourceBatch(batch);
    assert.equal(replay.alreadyCommitted, true);
    assert.equal(replay.checkpoint.checkpointSeq, 1);
    assert.deepEqual(workspace.resourceUsage(), usage);

    const stale = batchFor({
      sourceKey: source.sourceKey,
      expected: initial,
      next: {
        phase: "record_scan", byteOffset: 0, lineOrdinal: 0,
        parserState: createEmptyCodexCheckpointState(),
        completedPhaseCursor: { byteOffset: source.prefixBytes, lineOrdinal: 1 },
      },
      resourceDeltas: { lines: 1 },
    });
    await assert.rejects(
      workspace.commitSourceBatch(stale),
      (error) => error instanceof ExportWorkspaceError && error.code === "export_workspace_checkpoint_mismatch",
    );

    const current = workspace.loadSourceCheckpoint(source.sourceKey);
    const nonNewline = batchFor({
      sourceKey: source.sourceKey,
      expected: current,
      next: { phase: "record_scan", byteOffset: 1, lineOrdinal: 1, parserState: current.parserState },
    });
    await assert.rejects(
      workspace.commitSourceBatch(nonNewline),
      (error) => error instanceof ExportWorkspaceError && error.code === "export_workspace_checkpoint_mismatch",
    );

    const privacyCanary = "PRIVATE_CHECKPOINT_STATE_CANARY";
    const malformedState = createEmptyCodexCheckpointState();
    malformedState.privateSession = privacyCanary;
    const malformed = batchFor({
      sourceKey: source.sourceKey,
      expected: current,
      next: { phase: "record_scan", byteOffset: 0, lineOrdinal: 0, parserState: malformedState },
    });
    await assert.rejects(workspace.commitSourceBatch(malformed), (error) => {
      assert.equal(String(error).includes(privacyCanary), false);
      return error instanceof TypeError && /Invalid privacy-safe Codex checkpoint state/.test(error.message);
    });
  } finally {
    workspace?.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("checkpoint commits roll back conflicts and finalization requires every source to complete", async () => {
  const value = await fixture();
  let workspace;
  try {
    workspace = await createExportWorkspace({
      directory: value.workspace,
      descriptor: value.descriptor,
      sourcePlan: value.sourcePlan,
    });
    const source = value.sourcePlan.sources[0];
    const initial = workspace.loadSourceCheckpoint(source.sourceKey);
    const first = batchFor({
      sourceKey: source.sourceKey,
      expected: initial,
      next: {
        phase: "record_scan", byteOffset: 0, lineOrdinal: 0,
        parserState: createEmptyCodexCheckpointState(),
        completedPhaseCursor: { byteOffset: source.prefixBytes, lineOrdinal: 1 },
      },
      records: [{ recordType: "usageEvent", record: usageRecord("B", 10) }],
      diagnosticDeltas: [{ code: "malformed_lines", count: 1 }],
      resourceDeltas: { lines: 1, cumulativeElapsedMs: 3 },
    });
    await workspace.commitSourceBatch(first);
    await assert.throws(() => workspace.finalizeScan(), (error) => error instanceof ExportWorkspaceError
      && error.code === "export_workspace_checkpoint_mismatch");

    const beforeCheckpoint = workspace.loadSourceCheckpoint(source.sourceKey);
    const beforeDiagnostics = workspace.diagnostics();
    const beforeResources = workspace.resourceUsage();
    const conflicting = batchFor({
      sourceKey: source.sourceKey,
      expected: beforeCheckpoint,
      next: {
        phase: "record_scan",
        byteOffset: source.prefixBytes,
        lineOrdinal: 1,
        parserState: createEmptyCodexCheckpointState(),
      },
      records: [{ recordType: "usageEvent", record: usageRecord("B", 99) }],
      diagnosticDeltas: [{ code: "malformed_lines", count: 99 }],
      resourceDeltas: { lines: 1, cumulativeElapsedMs: 99, peakRssBytes: 99999 },
    });
    await assert.rejects(
      workspace.commitSourceBatch(conflicting),
      (error) => error instanceof ExportWorkspaceError && error.code === "export_workspace_record_conflict",
    );
    assert.deepEqual(workspace.loadSourceCheckpoint(source.sourceKey), beforeCheckpoint);
    assert.deepEqual(workspace.diagnostics(), beforeDiagnostics);
    assert.deepEqual(workspace.resourceUsage(), beforeResources);
    assert.equal(workspace.counts().usageEvents, 1);

    const complete = batchFor({
      sourceKey: source.sourceKey,
      expected: beforeCheckpoint,
      next: {
        phase: "complete",
        byteOffset: source.prefixBytes,
        lineOrdinal: 1,
        parserState: beforeCheckpoint.parserState,
      },
      resourceDeltas: { lines: 1 },
    });
    await workspace.commitSourceBatch(complete);
    workspace.finalizeScan();
    assert.equal(workspace.isScanComplete(), true);
    assert.deepEqual(workspace.scanDiagnostics(), {
      sourceFilesScanned: 1,
      codes: [{ code: "malformed_lines", count: 1 }],
    });
  } finally {
    workspace?.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("fork checkpoints can see a parent snapshot without storing a raw session identity", async () => {
  const value = await fixture({ fork: true });
  let workspace;
  try {
    workspace = await createExportWorkspace({
      directory: value.workspace,
      descriptor: value.descriptor,
      sourcePlan: value.sourcePlan,
    });
    assert.equal(value.sourcePlan.sources.length, 2);
    const [parent, child] = value.sourcePlan.sources;
    assert.equal(child.parentSourceKey, parent.sourceKey);
    const snapshotKey = privateKey("inherited-cumulative-snapshot");
    const initial = workspace.loadSourceCheckpoint(parent.sourceKey);
    await workspace.commitSourceBatch(batchFor({
      sourceKey: parent.sourceKey,
      expected: initial,
      next: {
        phase: "record_scan", byteOffset: 0, lineOrdinal: 0,
        parserState: createEmptyCodexCheckpointState(),
        completedPhaseCursor: { byteOffset: parent.prefixBytes, lineOrdinal: 1 },
      },
      resourceDeltas: { lines: 1 },
      localSnapshots: [{ kind: "cumulative_usage", snapshotKey }],
    }));
    assert.equal(workspace.hasInheritedSnapshot(child.sourceKey, "cumulative_usage", snapshotKey), true);
    assert.equal(workspace.hasInheritedSnapshot(child.sourceKey, "tool_call", snapshotKey), false);
    const status = await workspace.status();
    assert.equal(JSON.stringify(status).includes("PRIVATE_PARENT_SESSION"), false);
    assert.equal(JSON.stringify(status).includes("PRIVATE_CHILD_SESSION"), false);
  } finally {
    workspace?.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("checkpoint workspace rejects unrecognized columns and executable schema objects", async (t) => {
  const mutations = [
    "ALTER TABLE workspace_meta ADD COLUMN unexpected_private_text TEXT",
    "ALTER TABLE workspace_meta ADD COLUMN unexpected_hidden_text TEXT GENERATED ALWAYS AS (value_json) VIRTUAL",
    "CREATE VIEW unexpected_private_view AS SELECT value_json FROM workspace_meta",
    "CREATE TRIGGER unexpected_private_trigger AFTER UPDATE ON workspace_meta BEGIN SELECT 1; END",
    "DROP INDEX source_tier_lookup; CREATE INDEX source_tier_lookup ON source_tier_events(source_key)",
  ];
  for (const [index, sql] of mutations.entries()) {
    await t.test(`schema mutation ${index + 1}`, async () => {
      const value = await fixture();
      let workspace;
      try {
        workspace = await createExportWorkspace({
          directory: value.workspace,
          descriptor: value.descriptor,
          sourcePlan: value.sourcePlan,
        });
        const databaseFile = workspace.databaseFile;
        workspace.close();
        workspace = null;
        const { DatabaseSync } = await import("node:sqlite");
        const database = new DatabaseSync(databaseFile);
        try {
          database.exec(sql);
        } finally {
          database.close();
        }
        await assert.rejects(
          openExportWorkspace({ directory: value.workspace }),
          (error) => error instanceof ExportWorkspaceError && error.code === "export_workspace_schema",
        );
      } finally {
        workspace?.close();
        await rm(value.root, { recursive: true, force: true });
      }
    });
  }
});
