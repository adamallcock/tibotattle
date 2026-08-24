import {
  canonicalComponentAvailability,
  canonicalComponents,
  canonicalRateLimitWindows,
  cumulativeSnapshotKey,
  deltaComponentPresence,
  extractToolObservations,
  normalizeProviderTier,
  normalizeTokenUsage,
  sameUsage,
  subtractUsage,
  tokenComponentPresence,
} from "../../providers/codex/logs.js";
import { CODEX_CHECKPOINT_SCAN_VERSION, stableJson } from "../../export/index.js";

export function createCodexCheckpointContext(configuration) {
const {
  bufferByteLength,
  codexSourcePlan,
  createCodexCheckpointStateContext,
  createHmac,
  deriveSessionScopeId,
  readBoundedUtf8LineEntries,
  safeRecords,
  workspace,
} = configuration;
const { createEmptyCodexCheckpointState } = createCodexCheckpointStateContext;
const {
  createEmptySafeToolClassCounts,
  normalizeCodexQuotaSnapshot,
  normalizeCodexUsageEvent,
  safeExportModelDeclaration,
  safeToolCountFieldForScannerToolClass,
} = safeRecords;
const {
  openVerifiedCodexExportSource,
  verifyCodexExportSourceHandle,
  ExportSourcePlanError,
} = codexSourcePlan;
const { ExportWorkspaceError, sourceCheckpointBatchSha256 } = workspace;

const DEFAULT_CHECKPOINT_LINES_PER_BATCH = 8_192;

const RELEVANT_NEEDLES = Object.freeze([
  '"type":"session_meta"', '"type":"turn_context"',
  '"type":"thread_settings_applied"', '"type":"token_count"',
  '"type":"task_started"', '"type":"task_complete"', '"type":"custom_tool_call"',
  '"type":"function_call"', '"type":"web_search_call"', '"type":"file_search_call"',
  '"type":"code_interpreter_call"', '"type":"shell_call"', '"type":"computer_call"',
  '"type":"mcp_call"', '"type":"apply_patch_call"', '"type":"local_shell_call"',
]);
const ACCOUNTING_NEEDLES = Object.freeze([
  '"type":"session_meta"',
  '"type":"turn_context"',
  '"type":"thread_settings_applied"',
  '"type":"token_count"',
]);

function accountingLine(line) {
  return ACCOUNTING_NEEDLES.some((needle) => line.includes(needle));
}

function accountingRecord(record) {
  return record?.type === "session_meta"
    || record?.type === "turn_context"
    || (record?.type === "event_msg"
      && ["thread_settings_applied", "token_count"]
        .includes(record?.payload?.type));
}

function contentInvalid() {
  throw new ExportSourcePlanError("codex_rollout_content_invalid");
}

function safeKey(secret, domain, subject) {
  return createHmac("sha256", secret)
    .update(`app-usagemonitor/${domain}/v1\0`)
    .update(stableJson(subject))
    .digest("hex");
}

function checkpointExpected(checkpoint) {
  return {
    checkpointSeq: checkpoint.checkpointSeq,
    phase: checkpoint.phase,
    byteOffset: checkpoint.byteOffset,
    lineOrdinal: checkpoint.lineOrdinal,
  };
}

function completedBatch(value) {
  return { ...value, batchSha256: sourceCheckpointBatchSha256(value) };
}

function emptyBatch(sourceKey, checkpoint) {
  return {
    sourceKey,
    expected: checkpointExpected(checkpoint),
    next: null,
    batchSha256: "0".repeat(64),
    records: [],
    seenOccurrences: [],
    localSnapshots: [],
    tierEvents: [],
    openTaskAdds: [],
    openTaskDeletes: [],
    diagnosticDeltas: [],
    resourceDeltas: {},
  };
}

function diagnosticAccumulator() {
  const counts = new Map();
  return {
    add(code, count = 1) {
      counts.set(code, (counts.get(code) ?? 0) + count);
    },
    rows() {
      return [...counts.entries()]
        .filter(([, count]) => count > 0)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([code, count]) => ({ code, count }));
    },
  };
}

function cloneState(state) {
  return structuredClone(state);
}

