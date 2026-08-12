import { randomUUID } from "node:crypto";
import {
  readCodexAccountSnapshot,
  sanitizeCodexAccountSnapshot,
} from "./providers/codex/account.js";
import { runCcusageCodexDaily, summarizeCcusage } from "./ccusage.js";
import { scanAndPriceCodexLogs } from "./codex-local-usage-analysis.js";

function isoDate(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function sumOfficialTokens(buckets, startDate, endDate) {
  return buckets
    .filter((bucket) => bucket.date >= startDate && bucket.date <= endDate)
    .reduce((sum, bucket) => sum + bucket.tokens, 0);
}

function canonicalWindows(limit) {
  return ["primary", "secondary"]
    .filter((slot) => limit?.[slot])
    .map((slot) => {
      const window = limit[slot];
      const startEpochSeconds = window.resetsAt - window.windowDurationMins * 60;
      return {
        // Identity is (limit, duration, resetsAt); the provider's
        // primary/secondary slot is a UI role recorded separately below.
        identity: [limit.limitId, window.windowDurationMins, window.resetsAt].join(":"),
        limitId: limit.limitId,
        slot,
        usedPercent: window.usedPercent,
        windowDurationMins: window.windowDurationMins,
        resetsAt: window.resetsAt,
        startAt: new Date(startEpochSeconds * 1000).toISOString(),
      };
    });
}

export function summarizeTierCoverage(rawLocal) {
  const rawCounts = rawLocal?.runcost?.observedTierUsageEventCounts ?? {};
  const observedUsageEventCounts = Object.fromEntries(
    ["standard", "fast", "unknown", "other"]
      .map((mode) => [mode, rawCounts[mode]])
      .filter(([, count]) => Number.isSafeInteger(count) && count > 0),
  );
  const total = Object.values(observedUsageEventCounts).reduce((sum, count) => sum + count, 0);
  const standard = observedUsageEventCounts.standard ?? 0;
  const fast = observedUsageEventCounts.fast ?? 0;
  const exactlyOneKnownMode = total > 0 && standard + fast === total && (standard === 0 || fast === 0);
  const codexSpeedMode = exactlyOneKnownMode ? (fast > 0 ? "fast" : "standard") : "unknown";

  return {
    billingSurface: "chatgpt_subscription",
    codexSpeedMode,
    apiServiceTier: "unknown",
    tierSource: exactlyOneKnownMode ? "rollout_thread_settings" : "unobserved",
    attribution: exactlyOneKnownMode ? "all_local_usage_events_exactly_attributed" : "unavailable_or_mixed",
    observedUsageEventCounts,
  };
}

export async function captureCodexObservation({
  label = null,
  controlled = false,
  offline = false,
  clock = () => Date.now(),
  createObservationId = randomUUID,
  readSnapshot = readCodexAccountSnapshot,
  sanitizeSnapshot = sanitizeCodexAccountSnapshot,
  runCcusage = runCcusageCodexDaily,
  summarizeCcusageReport = summarizeCcusage,
  scanLocal = scanAndPriceCodexLogs,
} = {}) {
  const startedAtMs = clock();
  const capturedAt = new Date(startedAtMs).toISOString();
  const rawSnapshot = await readSnapshot();
  const account = await sanitizeSnapshot(rawSnapshot, capturedAt);
  const windows = [];

  for (const window of canonicalWindows(account.canonical)) {
    const startDate = isoDate(Date.parse(window.startAt));
    const endDate = isoDate(startedAtMs);
    const [ccusageReport, rawLocal] = await Promise.all([
      runCcusage({ since: startDate, until: endDate, timezone: "UTC", offline }),
      scanLocal({ startAt: window.startAt, endAt: capturedAt, offline }),
    ]);
    const ccusage = summarizeCcusageReport(ccusageReport);
    const officialWindowDayTokens = sumOfficialTokens(account.officialDailyTokens, startDate, endDate);
    const todayOfficial = account.officialDailyTokens.find((bucket) => bucket.date === endDate)?.tokens ?? null;
    const todayLocal = ccusage.daily.find((bucket) => bucket.date === endDate)?.totalTokens ?? null;

    windows.push({
      ...window,
      officialTokenActivity: {
        dateBucketTotalSinceStartDate: officialWindowDayTokens,
        currentUtcDayTokens: todayOfficial,
        localToOfficialCurrentDayRatio: todayOfficial && todayLocal !== null ? todayLocal / todayOfficial : null,
        caveat: "Official buckets are day-level account token activity and may include shared-pool surfaces or devices not present in local Codex logs",
      },
      local: {
        apiPricing: {
          totalUsd: rawLocal.runcost.totalUsd,
          components: rawLocal.components,
          totalTokens: rawLocal.totalTokens,
          byModel: rawLocal.runcost.byModel,
          warningCounts: rawLocal.runcost.warningCounts,
          priceResolution: rawLocal.runcost.priceResolution,
          tierSemantics: summarizeTierCoverage(rawLocal),
          engine: "runcost",
          basis: "Standard OpenAI API prices applied per request-like local token delta",
          source: {
            name: "OpenAI API pricing",
            url: "https://developers.openai.com/api/docs/pricing",
            checkedAt: "2026-07-23",
          },
        },
        ccusage,
        observedToolClasses: rawLocal.toolCallsByClass,
        diagnostics: rawLocal.diagnostics,
        assumptions: rawLocal.assumptions,
      },
    });
  }

  return {
    schemaVersion: "0.2",
    kind: "codex_quota_observation",
    observationId: createObservationId(),
    capturedAt,
    captureDurationMs: Math.max(0, clock() - startedAtMs),
    provider: "openai_codex",
    label,
    controlled,
    offlinePricing: offline,
    accountScope: account.accountScope,
    planType: account.canonical.planType,
    canonicalLimitId: account.canonical.limitId,
    availableLimits: account.byLimitId,
    officialUsageSummary: account.officialUsageSummary,
    windows,
    privacy: {
      conversationContentStored: false,
      rawAccountIdentifiersStored: false,
      pseudonymousAccountScopeStored: account.accountScope?.status === "available",
      credentialsStored: false,
      repositoryPathsStored: false,
      toolArgumentsStored: false,
    },
  };
}
