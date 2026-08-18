import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import {
  buildLocalCompanionSnapshot,
} from "../src/local-companion-data.js";
import {
  rebuildLocalUnifiedIndex,
} from "../src/local-unified-index-build.js";
import {
  ingestLocalUnifiedIndexIncrement,
} from "../src/local-unified-index-ingest.js";
import {
  inspectLocalUnifiedIndex,
  openLocalUnifiedIndex,
  readUnifiedIndexGenerationDescriptor,
} from "../src/local-unified-index.js";
import {
  createIndexedCodexLogScan,
  inspectLocalAnalysisIndex,
} from "../src/local-analysis-index.js";
import {
  readReplaySafeAccountingCache,
  refreshReplaySafeAccountingCache,
} from "../src/replay-safe-accounting-cache.js";
import {
  createLocalUnifiedAccountingSource,
} from "../src/local-unified-accounting-source.js";

export const LOCAL_INDEX_RETIREMENT_BENCHMARK_VERSION =
  "local-index-retirement-qualification-v2";
export const LOCAL_INDEX_RETIREMENT_BENCHMARK_CONTRACT =
  "usage-event-v0.2";
export const LOCAL_INDEX_RETIREMENT_BENCHMARK_START_AT =
  "2025-08-02T00:00:00.000Z";
export const LOCAL_INDEX_RETIREMENT_BENCHMARK_END_AT =
  "2026-08-02T00:00:00.000Z";
export const LOCAL_INDEX_RETIREMENT_ACCOUNTING_MIN_WINDOW_DAYS = 365;
export const LOCAL_INDEX_RETIREMENT_ACCOUNTING_MAX_WINDOW_DAYS = 3_653;

const MILLIS_PER_DAY = 24 * 60 * 60 * 1_000;

function canonicalInstant(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const canonical = new Date(milliseconds).toISOString();
  return canonical === value ? canonical : null;
}

// replay-safe accounting supports only whole-day windows from 365 through
// 3,653 days. Derive that exact supported window from the benchmark caller's
// interval so neither authority silently widens or shifts the comparison.
export function deriveSupportedAccountingWindow(startAt, endAt) {
  const canonicalStartAt = canonicalInstant(startAt);
  const canonicalEndAt = canonicalInstant(endAt);
  if (canonicalStartAt === null || canonicalEndAt === null) {
    throw new TypeError("startAt/endAt must be canonical ISO instants");
  }
  const startMs = Date.parse(canonicalStartAt);
  const endMs = Date.parse(canonicalEndAt);
  const durationMs = endMs - startMs;
  if (!Number.isSafeInteger(durationMs)
      || durationMs < 0
      || durationMs % MILLIS_PER_DAY !== 0) {
    throw new TypeError("benchmark interval must contain whole days");
  }
  const durationDays = durationMs / MILLIS_PER_DAY;
  if (durationDays < LOCAL_INDEX_RETIREMENT_ACCOUNTING_MIN_WINDOW_DAYS
      || durationDays > LOCAL_INDEX_RETIREMENT_ACCOUNTING_MAX_WINDOW_DAYS) {
    throw new TypeError(
      "benchmark accounting window must be between 365 and 3653 days",
    );
  }
  return Object.freeze({
    startAt: canonicalStartAt,
    endAt: canonicalEndAt,
    durationDays,
  });
}

// These are deliberately generous synthetic-fixture guardrails. They make a
// runaway benchmark fail closed without turning a machine's absolute speed
// into a product claim. The receipt reports measured values only.
export const LOCAL_INDEX_RETIREMENT_BENCHMARK_LIMITS = Object.freeze({
  maxPhaseMs: 60_000,
  maxTotalMs: 180_000,
  maxRssDeltaBytes: 1_024 * 1024 * 1024,
  maxDiskBytes: 64 * 1024 * 1024,
  maxSourceBytes: 4 * 1024 * 1024,
});

function sessionMeta(sessionId, timestamp) {
  return JSON.stringify({
    timestamp,
    type: "session_meta",
    payload: {
      id: sessionId,
      session_id: sessionId,
      thread_source: "user",
      originator: "codex_cli_rs",
      cwd: "/private/synthetic-index-retirement",
    },
  });
}

function turnContext(timestamp) {
  return JSON.stringify({
    timestamp,
    type: "turn_context",
    payload: {
      turn_id: "synthetic-turn",
      cwd: "/private/synthetic-index-retirement",
      model: "gpt-5.6-sol",
      effort: "medium",
    },
  });
}

function threadSettings(timestamp) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "thread_settings_applied",
      thread_settings: {
        service_tier: "priority",
        reasoning_effort: "medium",
      },
    },
  });
}

function tokenCount(timestamp, total, last, usedPercent = null) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: total,
        last_token_usage: last,
      },
      ...(usedPercent === null
        ? {}
        : {
          rate_limits: {
            limit_id: "codex",
            plan_type: "pro",
            primary: {
              used_percent: usedPercent,
              window_minutes: 10_080,
              resets_at: Math.floor(
                Date.parse("2026-08-08T00:00:00.000Z") / 1_000,
              ),
            },
          },
        }),
    },
  });
}

