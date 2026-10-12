import { createHash } from "node:crypto";

export const PUBLIC_GRAPH_BENCHMARK_VERSION = "public-graph-benchmark-v2";
export const PUBLIC_GRAPH_BENCHMARK_WORKLOAD_VERSION = "public-graph-benchmark-v1";
export const PUBLIC_GRAPH_BENCHMARK_TIMING_BOUNDARY = "cold-native-public-graph-build-publish-readback";
export const PUBLIC_GRAPH_BENCHMARK_FIXED_NOW = "2026-09-24T02:00:00.000Z";
export const PUBLIC_GRAPH_BENCHMARK_MAX_TOTAL_ROWS = 10_000;
export const PUBLIC_GRAPH_BENCHMARK_MAX_ROWS_PER_STREAM_PER_DAY = 1_000;
export const PUBLIC_GRAPH_BENCHMARK_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const PUBLIC_GRAPH_BENCHMARK_STRESS_MEASURED_RUNS = 3;
export const PUBLIC_GRAPH_BENCHMARK_STRESS_WARMUP_RUNS = 1;
export const PUBLIC_GRAPH_BENCHMARK_DAYS = Object.freeze([
  "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23",
]);
export const PUBLIC_GRAPH_BENCHMARK_TARGET_DAY = PUBLIC_GRAPH_BENCHMARK_DAYS.at(-1);
export const PUBLIC_GRAPH_BENCHMARK_PROFILES = Object.freeze({
  small: Object.freeze({ multiplier: 1, rowsPerStreamPerDay: 20 }),
  medium: Object.freeze({ multiplier: 5, rowsPerStreamPerDay: 20 }),
  stress_5k: Object.freeze({ multiplier: 25, rowsPerStreamPerDay: 20 }),
  stress_10k: Object.freeze({ multiplier: 50, rowsPerStreamPerDay: 20 }),
});

export function publicGraphBenchmarkRunPlan(stressMode = process.env.PUBLIC_GRAPH_BENCHMARK_STRESS) {
  const stress = stressMode === true || stressMode === "1";
  if (!(stressMode === undefined || stressMode === false || stressMode === "0" || stress)) {
    throw new TypeError("PUBLIC_GRAPH_BENCHMARK_STRESS must be unset, 0, or 1");
  }
  const profiles = stress
    ? ["small", "medium", "stress_5k", "stress_10k"]
    : ["small", "medium"];
  const runs = [];
  for (const profile of profiles) {
    if (stress) {
      for (let iteration = 1; iteration <= PUBLIC_GRAPH_BENCHMARK_STRESS_WARMUP_RUNS; iteration += 1) {
        runs.push(Object.freeze({ profile, kind: "warmup", iteration }));
      }
      for (let iteration = 1; iteration <= PUBLIC_GRAPH_BENCHMARK_STRESS_MEASURED_RUNS; iteration += 1) {
        runs.push(Object.freeze({ profile, kind: "measured", iteration }));
      }
    } else {
      runs.push(Object.freeze({ profile, kind: "measured", iteration: 1 }));
    }
  }
  return Object.freeze(runs);
}

export function canonicalBenchmarkJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalBenchmarkJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalBenchmarkJson(value[key])}`).join(",")}}`;
}

export function benchmarkSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function benchmarkProfileConfig(profile) {
  if (typeof profile !== "string" || !Object.hasOwn(PUBLIC_GRAPH_BENCHMARK_PROFILES, profile)) return null;
  return PUBLIC_GRAPH_BENCHMARK_PROFILES[profile];
}

