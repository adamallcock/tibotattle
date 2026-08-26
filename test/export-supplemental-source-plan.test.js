import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportCompatibilityTuple } from "../src/export-contract.js";
import { createEmptyCodexCheckpointState } from "../src/export-checkpoint-state.js";
import { deriveParticipantId } from "../src/export-identity.js";
import { createCodexExportSourcePlan } from "../src/export-source-plan.js";
import {
  createSupplementalSourcePlan,
  ExportSupplementalSourcePlanError,
  summarizeSupplementalSourcePlan,
} from "../src/export-supplemental-source-plan.js";
import {
  buildExportWorkspaceDescriptor,
  createExportWorkspace,
  ExportWorkspaceError,
  inspectExportWorkspaceDiscardState,
  openExportWorkspace,
  sourceCheckpointBatchSha256,
  supplementalSourceCheckpointBatchSha256,
} from "../src/export-workspace.js";
import { stableJson } from "../src/storage.js";

const SECRET = Buffer.alloc(32, 79);

function digest(label) {
  return createHash("sha256").update(`supplemental-workspace-test:${label}`).digest("hex");
}

function activityPlan() {
  return {
    recordCount: 0,
    recordsSha256: createHash("sha256")
      .update("app-usagemonitor/export-activity-plan/v1\0")
      .update("[]")
      .digest("hex"),
  };
}

function usageRecord(id = "a", tokens = 10) {
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
    eventId: `event:v2:${id.repeat(64)}`,
    sessionScopeId: `session:v1:${"9".repeat(64)}`,
    accountScopeId: "unattributed",
  };
}

function supplementalPlan() {
  return createSupplementalSourcePlan({
    sources: [
      {
        ordinal: 0,
        sourceKey: digest("collector"),
        kind: "codex_collector_ledger",
        parserVersion: "codex-collector-ledger-v0.1",
        binding: {
          kind: "file_prefix",
          device: 1,
          inode: 2,
          birthtimeMs: 3,
          prefixBytes: 11,
          prefixSha256: digest("collector-prefix"),
        },
        initialCursorJson: stableJson({ batch: 0 }),
      },
      {
        ordinal: 1,
        sourceKey: digest("claude"),
        kind: "claude_status_snapshot",
        parserVersion: "claude-statusline-v0.2",
        binding: {
          kind: "frozen_inventory",
          inventoryEntries: 2,
          inventoryBytes: 17,
          inventorySha256: digest("claude-inventory"),
        },
        initialCursorJson: stableJson({ snapshot: 0 }),
      },
    ],
  });
}

async function fixture({ supplemental = supplementalPlan() } = {}) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-supplemental-workspace-"));
  const home = join(root, "codex-home");
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  await writeFile(join(home, "sessions", "rollout-2026-07-24T12-00-00-supplemental.jsonl"), `${JSON.stringify({
    timestamp: "2026-07-24T12:00:00.000Z",
    type: "session_meta",
    payload: { id: "PRIVATE_SESSION" },
  })}\n`);
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
    supplementalSourcePlan: supplemental,
    activityPlan: activityPlan(),
  });
  return {
    root,
    sourcePlan,
    supplemental,
    supplementalPrivatePlans: supplemental.sources
      .filter((source) => source.kind === "claude_status_snapshot")
      .map((source) => ({ sourceKey: source.sourceKey, valueJson: stableJson({ opaquePrivatePlan: "fixture" }) })),
    descriptor,
    workspace: join(root, "workspace"),
  };
}

function codexBatch(sourceKey, expected, next, resourceDeltas = {}) {
  const value = {
    sourceKey,
    expected: {
      checkpointSeq: expected.checkpointSeq,
      phase: expected.phase,
      byteOffset: expected.byteOffset,
      lineOrdinal: expected.lineOrdinal,
    },
    next,
    records: [],
    seenOccurrences: [],
    localSnapshots: [],
    tierEvents: [],
    openTaskAdds: [],
    openTaskDeletes: [],
    diagnosticDeltas: [],
    resourceDeltas,
  };
  return { ...value, batchSha256: sourceCheckpointBatchSha256(value) };
}

function supplementalBatch(sourceKey, expected, next, {
  records = [], diagnosticDeltas = [], registryGapDeltas = [], resourceDeltas = {},
} = {}) {
  const value = {
    sourceKey,
    expected: {
      checkpointSeq: expected.checkpointSeq,
      status: expected.status,
      cursorJson: expected.cursorJson,
    },
    next,
    records,
    diagnosticDeltas,
    registryGapDeltas,
    resourceDeltas,
  };
  return { ...value, batchSha256: supplementalSourceCheckpointBatchSha256(value) };
}