function usage(input, output, reasoning = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output + reasoning,
  };
}

async function writeSyntheticSource(path, {
  sessionId,
  sessionAt,
  events,
}) {
  const lines = [
    sessionMeta(sessionId, sessionAt),
    turnContext(sessionAt),
    threadSettings(sessionAt),
    ...events.map((event) => tokenCount(
      event.timestamp,
      event.total,
      event.last,
      event.usedPercent ?? null,
    )),
  ];
  await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });
}

export async function createSyntheticLocalIndexRetirementCorpus(stateDirectory) {
  const codexHome = join(stateDirectory, "synthetic-codex-home");
  const firstDirectory = join(codexHome, "sessions", "2026", "07", "01");
  const secondDirectory = join(codexHome, "sessions", "2026", "08", "01");
  await mkdir(firstDirectory, { recursive: true, mode: 0o700 });
  await mkdir(secondDirectory, { recursive: true, mode: 0o700 });
  const firstSource = join(
    firstDirectory,
    "rollout-2026-07-01T12-00-00-qualification.jsonl",
  );
  const secondSource = join(
    secondDirectory,
    "rollout-2026-08-01T12-00-00-qualification.jsonl",
  );
  await writeSyntheticSource(firstSource, {
    sessionId: "synthetic-qualification-history",
    sessionAt: "2026-07-01T12:00:00.000Z",
    events: [
      {
        timestamp: "2026-07-01T12:01:00.000Z",
        total: usage(100, 10),
        last: usage(100, 10),
        usedPercent: 4,
      },
      {
        timestamp: "2026-07-01T12:02:00.000Z",
        total: usage(220, 25),
        last: usage(120, 15),
      },
    ],
  });
  await writeSyntheticSource(secondSource, {
    sessionId: "synthetic-qualification-current",
    sessionAt: "2026-08-01T12:00:00.000Z",
    events: [
      {
        timestamp: "2026-08-01T12:01:00.000Z",
        total: usage(300, 30),
        last: usage(300, 30),
        usedPercent: 8,
      },
      {
        timestamp: "2026-08-01T12:02:00.000Z",
        total: usage(500, 55),
        last: usage(200, 25),
      },
    ],
  });
  return { codexHome, firstSource, secondSource };
}

function phaseMeasure(name, action, state) {
  return (async () => {
    const started = performance.now();
    const value = await action();
    const elapsedMs = performance.now() - started;
    state.phaseMs[name] = Number(elapsedMs.toFixed(3));
    state.peakRssBytes = Math.max(state.peakRssBytes, process.memoryUsage.rss());
    if (state.maxPhaseMs !== null
        && elapsedMs > state.maxPhaseMs) {
      throw new Error(`benchmark_phase_timeout:${name}`);
    }
    return value;
  })();
}

async function directoryBytes(directory) {
  let total = 0;
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile()) {
        total += (await stat(child)).size;
      }
    }
  }
  await visit(directory);
  return total;
}

async function missing(path) {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

function assertBounded(value, limit, label) {
  if (!Number.isFinite(value) || value < 0 || value > limit) {
    throw new Error(`benchmark_bound_exceeded:${label}`);
  }
}

function metadataSnapshot(path) {
  return stat(path).then((value) => ({
    size: value.size,
    mtimeMs: value.mtimeMs,
  }));
}

async function contentMetadataSnapshot(path) {
  const [metadata, contents] = await Promise.all([
    metadataSnapshot(path),
    readFile(path),
  ]);
  return { ...metadata, contents };
}

async function unchangedContentMetadata(before, path) {
  const after = await contentMetadataSnapshot(path);
  return after.size === before.size
    && after.mtimeMs === before.mtimeMs
    && Buffer.compare(after.contents, before.contents) === 0;
}

function countedScanner(scanner, counters) {
  return async function scanWithBoundedCounters({
    onUsage,
    onRateLimitSnapshot,
    ...options
  } = {}) {
    return scanner({
      ...options,
      onUsage: async (event) => {
        counters.usageCallbacks += 1;
        return onUsage?.(event);
      },
      onRateLimitSnapshot: async (snapshot) => {
        counters.quotaCallbacks += 1;
        return onRateLimitSnapshot?.(snapshot);
      },
    });
  };
}

function safeCount(value, label) {
  if (value === null || value === undefined) {
    throw new Error(`benchmark_count_invalid:${label}`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`benchmark_count_invalid:${label}`);
  }
  return count;
}

function rounded(value) {
  return Number(value.toFixed(3));
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index];
}

function summarizeNumbers(values) {
  if (!Array.isArray(values) || values.length < 1
      || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("benchmark_statistics_invalid");
  }
  return {
    min: rounded(Math.min(...values)),
    median: rounded(percentile(values, 0.5)),
    p95: rounded(percentile(values, 0.95)),
    max: rounded(Math.max(...values)),
  };
}

