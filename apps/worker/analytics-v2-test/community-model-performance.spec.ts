// SPD-P2b: the A-2 community model performance fold
// (src/analytics-v2/compute-performance.ts). Pure: no database. Every record
// is synthetic and content-free; the opaque keys are fixture labels that the
// fold must never output.
//
// Golden: analytics-v2-test/golden-performance/ holds a synthetic input
// (goldenInput() below, all three dictionaries, exclusions, a weekly span)
// and the fold's expected outputs. Regenerate both, and SOURCE.json's
// digests, only for an intended fold change:
//   ANALYTICS_V2_PERFORMANCE_GOLDEN_WRITE=1 npx vitest run \
//     --config vitest.analytics-v2.config.mjs analytics-v2-test/community-model-performance.spec.ts
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMMUNITY_MODEL_PERFORMANCE_PERCENTILES,
  MAX_PERFORMANCE_COUNT,
  PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_21 as D0921,
  PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_29 as D0929,
  PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_10_10 as D1010,
  REVIEWED_MODEL_CATALOG,
  SPEED_BUCKET_UPPER_CENTI_TPS,
  SPEED_BUCKET_UPPER_CENTI_TPS_V2,
  TTFT_BUCKET_UPPER_MS,
  adaptTelemetryPerformanceRecord,
  buildCommunityModelPerformancePoint,
  buildPerformanceHistogram,
  parseCommunityModelPerformance,
  poolPerformanceHistograms,
  type CommunityModelPerformance,
  type CommunityModelPerformancePoint,
  type PerformanceFieldDictionaryVersion,
  type PerformanceHistogram,
  type PerformanceHistogramPool,
  type PerformanceSpeedMethod,
  type PerformanceSpeedMode,
  type TelemetryPerformanceRecord,
} from "@app-usagemonitor/telemetry-contract";
import { canonicalJson } from "../src/canonical-json";
import { sha256Hex } from "../src/crypto";
import {
  ANALYTICS_V2_PERFORMANCE_PERIODS,
  ANALYTICS_V2_PERFORMANCE_POOL_PAGE,
  ANALYTICS_V2_PERFORMANCE_SPEED_MODES,
  analyticsV2PerformanceContentSha256,
  computeAnalyticsV2Performance,
  type AnalyticsV2PerformanceCheckpoint,
  type AnalyticsV2PerformanceInput,
  type AnalyticsV2PerformanceOutputs,
  type AnalyticsV2PerformanceSourceRecord,
} from "../src/analytics-v2/compute-performance";

// Every poolPerformanceHistograms call the fold makes, to prove no call takes more than one page.
const poolCalls = vi.hoisted(() => ({ calls: 0, largest: 0 }));
vi.mock("@app-usagemonitor/telemetry-contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@app-usagemonitor/telemetry-contract")>();
  return {
    ...actual,
    poolPerformanceHistograms: (items: Parameters<typeof actual.poolPerformanceHistograms>[0]) => {
      poolCalls.calls += 1;
      if (items.length > poolCalls.largest) poolCalls.largest = items.length;
      return actual.poolPerformanceHistograms(items);
    },
  };
});

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = resolve(HERE, "golden-performance");
const DAY_MS = 86_400_000;
const NOW_MS = Date.parse("2026-10-11T12:00:00.000Z");
const TODAY = "2026-10-11";
const END = "2026-10-10";

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS)
  .toISOString().slice(0, 10);
const epochDay = (day: string): number => Date.parse(`${day}T00:00:00.000Z`) / DAY_MS;

/** A seeded PRNG (mulberry32) so every synthetic corpus is reproducible. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const random = prng(seed);
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
}

// ---- Synthetic records --------------------------------------------------

/** One synthetic turn: output tokens over a response duration, its first-token latency and its turn time. */
interface Turn { readonly tokens: number; readonly durationMs: number; readonly ttftMs: number | null; readonly turnMs: number }

interface RecordSpec {
  readonly participant: string;
  readonly device?: string;
  readonly report?: string;
  readonly day: string;
  readonly dictionary?: PerformanceFieldDictionaryVersion;
  readonly provider?: string;
  readonly modelId?: string;
  readonly speedMode?: PerformanceSpeedMode;
  readonly method?: PerformanceSpeedMethod;
  readonly turns: readonly Turn[];
}

const schemeOf = (dictionary: PerformanceFieldDictionaryVersion) =>
  (dictionary === D1010 ? "performance-histogram-v2" : "performance-histogram-v1") as const;

/** A turn whose output speed is `tokensPerSecond` (two decimals; a 100 s response). */
const turnAt = (tokensPerSecond: number, ttftMs: number | null = 800, turnMs = 4000): Turn =>
  ({ tokens: Math.round(tokensPerSecond * 100), durationMs: 100_000, ttftMs, turnMs });

function makeRecord(spec: RecordSpec): TelemetryPerformanceRecord {
  const dictionary = spec.dictionary ?? D0929;
  const scheme = schemeOf(dictionary);
  const speedMode = spec.speedMode ?? "standard";
  const method = spec.method ?? "receipt";
  const timed = method === "unavailable" ? [] : spec.turns;
  const ttfts = spec.turns.flatMap((turn) => (turn.ttftMs === null ? [] : [turn.ttftMs]));
  const record = {
    schemaVersion: "model-performance-daily-v1",
    day: spec.day,
    provider: spec.provider ?? "openai_codex",
    modelId: spec.modelId ?? "gpt-5.5",
    reasoningEffort: "medium",
    speedMethod: method,
    speedMode,
    speedModeSource: speedMode === "unknown" ? "unobserved" : speedMode === "mixed" ? "mixed" : "rollout_thread_settings",
    apiServiceTier: "standard",
    measurementVersion: "model-performance-samples-v1",
    bucketSchemeVersion: scheme,
    turns: spec.turns.length,
    speedTurns: timed.length,
    ttftTurns: ttfts.length,
    completionTurns: spec.turns.length,
    timedResponses: timed.length,
    speedTokens: timed.reduce((sum, turn) => sum + turn.tokens, 0),
    speedDurationMs: timed.reduce((sum, turn) => sum + turn.durationMs, 0),
    speedHistogram: buildPerformanceHistogram("speed", timed.map((turn) => turn.tokens * 1000 / turn.durationMs), scheme),
    ttftHistogram: buildPerformanceHistogram("ttft", ttfts, scheme),
    completionHistogram: buildPerformanceHistogram("turnDuration", spec.turns.map((turn) => turn.turnMs), scheme),
  } as TelemetryPerformanceRecord;
  // The fixture must itself be a valid record of its dictionary.
  adaptTelemetryPerformanceRecord(record, dictionary);
  return record;
}

