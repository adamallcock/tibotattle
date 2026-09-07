import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import * as zlib from "node:zlib";
import { createSourcePlanSummaryContract } from "../src/export/index.js";
import { exportCompatibilityTuple } from "../src/export-contract.js";
import { deriveParticipantId } from "../src/export-identity.js";
import {
  createCodexExportSourcePlan,
  ExportSourcePlanError,
  resolveCodexExportSourcePlan,
  verifyCodexExportSourcePlan,
} from "../src/export-source-plan.js";
import {
  localCodexLogScanner,
  localExportSourcePipeline,
  localExportWorkspace,
  localSafeRecords,
} from "../src/local-node-runtime.js";
import { stableJson } from "../src/storage.js";

const { createLocalExportWorkspace, resumeLocalExportWorkspace } = localExportSourcePipeline.controller;
const { buildExportWorkspaceDescriptor, createExportWorkspace, ExportWorkspaceError, openExportWorkspace } = localExportWorkspace;
const { scanCodexSafeRecords, summarizeActivityMarkerPlan } = localSafeRecords;
const { scanCodexLogEvents } = localCodexLogScanner;
const { planDigest } = createSourcePlanSummaryContract();
const SECRET = Buffer.alloc(32, 93);
const START_AT = "2026-07-24T11:55:00.000Z";
const END_AT = "2026-07-24T12:10:00.000Z";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const RESET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRIVATE_CANARY = "PAGINATED_RESET_SYNTHETIC_PRIVATE_CONTENT";

function usage(total) {
  return {
    input_tokens: total,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: total,
  };
}

function tokenCount(total, last = total) {
  return {
    timestamp: "2026-07-24T12:02:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: usage(total), last_token_usage: usage(last) },
      rate_limits: {
        limit_id: "codex", plan_type: "pro",
        primary: { used_percent: 12, window_minutes: 300, resets_at: 1784912400 },
        secondary: null,
      },
    },
  };
}

function toolCall(label = "shared") {
  return {
    timestamp: "2026-07-24T12:01:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call", name: "exec_command",
      call_id: `${PRIVATE_CANARY}-${label}`,
      arguments: PRIVATE_CANARY,
    },
  };
}

const CONTEXT = {
  timestamp: "2026-07-24T12:00:10.000Z",
  type: "turn_context",
  payload: { model: "gpt-6-astra", prompt: PRIVATE_CANARY },
};

function source({
  id = A, parentId = null, rolloutId = null, paginated = true,
  historyBase = undefined, ordinal = 0, omitOrdinal = false,
  records = [CONTEXT, toolCall(), tokenCount(100)],
} = {}) {
  return {
    id,
    rolloutId,
    records: [{
      timestamp: "2026-07-24T12:00:00.000Z",
      ...(omitOrdinal ? {} : { ordinal }),
      type: "session_meta",
      payload: {
        id,
        ...(parentId === null ? {} : { forked_from_id: parentId }),
        ...(paginated ? { history_mode: "paginated" } : {}),
        ...(historyBase === undefined ? {} : { history_base: historyBase }),
      },
    }, ...records],
  };
}