function summarizeRunReceipts(receipts) {
  if (!Array.isArray(receipts) || receipts.length < 1) {
    throw new Error("benchmark_runs_empty");
  }
  const timingNames = [...new Set(receipts.flatMap((receipt) => (
    Object.keys(receipt.timings ?? {})
  )))].sort();
  const countNames = [...new Set(receipts.flatMap((receipt) => (
    Object.keys(receipt.counts ?? {})
  )))].sort();
  return {
    runCount: receipts.length,
    timings: Object.fromEntries(timingNames.map((name) => [
      name,
      summarizeNumbers(receipts.map((receipt) => receipt.timings[name])),
    ])),
    counts: Object.fromEntries(countNames.map((name) => [
      name,
      summarizeNumbers(receipts.map((receipt) => receipt.counts[name])),
    ])),
  };
}

async function runSingleLocalIndexRetirementQualification({
  stateDirectory,
  codexHome = null,
  endAt = LOCAL_INDEX_RETIREMENT_BENCHMARK_END_AT,
  startAt = LOCAL_INDEX_RETIREMENT_BENCHMARK_START_AT,
  seedLegacySentinels = false,
  workerCount = 1,
} = {}) {
  if (typeof stateDirectory !== "string" || stateDirectory.length < 1) {
    throw new TypeError("stateDirectory must be a non-empty path");
  }
  if (codexHome !== null
      && (typeof codexHome !== "string" || codexHome.length < 1)) {
    throw new TypeError("codexHome must be a non-empty path or null");
  }
  if (typeof seedLegacySentinels !== "boolean") {
    throw new TypeError("seedLegacySentinels must be a boolean");
  }
  if (!Number.isSafeInteger(workerCount) || workerCount < 1 || workerCount > 10) {
    throw new TypeError("workerCount must be an integer from 1 through 10");
  }
  const accountingWindow = deriveSupportedAccountingWindow(startAt, endAt);
  const resolvedStateDirectory = resolve(stateDirectory);
  await mkdir(resolvedStateDirectory, { recursive: true, mode: 0o700 });
  if ((await readdir(resolvedStateDirectory)).length !== 0) {
    throw new Error("Benchmark state directory must be empty");
  }
  const synthetic = codexHome === null;
  const resolvedCodexHome = synthetic ? null : resolve(codexHome);
  const parsedEndAt = Date.parse(accountingWindow.endAt);
  const paths = {
    indexFile: join(resolvedStateDirectory, "local-unified-index-v1.sqlite"),
    secretFile: join(
      resolvedStateDirectory,
      "local-unified-index-device-salt-v1",
    ),
    accountingStateFile: join(
      resolvedStateDirectory,
      "local-collector-state-v1.sqlite",
    ),
    legacyAnalysisFile: join(
      resolvedStateDirectory,
      "local-analysis-index-v2.sqlite",
    ),
    legacyAnalysisSecretFile: join(
      resolvedStateDirectory,
      "local-analysis-index-secret-v2",
    ),
    legacyArchiveFile: join(
      resolvedStateDirectory,
      "local-archive-accounting-index-v1.sqlite",
    ),
    legacyArchiveSecretFile: join(
      resolvedStateDirectory,
      "local-archive-accounting-index-v1-secret",
    ),
  };
  const corpus = synthetic
    ? await createSyntheticLocalIndexRetirementCorpus(resolvedStateDirectory)
    : { codexHome: resolvedCodexHome, firstSource: null, secondSource: null };
  const legacySentinelContents = {
    analysis: Buffer.from("legacy-analysis-index-sentinel\n", "utf8"),
    secret: Buffer.from("legacy-analysis-secret-sentinel\n", "utf8"),
  };
  const legacySentinelBefore = seedLegacySentinels
    ? {
      analysis: await (async () => {
        await writeFile(
          paths.legacyAnalysisFile,
          legacySentinelContents.analysis,
          { mode: 0o600 },
        );
        return contentMetadataSnapshot(paths.legacyAnalysisFile);
      })(),
      secret: await (async () => {
        await writeFile(
          paths.legacyAnalysisSecretFile,
          legacySentinelContents.secret,
          { mode: 0o600 },
        );
        return contentMetadataSnapshot(paths.legacyAnalysisSecretFile);
      })(),
    }
    : null;
  const benchmarkState = {
    phaseMs: {},
    peakRssBytes: process.memoryUsage.rss(),
    maxPhaseMs: synthetic
      ? LOCAL_INDEX_RETIREMENT_BENCHMARK_LIMITS.maxPhaseMs
      : null,
  };
  const initialRssBytes = benchmarkState.peakRssBytes;
  const started = performance.now();
  const cold = await phaseMeasure("coldRebuild", () => rebuildLocalUnifiedIndex({
    codexHome: corpus.codexHome,
    indexFile: paths.indexFile,
    secretFile: paths.secretFile,
    startAt: accountingWindow.startAt,
    endAt: accountingWindow.endAt,
    contractVersion: LOCAL_INDEX_RETIREMENT_BENCHMARK_CONTRACT,
    workerCount,
  }), benchmarkState);
  if (cold.status !== "built" || cold.generation?.status !== "complete") {
    throw new Error("benchmark_cold_rebuild_incomplete");
  }
  const initialIndex = await inspectLocalUnifiedIndex({
    indexFile: paths.indexFile,
  });
  const coldGeneration = cold.generation;
  const accountingCounters = {
    usageCallbacks: 0,
    quotaCallbacks: 0,
  };
  const unifiedAccountingScan = (generation) => countedScanner(
    createLocalUnifiedAccountingSource({
      indexFile: paths.indexFile,
      requireComplete: true,
      expectedGeneration: generation,
      contextBehavior: "legacy_zero",
    }),
    accountingCounters,
  );
  const cache = await phaseMeasure("unifiedAccountingCache", () => (
    refreshReplaySafeAccountingCache({
      stateFile: paths.accountingStateFile,
      codexHome: corpus.codexHome,
      sourceMode: "unified",
      scan: unifiedAccountingScan(coldGeneration),
      unifiedIndexFile: paths.indexFile,
      expectedGeneration: coldGeneration,
      contextBehavior: "legacy_zero",
      now: () => parsedEndAt,
      windowDays: accountingWindow.durationDays,
    })
  ), benchmarkState);
  if (cache.status === "accounting_rebuild_deferred"
      || cache.weeklyCalibrationInput?.source !== "unified_index") {
    throw new Error("benchmark_unified_cache_not_folded");
  }
  const companion = await phaseMeasure("unifiedCompanionSnapshot", () => (
    buildLocalCompanionSnapshot({
      root: resolvedStateDirectory,
      collectorStateFile: paths.accountingStateFile,
      archiveIndexFile: paths.legacyArchiveFile,
      accountingSourceMode: "unified",
      unifiedIndexFile: paths.indexFile,
      now: () => parsedEndAt,
    })
  ), benchmarkState);
  if (companion.overview?.timeline?.source !== "unified_local_index"
      || companion.overview?.timeline?.history?.status !== "complete") {
    throw new Error("benchmark_unified_companion_not_complete");
  }

  const beforeNoChange = await metadataSnapshot(paths.indexFile);
  const noChange = await phaseMeasure("noChangeIngest", () => (
    ingestLocalUnifiedIndexIncrement({
      codexHome: corpus.codexHome,
      indexFile: paths.indexFile,
      secretFile: paths.secretFile,
      startAt: accountingWindow.startAt,
      endAt: accountingWindow.endAt,
      contractVersion: LOCAL_INDEX_RETIREMENT_BENCHMARK_CONTRACT,
    })
  ), benchmarkState);
  const afterNoChange = await metadataSnapshot(paths.indexFile);
  if (noChange.unchanged !== true
      || noChange.bytesScanned !== 0
      || afterNoChange.size !== beforeNoChange.size
      || afterNoChange.mtimeMs !== beforeNoChange.mtimeMs) {
    throw new Error("benchmark_no_change_ingest_mutated_index");
  }

  let appendedBytes = 0;
  let appendIngest;
  let postAppendGeneration = coldGeneration;
  if (synthetic) {
    const appendedText = `${tokenCount(
      "2026-08-01T12:03:00.000Z",
      usage(680, 75),
      usage(180, 20),
    )}\n`;
    await appendFile(corpus.secondSource, appendedText, { mode: 0o600 });
    appendedBytes = Buffer.byteLength(appendedText);
    appendIngest = await phaseMeasure("appendIngest", () => (
      ingestLocalUnifiedIndexIncrement({
        codexHome: corpus.codexHome,
        indexFile: paths.indexFile,
        secretFile: paths.secretFile,
        startAt: accountingWindow.startAt,
        endAt: accountingWindow.endAt,
        contractVersion: LOCAL_INDEX_RETIREMENT_BENCHMARK_CONTRACT,
      })
    ), benchmarkState);
    if (appendIngest.sourcesResumed !== 1
        || appendIngest.bytesScanned !== appendedBytes
        || appendIngest.insertedUsageEvents < 1) {
      throw new Error("benchmark_append_ingest_incomplete");
    }
    postAppendGeneration = appendIngest.generation;
    if (postAppendGeneration?.fingerprint === coldGeneration.fingerprint) {
      throw new Error("benchmark_generation_did_not_advance");
    }
  } else {
    // A real corpus is never mutated by this benchmark. The no-change
    // incremental pass above is the safe increment qualification; an append
    // pass is retained for the tiny synthetic CI fixture only.
    appendIngest = {
      status: "not_run",
      reason: "real_corpus_is_read_only",
      sourcesResumed: 0,
      bytesScanned: 0,
      insertedUsageEvents: 0,
    };
  }
  const staleCache = await phaseMeasure("staleCacheGenerationCheck", () => (
    readReplaySafeAccountingCache({
      stateFile: paths.accountingStateFile,
      now: () => parsedEndAt,
      sourceMode: "unified",
      expectedGeneration: postAppendGeneration,
      contextBehavior: "legacy_zero",
    })
  ), benchmarkState);
  if (synthetic && staleCache.status === "available") {
    throw new Error("benchmark_stale_cache_was_not_rejected");
  }
  if (!synthetic && staleCache.status !== "available") {
    throw new Error("benchmark_real_cache_was_not_reusable");
  }
  const postAppendCache = await phaseMeasure(
    "unifiedAccountingCacheAfterAppend",
    () => refreshReplaySafeAccountingCache({
      stateFile: paths.accountingStateFile,
      codexHome: corpus.codexHome,
      sourceMode: "unified",
      scan: unifiedAccountingScan(postAppendGeneration),
      unifiedIndexFile: paths.indexFile,
      expectedGeneration: postAppendGeneration,
      contextBehavior: "legacy_zero",
      now: () => parsedEndAt,
      windowDays: accountingWindow.durationDays,
    }),
    benchmarkState,
  );
  if (postAppendCache.status === "accounting_rebuild_deferred"
      || postAppendCache.weeklyCalibrationInput?.source !== "unified_index") {
    throw new Error("benchmark_unified_append_cache_not_folded");
  }
  const relaunchedCache = await phaseMeasure("cacheRelaunchRead", () => (
    readReplaySafeAccountingCache({
      stateFile: paths.accountingStateFile,
      now: () => parsedEndAt,
      sourceMode: "unified",
      expectedGeneration: postAppendGeneration,
      contextBehavior: "legacy_zero",
    })
  ), benchmarkState);
  if (relaunchedCache.status !== "available"
      || relaunchedCache.cache?.sourceDescriptor?.mode !== "unified"
      || relaunchedCache.cache?.weeklyCalibrationInput?.source
        !== "unified_index") {
    throw new Error("benchmark_cache_relaunch_validation_failed");
  }
  const postAppendCompanion = await phaseMeasure(
    "unifiedCompanionSnapshotAfterAppend",
    () => buildLocalCompanionSnapshot({
      root: resolvedStateDirectory,
      collectorStateFile: paths.accountingStateFile,
      archiveIndexFile: paths.legacyArchiveFile,
      accountingSourceMode: "unified",
      unifiedIndexFile: paths.indexFile,
      now: () => parsedEndAt,
    }),
    benchmarkState,
  );
  if (postAppendCompanion.overview?.timeline?.source
      !== "unified_local_index"
      || postAppendCompanion.overview?.timeline?.history?.status
        !== "complete") {
    throw new Error("benchmark_unified_companion_after_append_incomplete");
  }
  const finalIndex = await inspectLocalUnifiedIndex({
    indexFile: paths.indexFile,
  });
  const finalDatabase = openLocalUnifiedIndex(paths.indexFile, {
    readOnly: true,
  });
  let finalGeneration;
  try {
    finalGeneration = readUnifiedIndexGenerationDescriptor(finalDatabase);
  } finally {
    finalDatabase.close();
  }
  if (finalGeneration?.status !== "complete"
      || finalGeneration?.id !== postAppendGeneration?.id) {
    throw new Error("benchmark_final_generation_invalid");
  }
  const legacyPathsAbsent = await Promise.all([
    missing(paths.legacyAnalysisFile),
    missing(paths.legacyAnalysisSecretFile),
    missing(paths.legacyArchiveFile),
    missing(paths.legacyArchiveSecretFile),
  ]);
  const legacyArchiveFilesAbsent = legacyPathsAbsent.slice(2).every(Boolean);
  const legacyAnalysisFilesPresent = legacyPathsAbsent.slice(0, 2)
    .every((value) => value === false);
  const legacyAnalysisSentinelsUnchanged = seedLegacySentinels
    ? await Promise.all([
      unchangedContentMetadata(
        legacySentinelBefore.analysis,
        paths.legacyAnalysisFile,
      ),
      unchangedContentMetadata(
        legacySentinelBefore.secret,
        paths.legacyAnalysisSecretFile,
      ),
    ]).then((values) => values.every(Boolean))
    : true;
  if (!legacyArchiveFilesAbsent
      || (seedLegacySentinels
        ? !legacyAnalysisFilesPresent || !legacyAnalysisSentinelsUnchanged
        : !legacyPathsAbsent.every(Boolean))) {
    throw new Error("benchmark_legacy_state_touched_in_unified_mode");
  }
  const legacyState = {
    analysisSentinelsSeeded: seedLegacySentinels,
    analysisSentinelsPresentAfter: legacyAnalysisFilesPresent,
    analysisSentinelsUnchanged: legacyAnalysisSentinelsUnchanged,
    archiveFilesAbsentAfter: legacyArchiveFilesAbsent,
  };
  const diskBytes = await directoryBytes(resolvedStateDirectory);
  const totalMs = performance.now() - started;
  const coldSourceBytes = safeCount(
    cold.sourceBytes
      ?? initialIndex.lastScan?.bytes
      ?? 0,
    "cold_source_bytes",
  );
  const finalSourceBytes = safeCount(
    finalGeneration.indexedSourceBytes
      ?? coldSourceBytes
      ?? 0,
    "final_source_bytes",
  );
  const rssDeltaBytes = Math.max(0, benchmarkState.peakRssBytes - initialRssBytes);
  const counts = {
    sourceCount: safeCount(finalGeneration.indexedSourceCount, "source_count"),
    sourceBytes: finalSourceBytes,
    coldSourceBytes,
    finalSourceBytes,
    usageEvents: safeCount(
      finalGeneration.usageEvents ?? finalIndex.usageEvents,
      "usage_events",
    ),
    quotaOccurrences: safeCount(
      finalGeneration.quotaOccurrences ?? 0,
      "quota_occurrences",
    ),
    quotaObservations: safeCount(
      finalIndex.quotaObservations,
      "quota_observations",
    ),
    usageCallbacks: safeCount(
      accountingCounters.usageCallbacks,
      "usage_callbacks",
    ),
    quotaCallbacks: safeCount(
      accountingCounters.quotaCallbacks,
      "quota_callbacks",
    ),
    totalCallbacks: safeCount(
      accountingCounters.usageCallbacks + accountingCounters.quotaCallbacks,
      "total_callbacks",
    ),
    usageFacts: safeCount(finalIndex.usageEvents, "usage_facts"),
    quotaFacts: safeCount(finalIndex.quotaObservations, "quota_facts"),
    indexedFacts: safeCount(
      finalIndex.usageEvents + finalIndex.quotaObservations,
      "indexed_facts",
    ),
  };
  const diskBytesCount = safeCount(diskBytes, "disk_bytes");
  const rssDeltaCount = safeCount(rssDeltaBytes, "rss_delta_bytes");
  if (synthetic) {
    assertBounded(totalMs, LOCAL_INDEX_RETIREMENT_BENCHMARK_LIMITS.maxTotalMs, "total_ms");
    assertBounded(rssDeltaCount, LOCAL_INDEX_RETIREMENT_BENCHMARK_LIMITS.maxRssDeltaBytes, "rss_delta_bytes");
    assertBounded(diskBytesCount, LOCAL_INDEX_RETIREMENT_BENCHMARK_LIMITS.maxDiskBytes, "disk_bytes");
    assertBounded(coldSourceBytes, LOCAL_INDEX_RETIREMENT_BENCHMARK_LIMITS.maxSourceBytes, "cold_source_bytes");
    assertBounded(finalSourceBytes, LOCAL_INDEX_RETIREMENT_BENCHMARK_LIMITS.maxSourceBytes, "final_source_bytes");
    for (const [name, value] of Object.entries(benchmarkState.phaseMs)) {
      assertBounded(value, LOCAL_INDEX_RETIREMENT_BENCHMARK_LIMITS.maxPhaseMs, name);
    }
  }
  const receipt = {
    schemaVersion: LOCAL_INDEX_RETIREMENT_BENCHMARK_VERSION,
    synthetic,
    node: process.version,
    workerCount,
    accountingWindow,
    sourceCount: counts.sourceCount,
    usageEvents: counts.usageEvents,
    sourceBytes: coldSourceBytes,
    finalSourceBytes,
    appendedBytes,
    indexBytes: safeCount(finalIndex.indexBytes, "index_bytes"),
    diskBytes: diskBytesCount,
    rssDeltaBytes: rssDeltaCount,
    peakRssBytes: safeCount(benchmarkState.peakRssBytes, "peak_rss_bytes"),
    counts,
    timings: {
      ...benchmarkState.phaseMs,
      totalMs: Number(totalMs.toFixed(3)),
    },
    generations: {
      cold: {
        id: coldGeneration.id,
        fingerprint: coldGeneration.fingerprint,
        status: coldGeneration.status,
      },
      append: {
        id: postAppendGeneration.id,
        fingerprint: postAppendGeneration.fingerprint,
        status: postAppendGeneration.status,
      },
    },
    accounting: {
      sourceMode: postAppendCache.sourceDescriptor.mode,
      contextBehavior: postAppendCache.sourceDescriptor.contextBehavior,
      weeklyCalibrationSource: postAppendCache.weeklyCalibrationInput.source,
      retainedUsageEvents: postAppendCache.weeklyCalibrationInput.retainedUsageEvents,
      staleGenerationStatus: staleCache.status,
      relaunchedStatus: relaunchedCache.status,
    },
    companion: {
      timelineSource: postAppendCompanion.overview.timeline.source,
      historyStatus: postAppendCompanion.overview.timeline.history.status,
      historyUsageEvents: postAppendCompanion.overview.timeline.history.usageEvents,
    },
    noChange: {
      unchanged: noChange.unchanged === true,
      bytesScanned: noChange.bytesScanned,
      sizeUnchanged: afterNoChange.size === beforeNoChange.size,
      mtimeUnchanged: afterNoChange.mtimeMs === beforeNoChange.mtimeMs,
    },
    append: {
      status: appendIngest.status ?? "complete",
      ...(appendIngest.reason === undefined ? {} : { reason: appendIngest.reason }),
      sourcesResumed: appendIngest.sourcesResumed,
      bytesScanned: appendIngest.bytesScanned,
      insertedUsageEvents: appendIngest.insertedUsageEvents,
    },
    legacyPathsAbsent: legacyPathsAbsent.every(Boolean),
    legacyState,
  };
  return {
    receipt,
    codexHome: corpus.codexHome,
  };
}