function relevantRecordLine(line) {
  return RELEVANT_NEEDLES.some((needle) => line.includes(needle));
}

function tierSemantics(tierEvent) {
  return {
    billingSurface: "chatgpt_subscription",
    codexSpeedMode: tierEvent?.tierState.speedMode ?? "unknown",
    apiServiceTier: tierEvent?.tierState.apiServiceTier ?? "unknown",
    tierSource: tierEvent ? "rollout_thread_settings" : "unobserved",
    tierObservedAt: tierEvent ? new Date(tierEvent.eventTimeMs).toISOString() : null,
  };
}

function addRecord(batch, recordType, record, resourceGuard) {
  resourceGuard.observeOutputRecord(bufferByteLength(stableJson(record), "utf8"));
  batch.records.push({ recordType, record });
}

function resourceDelta(before, after, lines, oversizedIrrelevantLines) {
  return {
    directoryEntries: Math.max(0, after.directoryEntries - before.directoryEntries),
    lines,
    oversizedIrrelevantLines,
    cumulativeElapsedMs: Math.max(0, after.cumulativeElapsedMs - before.cumulativeElapsedMs),
    peakRssBytes: after.peakRssBytes,
  };
}

async function commitBatch(
  workspace,
  batch,
  state,
  cursor,
  resourceGuard,
  resourceBefore,
  lineCounts,
  failpoint,
  completedPhaseCursor = null,
) {
  const after = resourceGuard.durableSnapshot();
  batch.next = {
    phase: cursor.phase,
    byteOffset: cursor.byteOffset,
    lineOrdinal: cursor.lineOrdinal,
    parserState: state,
    ...(completedPhaseCursor ? { completedPhaseCursor } : {}),
  };
  batch.resourceDeltas = resourceDelta(resourceBefore, after, lineCounts.lines, lineCounts.oversized);
  batch.diagnosticDeltas = batch.diagnostics.rows();
  delete batch.diagnostics;
  const emittedRecords = batch.records.length;
  const committed = await workspace.commitSourceBatch(completedBatch(batch));
  await failpoint?.("after_source_checkpoint_batch", committed.checkpoint);
  if (emittedRecords > 0) await failpoint?.("after_record_batch", committed.checkpoint);
  return committed.checkpoint;
}

async function scanTierPhase({ workspace, source, checkpoint, resourceGuard, failpoint, maximumLinesPerBatch }) {
  const handle = await openVerifiedCodexExportSource(source, { resourceGuard });
  try {
    let current = checkpoint;
    let state = cloneState(current.parserState);
    let batch = emptyBatch(source.sourceKey, current);
    batch.diagnostics = diagnosticAccumulator();
    let resourceBefore = workspace.resourceUsage();
    let lineCounts = { lines: 0, oversized: 0 };
    let cursor = { phase: "tier_scan", byteOffset: current.byteOffset, lineOrdinal: current.lineOrdinal };
    for await (const entry of readBoundedUtf8LineEntries(handle, {
      maximumLineBytes: resourceGuard.limits.maximumLineBytes,
      resourceGuard,
      oversizedIrrelevantNeedles: RELEVANT_NEEDLES,
      maximumTotalBytes: source.prefixBytes,
      startByte: current.byteOffset,
      startLineOrdinal: current.lineOrdinal + 1,
    })) {
      cursor.byteOffset = entry.endByteExclusive;
      cursor.lineOrdinal = entry.lineOrdinal;
      lineCounts.lines += 1;
      if (entry.line === null) lineCounts.oversized += 1;
      if (entry.line?.includes('"type":"thread_settings_applied"')) {
        try {
          const record = JSON.parse(entry.line);
          if (record.type === "event_msg" && record.payload?.type === "thread_settings_applied") {
            const timestampMs = typeof record?.timestamp === "string"
              ? Date.parse(record.timestamp)
              : Number.NaN;
            const rawTier = record.payload?.thread_settings?.service_tier;
            if (Number.isFinite(timestampMs) && (rawTier === null || typeof rawTier === "string")) {
              const normalized = normalizeProviderTier(rawTier, {
                billingSurface: "chatgpt_subscription",
                tierSource: "rollout_thread_settings",
                tierObservedAt: record.timestamp,
              });
              const tierIndex = state.tier.timelineIndex;
              state.tier = {
                timelineIndex: tierIndex + 1,
                speedMode: normalized.codexSpeedMode,
                apiServiceTier: normalized.apiServiceTier,
              };
              batch.tierEvents.push({
                tierIndex,
                eventTimeMs: timestampMs,
                lineOrdinal: entry.lineOrdinal,
                tierState: state.tier,
              });
            }
          }
        } catch {
          // The legacy tier prepass silently ignores malformed JSON.
        }
      }
      if (lineCounts.lines >= maximumLinesPerBatch) {
        current = await commitBatch(workspace, batch, state, cursor, resourceGuard, resourceBefore, lineCounts, failpoint);
        batch = emptyBatch(source.sourceKey, current);
        batch.diagnostics = diagnosticAccumulator();
        resourceBefore = workspace.resourceUsage();
        lineCounts = { lines: 0, oversized: 0 };
      }
    }
    const completedTierCursor = { byteOffset: cursor.byteOffset, lineOrdinal: cursor.lineOrdinal };
    cursor = { phase: "record_scan", byteOffset: 0, lineOrdinal: 0 };
    if (source.parentMissing) batch.diagnostics.add("lineage_parents_missing");
    await commitBatch(
      workspace,
      batch,
      createEmptyCodexCheckpointState(),
      cursor,
      resourceGuard,
      resourceBefore,
      lineCounts,
      failpoint,
      completedTierCursor,
    );
  } finally {
    try {
      await verifyCodexExportSourceHandle(source, handle, { resourceGuard });
    } finally {
      await handle.close().catch(() => {});
    }
  }
}

