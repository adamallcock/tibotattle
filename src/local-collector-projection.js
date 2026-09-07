import { declaredSpeedModeAt } from "./codex-speed-baseline.js";
import {
  addTimelineUsage,
  addUsageToPeriod,
  finalizeQuotaTimeline,
  finalizeTimelineBuckets,
  finalizeUsagePeriod,
  KNOWN_TOOL_CLASSES,
  newUsagePeriod,
  orderQuotaWindows,
  quotaWindowProjection,
  safeSpeed,
  SPARK_QUOTA_LIMIT_IDS,
  TIMELINE_BUCKET_MS,
  usageProjection,
  validObservedAt,
} from "./local-companion-usage-model.js";
import { createAccountingPricer } from "./replay-safe-accounting-cache.js";
import {
  forEachLocalCollectorRecord,
  readLocalCollectorRecordSummary,
  readLocalCollectorState,
} from "./local-collector-state.js";
import {
  projectWeeklyPaceForecast,
  projectWeeklyPaceOutlook,
  weeklyPaceSnapshotsFromCollectorRecord,
} from "./weekly-pace-projection.js";

const MAX_LEDGER_RECORDS = 5_000_000;
export const RECENT_TIMELINE_DAYS = 31;
export const RECENT_COLLECTOR_PERIOD_LABEL =
  `Cached ${RECENT_TIMELINE_DAYS}-day collector window`;
const MAX_WEEKLY_PACE_OBSERVATIONS = 8_192;
const MAX_SAFE_TEXT_LENGTH = 2_000;

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeText(value) {
  if (typeof value !== "string") return null;
  const clipped = value.slice(0, MAX_SAFE_TEXT_LENGTH);
  if (/https?:\/\/|file:\/\/|\/Users\/|\/home\/|[A-Z]:\\|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/i.test(clipped)) {
    return "[redacted]";
  }
  return clipped;
}

/**
 * Produce the bounded collector projection used by the local dashboard.
 *
 * This reader never returns rows, paths, database handles, or raw cache
 * records. It is deliberately a standalone module so a companion can run the
 * synchronous SQLite traversal in a worker without changing its snapshot API.
 */