async function runLegacyComparison({
  stateDirectory,
  codexHome,
  startAt,
  endAt,
  synthetic,
  workerCount = 1,
}) {
  const accountingWindow = deriveSupportedAccountingWindow(startAt, endAt);
  const resolvedStateDirectory = resolve(stateDirectory);
  await mkdir(resolvedStateDirectory, { recursive: true, mode: 0o700 });
  if ((await readdir(resolvedStateDirectory)).length !== 0) {
    throw new Error("Legacy comparison state directory must be empty");
  }
  const indexFile = join(
    resolvedStateDirectory,
    "local-analysis-index-v2.sqlite",
  );
  const indexSecretFile = join(
    resolvedStateDirectory,
    "local-analysis-index-secret-v2",
  );
  const stateFile = join(
    resolvedStateDirectory,
    "local-collector-state-v1.sqlite",
  );
  const counters = { usageCallbacks: 0, quotaCallbacks: 0 };
  const benchmarkState = {
    phaseMs: {},
    peakRssBytes: process.memoryUsage.rss(),
    maxPhaseMs: synthetic
      ? LOCAL_INDEX_RETIREMENT_BENCHMARK_LIMITS.maxPhaseMs
      : null,
  };
  const initialRssBytes = benchmarkState.peakRssBytes;
  const started = performance.now();
  const cache = await phaseMeasure("legacyAccountingCache", () => (
    refreshReplaySafeAccountingCache({
      stateFile,
      codexHome,
      sourceMode: "legacy",
      scan: countedScanner(
        createIndexedCodexLogScan({
          indexFile,
          secretFile: indexSecretFile,
          workerCount,
        }),
        counters,
      ),
      indexFile,
      indexSecretFile,
      now: () => Date.parse(accountingWindow.endAt),
      windowDays: accountingWindow.durationDays,
    })
  ), benchmarkState);
  const index = await inspectLocalAnalysisIndex({ indexFile });
  const diskBytes = await directoryBytes(resolvedStateDirectory);
  const totalMs = performance.now() - started;
  const counts = {
    sourceCount: safeCount(index.sourceCount, "legacy_source_count"),
    sourceBytes: safeCount(index.lastScan?.bytes, "legacy_source_bytes"),
    usageEvents: safeCount(index.usageFacts, "legacy_usage_events"),
    quotaOccurrences: safeCount(index.quotaFacts, "legacy_quota_occurrences"),
    quotaObservations: safeCount(index.quotaFacts, "legacy_quota_observations"),
    usageCallbacks: safeCount(counters.usageCallbacks, "legacy_usage_callbacks"),
    quotaCallbacks: safeCount(counters.quotaCallbacks, "legacy_quota_callbacks"),
    totalCallbacks: safeCount(
      counters.usageCallbacks + counters.quotaCallbacks,
      "legacy_total_callbacks",
    ),
    usageFacts: safeCount(index.usageFacts, "legacy_usage_facts"),
    quotaFacts: safeCount(index.quotaFacts, "legacy_quota_facts"),
    indexedFacts: safeCount(
      index.usageFacts + index.quotaFacts,
      "legacy_indexed_facts",
    ),
  };
  const rssDeltaBytes = Math.max(
    0,
    benchmarkState.peakRssBytes - initialRssBytes,
  );
  if (synthetic) {
    assertBounded(totalMs, LOCAL_INDEX_RETIREMENT_BENCHMARK_LIMITS.maxTotalMs, "legacy_total_ms");
    assertBounded(rssDeltaBytes, LOCAL_INDEX_RETIREMENT_BENCHMARK_LIMITS.maxRssDeltaBytes, "legacy_rss_delta_bytes");
    assertBounded(diskBytes, LOCAL_INDEX_RETIREMENT_BENCHMARK_LIMITS.maxDiskBytes, "legacy_disk_bytes");
    assertBounded(counts.sourceBytes, LOCAL_INDEX_RETIREMENT_BENCHMARK_LIMITS.maxSourceBytes, "legacy_source_bytes");
    for (const [name, value] of Object.entries(benchmarkState.phaseMs)) {
      assertBounded(value, LOCAL_INDEX_RETIREMENT_BENCHMARK_LIMITS.maxPhaseMs, `legacy_${name}`);
    }
  }
  return {
    schemaVersion: "local-index-retirement-legacy-comparison-v2",
    mode: "legacy",
    selection: "explicit",
    node: process.version,
    workerCount,
    accountingWindow,
    sourceCount: counts.sourceCount,
    sourceBytes: counts.sourceBytes,
    usageEvents: counts.usageEvents,
    quotaObservations: counts.quotaObservations,
    quotaFacts: counts.quotaFacts,
    indexBytes: safeCount(index.indexBytes, "legacy_index_bytes"),
    diskBytes: safeCount(diskBytes, "legacy_disk_bytes"),
    rssDeltaBytes: safeCount(rssDeltaBytes, "legacy_rss_delta_bytes"),
    counts,
    timings: {
      ...benchmarkState.phaseMs,
      totalMs: rounded(totalMs),
    },
    accounting: {
      sourceMode: cache.sourceDescriptor?.mode ?? "legacy",
      weeklyStatus: cache.weeklyCalibration?.status ?? null,
    },
  };
}