async function completeCodexSource(workspace, source) {
  const initial = workspace.loadSourceCheckpoint(source.sourceKey);
  await workspace.commitSourceBatch(codexBatch(source.sourceKey, initial, {
    phase: "record_scan",
    byteOffset: 0,
    lineOrdinal: 0,
    parserState: createEmptyCodexCheckpointState(),
    completedPhaseCursor: { byteOffset: source.prefixBytes, lineOrdinal: 1 },
  }, { lines: 1 }));
  const record = workspace.loadSourceCheckpoint(source.sourceKey);
  await workspace.commitSourceBatch(codexBatch(source.sourceKey, record, {
    phase: "complete",
    byteOffset: source.prefixBytes,
    lineOrdinal: 1,
    parserState: record.parserState,
  }, { lines: 1 }));
}

test("supplemental plans are strict, deterministic, and resource-accountable", async () => {
  const plan = supplementalPlan();
  assert.deepEqual(summarizeSupplementalSourcePlan(plan), {
    schemaVersion: "supplemental-export-source-plan-v1",
    supplementalSourcePlanSha256: plan.supplementalSourcePlanSha256,
    sourceCount: 2,
    sourceFiles: 3,
    sourceBytes: 28,
  });
  for (const mutate of [
    (value) => { value.sources[0].kind = "unreviewed_source"; },
    (value) => {
      value.sources[0].binding = structuredClone(value.sources[1].binding);
      value.sources[1].binding = {
        kind: "file_prefix",
        device: 4,
        inode: 5,
        birthtimeMs: 6,
        prefixBytes: 7,
        prefixSha256: digest("wrong-claude-prefix"),
      };
    },
    (value) => { value.sources[0].initialCursorJson = "{\"batch\":0}"; },
    (value) => { value.sources[1].ordinal = 0; },
    (value) => { value.sources[1].sourceKey = value.sources[0].sourceKey; },
  ]) {
    const value = structuredClone(plan);
    mutate(value);
    assert.throws(() => summarizeSupplementalSourcePlan(value), (error) => error instanceof ExportSupplementalSourcePlanError
      && error.code === "export_supplemental_source_schema");
  }

  const value = await fixture();
  let workspace;
  try {
    workspace = await createExportWorkspace({
      directory: value.workspace,
      descriptor: value.descriptor,
      sourcePlan: value.sourcePlan,
      supplementalSourcePlan: value.supplemental,
      supplementalPrivatePlans: value.supplementalPrivatePlans,
    });
    assert.deepEqual(workspace.resourceUsage(), {
      policyVersion: workspace.resourceUsage().policyVersion,
      sourceFiles: 4,
      sourceBytes: value.sourcePlan.sources[0].prefixBytes + 28,
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
    assert.deepEqual(workspace.loadSupplementalSourcePlan(), value.supplemental);
    const checkpoint = workspace.loadNextSupplementalSourceCheckpoint();
    assert.equal(checkpoint.sourceKey, value.supplemental.sources[0].sourceKey);
    assert.equal(checkpoint.parserVersion, "codex-collector-ledger-v0.1");
  } finally {
    workspace?.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Windows-sized Claude supplemental identities round-trip through close and reopen", async () => {
  const base = supplementalPlan().sources[0];
  const oversized = ((2n ** 64n) - 1n).toString(10);
  const supplemental = createSupplementalSourcePlan({
    sources: [{
      ...base,
      kind: "claude_transcript_jsonl",
      parserVersion: "claude-transcript-export-source-plan-v0.2",
      binding: {
        ...base.binding,
        device: oversized,
        inode: oversized,
      },
    }],
  });
  const value = await fixture({ supplemental });
  const supplementalPrivatePlans = [{
    sourceKey: supplemental.sources[0].sourceKey,
    valueJson: stableJson({ opaquePrivatePlan: "claude-transcript-fixture" }),
  }];
  let workspace;
  try {
    workspace = await createExportWorkspace({
      directory: value.workspace,
      descriptor: value.descriptor,
      sourcePlan: value.sourcePlan,
      supplementalSourcePlan: supplemental,
      supplementalPrivatePlans,
    });
    assert.deepEqual(workspace.loadSupplementalSourcePlan(), supplemental);
    const checkpoint = workspace.loadNextSupplementalSourceCheckpoint();
    assert.equal(checkpoint.binding.device, oversized);
    assert.equal(checkpoint.binding.inode, oversized);
    workspace.close();
    workspace = await openExportWorkspace({ directory: value.workspace, expectedDescriptor: value.descriptor });
    assert.deepEqual(workspace.loadSupplementalSourcePlan(), supplemental);
    assert.deepEqual(
      workspace.loadSupplementalPrivatePlan(supplemental.sources[0].sourceKey),
      { opaquePrivatePlan: "claude-transcript-fixture" },
    );
    const reopenedCheckpoint = workspace.loadNextSupplementalSourceCheckpoint();
    assert.equal(reopenedCheckpoint.binding.device, oversized);
    assert.equal(reopenedCheckpoint.binding.inode, oversized);
  } finally {
    await workspace?.close?.();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Claude private plans are exact and bounded before reopening parses them", async () => {
  const value = await fixture();
  let workspace;
  try {
    for (const supplementalPrivatePlans of [
      [],
      [{
        sourceKey: value.supplemental.sources[0].sourceKey,
        valueJson: stableJson({ opaquePrivatePlan: "wrong-source" }),
      }],
    ]) {
      await assert.rejects(createExportWorkspace({
        directory: join(value.root, `invalid-private-${supplementalPrivatePlans.length}`),
        descriptor: value.descriptor,
        sourcePlan: value.sourcePlan,
        supplementalSourcePlan: value.supplemental,
        supplementalPrivatePlans,
      }), (error) => error instanceof ExportWorkspaceError
        && error.code === "export_workspace_schema");
    }
    workspace = await createExportWorkspace({
      directory: value.workspace,
      descriptor: value.descriptor,
      sourcePlan: value.sourcePlan,
      supplementalSourcePlan: value.supplemental,
      supplementalPrivatePlans: value.supplementalPrivatePlans,
    });
    const databaseFile = workspace.databaseFile;
    const claudeSource = value.supplemental.sources.find((source) => source.kind === "claude_status_snapshot");
    workspace.close();
    workspace = null;
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databaseFile);
    try {
      // The four-byte UTF-8 character crosses the 32 MiB on-disk limit while
      // keeping the test allocation smaller than a Latin-1 equivalent.
      const oversized = `{"private":"${"\u{1F4A9}".repeat((32 * 1024 * 1024 / 4) + 1)}"}`;
      database.prepare("UPDATE workspace_meta SET value_json = ? WHERE key = ?").run(
        oversized,
        `supplemental_private_plan:${claudeSource.sourceKey}`,
      );
    } finally {
      database.close();
    }
    const reopened = await openExportWorkspace({ directory: value.workspace });
    try {
      assert.throws(() => reopened.loadSupplementalPrivatePlan(claudeSource.sourceKey), (error) => error instanceof ExportWorkspaceError
        && error.code === "export_workspace_schema"
        && !error.message.includes("private"));
    } finally {
      reopened.close();
    }
  } finally {
    workspace?.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("supplemental commits are atomic, byte-identical replays, and gate completion", async () => {
  const value = await fixture();
  let workspace;
  try {
    workspace = await createExportWorkspace({
      directory: value.workspace,
      descriptor: value.descriptor,
      sourcePlan: value.sourcePlan,
      supplementalSourcePlan: value.supplemental,
      supplementalPrivatePlans: value.supplementalPrivatePlans,
    });
    await completeCodexSource(workspace, value.sourcePlan.sources[0]);
    await assert.throws(() => workspace.finalizeScan(), (error) => error instanceof ExportWorkspaceError
      && error.code === "export_workspace_checkpoint_mismatch");
    assert.equal(workspace.isScanComplete(), false);
    workspace.close();
    workspace = null;
    assert.equal((await inspectExportWorkspaceDiscardState({ directory: value.workspace })).scanComplete, false);
    workspace = await openExportWorkspace({ directory: value.workspace, expectedDescriptor: value.descriptor });

    const first = workspace.loadSupplementalSourceCheckpoint(value.supplemental.sources[0].sourceKey);
    const batch = supplementalBatch(first.sourceKey, first, {
      status: "pending",
      cursorJson: stableJson({ batch: 1 }),
    }, {
      records: [{ recordType: "usageEvent", record: usageRecord("a", 10) }],
      diagnosticDeltas: [{ code: "malformed_lines", count: 1 }],
      resourceDeltas: { directoryEntries: 1, lines: 1, cumulativeElapsedMs: 4, peakRssBytes: 1024 },
    });
    const committed = await workspace.commitSupplementalSourceBatch(batch);
    assert.equal(committed.alreadyCommitted, false);
    assert.equal(committed.checkpoint.checkpointSeq, 1);
    assert.deepEqual(await workspace.commitSupplementalSourceBatch(batch), {
      alreadyCommitted: true,
      checkpoint: committed.checkpoint,
    });
    assert.deepEqual(workspace.diagnostics(), [{ code: "malformed_lines", count: 1 }]);
    const afterReplayUsage = workspace.resourceUsage();
    assert.equal(afterReplayUsage.outputRecords, 1);
    assert.equal(afterReplayUsage.directoryEntries, 1);

    const branching = supplementalBatch(first.sourceKey, first, {
      status: "pending",
      cursorJson: stableJson({ batch: 99 }),
    });
    await assert.rejects(workspace.commitSupplementalSourceBatch(branching), (error) => error instanceof ExportWorkspaceError
      && error.code === "export_workspace_checkpoint_mismatch");

    const current = workspace.loadSupplementalSourceCheckpoint(first.sourceKey);
    const conflict = supplementalBatch(first.sourceKey, current, {
      status: "pending",
      cursorJson: stableJson({ batch: 2 }),
    }, {
      records: [{ recordType: "usageEvent", record: usageRecord("a", 99) }],
      diagnosticDeltas: [{ code: "malformed_lines", count: 9 }],
      resourceDeltas: { lines: 1 },
    });
    await assert.rejects(workspace.commitSupplementalSourceBatch(conflict), (error) => error instanceof ExportWorkspaceError
      && error.code === "export_workspace_record_conflict");
    assert.deepEqual(workspace.loadSupplementalSourceCheckpoint(first.sourceKey), current);
    assert.deepEqual(workspace.resourceUsage(), afterReplayUsage);

    const invalidCursor = supplementalBatch(first.sourceKey, current, {
      status: "pending",
      cursorJson: "{\"batch\":2}",
    });
    await assert.rejects(workspace.commitSupplementalSourceBatch(invalidCursor), (error) => error instanceof ExportWorkspaceError
      && error.code === "export_workspace_schema");

    await workspace.commitSupplementalSourceBatch(supplementalBatch(first.sourceKey, current, {
      status: "complete",
      cursorJson: stableJson({ batch: 2 }),
    }));
    const second = workspace.loadSupplementalSourceCheckpoint(value.supplemental.sources[1].sourceKey);
    await workspace.commitSupplementalSourceBatch(supplementalBatch(second.sourceKey, second, {
      status: "complete",
      cursorJson: stableJson({ snapshot: 1 }),
    }));
    workspace.finalizeScan();
    assert.equal(workspace.isScanComplete(), true);
    assert.deepEqual(workspace.scanDiagnostics(), {
      sourceFilesScanned: 4,
      codes: [{ code: "malformed_lines", count: 1 }],
    });
    workspace.close();
    workspace = null;
    assert.equal((await inspectExportWorkspaceDiscardState({ directory: value.workspace })).scanComplete, true);
  } finally {
    workspace?.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("an empty supplemental plan preserves the Codex-only completion path", async () => {
  const value = await fixture({ supplemental: createSupplementalSourcePlan() });
  let workspace;
  try {
    workspace = await createExportWorkspace({
      directory: value.workspace,
      descriptor: value.descriptor,
      sourcePlan: value.sourcePlan,
      supplementalPrivatePlans: value.supplementalPrivatePlans,
    });
    assert.equal(workspace.loadNextSupplementalSourceCheckpoint(), null);
    assert.equal(workspace.hasPendingSupplementalSources(), false);
    await completeCodexSource(workspace, value.sourcePlan.sources[0]);
    workspace.finalizeScan();
    assert.equal(workspace.isScanComplete(), true);
    workspace.close();
    workspace = null;
    const reopened = await openExportWorkspace({ directory: value.workspace, expectedDescriptor: value.descriptor });
    try {
      assert.equal(reopened.isScanComplete(), true);
      assert.deepEqual(reopened.loadSupplementalSourcePlan(), value.supplemental);
    } finally {
      reopened.close();
    }
  } finally {
    workspace?.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("opening revalidates the descriptor-bound supplemental plan exactly", async () => {
  const value = await fixture();
  let workspace;
  try {
    workspace = await createExportWorkspace({
      directory: value.workspace,
      descriptor: value.descriptor,
      sourcePlan: value.sourcePlan,
      supplementalSourcePlan: value.supplemental,
      supplementalPrivatePlans: value.supplementalPrivatePlans,
    });
    const databaseFile = workspace.databaseFile;
    workspace.close();
    workspace = null;
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databaseFile);
    try {
      database.prepare(`
        UPDATE supplemental_source_plan SET initial_cursor_json = ? WHERE source_key = ?
      `).run(stableJson({ batch: 7 }), value.supplemental.sources[0].sourceKey);
    } finally {
      database.close();
    }
    await assert.rejects(openExportWorkspace({ directory: value.workspace }), (error) => error instanceof ExportWorkspaceError
      && error.code === "export_workspace_schema");
  } finally {
    workspace?.close();
    await rm(value.root, { recursive: true, force: true });
  }
});
