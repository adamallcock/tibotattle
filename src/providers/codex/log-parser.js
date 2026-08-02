import {
  CODEX_LOG_RELEVANT_LINE_NEEDLES,
  canonicalComponentAvailability,
  canonicalComponents,
  canonicalRateLimitWindows,
  createLeadingRateLimitGate,
  cumulativeSnapshotKey,
  deltaComponentPresence,
  extractToolObservations,
  normalizeTokenUsage,
  sameUsage,
  subtractUsage,
  throwIfAborted,
  tokenComponentPresence,
} from "./log-normalization.js";
import { normalizeProviderTier } from "./tier-normalization.js";

export function createCodexLogParser({ lineReader }) {
  function boundedScannerLines(
    source,
    resourceGuard,
    maximumTotalBytes = Number.POSITIVE_INFINITY,
    signal = null,
  ) {
    return lineReader.readBoundedUtf8Lines(source, {
      maximumLineBytes: resourceGuard?.limits.maximumLineBytes,
      resourceGuard,
      oversizedIrrelevantNeedles: CODEX_LOG_RELEVANT_LINE_NEEDLES,
      maximumTotalBytes,
      signal,
    });
  }

  function addToolObservation(target, bySource, serverUnits, observation) {
    target[observation.toolClass] = (target[observation.toolClass] ?? 0) + 1;
    const sourceCounts = bySource[observation.sourceKind] ??= {};
    sourceCounts[observation.toolClass] = (sourceCounts[observation.toolClass] ?? 0) + 1;
    if (observation.serverBillableUnit) {
      serverUnits[observation.serverBillableUnit] = (serverUnits[observation.serverBillableUnit] ?? 0) + 1;
    }
  }

  async function collectCumulativeSnapshotKeys(
    source,
    target,
    resourceGuard = null,
    maximumTotalBytes = Number.POSITIVE_INFINITY,
    signal = null,
  ) {
    for await (const line of boundedScannerLines(
      source,
      resourceGuard,
      maximumTotalBytes,
      signal,
    )) {
      throwIfAborted(signal);
      if (line === null) continue;
      if (!line.includes('"token_count"')) continue;
      try {
        const record = JSON.parse(line);
        if (record.type !== "event_msg" || record.payload?.type !== "token_count") continue;
        const total = normalizeTokenUsage(record.payload?.info?.total_token_usage);
        const last = normalizeTokenUsage(record.payload?.info?.last_token_usage);
        const key = cumulativeSnapshotKey(total, last);
        if (key) target.add(key);
      } catch {
        // Excluded rollouts support in-memory lineage only; their parse errors are not emitted.
      }
    }
  }

  async function collectTierTimeline(
    source,
    diagnostics,
    resourceGuard = null,
    maximumTotalBytes = Number.POSITIVE_INFINITY,
    signal = null,
  ) {
    const timeline = [];
    let ordinal = 0;
    for await (const line of boundedScannerLines(
      source,
      resourceGuard,
      maximumTotalBytes,
      signal,
    )) {
      throwIfAborted(signal);
      if (line === null) continue;
      ordinal += 1;
      if (!line.includes('"type":"thread_settings_applied"')) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type !== "event_msg" || record.payload?.type !== "thread_settings_applied") continue;
      const timestampMs = Date.parse(record.timestamp);
      if (!Number.isFinite(timestampMs)) continue;
      const rawTier = record.payload?.thread_settings?.service_tier;
      if (rawTier !== null && typeof rawTier !== "string") {
        diagnostics.malformedTierSettingEvents += 1;
        continue;
      }
      const normalized = normalizeProviderTier(rawTier, {
        billingSurface: "chatgpt_subscription",
        tierSource: "rollout_thread_settings",
        tierObservedAt: record.timestamp,
      });
      diagnostics.tierSettingEvents += 1;
      diagnostics.tierSettingCounts[normalized.codexSpeedMode] = (diagnostics.tierSettingCounts[normalized.codexSpeedMode] ?? 0) + 1;
      timeline.push({ ordinal, rawTier, timestamp: record.timestamp, timestampMs });
    }
    return timeline.sort((left, right) => left.timestampMs - right.timestampMs || left.ordinal - right.ordinal);
  }

  function tierAt(timeline, timestampMs) {
    let lower = 0;
    let upper = timeline.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (timeline[middle].timestampMs <= timestampMs) lower = middle + 1;
      else upper = middle;
    }
    return lower === 0 ? null : timeline[lower - 1];
  }

  async function parseRollout(source, {
    forked,
    inheritedSnapshots,
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
    surfaceClassification,
    sourceScopeId,
    sourceDedupeScope,
    resourceGuard,
    maximumTotalBytes = Number.POSITIVE_INFINITY,
    signal = null,
  }) {
    const tierTimeline = await collectTierTimeline(
      source,
      diagnostics,
      resourceGuard,
      maximumTotalBytes,
      signal,
    );
    let currentModel = null;
    let previousTotals = null;
    let previousTotalsPresence = null;
    const openTaskIds = new Set();
    let sourceRecordOrdinal = 0;
    const leadingRateLimitGate = createLeadingRateLimitGate();

    // Whether a source's leading reading is trustworthy is a property of the
    // source, not of the requested interval, so readings outside the interval
    // are offered to the gate with no emissible payload. The durable index
    // decides the same way over the same records.
    async function applyGateDecision(decision) {
      for (const withheld of decision.withheld) {
        if (withheld !== null) diagnostics.contradictedLeadingSnapshotsSkipped += 1;
      }
      for (const snapshot of decision.released) {
        if (snapshot === null) continue;
        await onRateLimitSnapshot?.(snapshot);
        diagnostics.rateLimitSnapshots += 1;
      }
    }

    async function gateUnobservedRateLimits(payload, timestampMs) {
      for (const window of canonicalRateLimitWindows(payload?.rate_limits)) {
        await applyGateDecision(
          leadingRateLimitGate.offer(window, timestampMs, null),
        );
      }
    }

    for await (const line of boundedScannerLines(
      source,
      resourceGuard,
      maximumTotalBytes,
      signal,
    )) {
      throwIfAborted(signal);
      sourceRecordOrdinal += 1;
      if (line === null) continue;
      if (!CODEX_LOG_RELEVANT_LINE_NEEDLES.some((needle) => line.includes(needle))) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        diagnostics.malformedLines += 1;
        continue;
      }
      const timestampMs = Date.parse(record.timestamp);
      if (!Number.isFinite(timestampMs)) {
        diagnostics.malformedTimestamps += 1;
        continue;
      }

      if (record.type === "turn_context") {
        if (typeof record.payload?.model === "string") currentModel = record.payload.model;
        continue;
      }

      if (record.type === "event_msg" && record.payload?.type === "thread_settings_applied") {
        continue;
      }

      if (record.type === "event_msg" && (record.payload?.type === "task_started" || record.payload?.type === "task_complete")) {
        if (timestampMs > endMs) continue;
        const turnId = record.payload?.turn_id;
        if (typeof turnId !== "string" || turnId.length === 0) {
          diagnostics.malformedTaskEvents += 1;
        } else if (record.payload.type === "task_started") {
          openTaskIds.add(turnId);
        } else {
          openTaskIds.delete(turnId);
        }
        continue;
      }

      if (record.type === "response_item") {
        const observations = extractToolObservations(record.payload);
        if (observations.length > 0) {
          if (timestampMs < startMs || timestampMs > endMs) continue;
          const stableId = record.payload?.call_id ?? record.payload?.id;
          const toolKey = [sourceDedupeScope, sourceRecordOrdinal, stableId ?? "no-provider-id", record.payload?.type].join("|");
          if (seenToolCalls.has(toolKey)) {
            diagnostics.replayedToolCallsSkipped += 1;
            continue;
          }
          seenToolCalls.add(toolKey);
          for (const observation of observations) {
            addToolObservation(toolCallsByClass, toolObservationsBySource, serverBillableUnits, observation);
            await onToolCall?.({
              timestamp: record.timestamp,
              timestampMs,
              model: currentModel ?? "unknown",
              surfaceClassification,
              ...(sourceScopeId ? { sourceScopeId } : {}),
              sourceRecordOrdinal,
              ...observation,
            });
          }
        }
        continue;
      }
      if (record.type !== "event_msg" || record.payload?.type !== "token_count") continue;

      const info = record.payload?.info;
      const totalPresence = tokenComponentPresence(info?.total_token_usage);
      const lastPresence = tokenComponentPresence(info?.last_token_usage);
      const total = normalizeTokenUsage(info?.total_token_usage);
      const last = normalizeTokenUsage(info?.last_token_usage);
      if ((info?.total_token_usage && !total) || (info?.last_token_usage && !last)) {
        diagnostics.malformedUsageRecords += 1;
      }
      const cumulativeKey = cumulativeSnapshotKey(total, last);
      if (cumulativeKey) rolloutSnapshots.add(cumulativeKey);
      if (forked && cumulativeKey && inheritedSnapshots.has(cumulativeKey)) {
        if (total) {
          previousTotals = total;
          previousTotalsPresence = totalPresence;
        }
        if (timestampMs >= startMs && timestampMs <= endMs) diagnostics.forkReplayEventsSkipped += 1;
        continue;
      }
      if (timestampMs < startMs || timestampMs > endMs) {
        if (total) {
          previousTotals = total;
          previousTotalsPresence = totalPresence;
        }
        await gateUnobservedRateLimits(record.payload, timestampMs);
        continue;
      }
      if (forked && currentModel === null) {
        if (total) {
          previousTotals = total;
          previousTotalsPresence = totalPresence;
        }
        diagnostics.unattributedForkReplayEventsSkipped += 1;
        continue;
      }
      const rateLimitWindows = canonicalRateLimitWindows(record.payload?.rate_limits);
      if (record.payload?.rate_limits === null || record.payload?.rate_limits === undefined) {
        diagnostics.missingRateLimitRecords += 1;
      } else if (rateLimitWindows.length === 0) {
        diagnostics.malformedRateLimitRecords += 1;
      }
      for (const window of rateLimitWindows) {
        await applyGateDecision(leadingRateLimitGate.offer(window, timestampMs, {
          timestamp: record.timestamp,
          timestampMs,
          window,
          surfaceClassification,
          ...(sourceScopeId ? { sourceScopeId } : {}),
          sourceRecordOrdinal,
        }));
      }
      let usage = null;
      let usagePresence = null;
      if (total) {
        const delta = subtractUsage(total, previousTotals);
        const deltaPresence = deltaComponentPresence(totalPresence, previousTotalsPresence);
        const firstCumulativeRecord = previousTotals === null;
        previousTotals = total;
        previousTotalsPresence = totalPresence;
        if (firstCumulativeRecord) {
          usage = last ?? delta;
          usagePresence = last ? lastPresence : deltaPresence;
        } else if (delta.total_tokens > 0) {
          if (last && sameUsage(last, delta)) {
            usage = last;
            usagePresence = lastPresence;
          } else {
            usage = delta;
            usagePresence = deltaPresence;
            if (last) diagnostics.lastVsCumulativeMismatches += 1;
          }
        } else if (last && last.total_tokens > 0) {
          diagnostics.duplicateSnapshotsSkipped += 1;
        }
      } else {
        usage = last;
        usagePresence = lastPresence;
        diagnostics.lastOnlyEvents += 1;
      }
      if (!usage || (usage.input_tokens === 0 && usage.output_tokens === 0)) continue;

      const model = record.payload?.model ?? info?.model ?? currentModel ?? "unknown";
      const eventKey = [sourceDedupeScope, sourceRecordOrdinal, "token_count"].join("|");
      if (seenEvents.has(eventKey)) {
        diagnostics.replayedEventsSkipped += 1;
        continue;
      }
      seenEvents.add(eventKey);
      const effectiveTier = tierAt(tierTimeline, timestampMs);
      await onUsage({
        timestamp: record.timestamp,
        model,
        raw: usage,
        rawAvailability: usagePresence,
        components: canonicalComponents(usage),
        componentAvailability: canonicalComponentAvailability(usagePresence, usage),
        tierSemantics: normalizeProviderTier(effectiveTier?.rawTier ?? null, {
          billingSurface: "chatgpt_subscription",
          tierSource: effectiveTier ? "rollout_thread_settings" : "unobserved",
          tierObservedAt: effectiveTier?.timestamp ?? null,
        }),
        surfaceClassification,
        sourceRolloutOrdinal,
        ...(sourceScopeId ? { sourceScopeId } : {}),
        sourceRecordOrdinal,
      });
    }
    await applyGateDecision({
      withheld: [],
      released: leadingRateLimitGate.flush(),
    });
    return { openTasksAtEnd: openTaskIds.size };
  }

  return {
    collectCumulativeSnapshotKeys,
    parseRollout,
  };
}