function sourceRecord(spec: RecordSpec): AnalyticsV2PerformanceSourceRecord {
  const device = spec.device ?? `${spec.participant}-device`;
  return {
    participantKey: spec.participant,
    deviceKey: device,
    reportKey: spec.report ?? `${device}-${spec.day}`,
    reportDay: spec.day,
    fieldDictionaryVersion: spec.dictionary ?? D0929,
    record: makeRecord(spec),
  };
}

type Exclusion = { readonly participantKey: string; readonly day: string };
function excludedOnOf(exclusions: readonly Exclusion[] = []): AnalyticsV2PerformanceInput["excludedOn"] {
  const set = new Set(exclusions.map(({ participantKey, day }) => `${participantKey}\u0000${day}`));
  return (participantKey, day) => set.has(`${String(participantKey)}\u0000${day}`);
}

async function fold(records: readonly AnalyticsV2PerformanceSourceRecord[],
  extra: Partial<AnalyticsV2PerformanceInput> & { exclusions?: readonly Exclusion[] } = {}): Promise<AnalyticsV2PerformanceOutputs> {
  const { exclusions, ...rest } = extra;
  return computeAnalyticsV2Performance({ records, nowMs: NOW_MS, excludedOn: excludedOnOf(exclusions), ...rest });
}

/** The candidate of one slot, re-validated with the contract. */
function slot(outputs: AnalyticsV2PerformanceOutputs, period: string, speedMode: string): CommunityModelPerformance {
  const candidate = outputs.candidates.find((item) => item.period === period && item.speedMode === speedMode);
  expect(candidate, `${period}/${speedMode}`).toBeDefined();
  return parseCommunityModelPerformance(candidate?.payload);
}

function modelOf(payload: CommunityModelPerformance, modelId = "gpt-5.5") {
  const model = payload.models.find((item) => item.modelId === modelId);
  expect(model, modelId).toBeDefined();
  return model as CommunityModelPerformance["models"][number];
}

/** Every structural promise a non-withheld result makes. */
async function expectWellFormed(outputs: AnalyticsV2PerformanceOutputs): Promise<void> {
  expect(outputs.withheld).toBeNull();
  expect(outputs.candidates.map((item) => `${item.period}/${item.speedMode}`)).toEqual(
    ANALYTICS_V2_PERFORMANCE_PERIODS.flatMap((period) => ANALYTICS_V2_PERFORMANCE_SPEED_MODES.map((mode) => `${period}/${mode}`)),
  );
  for (const candidate of outputs.candidates) {
    const payload = parseCommunityModelPerformance(candidate.payload);
    expect(payload.period).toBe(candidate.period);
    expect(payload.speedMode).toBe(candidate.speedMode);
    expect(payload.revision).toBe(1);
    expect(payload.generatedAt).toBe(new Date(NOW_MS).toISOString());
    expect(payload.end).toBe(outputs.summary.end);
    expect(candidate.payloadSha256).toBe(await analyticsV2PerformanceContentSha256(candidate.payload));
    const catalogOrder = payload.models.map((model) => REVIEWED_MODEL_CATALOG
      .findIndex((entry) => entry.provider === model.provider && entry.id === model.modelId));
    expect(catalogOrder.every((index) => index >= 0)).toBe(true);
    expect([...catalogOrder].sort((left, right) => left - right)).toEqual(catalogOrder);
  }
}

beforeEach(() => {
  poolCalls.calls = 0;
  poolCalls.largest = 0;
});

// ---- An independent Type-7 bounds oracle --------------------------------
//
// Each raw sample lies in a closed interval [low, high]: its bucket, clamped
// to the pooled extrema; a v1 speed sample at or above 120 tokens/second
// (the v1 overflow) only to [max(120, pool min), pool max]. The k-th smallest
// true value lies between the k-th smallest low and the k-th smallest high,
// so Type-7 interpolation of those order statistics bounds the Type-7
// quantile. Coded here from the bucket edges alone, without the contract's
// pool or quantile functions.

interface RawSample { readonly value: number; readonly scheme: "performance-histogram-v1" | "performance-histogram-v2" }
const PERCENTILE_FRACTIONS: Record<string, [number, number]> = { p10: [1, 10], p25: [1, 4], median: [1, 2], p75: [3, 4], p90: [9, 10] };

function speedIntervals(samples: readonly RawSample[]): [number, number][] {
  const minimum = Math.min(...samples.map(({ value }) => Math.floor(value * 100))) / 100;
  const maximum = Math.max(...samples.map(({ value }) => Math.ceil(value * 100))) / 100;
  const v1Top = SPEED_BUCKET_UPPER_CENTI_TPS.at(-1) as number;
  return samples.map(({ value, scheme }) => {
    const centi = value * 100;
    if (scheme === "performance-histogram-v1" && centi >= v1Top) return [Math.max(v1Top / 100, minimum), maximum];
    const edges = SPEED_BUCKET_UPPER_CENTI_TPS_V2;
    const index = edges.findIndex((upper) => centi < upper);
    const [low, high] = index < 0 ? [(edges.at(-1) as number) / 100, maximum]
      : [index === 0 ? 0 : (edges[index - 1] as number) / 100, (edges[index] as number) / 100];
    return [Math.max(low, minimum), Math.min(high, maximum)];
  });
}

function ttftIntervals(values: readonly number[]): [number, number][] {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const edges = TTFT_BUCKET_UPPER_MS;
  return values.map((value) => {
    let low: number;
    let high: number;
    if (value === 0) [low, high] = [0, 0];
    else if (value < (edges[1] as number)) [low, high] = [1, (edges[1] as number) - 1];
    else {
      const index = edges.findIndex((upper, at) => at >= 2 && value < upper);
      [low, high] = index < 0 ? [edges.at(-1) as number, Number.MAX_SAFE_INTEGER]
        : [edges[index - 1] as number, (edges[index] as number) - 1];
    }
    return [Math.max(low, minimum), Math.min(high, maximum)];
  });
}

function type7(sorted: readonly number[], numerator: number, denominator: number): number {
  const rank = (sorted.length - 1) * numerator;
  const lower = Math.floor(rank / denominator);
  const remainder = rank % denominator;
  const upper = remainder === 0 ? lower : lower + 1;
  return (sorted[lower] as number) + ((sorted[upper] as number) - (sorted[lower] as number)) * (remainder / denominator);
}