export async function readLocalCollectorProjection(
  stateFile,
  nowMs,
  { summarizeUsageEvents = true, declaredSpeedBaselines = [] } = {},
) {
  let state;
  try {
    state = await readLocalCollectorState({ stateFile, includeRecords: false });
  } catch {
    throw fixedError("collector_unavailable");
  }
  if (state.status === "missing") {
    const paceForecast = projectWeeklyPaceForecast({ nowMs });
    return {
      status: "missing",
      recordCount: 0,
      malformedLines: 0,
      firstRecordAt: null,
      latestRecordAt: null,
      firstExportableRecordAt: null,
      latestExportableRecordAt: null,
      usage: summarizeUsage([], nowMs),
      quota: latestQuotaProjection([]),
      tools: summarizeToolClasses([]),
      timeline: {
        bucketMinutes: 15,
        usage: [],
        quota: [],
        sparkUsage: [],
        sparkQuota: [],
      },
      recordCounts: { usage: 0, quota: 0, tools: 0, other: 0 },
      paceForecast,
      paceOutlook: projectWeeklyPaceOutlook({ forecast: paceForecast, nowMs }),
    };
  }
  const periods = [
    { summary: newUsagePeriod("24h", "Last 24 hours"), start: nowMs - 24 * 60 * 60 * 1_000 },
    { summary: newUsagePeriod("7d", "Last 7 days"), start: nowMs - 7 * 24 * 60 * 60 * 1_000 },
    { summary: newUsagePeriod("30d", "Last 30 days"), start: nowMs - 30 * 24 * 60 * 60 * 1_000 },
    {
      summary: newUsagePeriod("all", RECENT_COLLECTOR_PERIOD_LABEL),
      start: nowMs - RECENT_TIMELINE_DAYS * 24 * 60 * 60 * 1_000,
    },
  ];
  const indexedSummary = summarizeUsageEvents
    ? null
    : await readLocalCollectorRecordSummary({
      stateFile,
      maximumUsageObservedAtMs: nowMs + 5 * 60_000,
    });
  if (indexedSummary?.status === "missing") throw fixedError("collector_unavailable");
  if (indexedSummary !== null && indexedSummary.recordCount > MAX_LEDGER_RECORDS) {
    throw fixedError("collector_invalid_size");
  }
  const toolCounts = Object.fromEntries([...KNOWN_TOOL_CLASSES].map((toolClass) => [toolClass, 0]));
  const recordCounts = indexedSummary?.recordCounts
    ?? { usage: 0, quota: 0, tools: 0, other: 0 };
  const pricer = createAccountingPricer();
  const recentStartMs = nowMs - RECENT_TIMELINE_DAYS * 24 * 60 * 60 * 1_000;
  const timelineBuckets = new Map();
  const sparkTimelineBuckets = new Map();
  const quotaTimeline = [];
  const weeklyPaceSnapshots = [];
  let toolTotal = 0;
  let recordCount = indexedSummary?.recordCount ?? 0;
  const malformedLines = Number.isSafeInteger(state.migration?.source?.malformedLines)
    ? state.migration.source.malformedLines
    : 0;
  let firstRecordAt = indexedSummary?.firstObservedAtMs ?? null;
  let latestRecordAt = indexedSummary?.latestObservedAtMs ?? null;
  let firstExportableRecordAt = indexedSummary?.firstUsageObservedAtMs ?? null;
  let latestExportableRecordAt = indexedSummary?.latestUsageObservedAtMs ?? null;
  let latestQuotaRecord = null;
  await forEachLocalCollectorRecord({
    stateFile,
    kinds: indexedSummary === null
      ? null
      : ["codex_quota_snapshot", "codex_tool_class_event"],
    onRecord: (value) => {
      if (indexedSummary === null) {
        recordCount += 1;
        if (recordCount > MAX_LEDGER_RECORDS) {
          throw fixedError("collector_invalid_size");
        }
      }
      const observedMs = validObservedAt(value);
      if (indexedSummary === null) {
        if (observedMs !== null
            && (firstRecordAt === null || observedMs < firstRecordAt)) {
          firstRecordAt = observedMs;
        }
        if (observedMs !== null
            && (latestRecordAt === null || observedMs > latestRecordAt)) {
          latestRecordAt = observedMs;
        }
        if (value.kind === "codex_quota_snapshot") {
          recordCounts.quota += 1;
        } else if (value.kind === "codex_rollout_usage_snapshot") {
          recordCounts.usage += 1;
        } else if (value.kind === "codex_tool_class_event") {
          recordCounts.tools += 1;
        } else {
          recordCounts.other += 1;
        }
      }
      if (value.kind === "codex_quota_snapshot" && observedMs !== null) {
        if (latestQuotaRecord === null
            || value.observedAt.localeCompare(latestQuotaRecord.observedAt) > 0) {
          latestQuotaRecord = value;
        }
        if (observedMs >= recentStartMs && observedMs <= nowMs + 5 * 60_000) {
          weeklyPaceSnapshots.push(
            ...weeklyPaceSnapshotsFromCollectorRecord(value),
          );
          if (weeklyPaceSnapshots.length > MAX_WEEKLY_PACE_OBSERVATIONS * 2) {
            weeklyPaceSnapshots.sort((left, right) => (
              left.observedAt.localeCompare(right.observedAt)
              || left.receivedAt.localeCompare(right.receivedAt)
              || left.accountTrackId.localeCompare(right.accountTrackId)
              || left.slot.localeCompare(right.slot)
            ));
            weeklyPaceSnapshots.splice(
              0,
              weeklyPaceSnapshots.length - MAX_WEEKLY_PACE_OBSERVATIONS,
            );
          }
        }
        if (observedMs >= recentStartMs && observedMs <= nowMs + 5 * 60_000) {
          for (const window of Array.isArray(value.windows) ? value.windows : []) {
            const projected = quotaWindowProjection(window);
            if (projected === null) continue;
            quotaTimeline.push({
              observedAt: new Date(observedMs).toISOString(),
              ...projected,
              accountAttribution: value.accountScope?.status === "available"
                ? "attributed_pseudonymous"
                : "unattributed",
            });
          }
        }
      }
      if (value.kind === "codex_rollout_usage_snapshot"
          && observedMs !== null && observedMs <= nowMs + 5 * 60_000) {
        if (firstExportableRecordAt === null
            || observedMs < firstExportableRecordAt) {
          firstExportableRecordAt = observedMs;
        }
        if (latestExportableRecordAt === null
            || observedMs > latestExportableRecordAt) {
          latestExportableRecordAt = observedMs;
        }
        if (summarizeUsageEvents) {
          const observedSpeed = safeSpeed(value.tierSemantics?.codexSpeedMode);
          const projection = usageProjection(
            value,
            observedSpeed === "unknown"
              ? declaredSpeedModeAt(declaredSpeedBaselines, observedMs) ?? "unknown"
              : "unknown",
            pricer,
          );
          for (const period of periods) {
            if (observedMs >= period.start) addUsageToPeriod(period.summary, projection);
          }
          if (observedMs >= recentStartMs) {
            addTimelineUsage(
              projection?.isSpark ? sparkTimelineBuckets : timelineBuckets,
              observedMs,
              projection,
            );
          }
        }
      }
      if (value.kind === "codex_tool_class_event") {
        if (observedMs !== null && observedMs <= nowMs + 5 * 60_000) {
          if (firstExportableRecordAt === null
              || observedMs < firstExportableRecordAt) {
            firstExportableRecordAt = observedMs;
          }
          if (latestExportableRecordAt === null
              || observedMs > latestExportableRecordAt) {
            latestExportableRecordAt = observedMs;
          }
        }
        const toolClass = KNOWN_TOOL_CLASSES.has(value.toolClass) ? value.toolClass : "other";
        toolCounts[toolClass] += 1;
        toolTotal += 1;
      }
    },
  });
  if (weeklyPaceSnapshots.length > MAX_WEEKLY_PACE_OBSERVATIONS) {
    weeklyPaceSnapshots.sort((left, right) => (
      left.observedAt.localeCompare(right.observedAt)
      || left.receivedAt.localeCompare(right.receivedAt)
      || left.accountTrackId.localeCompare(right.accountTrackId)
      || left.slot.localeCompare(right.slot)
    ));
    weeklyPaceSnapshots.splice(
      0,
      weeklyPaceSnapshots.length - MAX_WEEKLY_PACE_OBSERVATIONS,
    );
  }
  const paceForecast = projectWeeklyPaceForecast({
    currentRecord: latestQuotaRecord,
    observations: weeklyPaceSnapshots,
    nowMs,
  });
  const paceOutlook = projectWeeklyPaceOutlook({ forecast: paceForecast, nowMs });
  const projection = {
    status: "available",
    recordCount,
    malformedLines,
    firstRecordAt,
    latestRecordAt,
    firstExportableRecordAt,
    latestExportableRecordAt,
    usage: periods.map((period) => finalizeUsagePeriod(period.summary)),
    quota: latestQuotaProjection(latestQuotaRecord === null ? [] : [latestQuotaRecord]),
    tools: { total: toolTotal, counts: toolCounts },
    timeline: {
      bucketMinutes: TIMELINE_BUCKET_MS / 60_000,
      coveredAt: {
        startAt: timelineBuckets.size === 0
          ? null
          : new Date(Math.min(...timelineBuckets.keys())).toISOString(),
        endAt: timelineBuckets.size === 0
          ? null
          : new Date(Math.max(...timelineBuckets.keys()) + TIMELINE_BUCKET_MS).toISOString(),
      },
      usage: finalizeTimelineBuckets(timelineBuckets),
      sparkUsage: finalizeTimelineBuckets(sparkTimelineBuckets),
      quota: finalizeQuotaTimeline(
        quotaTimeline.filter((row) => row.limitId === "codex"),
      ),
      sparkQuota: finalizeQuotaTimeline(
        quotaTimeline.filter((row) => SPARK_QUOTA_LIMIT_IDS.includes(row.limitId)),
      ),
    },
    recordCounts,
    paceForecast,
    paceOutlook,
  };
  return projection;
}

