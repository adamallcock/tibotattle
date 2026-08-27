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
    requireCompleteDiscovery = false,
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
    if (typeof requireCompleteDiscovery !== "boolean") {
      throw new TypeError("requireCompleteDiscovery must be a boolean");
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
    const discoveryReceipt = sources.codexRolloutDiscoveryReceipt(rolloutInfos);
    if (requireCompleteDiscovery && discoveryReceipt.status === "partial") {
      const reason = Object.keys(discoveryReceipt.reasonCounts).sort()[0]
        ?? "codex_rollout_sources_quarantined";
      const error = new Error(
        "Codex rollout coverage is partial; local metadata export stopped",
      );
      error.name = "CodexRolloutCoverageError";
      error.code = reason;
      error.coverage = Object.freeze({
        skippedSourceCount: Number(discoveryReceipt.skippedSourceCount ?? 0),
        skippedSourceBytes: Number(discoveryReceipt.skippedSourceBytes ?? 0),
        skippedThreadCount: Number(discoveryReceipt.skippedThreadCount ?? 0),
        reasonCounts: Object.freeze({ ...discoveryReceipt.reasonCounts }),
      });
      throw error;
    }
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
      malformedAccountingRecords: 0,
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
    const replayParentSessionIds = new Set(rolloutInfos
      .filter((info) => info.lineage?.isInlineFork === true)
      .map((info) => info.lineage?.parentId)
      .filter((value) => typeof value === "string" && value.length > 0));
    const discardedSnapshots = Object.freeze({
      add() { return this; },
      has() { return false; },
    });
    diagnostics.sourceProvenance = sources.summarizeCodexRolloutSources(rolloutInfos, { endAt });
    if (requireCompleteDiscovery) {
      for (const info of rolloutInfos) {
        await sources.assertCompleteRolloutTail(info, signal);
      }
    }

    async function withRolloutInput(info, operation) {
      const activeSnapshot = typeof openRolloutSource !== "function"
          && info.location === "active"
        ? await sources.openActiveRolloutSnapshot(
          info,
          endMs,
          resourceGuard,
          signal,
        )
        : null;
      const openedSource = typeof openRolloutSource === "function"
        ? await openRolloutSource(info)
        : activeSnapshot?.handle ?? null;
      const sourceInput = openedSource ?? info.path;
      try {
        return await operation(sourceInput);
      } finally {
        try {
          if (activeSnapshot) {
            await sources.verifyActiveRolloutSnapshot(
              info,
              activeSnapshot,
              endMs,
              resourceGuard,
              signal,
            );
          } else if (openedSource
              && typeof verifyRolloutSource === "function") {
            await verifyRolloutSource(info, openedSource);
          }
        } finally {
          await openedSource?.close?.().catch(() => {});
        }
      }
    }

    const byRolloutId = new Map(rolloutInfos
      .filter((info) => typeof info.rolloutId === "string")
      .map((info) => [info.rolloutId, info]));
    const historySeedCache = new Map();
    const resolvingHistorySeeds = new Set();
    async function resolveHistorySeed(info, { includeSnapshots = false } = {}) {
      const chain = [];
      const ownedKeys = [];
      const localKeys = new Set();
      let current = info;
      let inherited = null;
      try {
        for (;;) {
          const base = current.lineage?.historyBase ?? null;
          if (current.lineage?.historyMode !== "paginated" || base === null) {
            inherited = null;
            break;
          }
          const key = `${base.rolloutId}\0${base.endByteOffset}\0${base.endOrdinalExclusive}`
            + `\0${includeSnapshots ? "snapshots" : "state"}`;
          if (historySeedCache.has(key)) {
            inherited = historySeedCache.get(key);
            break;
          }
          if (localKeys.has(key) || resolvingHistorySeeds.has(key)) {
            const error = new Error("Codex rollout lineage is invalid");
            error.code = "codex_rollout_lineage_invalid";
            throw error;
          }
          const parent = byRolloutId.get(base.rolloutId);
          if (parent === undefined) {
            const error = new Error("Codex rollout lineage is invalid");
            error.code = "codex_rollout_lineage_invalid";
            throw error;
          }
          localKeys.add(key);
          resolvingHistorySeeds.add(key);
          ownedKeys.push(key);
          chain.push({ base, key, parent });
          current = parent;
        }
        for (let index = chain.length - 1; index >= 0; index -= 1) {
          const { base, key, parent } = chain[index];
          inherited = await withRolloutInput(parent, (sourceInput) => (
            parser.collectHistorySeed(sourceInput, {
              seedModel: inherited?.model ?? null,
              seedTotals: inherited?.totals ?? null,
              seedTotalsPresence: inherited?.totalsPresence ?? null,
              seedTier: inherited?.tier ?? null,
              seedSnapshots: inherited?.snapshots ?? null,
              includeSnapshots,
              resourceGuard,
              maximumTotalBytes: base.endByteOffset,
              signal,
            })
          ));
          historySeedCache.set(key, inherited);
        }
        return inherited;
      } finally {
        for (const key of ownedKeys) resolvingHistorySeeds.delete(key);
      }
    }

    for (let sourceRolloutOrdinal = 0; sourceRolloutOrdinal < rolloutInfos.length; sourceRolloutOrdinal += 1) {
      throwIfAborted(signal);
      const info = rolloutInfos[sourceRolloutOrdinal];
      const classification = info.lineage.surfaceClassification
        ?? classifySessionSurface(null);
      diagnostics.rolloutsBySurface[classification.surface]
        = (diagnostics.rolloutsBySurface[classification.surface] ?? 0) + 1;
      diagnostics.rolloutsByThreadSource[classification.threadSource]
        = (diagnostics.rolloutsByThreadSource[classification.threadSource]
          ?? 0) + 1;
      diagnostics.rolloutsByAgentScope[classification.agentScope]
        = (diagnostics.rolloutsByAgentScope[classification.agentScope] ?? 0) + 1;
      const collectOwnSnapshots = replayParentSessionIds.has(
        info.lineage?.sessionId,
      );
      const historySeed = await resolveHistorySeed(info, {
        includeSnapshots: collectOwnSnapshots,
      });
      const inheritedSnapshots = info.lineage.isInlineFork === true
          && info.lineage.parentId
        ? snapshotsBySession.get(info.lineage.parentId)
        : null;
      if (info.lineage.isInlineFork === true && !inheritedSnapshots) {
        diagnostics.lineageParentsMissing += 1;
      }
      const rolloutSnapshots = collectOwnSnapshots
        ? createSnapshotLineage(inheritedSnapshots ?? null)
        : discardedSnapshots;
      for (const snapshot of historySeed?.snapshots ?? []) {
        rolloutSnapshots.add(snapshot);
      }
      if (info.lineage.sessionId
          && excludedSessions.has(info.lineage.sessionId)) {
        if (collectOwnSnapshots) {
          await withRolloutInput(info, async (sourceInput) => {
            await parser.collectCumulativeSnapshotKeys(
              sourceInput,
              rolloutSnapshots,
              resourceGuard,
              info.size,
              signal,
            );
          });
          snapshotsBySession.set(info.lineage.sessionId, rolloutSnapshots);
        }
        diagnostics.excludedRollouts += 1;
        continue;
      }
      const sourceScopeId = typeof sourceScopeForRollout === "function"
        ? sourceScopeForRollout(info.lineage.sessionId ?? info.rolloutKey)
        : null;
      // Record ordinals restart in every physical rollout generation. A
      // paginated continuation deliberately keeps the logical session id, so
      // session-scoped keys can collide with an older generation and silently
      // suppress valid replacement work. Discovery has already proved the
      // physical source identity globally unique (or quarantined its owners).
      const sourceDedupeScope = info.sourceIdentity
        ?? info.rolloutId
        ?? info.rolloutKey;
      if (sourceScopeId !== null
          && (typeof sourceScopeId !== "string"
            || !/^session:v1:[a-f0-9]{64}$/.test(sourceScopeId))) {
        throw new Error(
          "sourceScopeForRollout must return a versioned privacy-safe pseudonym or null",
        );
      }
      const parsed = await withRolloutInput(info, (sourceInput) => (
        parser.parseRollout(sourceInput, {
          forked: info.lineage.isInlineFork === true,
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
          seedModel: historySeed?.model ?? null,
          seedTotals: historySeed?.totals ?? null,
          seedTotalsPresence: historySeed?.totalsPresence ?? null,
          seedTier: historySeed?.tier ?? null,
          expectedSessionId: info.lineage?.sessionId ?? null,
        })
      ));
      if (parsed.openTasksAtEnd > 0 && info.mtimeMs >= activeCutoffMs) {
        diagnostics.activeTaskRolloutsAtEnd += 1;
      }
      if (collectOwnSnapshots && info.lineage.sessionId) {
        snapshotsBySession.set(info.lineage.sessionId, rolloutSnapshots);
      }
    }
    throwIfAborted(signal);
    if (requireCompleteDiscovery) {
      const invalidAccountingRecords = [
        diagnostics.malformedAccountingRecords,
        diagnostics.malformedUsageRecords,
        diagnostics.malformedRateLimitRecords,
      ].reduce((sum, count) => sum + Number(count ?? 0), 0);
      if (invalidAccountingRecords > 0) {
        const error = new Error(
          "Codex rollout accounting is malformed; complete scan stopped",
        );
        error.name = "CodexRolloutCoverageError";
        error.code = "codex_rollout_content_invalid";
        error.coverage = Object.freeze({ invalidAccountingRecords });
        throw error;
      }
    }
    return {
      parserVersion,
      discovery: {
        schemaVersion: discoveryReceipt.schemaVersion,
        status: discoveryReceipt.status,
        acceptedSourceCount: discoveryReceipt.acceptedSourceCount,
        acceptedSourceBytes: discoveryReceipt.acceptedSourceBytes,
        skippedSourceCount: discoveryReceipt.skippedSourceCount,
        skippedSourceBytes: discoveryReceipt.skippedSourceBytes,
        skippedThreadCount: discoveryReceipt.skippedThreadCount,
        reasonCounts: { ...discoveryReceipt.reasonCounts },
      },
      diagnostics,
      toolCallsByClass,
      toolObservationsBySource,
      serverBillableUnits,
    };
  };
}