function oracleBounds(intervals: readonly [number, number][], numerator: number, denominator: number) {
  const lows = intervals.map(([low]) => low).sort((left, right) => left - right);
  const highs = intervals.map(([, high]) => high).sort((left, right) => left - right);
  return { lower: type7(lows, numerator, denominator), upper: type7(highs, numerator, denominator) };
}

/** A published point against the oracle and the exact Type-7 quantile of the raw values. */
function expectPointMatchesOracle(point: CommunityModelPerformancePoint, intervals: readonly [number, number][],
  rawValues: readonly number[]): void {
  expect(point.n).toBe(rawValues.length);
  const exact = [...rawValues].sort((left, right) => left - right);
  for (const name of COMMUNITY_MODEL_PERFORMANCE_PERCENTILES) {
    const published = point[name];
    if (rawValues.length < 5 && name !== "median") {
      expect(published, name).toBeNull();
      continue;
    }
    expect(published, name).not.toBeNull();
    const [numerator, denominator] = PERCENTILE_FRACTIONS[name] as [number, number];
    const oracle = oracleBounds(intervals, numerator, denominator);
    const tolerance = 1e-9 * Math.max(1, oracle.upper);
    const band = published as NonNullable<typeof published>;
    // Outward rounding to three decimals: never inside the oracle's interval, never more than 0.001 outside.
    expect(band.lower, `${name} lower`).toBeLessThanOrEqual(oracle.lower + tolerance);
    expect(band.lower, `${name} lower`).toBeGreaterThanOrEqual(Math.max(0, oracle.lower - 0.001) - 0.001 - tolerance);
    expect(band.upper, `${name} upper`).toBeGreaterThanOrEqual(oracle.upper - tolerance);
    expect(band.upper, `${name} upper`).toBeLessThanOrEqual(oracle.upper + 0.002 + tolerance);
    const truth = type7(exact, numerator, denominator);
    expect(truth, `${name} exact`).toBeGreaterThanOrEqual(band.lower - tolerance);
    expect(truth, `${name} exact`).toBeLessThanOrEqual(band.upper + tolerance);
    expect(band.estimate).toBeGreaterThanOrEqual(band.lower);
    expect(band.estimate).toBeLessThanOrEqual(band.upper);
  }
}

// ---- The golden corpus --------------------------------------------------

const GOLDEN_SCHEMA = "analytics-v2-performance-golden-input-v1";
const GOLDEN_MODELS = ["gpt-6-sol", "gpt-5.5", "gpt-5.3-codex-spark", "gpt-5.6-terra"] as const;

/** The golden input: deterministic and synthetic (participants, devices and reports are fixture labels). */
function goldenInput() {
  const random = prng(20261011);
  const records: AnalyticsV2PerformanceSourceRecord[] = [];
  const speedFor = (modelId: string) => (modelId === "gpt-5.3-codex-spark" ? 180 + random() * 260
    : modelId === "gpt-6-sol" ? 35 + random() * 50 : 20 + random() * 60);
  const turnsFor = (modelId: string, count: number) => Array.from({ length: count }, () => {
    const tokensPerSecond = Math.round(speedFor(modelId) * 100) / 100;
    return { tokens: Math.round(tokensPerSecond * 15), durationMs: 15_000,
      ttftMs: random() < 0.15 ? null : Math.round(300 + random() * 4_000), turnMs: Math.round(5_000 + random() * 60_000) };
  });
  for (let index = 0; index < 6; index += 1) {
    const participant = `golden-participant-${String(index + 1).padStart(2, "0")}`;
    const dictionary = index < 2 ? D0921 : index < 4 ? D0929 : D1010;
    for (let back = 0; back < 31; back += 1) {
      if (random() < 0.55) continue;
      const day = addDays(END, -back);
      for (const modelId of GOLDEN_MODELS) {
        if (random() < 0.4) continue;
        const modes: PerformanceSpeedMode[] = ["standard", "fast", ...(dictionary === D0921 ? ["other" as const] : ["ultrafast" as const]),
          "unknown"];
        const speedMode = modes[Math.floor(random() * modes.length)] as PerformanceSpeedMode;
        const method: PerformanceSpeedMethod = random() < 0.2 ? "tool_free" : random() < 0.1 ? "unavailable" : "receipt";
        records.push(sourceRecord({ participant, device: `${participant}-device-${index % 2 === 0 ? "a" : "b"}`,
          day, dictionary, modelId, speedMode, method, turns: turnsFor(modelId, 1 + Math.floor(random() * 9)) }));
      }
    }
  }
  // A long Fast history, so period all publishes Monday-aligned weeks.
  for (let back = 380; back <= 520; back += 9) {
    records.push(sourceRecord({ participant: "golden-participant-07", day: addDays(END, -back), dictionary: D0929,
      speedMode: "fast", turns: turnsFor("gpt-5.5", 3) }));
  }
  // A latest-day Standard v2 cohort above 120 tokens/second.
  records.push(sourceRecord({ participant: "golden-participant-06", device: "golden-participant-06-device-c", day: END,
    dictionary: D1010, modelId: "gpt-5.3-codex-spark", turns: turnsFor("gpt-5.3-codex-spark", 6) }));
  // A future day the fold must defer.
  records.push(sourceRecord({ participant: "golden-participant-03", day: TODAY, dictionary: D0929,
    turns: turnsFor("gpt-5.5", 2) }));
  // Exclude the newest included day of two participants, so the corpus always exercises N-EXCL.
  const exclusions: Exclusion[] = ["golden-participant-02", "golden-participant-05"].map((participantKey) => ({
    participantKey,
    day: records.filter((record) => record.participantKey === participantKey)
      .map((record) => record.reportDay as string).sort().at(-1) as string,
  }));
  return { schemaVersion: GOLDEN_SCHEMA, nowMs: NOW_MS, exclusions, records };
}

function goldenText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The golden input as JSON with one record per line (compact, reviewable). */
function goldenInputText(input: ReturnType<typeof goldenInput>): string {
  const { records, ...rest } = input;
  const head = JSON.stringify(rest);
  return `${head.slice(0, -1)},"records":[\n${records.map((record) => JSON.stringify(record)).join(",\n")}\n]}\n`;
}