export function createPublicGraphBenchmarkRows(profile, priceChunkUsageRecord) {
  const config = benchmarkProfileConfig(profile);
  if (!config || typeof priceChunkUsageRecord !== "function") {
    throw new TypeError("profile and usage pricing function are required");
  }
  const attribution = () => ({
    accountBasis: "same_source",
    accountTrackId: `account-track:v2:${"a".repeat(64)}`,
    planBasis: "same_source_occurrence",
    planType: "pro",
    planEraId: null,
  });
  const capacities = { "gpt-5.6-sol": 2_500, "gpt-5.6-terra": 900 };
  const days = PUBLIC_GRAPH_BENCHMARK_DAYS.map((day) => ({ day, quota: [], usage: [] }));
  for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
    const { day, quota, usage } = days[dayIndex];
    const usageRows = [];
    let dailyQuotaGrowth = 0;
    for (let index = 0; index < config.rowsPerStreamPerDay * config.multiplier; index += 1) {
      const globalIndex = index * 2;
      const modelPattern = [
        ["gpt-5.6-sol", "gpt-5.6-sol", "gpt-5.6-sol", "gpt-5.6-terra"],
        ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-terra", "gpt-5.6-terra"],
        ["gpt-5.6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-terra"],
        ["gpt-5.6-terra", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-sol"],
      ];
      const modelId = modelPattern[Math.floor(globalIndex / 4) % modelPattern.length][globalIndex % 4];
      const minute = Math.floor(index * 20 * 60 / (config.rowsPerStreamPerDay * config.multiplier));
      const at = new Date(Date.parse(`${day}T00:15:00.000Z`) + minute * 60_000).toISOString();
      const eventId = `event:graph-benchmark:${day.replaceAll("-", "")}:${String(index).padStart(3, "0")}`;
      const usageBase = {
        schemaVersion: "usage-event-v1.1",
        eventId,
        eventTime: at,
        sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
        provider: "openai_codex",
        modelId,
        speedMode: "standard",
        apiServiceTier: "default",
        surface: "local_interactive_unclassified",
        billingSurface: "chatgpt_subscription",
        reasoningEffort: "high",
        agentScope: "root",
        outcome: "completed",
        totalInputContextTokens: 1000,
        components: { inputUncachedTokens: 0, inputCacheReadTokens: 0, inputCacheWriteTokens: 0,
          outputTextTokens: 1, outputReasoningTokens: 0, outputCombinedTokens: null },
        accountPlanAttribution: attribution(),
      };
      const unit = priceChunkUsageRecord(JSON.stringify(usageBase), at);
      if (!unit || unit.pricingStatus !== "fully_priced" || unit.costNanousd <= 0) {
        throw new Error("benchmark model price is unavailable");
      }
      const targetCostUsd = (5 + ((globalIndex * 7 + dayIndex * 11) % 17) / 4)
        * ((index + dayIndex) % 3 === 0 ? 0.2 : 1) / config.multiplier;
      const tokens = Math.max(1, Math.round(targetCostUsd * 1_000_000_000 / unit.costNanousd));
      const record = { ...usageBase, components: { ...usageBase.components, outputTextTokens: tokens } };
      const priced = priceChunkUsageRecord(JSON.stringify(record), at);
      if (!priced || priced.pricingStatus !== "fully_priced" || priced.costNanousd <= 0) {
        throw new Error("benchmark usage row is not priceable");
      }
      dailyQuotaGrowth += (priced.costNanousd / 1_000_000_000) * 100 / capacities[modelId];
      usageRows.push({ record, at, eventId, modelId, index });
    }
    const quotaScale = 60 / dailyQuotaGrowth;
    if (!Number.isFinite(quotaScale) || dailyQuotaGrowth <= 0) {
      throw new Error("benchmark quota curve cannot be normalized");
    }
    let usedPercent = 0;
    for (const { record, at, eventId, modelId, index } of usageRows) {
      const indexedCost = priceChunkUsageRecord(JSON.stringify(record), at);
      if (!indexedCost || indexedCost.pricingStatus !== "fully_priced" || indexedCost.costNanousd <= 0) {
        throw new Error("benchmark usage row is not priceable");
      }
      usedPercent += (indexedCost.costNanousd / 1_000_000_000) * 100 / capacities[modelId] * quotaScale;
      if (usedPercent >= 90) throw new Error("benchmark fixture exceeds its quota bound");
      usage.push(record);
      quota.push({
        schemaVersion: "quota-observation-v1.1",
        observationId: `quota:graph-benchmark:${day.replaceAll("-", "")}:${String(index).padStart(3, "0")}`,
        observedTime: at,
        provider: "openai_codex",
        planType: "pro",
        planVariant: "standard",
        limitId: "codex",
        slot: "seven_day",
        usedPercent,
        windowDurationMinutes: 10_080,
        resetsAt: new Date(Date.parse(`${day}T00:00:00.000Z`) + 7 * 86_400_000).toISOString(),
        accountPlanAttribution: attribution(),
      });
    }
  }
  const input = days.flatMap(({ day, quota, usage }) => [...quota, ...usage].map((record) => ({ day, record })));
  const serializedInput = canonicalBenchmarkJson(input);
  const sourceBytes = new TextEncoder().encode(serializedInput).byteLength;
  const workload = publicGraphWorkload(profile);
  if (workload.totalRows > PUBLIC_GRAPH_BENCHMARK_MAX_TOTAL_ROWS
      || workload.rowsPerStreamPerDay > PUBLIC_GRAPH_BENCHMARK_MAX_ROWS_PER_STREAM_PER_DAY
      || sourceBytes > PUBLIC_GRAPH_BENCHMARK_MAX_SOURCE_BYTES) {
    throw new Error("benchmark input exceeds its bounded profile limits");
  }
  return Object.freeze({
    days: Object.freeze(days.map((entry) => Object.freeze(entry))),
    sourceDigest: benchmarkSha256(serializedInput),
    sourceBytes,
  });
}