function snapshotKey(secret, total, last) {
  const key = cumulativeSnapshotKey(total, last);
  return key === null ? null : safeKey(secret, "checkpoint-cumulative-snapshot", { key });
}

function toolSnapshotKey(secret, line) {
  // Fork replay prefixes copy the source JSONL record byte-for-byte. Hash the
  // already-bounded line directly so arbitrary tool arguments are never
  // canonicalized into a second potentially large allocation.
  return createHmac("sha256", secret)
    .update("app-usagemonitor/checkpoint-tool-snapshot-line/v1\0")
    .update(line)
    .digest("hex");
}

async function scanRecordPhase({ workspace, source, checkpoint, secret, bounds, resourceGuard, failpoint, maximumLinesPerBatch }) {
  const handle = await openVerifiedCodexExportSource(source, { resourceGuard });
  const sourceScopeId = deriveSessionScopeId(
    secret,
    source.rolloutInfo?.lineage?.sessionId ?? source.rolloutInfo?.rolloutKey ?? source.sourceKey,
  );
  try {
    let current = checkpoint;
    let state = cloneState(current.parserState);
    let batch = emptyBatch(source.sourceKey, current);
    batch.diagnostics = diagnosticAccumulator();
    let resourceBefore = workspace.resourceUsage();
    let lineCounts = { lines: 0, oversized: 0 };
    let cursor = { phase: "record_scan", byteOffset: current.byteOffset, lineOrdinal: current.lineOrdinal };
    const openTasks = new Set(workspace.sourceOpenTaskKeys(source.sourceKey));
    const pendingTaskAdds = new Set();
    const pendingTaskDeletes = new Set();

    function rebaseTotals(total, presence) {
      if (state.previousTotals !== null
          && total.total_tokens < state.previousTotals.total_tokens) {
        state.reAnchored = true;
      }
      state.previousTotals = total;
      state.previousTotalsPresence = presence;
    }

    async function flush() {
      batch.openTaskAdds = [...pendingTaskAdds].sort();
      batch.openTaskDeletes = [...pendingTaskDeletes].sort();
      current = await commitBatch(workspace, batch, state, cursor, resourceGuard, resourceBefore, lineCounts, failpoint);
      batch = emptyBatch(source.sourceKey, current);
      batch.diagnostics = diagnosticAccumulator();
      resourceBefore = workspace.resourceUsage();
      lineCounts = { lines: 0, oversized: 0 };
      pendingTaskAdds.clear();
      pendingTaskDeletes.clear();
    }

    for await (const entry of readBoundedUtf8LineEntries(handle, {
      maximumLineBytes: resourceGuard.limits.maximumLineBytes,
      resourceGuard,
      oversizedIrrelevantNeedles: RELEVANT_NEEDLES,
      maximumTotalBytes: source.prefixBytes,
      startByte: current.byteOffset,
      startLineOrdinal: current.lineOrdinal + 1,
    })) {
      // A token line can emit at most two quota snapshots plus one usage
      // event. Commit before consuming the line when only two slots remain.
      if (batch.records.length > 997) await flush();
      cursor.byteOffset = entry.endByteExclusive;
      cursor.lineOrdinal = entry.lineOrdinal;
      lineCounts.lines += 1;
      if (entry.line === null) lineCounts.oversized += 1;
      if (entry.line === null || !relevantRecordLine(entry.line)) {
        if (lineCounts.lines >= maximumLinesPerBatch) await flush();
        continue;
      }
      let record;
      try {
        record = JSON.parse(entry.line);
      } catch {
        batch.diagnostics.add("malformed_lines");
        if (accountingLine(entry.line)) contentInvalid();
        if (lineCounts.lines >= maximumLinesPerBatch) await flush();
        continue;
      }
      const timestampMs = typeof record?.timestamp === "string"
        ? Date.parse(record.timestamp)
        : Number.NaN;
      if (!Number.isFinite(timestampMs)) {
        batch.diagnostics.add("malformed_timestamps");
        if (accountingRecord(record)) contentInvalid();
        if (lineCounts.lines >= maximumLinesPerBatch) await flush();
        continue;
      }

      if (record.type === "session_meta") {
        if (state.sessionMetaSeen) contentInvalid();
        state.sessionMetaSeen = true;
      } else if (record.type === "turn_context") {
        if (typeof record.payload?.model === "string") {
          state.currentModel = safeExportModelDeclaration(secret, record.payload.model);
        }
      } else if (record.type === "event_msg" && record.payload?.type === "thread_settings_applied") {
        // Persisted tier prepass owns valid values. Reject an explicitly
        // malformed setting here so the checkpoint cannot complete with a
        // silently missing speed declaration.
        const settings = record.payload?.thread_settings;
        if (!settings || typeof settings !== "object" || Array.isArray(settings)
            || (Object.hasOwn(settings, "service_tier")
              && settings.service_tier !== null
              && typeof settings.service_tier !== "string")) {
          contentInvalid();
        }
      } else if (record.type === "event_msg"
          && (record.payload?.type === "task_started" || record.payload?.type === "task_complete")) {
        if (timestampMs <= bounds.endMs) {
          const turnId = record.payload?.turn_id;
          if (typeof turnId !== "string" || turnId.length === 0) {
            batch.diagnostics.add("malformed_task_events");
          } else {
            const taskKey = safeKey(secret, "checkpoint-task", { sourceKey: source.sourceKey, turnId });
            if (record.payload.type === "task_started") {
              if (!openTasks.has(taskKey)) {
                openTasks.add(taskKey);
                if (!pendingTaskDeletes.delete(taskKey)) pendingTaskAdds.add(taskKey);
              }
            } else if (openTasks.delete(taskKey)) {
              if (!pendingTaskAdds.delete(taskKey)) pendingTaskDeletes.add(taskKey);
            }
          }
        }
      } else if (record.type === "response_item") {
        const observations = extractToolObservations(record.payload);
        if (observations.length > 0 && timestampMs >= bounds.startMs && timestampMs <= bounds.endMs) {
          const lineageKey = toolSnapshotKey(secret, entry.line);
          batch.localSnapshots.push({ kind: "tool_call", snapshotKey: lineageKey });
          const inherited = source.parentSourceKey !== null
            && workspace.hasInheritedSnapshot(source.sourceKey, "tool_call", lineageKey);
          if (inherited) {
            batch.diagnostics.add("replayed_tool_calls_skipped");
          } else {
            for (const observation of observations) {
              state.pendingToolCounts[safeToolCountFieldForScannerToolClass(observation.toolClass)] += 1;
            }
          }
        }
      } else if (record.type === "event_msg" && record.payload?.type === "token_count") {
        const info = record.payload?.info;
        const totalPresence = tokenComponentPresence(info?.total_token_usage);
        const lastPresence = tokenComponentPresence(info?.last_token_usage);
        const total = normalizeTokenUsage(info?.total_token_usage);
        const last = normalizeTokenUsage(info?.last_token_usage);
        const malformedInfo = info !== null && info !== undefined
          && (typeof info !== "object" || Array.isArray(info));
        if (malformedInfo
            || (info?.total_token_usage !== null
              && info?.total_token_usage !== undefined && total === null)
            || (info?.last_token_usage !== null
              && info?.last_token_usage !== undefined && last === null)) {
          batch.diagnostics.add("malformed_usage_records");
          contentInvalid();
        }
        const cumulativeKey = snapshotKey(secret, total, last);
        if (cumulativeKey) batch.localSnapshots.push({ kind: "cumulative_usage", snapshotKey: cumulativeKey });
        if (source.parentSourceKey !== null && cumulativeKey
            && workspace.hasInheritedSnapshot(source.sourceKey, "cumulative_usage", cumulativeKey)) {
          if (total) {
            rebaseTotals(total, totalPresence);
          }
          if (timestampMs >= bounds.startMs && timestampMs <= bounds.endMs) {
            batch.diagnostics.add("fork_replay_events_skipped");
          }
        } else if (timestampMs < bounds.startMs || timestampMs > bounds.endMs) {
          if (total) {
            rebaseTotals(total, totalPresence);
          }
        } else if (source.isFork && state.currentModel === null) {
          if (total) {
            rebaseTotals(total, totalPresence);
          }
          batch.diagnostics.add("unattributed_fork_replay_events_skipped");
        } else {
          const windows = canonicalRateLimitWindows(record.payload?.rate_limits);
          if (record.payload?.rate_limits === null || record.payload?.rate_limits === undefined) {
            batch.diagnostics.add("missing_rate_limit_records");
          } else if (windows.length === 0) {
            batch.diagnostics.add("malformed_rate_limit_records");
            contentInvalid();
          }
          for (const window of windows) {
            addRecord(batch, "quotaSnapshot", normalizeCodexQuotaSnapshot(secret, {
              timestamp: record.timestamp,
              timestampMs,
              window,
              surfaceClassification: source.rolloutInfo.lineage.surfaceClassification,
              sourceScopeId,
              sourceRecordOrdinal: entry.lineOrdinal,
            }), resourceGuard);
          }
          let usage = null;
          let usagePresence = null;
          if (total) {
            const first = state.previousTotals === null;
            const regressed = !first
              && total.total_tokens < state.previousTotals.total_tokens;
            const delta = subtractUsage(total, state.previousTotals);
            const deltaPresence = deltaComponentPresence(totalPresence, state.previousTotalsPresence);
            const chargePerTurnOnly = state.reAnchored;
            state.previousTotals = total;
            state.previousTotalsPresence = totalPresence;
            if (regressed) {
              state.reAnchored = true;
              if (last && last.total_tokens > 0) {
                usage = last;
                usagePresence = lastPresence;
              }
            } else if (first) {
              usage = last ?? delta;
              usagePresence = last ? lastPresence : deltaPresence;
            } else if (delta.total_tokens > 0) {
              if (last && sameUsage(last, delta)) {
                usage = last;
                usagePresence = lastPresence;
              } else if (last && (chargePerTurnOnly
                  || delta.total_tokens > last.total_tokens + 16)) {
                usage = last;
                usagePresence = lastPresence;
              } else {
                usage = delta;
                usagePresence = deltaPresence;
                // Retained in parser arithmetic but not part of the reviewed
                  // export diagnostic registry in telemetry v0.1.
              }
              state.reAnchored = false;
            } else if (last && last.total_tokens > 0) {
              // Legacy safe export does not publish this internal diagnostic.
            }
          } else {
            usage = last;
            usagePresence = lastPresence;
            batch.diagnostics.add("last_only_events");
          }
          if (usage && (usage.input_tokens !== 0 || usage.output_tokens !== 0)) {
            const explicitModel = record.payload?.model ?? info?.model;
            const modelDeclaration = explicitModel !== null && explicitModel !== undefined
              ? safeExportModelDeclaration(secret, explicitModel)
              : (state.currentModel ?? safeExportModelDeclaration(secret, null));
            const tier = workspace.sourceTierAt(source.sourceKey, timestampMs);
            addRecord(batch, "usageEvent", normalizeCodexUsageEvent(secret, {
              timestamp: record.timestamp,
              modelDeclaration,
              raw: usage,
              rawAvailability: usagePresence,
              components: canonicalComponents(usage),
              componentAvailability: canonicalComponentAvailability(usagePresence, usage),
              tierSemantics: tierSemantics(tier),
              surfaceClassification: source.rolloutInfo.lineage.surfaceClassification,
              sourceScopeId,
              sourceRecordOrdinal: entry.lineOrdinal,
            }, state.pendingToolCounts), resourceGuard);
            state.pendingToolCounts = createEmptySafeToolClassCounts();
          }
        }
      }
      if (lineCounts.lines >= maximumLinesPerBatch) await flush();
    }

    const unattached = Object.values(state.pendingToolCounts).reduce((sum, count) => sum + count, 0);
    if (unattached > 0) batch.diagnostics.add("unattached_tool_calls", unattached);
    state.pendingToolCounts = createEmptySafeToolClassCounts();
    cursor = { phase: "complete", byteOffset: source.prefixBytes, lineOrdinal: cursor.lineOrdinal };
    await flush();
  } finally {
    try {
      await verifyCodexExportSourceHandle(source, handle, { resourceGuard });
    } finally {
      await handle.close().catch(() => {});
    }
  }
}