/** The fold's outputs as JSON with one candidate per line. */
function goldenOutputsText(outputs: AnalyticsV2PerformanceOutputs): string {
  const head = JSON.stringify({ withheld: outputs.withheld, summary: outputs.summary });
  return `${head.slice(0, -1)},"candidates":[\n${outputs.candidates.map((candidate) => JSON.stringify(candidate)).join(",\n")}\n]}\n`;
}

const fileSha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

// ---- Tests --------------------------------------------------------------

describe("computeAnalyticsV2Performance: shape", () => {
  it("folds an empty record set into the 12 empty slots, withheld null", async () => {
    const outputs = await fold([]);
    await expectWellFormed(outputs);
    expect(outputs.candidates).toHaveLength(12);
    for (const candidate of outputs.candidates) {
      const payload = parseCommunityModelPerformance(candidate.payload);
      expect(payload).toMatchObject({ models: [], contributors: 0, devices: 0, reports: 0, excludedUnknownTurns: 0,
        end: END, interval: "day" });
      expect(payload.start).toBe(candidate.period === "all" ? END : addDays(END, -(Number(candidate.period) - 1)));
    }
    expect(outputs.summary).toEqual({ reports: 0, cohorts: 0, includedRecords: 0, excludedRecords: 0,
      excludedUnknownTurns: 0, deferredFutureDays: 0, end: END });
  });

  it("stamps placeholders only, and identifies content without revision and generatedAt", async () => {
    const outputs = await fold([sourceRecord({ participant: "p-1", day: END, turns: [turnAt(40)] })]);
    await expectWellFormed(outputs);
    const later = await computeAnalyticsV2Performance({ records: [sourceRecord({ participant: "p-1", day: END, turns: [turnAt(40)] })],
      nowMs: NOW_MS + 3_600_000, excludedOn: () => false });
    for (const [index, candidate] of outputs.candidates.entries()) {
      const { revision: _revision, generatedAt: _generatedAt, ...content } = candidate.payload;
      expect(candidate.payloadSha256).toBe(await sha256Hex(canonicalJson(content)));
      // The same day an hour later: same content, so same digest, another generatedAt.
      expect(later.candidates[index]?.payloadSha256).toBe(candidate.payloadSha256);
      expect(later.candidates[index]?.payload.generatedAt).not.toBe(candidate.payload.generatedAt);
    }
  });

  it("never outputs a participant, device or report key", async () => {
    const records = [
      sourceRecord({ participant: "secret-participant-key-1", device: "secret-device-key-1", report: "secret-report-key-1",
        day: END, turns: [turnAt(30), turnAt(50)] }),
      sourceRecord({ participant: "secret-participant-key-2", device: "secret-device-key-2", report: "secret-report-key-2",
        day: addDays(END, -2), speedMode: "fast", turns: [turnAt(70)] }),
    ];
    const outputs = await fold(records);
    await expectWellFormed(outputs);
    expect(JSON.stringify(outputs)).not.toMatch(/secret-/u);
  });
});

describe("computeAnalyticsV2Performance: dictionaries and buckets", () => {
  it("accepts all three dictionaries, excludes 2026-09-21.1 other, and resolves v2 above 120 tokens/second", async () => {
    const records = [
      sourceRecord({ participant: "p-0921", day: END, dictionary: D0921, turns: [turnAt(40), turnAt(45)] }),
      sourceRecord({ participant: "p-0921", day: END, dictionary: D0921, speedMode: "other", report: "r-0921-b",
        turns: [turnAt(300), turnAt(310), turnAt(320)] }),
      sourceRecord({ participant: "p-0929", day: END, dictionary: D0929, speedMode: "ultrafast", turns: [turnAt(90)] }),
      sourceRecord({ participant: "p-1010", day: END, dictionary: D1010, modelId: "gpt-5.3-codex-spark",
        turns: [turnAt(408)] }),
      sourceRecord({ participant: "p-1010", day: END, dictionary: D1010, speedMode: "mixed", report: "r-1010-b",
        turns: [turnAt(20)] }),
      sourceRecord({ participant: "p-0929", day: END, dictionary: D0929, speedMode: "unknown", report: "r-0929-b",
        turns: [turnAt(20), turnAt(25)] }),
    ];
    const outputs = await fold(records);
    await expectWellFormed(outputs);
    // other (3), mixed (1) and unknown (2) only count as excluded unknown turns, in every slot of the window.
    expect(outputs.summary).toMatchObject({ includedRecords: 3, excludedUnknownTurns: 6, cohorts: 6, reports: 6 });
    for (const candidate of outputs.candidates) expect(candidate.payload.excludedUnknownTurns).toBe(6);
    const standard = slot(outputs, "1", "standard");
    expect(standard.models.map((model) => model.modelId)).toEqual(["gpt-5.3-codex-spark", "gpt-5.5"]);
    expect(modelOf(standard).turns).toBe(2);
    const spark = modelOf(standard, "gpt-5.3-codex-spark");
    const point = spark.speed.points[0] as CommunityModelPerformancePoint;
    expect(point).toMatchObject({ day: END, n: 1, unresolved: 0 });
    // 408 tokens/second lands in a resolved v2 bucket: its bounds sit far above 120.
    expect(point.median?.lower).toBeGreaterThan(400);
    expect(point.median?.upper).toBeLessThan(420);
    expect(slot(outputs, "1", "ultrafast").models.map((model) => [model.modelId, model.turns])).toEqual([["gpt-5.5", 1]]);
    expect(slot(outputs, "1", "fast").models).toEqual([]);
  });

  it("keeps a v1 speed overflow unresolved and widens its bounds to the pooled maximum", async () => {
    const outputs = await fold([
      sourceRecord({ participant: "p-v1", day: END, dictionary: D0929, turns: [turnAt(200), turnAt(40), turnAt(41), turnAt(42),
        turnAt(43), turnAt(260)] }),
    ]);
    await expectWellFormed(outputs);
    const point = modelOf(slot(outputs, "1", "standard")).speed.points[0] as CommunityModelPerformancePoint;
    expect(point).toMatchObject({ n: 6, unresolved: 2 });
    // The top two samples are only known to be in [120, 260]: p90 cannot claim more.
    expect(point.p90?.lower).toBeGreaterThanOrEqual(120 - 0.001);
    expect(point.p90?.upper).toBeGreaterThanOrEqual(260);
    expectPointMatchesOracle(point, speedIntervals([200, 40, 41, 42, 43, 260]
      .map((value) => ({ value, scheme: "performance-histogram-v1" as const }))), [200, 40, 41, 42, 43, 260]);
  });

  it("keeps only the median below five samples", async () => {
    const outputs = await fold([
      sourceRecord({ participant: "p-a", day: END, turns: [turnAt(30), turnAt(31), turnAt(33), turnAt(35)] }),
      sourceRecord({ participant: "p-b", day: addDays(END, -1), turns: [turnAt(30), turnAt(31), turnAt(33), turnAt(35), turnAt(36)] }),
    ]);
    await expectWellFormed(outputs);
    const [before, last] = modelOf(slot(outputs, "7", "standard")).speed.points as CommunityModelPerformancePoint[];
    expect(last).toMatchObject({ day: END, n: 4, p10: null, p25: null, p75: null, p90: null });
    expect(last?.median).not.toBeNull();
    expect(before?.n).toBe(5);
    for (const name of COMMUNITY_MODEL_PERFORMANCE_PERCENTILES) expect(before?.[name]).not.toBeNull();
  });
});