export function publicGraphWorkload(profile) {
  const config = benchmarkProfileConfig(profile);
  if (!config) throw new TypeError("unknown public graph benchmark profile");
  const quotaObservations = PUBLIC_GRAPH_BENCHMARK_DAYS.length
    * config.rowsPerStreamPerDay * config.multiplier;
  const usageEvents = quotaObservations;
  const descriptor = {
    version: PUBLIC_GRAPH_BENCHMARK_WORKLOAD_VERSION,
    telemetryFormat: "v1.1",
    fixedNow: PUBLIC_GRAPH_BENCHMARK_FIXED_NOW,
    days: PUBLIC_GRAPH_BENCHMARK_DAYS,
    targetDay: PUBLIC_GRAPH_BENCHMARK_TARGET_DAY,
    ownerCount: 1,
    quotaObservations,
    usageEvents,
    profile,
  };
  return Object.freeze({
    ...descriptor,
    totalRows: quotaObservations + usageEvents,
    rowsPerStreamPerDay: config.rowsPerStreamPerDay * config.multiplier,
    rowsPerDay: 2 * config.rowsPerStreamPerDay * config.multiplier,
    workloadId: benchmarkSha256(canonicalBenchmarkJson(descriptor)),
  });
}

function isHexDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function summarize(values) {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new TypeError("benchmark samples must be finite nonnegative numbers");
  }
  const center = median(values);
  return Object.freeze({
    minMs: Math.min(...values),
    medianMs: center,
    maxMs: Math.max(...values),
    medianAbsoluteDeviationMs: median(values.map((value) => Math.abs(value - center))),
  });
}

function exactKeys(value, keys) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function validateNativeWork(provider, work) {
  const keys = provider === "d1"
    ? ["kind", "steps", "queriesUsed", "graphCalculations", "dailyPublications"]
    : ["kind", "calculated", "published", "historicalPublished", "acknowledged", "deferred", "stale",
      "persistedOwnerResults", "persistedPublications", "persistedPreviews"];
  if (!exactKeys(work, keys) || work.kind !== provider
      || keys.slice(1).some((key) => !Number.isSafeInteger(work[key]) || work[key] < 0)) {
    throw new TypeError("benchmark native-work counters are incomplete");
  }
}

function validateSample(provider, sample, digests) {
  const expectedKeys = ["elapsedMs", "overallWallMs", "nativePasses", "nativeWork", "sourceBytes", "sourceDigest", "outputDigest"];
  if (!exactKeys(sample, expectedKeys)
      || !Number.isFinite(sample.elapsedMs) || sample.elapsedMs < 0
      || !Number.isFinite(sample.overallWallMs) || sample.overallWallMs < sample.elapsedMs
      || !Number.isSafeInteger(sample.nativePasses) || sample.nativePasses < 1
      || !Number.isSafeInteger(sample.sourceBytes) || sample.sourceBytes < 1
      || sample.sourceBytes > PUBLIC_GRAPH_BENCHMARK_MAX_SOURCE_BYTES
      || !isHexDigest(sample.sourceDigest) || !isHexDigest(sample.outputDigest)) {
    throw new TypeError("benchmark sample is incomplete");
  }
  validateNativeWork(provider, sample.nativeWork);
  if (digests && (sample.sourceDigest !== digests.sourceDigest || sample.outputDigest !== digests.outputDigest)) {
    throw new TypeError("benchmark samples do not have identical source and output digests");
  }
  return sample;
}

function validateReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new TypeError("benchmark receipt must be an object");
  }
  const expectedKeys = ["schemaVersion", "mode", "provider", "timingBoundary", "telemetryFormat", "workloadId",
    "profile", "ownerCount", "dayCount", "targetDay", "quotaObservations", "usageEvents", "totalRows", "fixedNow", "iterations",
    "warmupIterations", "rowsPerStreamPerDay", "rowsPerDay", "outputScope", "fullHistoryQualified",
    "equivalentWorkQualified", "equivalentWorkReason", "nativePasses", "sourceBytes", "samples", "warmupSamples",
    "elapsedSummary", "overallWallSummary", "fullBuild", "coldStart", "published", "readbackRows", "sourceDigest",
    "outputDigest", "elapsedMs", "overallWallMs"].sort();
  if (Object.keys(receipt).sort().join("\0") !== expectedKeys.join("\0")) {
    throw new TypeError("benchmark receipt has missing or unexpected fields");
  }
  const expected = publicGraphWorkload(receipt.profile);
  if (receipt.schemaVersion !== PUBLIC_GRAPH_BENCHMARK_VERSION
      || !["local-development", "hosted-synthetic"].includes(receipt.mode)
      || !["d1", "postgres"].includes(receipt.provider)
      || receipt.timingBoundary !== PUBLIC_GRAPH_BENCHMARK_TIMING_BOUNDARY
      || receipt.telemetryFormat !== "v1.1"
      || receipt.workloadId !== expected.workloadId
      || receipt.ownerCount !== expected.ownerCount
      || receipt.dayCount !== expected.days.length
      || receipt.targetDay !== expected.targetDay
      || receipt.quotaObservations !== expected.quotaObservations
      || receipt.usageEvents !== expected.usageEvents
      || receipt.totalRows !== expected.totalRows
      || receipt.fixedNow !== expected.fixedNow
      || ![1, PUBLIC_GRAPH_BENCHMARK_STRESS_MEASURED_RUNS].includes(receipt.iterations)
      || !Number.isSafeInteger(receipt.warmupIterations) || receipt.warmupIterations < 0
      || receipt.warmupIterations !== (receipt.iterations === 1 ? 0 : PUBLIC_GRAPH_BENCHMARK_STRESS_WARMUP_RUNS)
      || receipt.rowsPerStreamPerDay !== expected.rowsPerStreamPerDay
      || receipt.rowsPerDay !== expected.rowsPerDay
      || receipt.outputScope !== "single-selected-day"
      || receipt.fullHistoryQualified !== false
      || receipt.equivalentWorkQualified !== false
      || receipt.equivalentWorkReason !== "native-path-work-differs"
      || !Number.isSafeInteger(receipt.nativePasses) || receipt.nativePasses < 1
      || receipt.fullBuild !== true || receipt.coldStart !== true || receipt.published !== true
      || receipt.readbackRows !== 1
      || !Number.isFinite(receipt.elapsedMs) || receipt.elapsedMs < 0
      || !Number.isFinite(receipt.overallWallMs) || receipt.overallWallMs < receipt.elapsedMs
      || !isHexDigest(receipt.sourceDigest) || !isHexDigest(receipt.outputDigest)) {
    throw new TypeError("benchmark receipt failed schema or workload validation");
  }
  if (!Array.isArray(receipt.samples) || receipt.samples.length !== receipt.iterations
      || !Array.isArray(receipt.warmupSamples) || receipt.warmupSamples.length !== receipt.warmupIterations) {
    throw new TypeError("benchmark receipt sample counts are inconsistent");
  }
  const digests = { sourceDigest: receipt.sourceDigest, outputDigest: receipt.outputDigest };
  for (const sample of [...receipt.warmupSamples, ...receipt.samples]) validateSample(receipt.provider, sample, digests);
  if ([...receipt.warmupSamples, ...receipt.samples].some((sample) => sample.sourceBytes !== receipt.sourceBytes)) {
    throw new TypeError("benchmark source byte count changed between trials");
  }
  const elapsedSummary = summarize(receipt.samples.map((sample) => sample.elapsedMs));
  const overallWallSummary = summarize(receipt.samples.map((sample) => sample.overallWallMs));
  if (!exactKeys(receipt.elapsedSummary, ["minMs", "medianMs", "maxMs", "medianAbsoluteDeviationMs"])
      || !exactKeys(receipt.overallWallSummary, ["minMs", "medianMs", "maxMs", "medianAbsoluteDeviationMs"])
      || canonicalBenchmarkJson(receipt.elapsedSummary) !== canonicalBenchmarkJson(elapsedSummary)
      || canonicalBenchmarkJson(receipt.overallWallSummary) !== canonicalBenchmarkJson(overallWallSummary)
      || receipt.elapsedMs !== elapsedSummary.medianMs
      || receipt.overallWallMs !== overallWallSummary.medianMs
      || receipt.nativePasses !== median(receipt.samples.map((sample) => sample.nativePasses))) {
      throw new TypeError("benchmark receipt summary does not match its measured samples");
  }
}