/**
 * Advance all frozen Codex sources from their durable checkpoints. No source
 * content is returned or stored; the only durable output is the reviewed safe
 * record contract and privacy-safe parser indexes.
 */
async function populateCheckpointedCodexSources({
  workspace,
  sourcePlan,
  secret,
  resourceGuard,
  failpoint = async () => {},
  maximumLinesPerBatch = DEFAULT_CHECKPOINT_LINES_PER_BATCH,
} = {}) {
  if (!workspace || !sourcePlan || !secret || !resourceGuard
      || !Number.isSafeInteger(maximumLinesPerBatch) || maximumLinesPerBatch < 1
      || maximumLinesPerBatch > DEFAULT_CHECKPOINT_LINES_PER_BATCH) {
    throw new TypeError("Checkpointed Codex source scan requires bounded inputs");
  }
  const sourceByKey = new Map(sourcePlan.sources.map((source) => [source.sourceKey, source]));
  try {
    for (;;) {
      const checkpoint = workspace.loadNextSourceCheckpoint();
      if (checkpoint === null) break;
      const source = sourceByKey.get(checkpoint.sourceKey);
      if (!source) throw new ExportSourcePlanError("source_changed");
      if (checkpoint.phase === "tier_scan") {
        await scanTierPhase({ workspace, source, checkpoint, resourceGuard, failpoint, maximumLinesPerBatch });
      } else if (checkpoint.phase === "record_scan") {
        await scanRecordPhase({
          workspace,
          source,
          checkpoint,
          secret,
          bounds: {
            startMs: Date.parse(sourcePlan.startAt),
            endMs: Date.parse(sourcePlan.endAt),
          },
          resourceGuard,
          failpoint,
          maximumLinesPerBatch,
        });
      }
    }
  } catch (error) {
    if (error instanceof ExportSourcePlanError
        || (error instanceof ExportWorkspaceError && error.code === "export_workspace_database_changed")) {
      workspace.markPoisoned("source_integrity");
    }
    throw error;
  }
}

return Object.freeze({
  CODEX_CHECKPOINT_SCAN_VERSION,
  DEFAULT_CHECKPOINT_LINES_PER_BATCH,
  populateCheckpointedCodexSources,
});
}