describe("computeAnalyticsV2Performance: windows and bins", () => {
  it("bounds periods 1, 7 and 30 at end and starts period all at the first included day", async () => {
    const days = [0, 1, 6, 7, 29, 30, 45].map((back) => addDays(END, -back));
    const outputs = await fold(days.map((day, index) => sourceRecord({ participant: `p-${index}`, day, turns: [turnAt(30 + index)] })));
    await expectWellFormed(outputs);
    const daysOf = (period: string) => modelOf(slot(outputs, period, "standard")).speed.points.map((point) => point.day);
    expect(daysOf("1")).toEqual([END]);
    expect(daysOf("7")).toEqual([addDays(END, -6), addDays(END, -1), END]);
    expect(daysOf("30")).toEqual([addDays(END, -29), addDays(END, -7), addDays(END, -6), addDays(END, -1), END]);
    expect(daysOf("all")).toHaveLength(7);
    expect(slot(outputs, "1", "standard")).toMatchObject({ start: END, contributors: 1, devices: 1, reports: 1 });
    expect(slot(outputs, "7", "standard")).toMatchObject({ start: addDays(END, -6), contributors: 3 });
    expect(slot(outputs, "30", "standard")).toMatchObject({ start: addDays(END, -29), contributors: 5 });
    expect(slot(outputs, "all", "standard")).toMatchObject({ start: addDays(END, -45), interval: "day", contributors: 7 });
    // A mode with no included record starts and ends at end.
    expect(slot(outputs, "all", "fast")).toMatchObject({ start: END, end: END, interval: "day", models: [] });
  });

  it("switches period all from days to Monday-aligned weeks once the span exceeds 366 days", async () => {
    const at366 = await fold([
      sourceRecord({ participant: "p-1", day: addDays(END, -366), turns: [turnAt(30)] }),
      sourceRecord({ participant: "p-1", day: END, turns: [turnAt(32)] }),
    ]);
    await expectWellFormed(at366);
    expect(slot(at366, "all", "standard")).toMatchObject({ interval: "day", start: addDays(END, -366) });
    expect(modelOf(slot(at366, "all", "standard")).speed.points.map((point) => point.day)).toEqual([addDays(END, -366), END]);

    // 367 days: weekly. Several days of one week share a single Monday bin.
    const days = [367, 300, 12, 11, 10, 9, 8, 7, 0].map((back) => addDays(END, -back));
    const speeds = [30, 31, 32, 33, 34, 35, 36, 37, 38];
    const weekly = await fold(days.map((day, index) => sourceRecord({ participant: `p-${index}`, day, turns: [turnAt(speeds[index] as number)] })));
    await expectWellFormed(weekly);
    const all = slot(weekly, "all", "standard");
    expect(all).toMatchObject({ interval: "week", start: addDays(END, -367), end: END });
    const points = modelOf(all).speed.points;
    for (const point of points) expect(new Date(`${point.day}T00:00:00.000Z`).getUTCDay()).toBe(1);
    const mondayOf = (day: string) => { const epoch = epochDay(day); return epoch - ((((epoch - 4) % 7) + 7) % 7); };
    const expectedBins = new Map<number, number[]>();
    days.forEach((day, index) => {
      const bin = mondayOf(day);
      expectedBins.set(bin, [...(expectedBins.get(bin) ?? []), speeds[index] as number]);
    });
    expect(points.map((point) => [epochDay(point.day), point.n])).toEqual([...expectedBins]
      .sort(([left], [right]) => left - right).map(([bin, values]) => [bin, values.length]));
    // The first bin's Monday may fall before start; it still ends on or after start.
    expect(epochDay(points[0]?.day as string)).toBeLessThanOrEqual(epochDay(all.start));
    for (const point of points) {
      const values = expectedBins.get(epochDay(point.day)) as number[];
      expectPointMatchesOracle(point, speedIntervals(values.map((value) => ({ value, scheme: "performance-histogram-v1" }))), values);
    }
    // Periods 1, 7 and 30 keep day points.
    expect(slot(weekly, "30", "standard").interval).toBe("day");
  });

  it("defers days after the latest completed UTC day", async () => {
    const outputs = await fold([
      sourceRecord({ participant: "p-1", day: END, turns: [turnAt(30)] }),
      sourceRecord({ participant: "p-1", day: TODAY, turns: [turnAt(31)] }),
      sourceRecord({ participant: "p-2", day: TODAY, turns: [turnAt(32)] }),
      sourceRecord({ participant: "p-2", day: addDays(TODAY, 1), turns: [turnAt(33)] }),
    ]);
    await expectWellFormed(outputs);
    expect(outputs.summary).toMatchObject({ end: END, deferredFutureDays: 2, includedRecords: 1, cohorts: 4, reports: 4 });
    expect(modelOf(slot(outputs, "all", "standard")).turns).toBe(1);
    expect(slot(outputs, "all", "standard")).toMatchObject({ end: END, contributors: 1, reports: 1 });
  });
});