export function createPublicGraphBenchmarkReceipt(input) {
  const workload = publicGraphWorkload(input?.profile);
  const samples = input?.samples ?? [{ elapsedMs: input?.elapsedMs, overallWallMs: input?.overallWallMs ?? input?.elapsedMs,
    nativePasses: input?.nativePasses, nativeWork: input?.nativeWork, sourceDigest: input?.sourceDigest,
    sourceBytes: input?.sourceBytes, outputDigest: input?.outputDigest }];
  const warmupSamples = input?.warmupSamples ?? [];
  if (!Array.isArray(samples) || !samples.length || !Array.isArray(warmupSamples)) {
    throw new TypeError("public graph benchmark samples are required");
  }
  const digests = { sourceDigest: input?.sourceDigest, outputDigest: input?.outputDigest };
  for (const sample of [...warmupSamples, ...samples]) validateSample(input?.provider, sample, digests);
  const elapsedSummary = summarize(samples.map((sample) => sample.elapsedMs));
  const overallWallSummary = summarize(samples.map((sample) => sample.overallWallMs));
  const nativePasses = median(samples.map((sample) => sample.nativePasses));
  const sourceBytes = samples[0]?.sourceBytes;
  if (input?.format !== "v1.1" || input?.fullBuild !== true || input?.coldStart !== true
      || input?.published !== true || !Number.isSafeInteger(input?.readbackRows) || input.readbackRows < 1
      || input?.readbackRows !== 1
      || ![1, PUBLIC_GRAPH_BENCHMARK_STRESS_MEASURED_RUNS].includes(samples.length)
      || (input?.iterations !== undefined && input.iterations !== samples.length)
      || warmupSamples.length !== (samples.length === 1 ? 0 : PUBLIC_GRAPH_BENCHMARK_STRESS_WARMUP_RUNS)
      || (input?.warmupIterations !== undefined && input.warmupIterations !== warmupSamples.length)
      || !Number.isSafeInteger(nativePasses) || nativePasses < 1
      || [...samples, ...warmupSamples].some((sample) => sample.sourceBytes !== sourceBytes)
      || !isHexDigest(input?.sourceDigest) || !isHexDigest(input?.outputDigest)
      || input?.timingBoundary !== PUBLIC_GRAPH_BENCHMARK_TIMING_BOUNDARY
      || !["local-development", "hosted-synthetic"].includes(input?.mode)
      || !["d1", "postgres"].includes(input?.provider)) {
    throw new TypeError("public graph benchmark receipt is incomplete");
  }
  return Object.freeze({
    schemaVersion: PUBLIC_GRAPH_BENCHMARK_VERSION,
    mode: input.mode,
    provider: input.provider,
    timingBoundary: input.timingBoundary,
    telemetryFormat: "v1.1",
    workloadId: workload.workloadId,
    profile: workload.profile,
    ownerCount: workload.ownerCount,
    dayCount: workload.days.length,
    targetDay: workload.targetDay,
    quotaObservations: workload.quotaObservations,
    usageEvents: workload.usageEvents,
    totalRows: workload.totalRows,
    fixedNow: workload.fixedNow,
    rowsPerStreamPerDay: workload.rowsPerStreamPerDay,
    rowsPerDay: workload.rowsPerDay,
    iterations: samples.length,
    warmupIterations: warmupSamples.length,
    nativePasses,
    sourceBytes,
    samples: Object.freeze(samples.map((sample) => Object.freeze({ ...sample, nativeWork: Object.freeze({ ...sample.nativeWork }) }))),
    warmupSamples: Object.freeze(warmupSamples.map((sample) => Object.freeze({ ...sample, nativeWork: Object.freeze({ ...sample.nativeWork }) }))),
    elapsedSummary,
    overallWallSummary,
    fullBuild: true,
    coldStart: true,
    published: true,
    readbackRows: 1,
    outputScope: "single-selected-day",
    fullHistoryQualified: false,
    equivalentWorkQualified: false,
    equivalentWorkReason: "native-path-work-differs",
    sourceDigest: input.sourceDigest,
    outputDigest: input.outputDigest,
    elapsedMs: elapsedSummary.medianMs,
    overallWallMs: overallWallSummary.medianMs,
  });
}