export async function runLocalIndexRetirementQualification({
  stateDirectory,
  codexHome = null,
  startAt = LOCAL_INDEX_RETIREMENT_BENCHMARK_START_AT,
  endAt = LOCAL_INDEX_RETIREMENT_BENCHMARK_END_AT,
  runs = 1,
  workerCount = 1,
  compareLegacy = false,
  seedLegacySentinels = false,
} = {}) {
  if (typeof stateDirectory !== "string" || stateDirectory.length < 1) {
    throw new TypeError("stateDirectory must be a non-empty path");
  }
  if (codexHome !== null
      && (typeof codexHome !== "string" || codexHome.length < 1)) {
    throw new TypeError("codexHome must be a non-empty path or null");
  }
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20) {
    throw new TypeError("runs must be an integer from 1 through 20");
  }
  if (!Number.isSafeInteger(workerCount) || workerCount < 1 || workerCount > 10) {
    throw new TypeError("workerCount must be an integer from 1 through 10");
  }
  if (typeof compareLegacy !== "boolean"
      || typeof seedLegacySentinels !== "boolean") {
    throw new TypeError("benchmark flags must be booleans");
  }
  const accountingWindow = deriveSupportedAccountingWindow(startAt, endAt);
  const resolvedStateDirectory = resolve(stateDirectory);
  await mkdir(resolvedStateDirectory, { recursive: true, mode: 0o700 });
  if ((await readdir(resolvedStateDirectory)).length !== 0) {
    throw new Error("Benchmark state directory must be empty");
  }
  const runResults = [];
  for (let index = 0; index < runs; index += 1) {
    const runStateDirectory = runs === 1
      ? resolvedStateDirectory
      : join(resolvedStateDirectory, `unified-run-${index + 1}`);
    runResults.push(await runSingleLocalIndexRetirementQualification({
      stateDirectory: runStateDirectory,
      codexHome,
      startAt: accountingWindow.startAt,
      endAt: accountingWindow.endAt,
      seedLegacySentinels,
      workerCount,
    }));
  }
  const receipts = runResults.map((result) => result.receipt);
  const legacyResults = [];
  if (compareLegacy) {
    for (let index = 0; index < runs; index += 1) {
      const legacyResult = await runLegacyComparison({
        stateDirectory: join(resolvedStateDirectory, `legacy-run-${index + 1}`),
        codexHome: runResults[index].codexHome,
        startAt: accountingWindow.startAt,
        endAt: accountingWindow.endAt,
        synthetic: codexHome === null,
        workerCount,
      });
      if (legacyResult.workerCount !== workerCount
          || legacyResult.accountingWindow.startAt !== accountingWindow.startAt
          || legacyResult.accountingWindow.endAt !== accountingWindow.endAt
          || legacyResult.accountingWindow.durationDays
            !== accountingWindow.durationDays) {
        throw new Error("benchmark_legacy_parity_window_mismatch");
      }
      legacyResults.push(legacyResult);
    }
  }
  const representative = receipts[0];
  return {
    ...representative,
    runCount: receipts.length,
    statistics: summarizeRunReceipts(receipts),
    runs: receipts,
    legacyComparison: compareLegacy
      ? {
        mode: "legacy",
        selection: "explicit",
        accountingWindow,
        invocation: {
          unifiedCommandTemplate:
            "node scripts/benchmark-local-index-retirement.mjs --codex-home <codex-home> --state <empty-state> --start-at <ISO> --end-at <ISO> --runs <RUNS> --workers <WORKERS> --compare-legacy",
          legacyCommandTemplate:
            "node scripts/benchmark-local-analysis-pipeline.mjs --codex-home <codex-home> --state <empty-state> --start-at <ISO> --end-at <ISO> --workers <WORKERS>",
        },
        runCount: legacyResults.length,
        statistics: summarizeRunReceipts(legacyResults),
        runs: legacyResults,
      }
      : null,
  };
}