describe("computeAnalyticsV2Performance: counts", () => {
  it("drops excluded participant-days before anything is counted", async () => {
    const records = [
      sourceRecord({ participant: "p-1", day: END, turns: [turnAt(30)] }),
      sourceRecord({ participant: "p-2", day: END, turns: [turnAt(80), turnAt(81)] }),
      sourceRecord({ participant: "p-2", day: addDays(END, -1), turns: [turnAt(82)] }),
      sourceRecord({ participant: "p-2", day: END, speedMode: "unknown", report: "p-2-unknown", turns: [turnAt(10)] }),
    ];
    const outputs = await fold(records, { exclusions: [{ participantKey: "p-2", day: END }] });
    await expectWellFormed(outputs);
    expect(outputs.summary).toMatchObject({ excludedRecords: 2, includedRecords: 2, excludedUnknownTurns: 0 });
    expect(slot(outputs, "1", "standard")).toMatchObject({ contributors: 1, devices: 1, reports: 1 });
    expect(modelOf(slot(outputs, "1", "standard"))).toMatchObject({ turns: 1, contributors: 1 });
    expect(slot(outputs, "7", "standard")).toMatchObject({ contributors: 2, reports: 2 });
    const unexcluded = await fold(records);
    expect(slot(unexcluded, "1", "standard")).toMatchObject({ contributors: 2, excludedUnknownTurns: 1 });
  });

  it("counts turns, timed responses, tool-free turns and distinct sources per model and per slot", async () => {
    const outputs = await fold([
      sourceRecord({ participant: "p-1", device: "d-1", day: END, method: "receipt", turns: [turnAt(30), turnAt(31)] }),
      sourceRecord({ participant: "p-1", device: "d-2", day: END, method: "tool_free", turns: [turnAt(32), turnAt(33), turnAt(34)] }),
      sourceRecord({ participant: "p-2", device: "d-3", day: END, method: "unavailable", turns: [turnAt(35, null)] }),
      sourceRecord({ participant: "p-3", device: "d-4", day: END, modelId: "gpt-6-sol", turns: [turnAt(50)] }),
      sourceRecord({ participant: "p-4", device: "d-5", day: END, speedMode: "fast", turns: [turnAt(90)] }),
    ]);
    await expectWellFormed(outputs);
    const standard = slot(outputs, "1", "standard");
    expect(standard).toMatchObject({ contributors: 3, devices: 4, reports: 4 });
    expect(modelOf(standard)).toMatchObject({ turns: 6, speedTurns: 5, ttftTurns: 5, timedResponses: 5, toolFreeTurns: 3,
      contributors: 2, devices: 3 });
    expect(modelOf(standard).speed.points.map((point) => point.n)).toEqual([5]);
    expect(modelOf(standard, "gpt-6-sol")).toMatchObject({ turns: 1, contributors: 1, devices: 1 });
    expect(slot(outputs, "1", "fast")).toMatchObject({ contributors: 1, devices: 1, reports: 1 });
  });

  it("orders models by the reviewed catalog, whatever the input order", async () => {
    const ids = ["gpt-6-sol", "claude-opus-5", "gpt-5.5", "gpt-4o", "gpt-6.1-sol"];
    const records = ids.map((modelId, index) => sourceRecord({ participant: `p-${index}`, day: END, modelId,
      provider: modelId.startsWith("claude") ? "anthropic_claude_code" : "openai_codex", turns: [turnAt(30)] }));
    const outputs = await fold(records);
    await expectWellFormed(outputs);
    const expected = REVIEWED_MODEL_CATALOG.filter((entry) => ids.includes(entry.id)).map((entry) => entry.id);
    expect(slot(outputs, "1", "standard").models.map((model) => model.modelId)).toEqual(expected);
  });
});

describe("computeAnalyticsV2Performance: pooling", () => {
  it("pools more than 200 histograms in one bin exactly as one single-shot pool, never passing more than 200", async () => {
    const random = prng(7);
    const histograms: PerformanceHistogram[] = [];
    const records: AnalyticsV2PerformanceSourceRecord[] = [];
    const rawSpeeds: RawSample[] = [];
    const rawTtfts: number[] = [];
    const devices = new Set<string>();
    for (let index = 0; index < 450; index += 1) {
      devices.add(`${index % 37}/${index % 53}`);
      const dictionary = index % 3 === 0 ? D1010 : D0929;
      const speeds = [5 + random() * 300, 5 + random() * 60];
      const turns = speeds.map((speed) => turnAt(Math.round(speed * 100) / 100, Math.round(random() * 9_000)));
      const record = sourceRecord({ participant: `p-${index % 37}`, device: `d-${index % 53}`, report: `r-${index}`,
        day: END, dictionary, turns });
      records.push(record);
      histograms.push((record.record as TelemetryPerformanceRecord).speedHistogram);
      for (const turn of turns) {
        rawSpeeds.push({ value: turn.tokens * 1000 / turn.durationMs, scheme: schemeOf(dictionary) });
        rawTtfts.push(turn.ttftMs as number);
      }
    }
    const outputs = await fold(records);
    await expectWellFormed(outputs);
    expect(poolCalls.calls).toBeGreaterThan(0);
    expect(poolCalls.largest).toBeLessThanOrEqual(ANALYTICS_V2_PERFORMANCE_POOL_PAGE);
    const model = modelOf(slot(outputs, "1", "standard"));
    expect(model).toMatchObject({ turns: 900, speedTurns: 900, ttftTurns: 900, contributors: 37, devices: devices.size });

    // The single-shot reference: every histogram's buckets summed directly in the v2 index space.
    const buckets: Record<string, number> = {};
    let unresolvedCount = 0;
    let sampleCount = 0;
    for (const histogram of histograms) {
      sampleCount += histogram.sampleCount;
      for (const [key, count] of Object.entries(histogram.buckets)) {
        if (histogram.schemaVersion === "performance-histogram-v1" && Number(key) === SPEED_BUCKET_UPPER_CENTI_TPS.length) {
          unresolvedCount += count;
        } else buckets[key] = (buckets[key] ?? 0) + count;
      }
    }
    const reference = poolPerformanceHistograms([{
      schemaVersion: "performance-histogram-pool-v1",
      metric: "speed",
      sampleCount,
      buckets: Object.fromEntries(Object.keys(buckets).map(Number).sort((left, right) => left - right)
        .map((index) => [String(index), buckets[String(index)] as number])),
      unresolvedCount,
      min: Math.min(...histograms.map((histogram) => histogram.min as number)),
      max: Math.max(...histograms.map((histogram) => histogram.max as number)),
    } as PerformanceHistogramPool]);
    expect(model.speed.points).toEqual([buildCommunityModelPerformancePoint(END, reference)]);
    expectPointMatchesOracle(model.speed.points[0] as CommunityModelPerformancePoint, speedIntervals(rawSpeeds),
      rawSpeeds.map(({ value }) => value));
    expectPointMatchesOracle(model.ttft.points[0] as CommunityModelPerformancePoint, ttftIntervals(rawTtfts), rawTtfts);
  });

  it("matches the independent Type-7 bounds oracle on mixed v1 and v2 evidence", async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const random = prng(seed);
      const records: AnalyticsV2PerformanceSourceRecord[] = [];
      const rawSpeeds: RawSample[] = [];
      const rawTtfts: number[] = [];
      const count = 3 + Math.floor(random() * 30);
      for (let index = 0; index < count; index += 1) {
        const dictionary = [D0921, D0929, D1010][Math.floor(random() * 3)] as PerformanceFieldDictionaryVersion;
        const turns = Array.from({ length: 1 + Math.floor(random() * 4) }, () => turnAt(
          Math.round((1 + random() * (random() < 0.3 ? 2_000 : 150)) * 100) / 100,
          random() < 0.1 ? 0 : Math.round(random() * 400_000)));
        records.push(sourceRecord({ participant: `p-${index}`, day: END, dictionary, turns }));
        for (const turn of turns) {
          rawSpeeds.push({ value: turn.tokens * 1000 / turn.durationMs, scheme: schemeOf(dictionary) });
          rawTtfts.push(turn.ttftMs as number);
        }
      }
      const outputs = await fold(records);
      await expectWellFormed(outputs);
      const model = modelOf(slot(outputs, "1", "standard"));
      const [speed] = model.speed.points as CommunityModelPerformancePoint[];
      const [ttft] = model.ttft.points as CommunityModelPerformancePoint[];
      expect(speed?.unresolved).toBe(rawSpeeds.filter(({ value, scheme }) => scheme === "performance-histogram-v1"
        && value * 100 >= (SPEED_BUCKET_UPPER_CENTI_TPS.at(-1) as number)).length);
      expectPointMatchesOracle(speed as CommunityModelPerformancePoint, speedIntervals(rawSpeeds), rawSpeeds.map(({ value }) => value));
      expectPointMatchesOracle(ttft as CommunityModelPerformancePoint, ttftIntervals(rawTtfts), rawTtfts);
    }
  });
});