export function comparePublicGraphBenchmarkReceipts(receipts) {
  if (!Array.isArray(receipts) || receipts.length !== 2) {
    throw new TypeError("exactly two provider receipts are required");
  }
  const byProvider = new Map(receipts.map((receipt) => [receipt?.provider, receipt]));
  const d1 = byProvider.get("d1");
  const postgres = byProvider.get("postgres");
  if (!d1 || !postgres || d1.provider === postgres.provider) {
    throw new TypeError("one D1 receipt and one PostgreSQL receipt are required");
  }
  validateReceipt(d1);
  validateReceipt(postgres);
  const invariantFields = ["schemaVersion", "mode", "timingBoundary", "telemetryFormat", "workloadId", "profile",
    "ownerCount", "dayCount", "targetDay", "quotaObservations", "usageEvents", "totalRows", "fixedNow", "iterations",
    "warmupIterations", "rowsPerStreamPerDay", "rowsPerDay", "outputScope", "fullHistoryQualified", "equivalentWorkQualified",
    "equivalentWorkReason", "fullBuild", "coldStart", "published", "readbackRows", "sourceBytes", "sourceDigest", "outputDigest"];
  const mismatches = invariantFields.filter((field) => d1[field] !== postgres[field]);
  if (mismatches.length) {
    throw new Error(`provider receipts are not comparable: ${mismatches.join(",")}`);
  }
  const latencyRatio = postgres.elapsedMs === 0 ? null : d1.elapsedMs / postgres.elapsedMs;
  return Object.freeze({
    status: "comparable-synthetic",
    profile: d1.profile,
    workloadId: d1.workloadId,
    sourceDigest: d1.sourceDigest,
    outputDigest: d1.outputDigest,
    d1ElapsedMs: d1.elapsedMs,
    postgresElapsedMs: postgres.elapsedMs,
    d1OverallWallMs: d1.overallWallMs,
    postgresOverallWallMs: postgres.overallWallMs,
    d1NativePasses: d1.nativePasses,
    postgresNativePasses: postgres.nativePasses,
    d1OverPostgresRatio: latencyRatio,
    equivalentWorkQualified: false,
    equivalentWorkReason: "native-path-work-differs",
    d1ElapsedSummary: d1.elapsedSummary,
    postgresElapsedSummary: postgres.elapsedSummary,
    d1NativeWorkSamples: d1.samples.map((sample) => sample.nativeWork),
    postgresNativeWorkSamples: postgres.samples.map((sample) => sample.nativeWork),
    hostedTenfoldClaimQualified: false,
    hostedClaimStatus: "not-established-by-local-receipt",
  });
}
