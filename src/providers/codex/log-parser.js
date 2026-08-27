import {
  CODEX_LOG_RELEVANT_LINE_NEEDLES,
  canonicalComponentAvailability,
  canonicalComponents,
  canonicalRateLimitSnapshot,
  canonicalRateLimitWindows,
  codexSessionMetaIdentity,
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

// Tolerance when deciding that a cumulative delta "materially exceeds" the
// co-reported per-turn `last_token_usage`. The counters are exact integers
// written by one process, so this absorbs only rounding/reporting noise; it is
// deliberately not a plausibility band. Measured on the live corpus
// (~/.codex sessions from Jun 16), two cumulative streams interleave
// line-by-line within one rollout (~5.5236B vs ~5.5224B, both climbing) and
// counters reset mid-file; charging the inter-stream swing as a delta
// materialized ~378 phantom events totaling 13.02B tokens in one session,
// while `last_token_usage` stayed honest (125k-240k per turn) throughout.
// Restated in src/local-unified-index-extract.js; keep the two identical.
export const CUMULATIVE_DELTA_VS_LAST_TOLERANCE_TOKENS = 16;

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
      const timestampMs = typeof record?.timestamp === "string"
        ? Date.parse(record.timestamp)
        : Number.NaN;
      if (!Number.isFinite(timestampMs)) continue;
      const settings = record.payload?.thread_settings;
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
        diagnostics.malformedTierSettingEvents += 1;
        diagnostics.malformedAccountingRecords += 1;
        continue;
      }
      if (!Object.hasOwn(settings, "service_tier")) continue;
      const rawTier = settings.service_tier;
      if (rawTier !== null && typeof rawTier !== "string") {
        diagnostics.malformedTierSettingEvents += 1;
        diagnostics.malformedAccountingRecords += 1;
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

  function tierAt(timeline, timestampMs, inheritedTier = null) {
    let lower = 0;
    let upper = timeline.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (timeline[middle].timestampMs <= timestampMs) lower = middle + 1;
      else upper = middle;
    }
    return lower === 0 ? inheritedTier : timeline[lower - 1];
  }

  async function collectHistorySeed(source, {
    seedModel = null,
    seedTotals = null,
    seedTotalsPresence = null,
    seedTier = null,
    seedSnapshots = null,
    includeSnapshots = false,
    resourceGuard = null,
    maximumTotalBytes = Number.POSITIVE_INFINITY,
    signal = null,
  } = {}) {
    let model = seedModel;
    let totals = seedTotals;
    let totalsPresence = seedTotalsPresence;
    let ownTier = null;
    const snapshots = includeSnapshots
      ? new Set(seedSnapshots ?? [])
      : null;
    for await (const line of boundedScannerLines(
      source,
      resourceGuard,
      maximumTotalBytes,
      signal,
    )) {
      throwIfAborted(signal);
      if (line === null
          || !CODEX_LOG_RELEVANT_LINE_NEEDLES.some((needle) => (
            line.includes(needle)
          ))) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        // The source's ordinary complete scan owns diagnostics and rejection.
        continue;
      }
      const timestampMs = typeof record?.timestamp === "string"
        ? Date.parse(record.timestamp)
        : Number.NaN;
      if (!Number.isFinite(timestampMs)) continue;
      if (record.type === "turn_context") {
        if (typeof record.payload?.model === "string") {
          model = record.payload.model;
        }
        continue;
      }
      if (record.type !== "event_msg") continue;
      if (record.payload?.type === "thread_settings_applied") {
        const settings = record.payload?.thread_settings;
        if (!settings || typeof settings !== "object"
            || Array.isArray(settings)
            || !Object.hasOwn(settings, "service_tier")) continue;
        const rawTier = settings.service_tier;
        if (rawTier !== null && typeof rawTier !== "string") continue;
        if (ownTier === null || timestampMs >= ownTier.timestampMs) {
          ownTier = {
            rawTier,
            timestamp: record.timestamp,
            timestampMs,
            inherited: true,
          };
        }
        continue;
      }
      if (record.payload?.type !== "token_count") continue;
      const nextTotals = normalizeTokenUsage(
        record.payload?.info?.total_token_usage,
      );
      const last = normalizeTokenUsage(
        record.payload?.info?.last_token_usage,
      );
      const snapshot = cumulativeSnapshotKey(nextTotals, last);
      if (snapshot !== null && snapshots !== null) snapshots.add(snapshot);
      if (nextTotals !== null) {
        totals = nextTotals;
        totalsPresence = tokenComponentPresence(
          record.payload?.info?.total_token_usage,
        );
      }
    }
    return Object.freeze({
      model,
      totals,
      totalsPresence,
      tier: ownTier ?? seedTier,
      snapshots,
    });
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
    seedModel = null,
    seedTotals = null,
    seedTotalsPresence = null,
    seedTier = null,
    expectedSessionId = null,
  }) {
    const tierTimeline = await collectTierTimeline(
      source,
      diagnostics,
      resourceGuard,
      maximumTotalBytes,
      signal,
    );
    let currentModel = seedModel;
    let previousTotals = seedTotals;
    let previousTotalsPresence = seedTotalsPresence;
    // Set when the cumulative baseline was re-anchored on a counter
    // regression. Until the next positive swing is derived, the delta from
    // the new anchor may span two interleaved streams, so that swing charges
    // only its own per-turn value when one is present.
    let reAnchored = false;
    const openTaskIds = new Set();
    let sourceRecordOrdinal = 0;
    let sessionMetaSeen = false;
    const leadingRateLimitGate = createLeadingRateLimitGate();

    // Every movement of the cumulative baseline goes through here, including
    // the skip paths, so a regression observed outside the requested interval
    // or under a replayed fork prefix still counts as stream-switch evidence.
    function rebaseTotals(total, totalPresence) {
      if (previousTotals !== null
          && total.total_tokens < previousTotals.total_tokens) {
        reAnchored = true;
      }
      previousTotals = total;
      previousTotalsPresence = totalPresence;
    }

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
        if (line.includes('"turn_context"')
            || line.includes('"token_count"')
            || line.includes('"thread_settings_applied"')
            || line.includes('"type":"session_meta"')) {
          diagnostics.malformedAccountingRecords += 1;
        }
        continue;
      }
      if (record.type === "session_meta") {
        const sessionMetaId = codexSessionMetaIdentity(record.payload);
        if (sessionMetaId === null
            || (!sessionMetaSeen && expectedSessionId !== null
              && sessionMetaId !== expectedSessionId)) {
          diagnostics.malformedAccountingRecords += 1;
        }
        sessionMetaSeen = true;
        continue;
      }
      const timestampMs = typeof record?.timestamp === "string"
        ? Date.parse(record.timestamp)
        : Number.NaN;
      if (!Number.isFinite(timestampMs)) {
        diagnostics.malformedTimestamps += 1;
        if (record?.type === "turn_context"
            || (record?.type === "event_msg"
              && ["token_count", "thread_settings_applied"]
                .includes(record?.payload?.type))) {
          diagnostics.malformedAccountingRecords += 1;
        }
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
      const malformedInfo = info !== null && info !== undefined
        && (typeof info !== "object" || Array.isArray(info));
      if (malformedInfo
          || (info?.total_token_usage !== null
            && info?.total_token_usage !== undefined && total === null)
          || (info?.last_token_usage !== null
            && info?.last_token_usage !== undefined && last === null)) {
        diagnostics.malformedUsageRecords += 1;
      }
      const cumulativeKey = cumulativeSnapshotKey(total, last);
      if (cumulativeKey) rolloutSnapshots.add(cumulativeKey);
      if (forked && cumulativeKey && inheritedSnapshots.has(cumulativeKey)) {
        if (total) rebaseTotals(total, totalPresence);
        if (timestampMs >= startMs && timestampMs <= endMs) diagnostics.forkReplayEventsSkipped += 1;
        continue;
      }
      if (timestampMs < startMs || timestampMs > endMs) {
        if (total) rebaseTotals(total, totalPresence);
        await gateUnobservedRateLimits(record.payload, timestampMs);
        continue;
      }
      if (forked && currentModel === null) {
        if (total) rebaseTotals(total, totalPresence);
        diagnostics.unattributedForkReplayEventsSkipped += 1;
        continue;
      }
      const rateLimitSnapshot = canonicalRateLimitSnapshot(record.payload?.rate_limits);
      const rateLimitWindows = rateLimitSnapshot?.windows ?? [];
      if (record.payload?.rate_limits === null || record.payload?.rate_limits === undefined) {
        diagnostics.missingRateLimitRecords += 1;
      } else if (rateLimitSnapshot === null) {
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
        const firstCumulativeRecord = previousTotals === null;
        const regressed = !firstCumulativeRecord
          && total.total_tokens < previousTotals.total_tokens;
        const delta = subtractUsage(total, previousTotals);
        const deltaPresence = deltaComponentPresence(totalPresence, previousTotalsPresence);
        const chargePerTurnOnly = reAnchored;
        previousTotals = total;
        previousTotalsPresence = totalPresence;
        if (regressed) {
          // A cumulative counter never legitimately goes down: this is a
          // stream switch or a mid-file reset. Re-anchor without charging any
          // swing. The row itself is still a real turn when it co-reports a
          // per-turn value — measured on the live corpus, every regressed
          // row's total equals its own stream's prior total plus its own
          // `last_token_usage` — so that per-turn value, and only it, is
          // charged.
          reAnchored = true;
          diagnostics.cumulativeCounterRegressions =
            (diagnostics.cumulativeCounterRegressions ?? 0) + 1;
          if (last && last.total_tokens > 0) {
            usage = last;
            usagePresence = lastPresence;
          }
        } else if (firstCumulativeRecord) {
          usage = last ?? delta;
          usagePresence = last ? lastPresence : deltaPresence;
        } else if (delta.total_tokens > 0) {
          if (last && sameUsage(last, delta)) {
            usage = last;
            usagePresence = lastPresence;
          } else if (last && (chargePerTurnOnly
              || delta.total_tokens
                > last.total_tokens + CUMULATIVE_DELTA_VS_LAST_TOLERANCE_TOKENS)) {
            // The cumulative delta materially exceeds the co-reported
            // per-turn value (or the baseline was just re-anchored after a
            // regression): the excess is an inter-stream gap, not spend.
            // Charge the honest per-turn value.
            usage = last;
            usagePresence = lastPresence;
            diagnostics.lastVsCumulativeMismatches += 1;
            diagnostics.crossStreamDeltasSuppressed =
              (diagnostics.crossStreamDeltasSuppressed ?? 0) + 1;
          } else {
            usage = delta;
            usagePresence = deltaPresence;
            if (last) diagnostics.lastVsCumulativeMismatches += 1;
          }
          reAnchored = false;
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
      const effectiveTier = tierAt(tierTimeline, timestampMs, seedTier);
      await onUsage({
        timestamp: record.timestamp,
        model,
        raw: usage,
        rawAvailability: usagePresence,
        components: canonicalComponents(usage),
        componentAvailability: canonicalComponentAvailability(usagePresence, usage),
        tierSemantics: normalizeProviderTier(effectiveTier?.rawTier ?? null, {
          billingSurface: "chatgpt_subscription",
          tierSource: effectiveTier?.inherited === true
            ? "lineage_inherited"
            : effectiveTier ? "rollout_thread_settings" : "unobserved",
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
    collectHistorySeed,
    collectCumulativeSnapshotKeys,
    parseRollout,
  };
}