describe("computeAnalyticsV2Performance: determinism and the golden corpus", () => {
  it("leaves every digest and the summary unchanged under input permutation, sync or async", async () => {
    const { records, exclusions } = goldenInput();
    const reference = await fold(records, { exclusions });
    await expectWellFormed(reference);
    const digests = (outputs: AnalyticsV2PerformanceOutputs) => outputs.candidates.map((candidate) => candidate.payloadSha256);
    for (const seed of [11, 12, 13]) {
      const permuted = await fold(shuffled(records, seed), { exclusions });
      expect(digests(permuted)).toEqual(digests(reference));
      expect(permuted.summary).toEqual(reference.summary);
      expect(canonicalJson(permuted.candidates)).toBe(canonicalJson(reference.candidates));
    }
    async function* stream() { for (const record of shuffled(records, 99)) yield record; }
    const streamed = await computeAnalyticsV2Performance({ records: stream(), nowMs: NOW_MS, excludedOn: excludedOnOf(exclusions) });
    expect(digests(streamed)).toEqual(digests(reference));
  });

  it("reproduces the golden input and its expected outputs byte for byte", async () => {
    const input = goldenInput();
    const outputs = await computeAnalyticsV2Performance({ records: input.records, nowMs: input.nowMs,
      excludedOn: excludedOnOf(input.exclusions) });
    await expectWellFormed(outputs);
    const inputText = goldenInputText(input);
    const expectedText = goldenOutputsText(outputs);
    const files = { "input.json": inputText, "expected.json": expectedText };
    const source = {
      schemaVersion: "analytics-v2-performance-golden-source-v1",
      note: "Synthetic, content-free fixtures generated by goldenInput() in analytics-v2-test/community-model-performance.spec.ts; expected.json is the fold's output for input.json. Regenerate both only for an intended fold change, with ANALYTICS_V2_PERFORMANCE_GOLDEN_WRITE=1.",
      generator: "apps/worker/analytics-v2-test/community-model-performance.spec.ts",
      fold: "apps/worker/src/analytics-v2/compute-performance.ts",
      files: Object.entries(files).map(([path, text]) => ({ path, sha256: fileSha256(text) })),
    };
    if (process.env.ANALYTICS_V2_PERFORMANCE_GOLDEN_WRITE === "1") {
      for (const [path, text] of Object.entries(files)) writeFileSync(join(GOLDEN, path), text);
      writeFileSync(join(GOLDEN, "SOURCE.json"), goldenText(source));
    }
    expect(readFileSync(join(GOLDEN, "input.json"), "utf8")).toBe(inputText);
    expect(readFileSync(join(GOLDEN, "expected.json"), "utf8")).toBe(expectedText);
    expect(JSON.parse(readFileSync(join(GOLDEN, "SOURCE.json"), "utf8"))).toEqual(source);
    // The committed input folds to the committed expectation (JSON round trip of the input).
    const committed = JSON.parse(readFileSync(join(GOLDEN, "input.json"), "utf8")) as ReturnType<typeof goldenInput>;
    const replay = await computeAnalyticsV2Performance({ records: committed.records, nowMs: committed.nowMs,
      excludedOn: excludedOnOf(committed.exclusions) });
    expect(goldenOutputsText(replay)).toBe(expectedText);
    // The corpus exercises what it claims to.
    expect(outputs.summary.deferredFutureDays).toBe(1);
    expect(outputs.summary.excludedRecords).toBeGreaterThan(0);
    expect(outputs.summary.excludedUnknownTurns).toBeGreaterThan(0);
    expect(new Set(committed.records.map((record) => record.fieldDictionaryVersion))).toEqual(new Set([D0921, D0929, D1010]));
    expect(slot(outputs, "all", "fast").interval).toBe("week");
    expect(slot(outputs, "1", "standard").models.length).toBeGreaterThan(0);
    expect(outputs.candidates.some((candidate) => (candidate.payload.models as { speed: { points: { unresolved: number }[] } }[])
      .some((model) => model.speed.points.some((point) => point.unresolved > 0)))).toBe(true);
  });
});