function sourceText(value) {
  return `${value.records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

async function fixture(t, sources, { compressed = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-paginated-reset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "codex-home");
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const value = { root, home, compressed, sources: [] };
  for (const item of sources) await appendSource(value, item);
  return value;
}

async function appendSource(value, item) {
  const sequence = String(value.sources.length).padStart(2, "0");
  const suffix = value.compressed ? ".jsonl.zst" : ".jsonl";
  const name = `rollout-2026-07-24T12-00-${sequence}-${item.id}${item.rolloutId === null ? "" : `_${item.rolloutId}`}${suffix}`;
  const path = join(value.home, "sessions", name);
  const text = sourceText(item);
  await writeFile(path, value.compressed ? zlib.zstdCompressSync(Buffer.from(text)) : text, { mode: 0o600 });
  value.sources.push({ path, item });
}

async function replaceSource(value, index, item) {
  const { path } = value.sources[index];
  const text = sourceText(item);
  await writeFile(path, value.compressed ? zlib.zstdCompressSync(Buffer.from(text)) : text, { mode: 0o600 });
  value.sources[index] = { path, item };
}

function storedPlanShape(plan) {
  const stored = JSON.parse(JSON.stringify(plan));
  // Persisted workspaces retain source bindings and ancestry, not the raw
  // discovery object. Resume must rediscover and validate those facts.
  for (const item of stored.sources) delete item.rolloutInfo;
  return stored;
}

function canonicalEnvelopes(records) {
  return records.map(({ recordType, record }) => ({ recordType, record }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

async function directResult(value) {
  const records = [];
  const result = await scanCodexSafeRecords({
    codexHome: value.home, startAt: START_AT, endAt: END_AT, secret: SECRET,
    onRecord: (record) => records.push(record),
  });
  return { records: canonicalEnvelopes(records), diagnostics: result.diagnostics.codes };
}

async function directScannerResult(value, { excludeSessionIds = [] } = {}) {
  const usageEvents = [];
  const toolEvents = [];
  const result = await scanCodexLogEvents({
    codexHome: value.home, startAt: START_AT, endAt: END_AT,
    excludeSessionIds, requireCompleteDiscovery: true,
    onUsage: (event) => usageEvents.push(event),
    onToolCall: (event) => toolEvents.push(event),
  });
  assert.equal(JSON.stringify({ usageEvents, toolEvents, result }).includes(PRIVATE_CANARY), false);
  return { usageEvents, toolEvents, result };
}

async function checkpointResult(value, label, { interruptAfterBatch = null, afterInterruption = null } = {}) {
  const directory = join(value.root, `workspace-${label}`);
  const common = { directory, codexHome: value.home, secret: SECRET, checkpointLinesPerBatch: 1 };
  const create = { ...common, startAt: START_AT, endAt: END_AT, createdAt: END_AT };
  let storedDigest = null;
  if (interruptAfterBatch === null) {
    await createLocalExportWorkspace(create);
  } else {
    let batches = 0;
    await assert.rejects(createLocalExportWorkspace({
      ...create,
      failpoint(stage) {
        if (stage === "after_source_checkpoint_batch" && ++batches === interruptAfterBatch) {
          throw new Error("synthetic-paginated-reset-interruption");
        }
      },
    }), /synthetic-paginated-reset-interruption/u);
    // The controller has closed its workspace. Reopen, inspect the persisted
    // plan, close again, then resume through the public controller: no retained
    // in-memory source plan can supply the missing lineage semantics.
    const interrupted = await openExportWorkspace({ directory });
    try {
      assert.equal((await interrupted.status()).scanComplete, false);
      const persisted = interrupted.loadSourcePlan();
      storedDigest = persisted.sourcePlanSha256;
      assert.equal(persisted.sources.length, value.sources.length);
    } finally { interrupted.close(); }
    await afterInterruption?.();
    const resumed = await resumeLocalExportWorkspace(common);
    assert.equal(resumed.status.scanComplete, true);
  }
  const workspace = await openExportWorkspace({ directory });
  try {
    if (storedDigest !== null) assert.equal(workspace.loadSourcePlan().sourcePlanSha256, storedDigest);
    const recordTypeForFamily = { usageEvents: "usageEvent", quotaSnapshots: "quotaSnapshot", activityMarkers: "activityMarker" };
    const records = canonicalEnvelopes([...workspace.iterateRecords()].map((item) => ({
      recordType: recordTypeForFamily[item.family], record: item.record,
    })));
    const diagnostics = workspace.scanDiagnostics().codes;
    assert.equal((await readFile(workspace.databaseFile)).includes(Buffer.from(PRIVATE_CANARY)), false);
    return { records, diagnostics };
  } finally { workspace.close(); }
}

function usageRecords(result) {
  return result.records.filter((item) => item.recordType === "usageEvent").map((item) => item.record);
}

function assertUsage(result, { count, totalInput, shellCalls = count, logicalScopes = count }) {
  const records = usageRecords(result);
  assert.equal(records.length, count);
  assert.equal(new Set(records.map((item) => item.eventId)).size, count, "physical occurrences are distinct");
  assert.equal(new Set(records.map((item) => item.sessionScopeId)).size, logicalScopes, "logical thread scope is retained");
  assert.equal(records.reduce((sum, item) => sum + item.components.inputUncachedTokens, 0), totalInput);
  assert.equal(records.reduce((sum, item) => sum + item.toolClassCounts.localShell, 0), shellCalls);
  assert.equal(JSON.stringify(result).includes(PRIVATE_CANARY), false);
}

function safeFailure(code) {
  return (error) => {
    assert.equal(error instanceof ExportSourcePlanError, true);
    assert.equal(error.code, `export_source_${code}`);
    assert.equal(error.message.includes(PRIVATE_CANARY), false);
    return true;
  };
}

test("paginated zero-start logical forks keep identical parent usage and tool occurrences across reopen", async (t) => {
  for (const [label, historyBase] of [["absent", undefined], ["null", null]]) {
    await t.test(label, async (t) => {
      const value = await fixture(t, [source(), source({ id: B, parentId: A, historyBase })]);
      const direct = await directResult(value);
      assertUsage(direct, { count: 2, totalInput: 200 });
      assert.equal(direct.diagnostics.some(({ code }) => code === "fork_replay_events_skipped" || code === "replayed_tool_calls_skipped"), false);
      const plan = await createCodexExportSourcePlan({ codexHome: value.home, startAt: START_AT, endAt: END_AT });
      assert.equal(plan.sources[1].isFork, false);
      assert.equal(plan.sources[1].parentSourceKey, null);
      assert.equal(plan.sources[1].parentMissing, false);
      assert.deepEqual(await checkpointResult(value, "uninterrupted"), direct);
      for (const interruptAfterBatch of [1, 7, 13]) {
        assert.deepEqual(await checkpointResult(value, `resumed-${interruptAfterBatch}`, { interruptAfterBatch }), direct);
      }
    });
  }
});

test("legacy inline forks still suppress identical replayed parent usage and tools", async (t) => {
  const value = await fixture(t, [source({ paginated: false }), source({ id: B, parentId: A, paginated: false })]);
  const direct = await directResult(value);
  assertUsage(direct, { count: 1, totalInput: 100 });
  assert.equal(direct.diagnostics.some(({ code, count }) => code === "fork_replay_events_skipped" && count === 1), true);
  assert.equal(direct.diagnostics.some(({ code, count }) => code === "replayed_tool_calls_skipped" && count === 1), true);
  assert.deepEqual(await checkpointResult(value, "legacy", { interruptAfterBatch: 7 }), direct);
});

test("inline tool replay requires an exact copied line, not merely the same call ID", async (t) => {
  const copiedTool = toolCall("same-call-id");
  const modifiedTool = structuredClone(copiedTool);
  modifiedTool.payload.arguments = `${PRIVATE_CANARY}-modified`;
  assert.equal(modifiedTool.payload.call_id, copiedTool.payload.call_id);
  const value = await fixture(t, [
    source({ paginated: false, records: [CONTEXT, copiedTool, tokenCount(100)] }),
    source({ id: B, parentId: A, paginated: false,
      records: [CONTEXT, copiedTool, tokenCount(100), modifiedTool, tokenCount(150, 50)] }),
  ]);
  const direct = await directResult(value);
  assertUsage(direct, { count: 2, totalInput: 150 });
  assert.deepEqual(usageRecords(direct).map((item) => item.components.inputUncachedTokens).sort((a, b) => a - b), [50, 100]);
  assert.equal(direct.diagnostics.some(({ code, count }) => code === "fork_replay_events_skipped" && count === 1), true);
  assert.equal(direct.diagnostics.some(({ code, count }) => code === "replayed_tool_calls_skipped" && count === 1), true);
  assert.deepEqual(await checkpointResult(value, "modified-tool", { interruptAfterBatch: 7 }), direct);
});

test("excluded inline parents still suppress copied tools without contributing usage or tools", async (t) => {
  const copiedTool = toolCall("excluded-parent");
  const freshTool = toolCall("included-child");
  const value = await fixture(t, [
    source({ paginated: false, records: [CONTEXT, copiedTool, tokenCount(100)] }),
    source({ id: B, parentId: A, paginated: false,
      records: [CONTEXT, copiedTool, tokenCount(100), freshTool, tokenCount(150, 50)] }),
  ]);
  const { usageEvents, toolEvents, result } = await directScannerResult(value, { excludeSessionIds: [A] });
  assert.deepEqual(usageEvents.map((event) => event.raw.input_tokens), [50]);
  assert.deepEqual(toolEvents.map((event) => event.toolClass), ["local_shell"]);
  assert.deepEqual(result.toolCallsByClass, { local_shell: 1 });
  assert.equal(result.diagnostics.excludedRollouts, 1);
  assert.equal(result.diagnostics.forkReplayEventsSkipped, 1);
  assert.equal(result.diagnostics.replayedToolCallsSkipped, 1);
  assert.equal(result.diagnostics.lineageParentsMissing, 0);
});

test("inline descendants inherit tool snapshots only within the paginated head's exact physical history prefix", async (t) => {
  const retainedTool = toolCall("retained-prefix");
  const removedSuffixTool = toolCall("removed-suffix");
  const prefix = source({ records: [CONTEXT, retainedTool, tokenCount(100)] });
  const value = await fixture(t, [
    source({ records: [...prefix.records.slice(1), removedSuffixTool, tokenCount(300, 200)] }),
    source({ rolloutId: RESET, historyBase: {
      thread_id: A,
      end_ordinal_exclusive: prefix.records.length,
      end_byte_offset: Buffer.byteLength(sourceText(prefix)),
    }, records: [] }),
    source({ id: C, parentId: A, paginated: false,
      records: [CONTEXT, retainedTool, tokenCount(100), removedSuffixTool, tokenCount(300, 200)] }),
  ]);
  // Physical-base export remains explicitly unsupported; exercise the direct
  // provider reader's bounded history seeding without weakening that gate.
  const { usageEvents, toolEvents, result } = await directScannerResult(value);
  assert.deepEqual(usageEvents.map((event) => event.raw.input_tokens), [100, 200, 200]);
  assert.deepEqual(toolEvents.map((event) => event.toolClass), ["local_shell", "local_shell", "local_shell"]);
  assert.deepEqual(result.toolCallsByClass, { local_shell: 3 });
  assert.equal(result.diagnostics.forkReplayEventsSkipped, 1);
  assert.equal(result.diagnostics.replayedToolCallsSkipped, 1);
  assert.equal(result.diagnostics.lineageParentsMissing, 0);
  assert.equal(result.diagnostics.unattributedForkReplayEventsSkipped, 0);
});

test("two physical reset generations retain distinct occurrences in one logical session", async (t) => {
  const value = await fixture(t, [source(), source({ rolloutId: RESET })]);
  const direct = await directResult(value);
  assertUsage(direct, { count: 2, totalInput: 200, logicalScopes: 1 });
  const quotas = direct.records.filter(({ recordType }) => recordType === "quotaSnapshot").map(({ record }) => record);
  assert.equal(quotas.length, 2);
  assert.equal(new Set(quotas.map((item) => item.snapshotId)).size, 2);
  assert.equal(new Set(quotas.map((item) => item.providerStateId)).size, 1, "repeated observations do not invent different provider states");
  assert.deepEqual(await checkpointResult(value, "same-session", { interruptAfterBatch: 13 }), direct);
});

test("unconsumed tools cannot leak into the next reset generation of the same logical session", async (t) => {
  const value = await fixture(t, [
    source({ records: [CONTEXT, tokenCount(100), toolCall("unconsumed")] }),
    source({ rolloutId: RESET, records: [CONTEXT, tokenCount(100)] }),
  ]);
  const direct = await directResult(value);
  assertUsage(direct, { count: 2, totalInput: 200, logicalScopes: 1, shellCalls: 0 });
  assert.deepEqual(await checkpointResult(value, "pending-tools", { interruptAfterBatch: 7 }), direct);
});

test("paginated zero-start history does not require a logical parent to seed accounting", async (t) => {
  const value = await fixture(t, [source({ id: B, parentId: A })]);
  const direct = await directResult(value);
  assertUsage(direct, { count: 1, totalInput: 100 });
  assert.equal(direct.diagnostics.some(({ code }) => code === "lineage_parents_missing" || code === "fork_rollouts_failed_closed"), false);
  assert.deepEqual(await checkpointResult(value, "missing-parent", { interruptAfterBatch: 7 }), direct);
});

test("legacy inline grandchildren inherit the reset snapshots but not the logical grandparent", async (t) => {
  const parentTool = toolCall("grandparent");
  const resetTool = toolCall("reset");
  const value = await fixture(t, [
    source({ records: [CONTEXT, parentTool, tokenCount(50)] }),
    source({ id: B, parentId: A, records: [CONTEXT, resetTool, tokenCount(100)] }),
    source({ id: C, parentId: B, paginated: false,
      records: [CONTEXT, resetTool, tokenCount(100), parentTool, tokenCount(50)] }),
  ]);
  const direct = await directResult(value);
  assertUsage(direct, { count: 3, totalInput: 200 });
  assert.deepEqual(usageRecords(direct).map((item) => item.components.inputUncachedTokens).sort((a, b) => a - b), [50, 50, 100]);
  assert.equal(direct.diagnostics.some(({ code, count }) => code === "fork_replay_events_skipped" && count === 1), true);
  assert.equal(direct.diagnostics.some(({ code, count }) => code === "replayed_tool_calls_skipped" && count === 1), true);
  assert.deepEqual(await checkpointResult(value, "grandchild", { interruptAfterBatch: 13 }), direct);
});

test("plain and compressed reset histories share records and persisted resume semantics", {
  skip: typeof zlib.zstdCompressSync !== "function" && "Native Zstd requires Node 22.15 or newer",
}, async (t) => {
  const sources = [source(), source({ id: B, parentId: A, historyBase: null })];
  const plain = await fixture(t, sources);
  const compressed = await fixture(t, sources, { compressed: true });
  const direct = await directResult(plain);
  assertUsage(direct, { count: 2, totalInput: 200 });
  assert.deepEqual(await directResult(compressed), direct);
  assert.deepEqual(await checkpointResult(compressed, "zstd-resume", { interruptAfterBatch: 13 }), direct);
});

test("archive movement preserves canonical physical occurrence identity across persisted resume", async (t) => {
  const value = await fixture(t, [source(), source({ rolloutId: RESET })]);
  const direct = await directResult(value);
  assertUsage(direct, { count: 2, totalInput: 200, logicalScopes: 1 });
  const resumed = await checkpointResult(value, "archive-move", {
    interruptAfterBatch: 7,
    async afterInterruption() {
      for (const entry of value.sources) {
        const moved = join(value.home, "archived_sessions", basename(entry.path));
        await rename(entry.path, moved);
        entry.path = moved;
      }
    },
  });
  assert.deepEqual(resumed, direct);
  assert.deepEqual(await directResult(value), direct, "archiving cannot change observation IDs or attribution");
});

test("prior checkpoint-scan compatibility refuses resume before recovering a pending invocation", async (t) => {
  const value = await fixture(t, [source({ paginated: false })]);
  const sourcePlan = await createCodexExportSourcePlan({ codexHome: value.home, startAt: START_AT, endAt: END_AT });
  const compatibility = structuredClone(exportCompatibilityTuple());
  assert.equal(compatibility.implementation.checkpointScanVersion, "codex-export-checkpoint-scan-v0.5");
  compatibility.implementation.checkpointScanVersion = "codex-export-checkpoint-scan-v0.4";
  const descriptor = buildExportWorkspaceDescriptor({
    participantId: deriveParticipantId(SECRET), createdAt: END_AT,
    coveredAt: { startAt: START_AT, endAt: END_AT }, compatibility, sourcePlan,
    activityPlan: summarizeActivityMarkerPlan(SECRET, [], { startAt: START_AT, endAt: END_AT }),
  });
  const directory = join(value.root, "workspace-prior-compatibility");
  const workspace = await createExportWorkspace({ directory, descriptor, sourcePlan });
  const databaseFile = workspace.databaseFile;
  let resources;
  try {
    // An old incomplete run has a durable invocation reservation. A new
    // reader must reject its compatibility before beginInvocation can charge
    // recovery, alter checkpoints, or touch the original history.
    workspace.beginInvocation({ nowMs: 100 });
    resources = workspace.resourceUsage();
    assert.equal(resources.recoveryReservations, 0);
  } finally { workspace.close(); }
  const before = await readFile(databaseFile);
  await assert.rejects(resumeLocalExportWorkspace({ directory, codexHome: value.home, secret: SECRET }),
    (error) => error instanceof ExportWorkspaceError && error.code === "export_workspace_checkpoint_mismatch");
  assert.deepEqual(await readFile(databaseFile), before, "compatibility refusal must not write even the invocation bookkeeping");
  const preserved = await openExportWorkspace({ directory });
  try {
    assert.deepEqual(preserved.resourceUsage(), resources);
    assert.equal(preserved.getDescriptor().compatibility.implementation.checkpointScanVersion, "codex-export-checkpoint-scan-v0.4");
    assert.equal(preserved.loadSourceCheckpoint(sourcePlan.sources[0].sourceKey).checkpointSeq, 0);
    assert.equal(preserved.isPoisoned(), false);
    assert.equal(preserved.isScanComplete(), false);
  } finally { preserved.close(); }
});

test("serialized prior-v2 paginated-as-inline semantics cannot verify or resume", async (t) => {
  const value = await fixture(t, [source(), source({ id: B, parentId: A })]);
  const plan = await createCodexExportSourcePlan({ codexHome: value.home, startAt: START_AT, endAt: END_AT });
  const prior = JSON.parse(JSON.stringify(plan));
  prior.sources[1].isFork = true;
  prior.sources[1].parentSourceKey = prior.sources[0].sourceKey;
  prior.sources[1].parentMissing = false;
  prior.sourcePlanSha256 = planDigest(prior.sources);
  assert.notEqual(prior.sourcePlanSha256, plan.sourcePlanSha256);
  await assert.rejects(verifyCodexExportSourcePlan(prior), safeFailure("source_changed"));
  await assert.rejects(resolveCodexExportSourcePlan(prior, { codexHome: value.home }), safeFailure("source_changed"));
});

test("forged rollout lineage cannot override frozen metadata when its plan digest is recomputed", async (t) => {
  const value = await fixture(t, [source(), source({ id: B, parentId: A })]);
  const plan = await createCodexExportSourcePlan({ codexHome: value.home, startAt: START_AT, endAt: END_AT });
  const forged = JSON.parse(JSON.stringify(plan));
  Object.assign(forged.sources[1].rolloutInfo.lineage, { historyMode: "legacy", isInlineFork: true });
  forged.sourcePlanSha256 = planDigest(forged.sources);
  assert.equal(forged.sourcePlanSha256, plan.sourcePlanSha256, "ephemeral raw-lineage fields are outside the public plan digest");
  await assert.rejects(verifyCodexExportSourcePlan(forged), safeFailure("source_changed"));
  await assert.rejects(resolveCodexExportSourcePlan(forged, { codexHome: value.home }), safeFailure("source_changed"));
});

test("valid physical history bases remain explicitly unsupported by export creation and resume", async (t) => {
  const parent = source();
  const value = await fixture(t, [parent, source({ id: B, parentId: A })]);
  const plan = storedPlanShape(await createCodexExportSourcePlan({ codexHome: value.home, startAt: START_AT, endAt: END_AT }));
  await replaceSource(value, 1, source({ id: B, parentId: A, historyBase: {
    thread_id: A, end_ordinal_exclusive: parent.records.length, end_byte_offset: Buffer.byteLength(sourceText(parent)),
  } }));
  // Establish the fixture's history boundary is valid for the direct reader;
  // the negative export result must not be a discovery/quarantine accident.
  await directResult(value);
  await assert.rejects(createCodexExportSourcePlan({ codexHome: value.home, startAt: START_AT, endAt: END_AT }),
    safeFailure("codex_rollout_checkpoint_history_unsupported"));
  await assert.rejects(resolveCodexExportSourcePlan(plan, { codexHome: value.home }),
    safeFailure("codex_rollout_checkpoint_history_unsupported"));
});

test("unsupported paginated start ordinals fail closed on creation and resume", async (t) => {
  for (const [label, options] of [
    ["missing", { omitOrdinal: true }], ["nonzero", { ordinal: 1 }],
    ["negative", { ordinal: -1 }], ["string", { ordinal: "0" }],
    ["fractional", { ordinal: 0.5 }], ["unsafe", { ordinal: Number.MAX_SAFE_INTEGER + 1 }],
  ]) {
    await t.test(label, async (t) => {
      const value = await fixture(t, [source(), source({ id: B })]);
      const plan = storedPlanShape(await createCodexExportSourcePlan({ codexHome: value.home, startAt: START_AT, endAt: END_AT }));
      await replaceSource(value, 1, source({ id: B, ...options }));
      await assert.rejects(createCodexExportSourcePlan({ codexHome: value.home, startAt: START_AT, endAt: END_AT }),
        safeFailure("codex_rollout_checkpoint_history_unsupported"));
      await assert.rejects(resolveCodexExportSourcePlan(plan, { codexHome: value.home }),
        safeFailure("codex_rollout_checkpoint_history_unsupported"));
    });
  }
});

test("malformed physical-base fields cannot masquerade as absent reset history", async (t) => {
  for (const [label, historyBase] of [["array", []], ["string", "invalid"], ["number", 7], ["boolean", true], ["object", {}]]) {
    await t.test(label, async (t) => {
      const value = await fixture(t, [source(), source({ id: B })]);
      const plan = storedPlanShape(await createCodexExportSourcePlan({ codexHome: value.home, startAt: START_AT, endAt: END_AT }));
      await replaceSource(value, 1, source({ id: B, historyBase }));
      await assert.rejects(createCodexExportSourcePlan({ codexHome: value.home, startAt: START_AT, endAt: END_AT }),
        safeFailure("codex_rollout_lineage_invalid"));
      await assert.rejects(resolveCodexExportSourcePlan(plan, { codexHome: value.home }),
        safeFailure("codex_rollout_lineage_invalid"));
    });
  }
});