function latestQuotaProjection(records) {
  const latest = records
    .filter((record) => record.kind === "codex_quota_snapshot" && validObservedAt(record) !== null)
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt))
    .at(-1);
  if (!latest) return { status: "unavailable", observedAt: null, windows: [] };
  const windows = Array.isArray(latest.windows)
    ? orderQuotaWindows(latest.windows.flatMap((window) => {
      const projected = quotaWindowProjection(window);
      return projected === null ? [] : [projected];
    }))
    : [];
  return {
    status: windows.length > 0 ? "available" : "unavailable",
    observedAt: safeText(latest.observedAt),
    accountAttribution: latest.accountScope?.status === "available"
      ? "attributed_pseudonymous"
      : "unattributed",
    windows,
  };
}

function summarizeToolClasses(records) {
  const counts = Object.fromEntries([...KNOWN_TOOL_CLASSES].map((toolClass) => [toolClass, 0]));
  let total = 0;
  for (const record of records) {
    if (record.kind !== "codex_tool_class_event") continue;
    const toolClass = KNOWN_TOOL_CLASSES.has(record.toolClass) ? record.toolClass : "other";
    counts[toolClass] += 1;
    total += 1;
  }
  return { total, counts };
}

function summarizeUsage(records, nowMs) {
  const periods = [
    { summary: newUsagePeriod("24h", "Last 24 hours"), start: nowMs - 24 * 60 * 60 * 1_000 },
    { summary: newUsagePeriod("7d", "Last 7 days"), start: nowMs - 7 * 24 * 60 * 60 * 1_000 },
    { summary: newUsagePeriod("30d", "Last 30 days"), start: nowMs - 30 * 24 * 60 * 60 * 1_000 },
    {
      summary: newUsagePeriod("all", RECENT_COLLECTOR_PERIOD_LABEL),
      start: nowMs - RECENT_TIMELINE_DAYS * 24 * 60 * 60 * 1_000,
    },
  ];
  const pricer = createAccountingPricer();
  for (const record of records) {
    if (record.kind !== "codex_rollout_usage_snapshot") continue;
    const observedMs = validObservedAt(record);
    if (observedMs === null || observedMs > nowMs + 5 * 60_000) continue;
    const projection = usageProjection(record, "unknown", pricer);
    for (const period of periods) {
      if (observedMs >= period.start) addUsageToPeriod(period.summary, projection);
    }
  }
  return periods.map((period) => finalizeUsagePeriod(period.summary));
}