describe("computeAnalyticsV2Performance: withholding", () => {
  const good = () => sourceRecord({ participant: "p-1", day: END, turns: [turnAt(30)] });

  it("withholds every candidate on an invalid stored record", async () => {
    const broken = good();
    const corrupt: AnalyticsV2PerformanceSourceRecord[] = [
      { ...broken, record: { ...(broken.record as object), turns: 0 } },
      { ...broken, fieldDictionaryVersion: "telemetry-performance-registry-2099-01-01.1" },
      { ...broken, reportDay: addDays(END, -1) },
      { ...broken, participantKey: null },
      { ...broken, fieldDictionaryVersion: D0921, record: makeRecord({ participant: "p-1", day: END, speedMode: "ultrafast", turns: [turnAt(30)] }) },
      { ...broken, fieldDictionaryVersion: D1010 },
    ];
    for (const item of corrupt) {
      const outputs = await fold([good(), item, good()]);
      expect(outputs.withheld).toBe("ANALYTICS_V2_PERFORMANCE_RECORD_INVALID");
      expect(outputs.candidates).toEqual([]);
      expect(outputs.summary.cohorts).toBe(3);
    }
  });

  it("withholds on capacity: more held days than the limit, or a count beyond the safe-integer range", async () => {
    const days = [0, 1, 2, 3].map((back) => sourceRecord({ participant: "p-1", day: addDays(END, -back), turns: [turnAt(30)] }));
    expect((await fold(days, { limits: { maxDays: 4 } })).withheld).toBeNull();
    const over = await fold(days, { limits: { maxDays: 3 } });
    expect(over).toMatchObject({ withheld: "ANALYTICS_V2_PERFORMANCE_CAPACITY", candidates: [] });
    expect(over.summary).toMatchObject({ includedRecords: 4, cohorts: 4 });
    // An invalid record still takes precedence over capacity.
    expect((await fold([...days, { ...good(), reportDay: "2026-01-01" }], { limits: { maxDays: 3 } })).withheld)
      .toBe("ANALYTICS_V2_PERFORMANCE_RECORD_INVALID");

    const huge = (participant: string) => {
      const record = { ...makeRecord({ participant, day: END, method: "unavailable", turns: [turnAt(30, null)] }),
        turns: MAX_PERFORMANCE_COUNT };
      adaptTelemetryPerformanceRecord(record, D0929);
      return { participantKey: participant, deviceKey: `${participant}-d`, reportKey: `${participant}-r`, reportDay: END,
        fieldDictionaryVersion: D0929, record };
    };
    expect((await fold([huge("p-1")])).withheld).toBeNull();
    for (const order of [[huge("p-1"), huge("p-2")], [huge("p-2"), huge("p-1")]]) {
      expect(await fold(order)).toMatchObject({ withheld: "ANALYTICS_V2_PERFORMANCE_CAPACITY", candidates: [] });
    }
  });

  it("withholds when more models than the limit are held", async () => {
    const records = ["gpt-5.5", "gpt-6-sol", "gpt-5.4"].map((modelId, index) =>
      sourceRecord({ participant: `p-${index}`, day: END, modelId, speedMode: index === 2 ? "fast" : "standard", turns: [turnAt(30)] }));
    expect((await fold(records, { limits: { maxModels: 3 } })).withheld).toBeNull();
    expect(await fold(records, { limits: { maxModels: 2 } }))
      .toMatchObject({ withheld: "ANALYTICS_V2_PERFORMANCE_MODELS_EXCEEDED", candidates: [] });
  });

  it("withholds when a series would exceed 600 points", async () => {
    // One record a week for 601 weeks: each week is its own bin in period all.
    const weekly = (weeks: number) => Array.from({ length: weeks }, (_, index) =>
      sourceRecord({ participant: "p-1", day: addDays(END, -7 * index), turns: [turnAt(30)] }));
    const at600 = await fold(weekly(600));
    await expectWellFormed(at600);
    expect(modelOf(slot(at600, "all", "standard")).speed.points).toHaveLength(600);
    expect(await fold(weekly(601))).toMatchObject({ withheld: "ANALYTICS_V2_PERFORMANCE_POINTS_EXCEEDED", candidates: [] });
    expect((await fold(weekly(30), { limits: { maxPoints: 29 } })).withheld).toBe("ANALYTICS_V2_PERFORMANCE_POINTS_EXCEEDED");
  });

  it("refuses invalid inputs and limits that would loosen the caps", async () => {
    await expect(computeAnalyticsV2Performance({ records: [], nowMs: Number.NaN, excludedOn: () => false }))
      .rejects.toThrow(/ANALYTICS_V2_PERFORMANCE_INPUT_INVALID:nowMs/u);
    await expect(computeAnalyticsV2Performance({ records: 5 as never, nowMs: NOW_MS, excludedOn: () => false }))
      .rejects.toThrow(/INPUT_INVALID:records/u);
    await expect(fold([], { limits: { maxDays: 5000 } })).rejects.toThrow(/INPUT_INVALID:limits\.maxDays/u);
    await expect(computeAnalyticsV2Performance({ records: [good()], nowMs: NOW_MS, excludedOn: (() => "yes") as never }))
      .rejects.toThrow(/INPUT_INVALID:excludedOn/u);
  });
});

describe("computeAnalyticsV2Performance: checkpoint and output account", () => {
  it("charges each emitted candidate and reports content-free progress", async () => {
    const charges: number[] = [];
    const events: AnalyticsV2PerformanceCheckpoint[] = [];
    const records = Array.from({ length: 4100 }, (_, index) =>
      sourceRecord({ participant: `p-${index % 10}`, report: `r-${index}`, day: addDays(END, -(index % 20)), turns: [turnAt(30 + (index % 7))] }));
    const outputs = await fold(records, { account: { charge: (bytes) => { charges.push(bytes); } },
      checkpoint: (event) => { events.push(event); } });
    await expectWellFormed(outputs);
    expect(charges).toHaveLength(12);
    expect(charges.every((bytes) => Number.isSafeInteger(bytes) && bytes > 128)).toBe(true);
    expect(events.filter((event) => event.phase === "records")).toEqual([{ kind: "performance", phase: "records", records: 4096 }]);
    expect(events.filter((event) => event.phase === "slot").map((event) => (event as { index: number }).index))
      .toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect(JSON.stringify(events)).not.toMatch(/p-\d|r-\d/u);
  });

  it("ends the fold when the checkpoint or the account throws", async () => {
    const records = [good()];
    await expect(fold(records, { checkpoint: () => { throw new Error("time guard"); } })).rejects.toThrow("time guard");
    await expect(fold(records, { account: { charge: () => { throw new Error("budget"); } } })).rejects.toThrow("budget");
  });

  function good() {
    return sourceRecord({ participant: "p-1", day: END, turns: [turnAt(30)] });
  }
});
