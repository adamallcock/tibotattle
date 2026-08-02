import {
  createSnapshotLineage,
  throwIfAborted,
  validAbortSignal,
} from "./log-normalization.js";
import { classifySessionSurface } from "./surface-classification.js";

export function createCodexLogIngestion({
  parserVersion,
  sources,
  parser,
}) {
  return async function scanCodexLogEvents({
    startAt,
    endAt,
    codexHome,
    onUsage = () => {},
    onRateLimitSnapshot,
    onToolCall,
    excludeSessionIds = [],
    activeTaskRecencyMs = null,
    sourceScopeForRollout = null,
    resourceGuard = null,
    signal = null,
    rolloutInfos: suppliedRolloutInfos = null,
    openRolloutSource = null,
    verifyRolloutSource = null,
  }) {
    const startMs = new Date(startAt).getTime();
    const endMs = new Date(endAt).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
      throw new Error("startAt and endAt must define a valid chronological interval");
    }
    const activeRecencyMs = Number.isFinite(activeTaskRecencyMs) && activeTaskRecencyMs >= 0
      ? activeTaskRecencyMs
      : endMs - startMs;
    const activeCutoffMs = endMs - activeRecencyMs;
    if (suppliedRolloutInfos !== null && !Array.isArray(suppliedRolloutInfos)) {
      throw new TypeError("rolloutInfos must be an array or null");
    }
    if (!validAbortSignal(signal)) throw new TypeError("signal must be an AbortSignal or null");
    throwIfAborted(signal);
    const rolloutInfos = suppliedRolloutInfos ?? await sources.discoverCodexRolloutInfos({
      codexHome,
      startAt: new Date(Math.min(startMs, activeCutoffMs)).toISOString(),
      endAt,
      resourceGuard,
      signal,
    });
    resourceGuard?.observeSourcePlan(
      rolloutInfos.length,
      rolloutInfos.reduce((sum, info) => sum + info.size, 0),
    );
    throwIfAborted(signal);
    const excludedSessions = new Set(excludeSessionIds.filter((value) => typeof value === "string" && value.length > 0));
    const seenEvents = new Set();
    const seenToolCalls = new Set();
    const diagnostics = {
      filesScanned: rolloutInfos.length,
      lineageParentsMissing: 0,
      malformedLines: 0,
      malformedTimestamps: 0,
      malformedUsageRecords: 0,
      missingRateLimitRecords: 0,
      malformedRateLimitRecords: 0,
      rateLimitSnapshots: 0,
      contradictedLeadingSnapshotsSkipped: 0,
      lastVsCumulativeMismatches: 0,
      duplicateSnapshotsSkipped: 0,
      replayedEventsSkipped: 0,
      forkReplayEventsSkipped: 0,
      unattributedForkReplayEventsSkipped: 0,
      replayedToolCallsSkipped: 0,
      lastOnlyEvents: 0,
      excludedRollouts: 0,
      malformedTaskEvents: 0,
      activeTaskRolloutsAtEnd: 0,
      tierSettingEvents: 0,
      malformedTierSettingEvents: 0,
      tierSettingCounts: {},
      rolloutsBySurface: {},
      rolloutsByThreadSource: {},
      rolloutsByAgentScope: {},
    };
    const toolCallsByClass = {};
    const toolObservationsBySource = {};
    const serverBillableUnits = {};
    const snapshotsBySession = new Map();
    diagnostics.sourceProvenance = sources.summarizeCodexRolloutSources(rolloutInfos, { endAt });
    for (let sourceRolloutOrdinal = 0; sourceRolloutOrdinal < rolloutInfos.length; sourceRolloutOrdinal += 1) {
      throwIfAborted(signal);
      const info = rolloutInfos[sourceRolloutOrdinal];
      const activeSnapshot = typeof openRolloutSource !== "function" && info.location === "active"
        ? await sources.openActiveRolloutSnapshot(info, endMs, resourceGuard)
        : null;
      const openedSource = typeof openRolloutSource === "function"
        ? await openRolloutSource(info)
        : activeSnapshot?.handle ?? null;
      const sourceInput = openedSource ?? info.path;
      try {
        const classification = info.lineage.surfaceClassification ?? classifySessionSurface(null);
        diagnostics.rolloutsBySurface[classification.surface] = (diagnostics.rolloutsBySurface[classification.surface] ?? 0) + 1;
        diagnostics.rolloutsByThreadSource[classification.threadSource] = (diagnostics.rolloutsByThreadSource[classification.threadSource] ?? 0) + 1;
        diagnostics.rolloutsByAgentScope[classification.agentScope] = (diagnostics.rolloutsByAgentScope[classification.agentScope] ?? 0) + 1;
        if (info.lineage.sessionId && excludedSessions.has(info.lineage.sessionId)) {
          const inheritedSnapshots = info.lineage.parentId
            ? snapshotsBySession.get(info.lineage.parentId)
            : null;
          const rolloutSnapshots = createSnapshotLineage(inheritedSnapshots ?? null);
          await parser.collectCumulativeSnapshotKeys(
            sourceInput,
            rolloutSnapshots,
            resourceGuard,
            info.size,
            signal,
          );
          snapshotsBySession.set(info.lineage.sessionId, rolloutSnapshots);
          diagnostics.excludedRollouts += 1;
          continue;
        }
        const inheritedSnapshots = info.lineage.parentId
          ? snapshotsBySession.get(info.lineage.parentId)
          : null;
        if (info.lineage.isFork && !inheritedSnapshots) diagnostics.lineageParentsMissing += 1;
        const rolloutSnapshots = createSnapshotLineage(inheritedSnapshots ?? null);
        const sourceScopeId = typeof sourceScopeForRollout === "function"
          ? sourceScopeForRollout(info.lineage.sessionId ?? info.rolloutKey)
          : null;
        const sourceDedupeScope = info.lineage.sessionId ?? info.rolloutKey;
        if (sourceScopeId !== null && (typeof sourceScopeId !== "string" || !/^session:v1:[a-f0-9]{64}$/.test(sourceScopeId))) {
          throw new Error("sourceScopeForRollout must return a versioned privacy-safe pseudonym or null");
        }
        const parsed = await parser.parseRollout(sourceInput, {
          forked: info.lineage.isFork,
          inheritedSnapshots: inheritedSnapshots ?? createSnapshotLineage(),
          rolloutSnapshots,
          startMs,
          endMs,
          seenEvents,
          seenToolCalls,
          onUsage,
          onRateLimitSnapshot,
          onToolCall,
          sourceRolloutOrdinal,
          diagnostics,
          toolCallsByClass,
          toolObservationsBySource,
          serverBillableUnits,
          surfaceClassification: classification,
          sourceScopeId,
          sourceDedupeScope,
          resourceGuard,
          maximumTotalBytes: info.size,
          signal,
        });
        if (parsed.openTasksAtEnd > 0 && info.mtimeMs >= activeCutoffMs) diagnostics.activeTaskRolloutsAtEnd += 1;
        if (info.lineage.sessionId) snapshotsBySession.set(info.lineage.sessionId, rolloutSnapshots);
      } finally {
        try {
          if (activeSnapshot) {
            await sources.verifyActiveRolloutSnapshot(info, activeSnapshot, endMs, resourceGuard);
          } else if (openedSource && typeof verifyRolloutSource === "function") {
            await verifyRolloutSource(info, openedSource);
          }
        } finally {
          await openedSource?.close?.().catch(() => {});
        }
      }
    }
    throwIfAborted(signal);
    return {
      parserVersion,
      diagnostics,
      toolCallsByClass,
      toolObservationsBySource,
      serverBillableUnits,
    };
  };
}