function parseOptions(argv) {
  const options = {
    stateDirectory: null,
    codexHome: null,
    startAt: LOCAL_INDEX_RETIREMENT_BENCHMARK_START_AT,
    endAt: LOCAL_INDEX_RETIREMENT_BENCHMARK_END_AT,
    runs: 1,
    workerCount: 1,
    compareLegacy: false,
    seedLegacySentinels: false,
  };
  for (let index = 0; index < argv.length;) {
    const name = argv[index];
    if (name === "--compare-legacy" || name === "--seed-legacy-sentinels") {
      options[name === "--compare-legacy"
        ? "compareLegacy"
        : "seedLegacySentinels"] = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new TypeError(`${name} needs a value`);
    if (name === "--state") options.stateDirectory = resolve(value);
    else if (name === "--codex-home") options.codexHome = resolve(value);
    else if (name === "--start-at") options.startAt = value;
    else if (name === "--end-at") options.endAt = value;
    else if (name === "--runs") options.runs = Number(value);
    else if (name === "--workers") options.workerCount = Number(value);
    else throw new TypeError(`Unknown option: ${name}`);
    index += 2;
  }
  if (options.stateDirectory === null) {
    throw new TypeError(
      "Required: --state EMPTY_DIR [--codex-home CODEX_HOME] "
      + "[--start-at ISO] [--end-at ISO] [--runs N] "
      + "[--workers N] [--compare-legacy] [--seed-legacy-sentinels]",
    );
  }
  return options;
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const options = parseOptions(process.argv.slice(2));
  const receipt = await runLocalIndexRetirementQualification(options);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
