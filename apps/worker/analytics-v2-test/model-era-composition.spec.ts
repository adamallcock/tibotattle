// Synthetic, content-free regression cases for the GCP model-era composition
// fallback. The input covers one complete closed 101-day model window.
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical-json";
import {
  evaluateAnalyticsV2ModelDate,
  isSharedAnalyticsDay,
  prepareAnalyticsV2Day,
  type AnalyticsV2PreparedDay,
} from "../src/analytics-v2/native-path";
import {
  analyticsV2DayDigest,
  buildAnalyticsV2Pin,
  EMPTY_DAY_OCCURRENCES,
  type AnalyticsV2DayOccurrences,
} from "../src/analytics-v2/pin";
import { ANALYTICS_V2_DEFAULT_RESOURCES } from "../src/analytics-v2/resources";
import {
  evaluateSharedModelDate,
  createV11QuotaAcquisitionIdentity,
  foldEffectiveQuotaDays,
  mapEffectiveUsagePageRow,
  quotaContext,
  usageEvent,
  usageEventSync,
  MAX_WINDOWED_USAGE_ROWS,
  modelHistoryWindow,
  type EffectiveTelemetryOccurrence,
  type V11CompletedQuotaAcquisition,
  type UsageRow,
} from "../vendor/analytics-d43c8f92/entry";
import { buildAnalyticsV2ModelCompositionDay } from "../src/analytics-v2/allowance-projection";
import { evaluateModelBlock, type AnalyticsV2ModelBlockInput } from "../src/analytics-v2/units";
import { evaluateAnalyticsV2PlanEraComposition } from "../src/analytics-v2/model-era-composition";
import {
  addDays,
  dayMs,
  occurrence,
  quota,
  syntheticOwner,
  usage,
  TODAY,
} from "./fixtures/synthetic-occurrences.mjs";

const DAY_MS = 86_400_000;
const HOUR_MS = 60 * 60 * 1_000;
const MINUTE_MS = 60 * 1_000;
const TARGET_DAY = addDays(TODAY, -1);
const WINDOW_START = modelHistoryWindow(TARGET_DAY).fromDay;
const WINDOW_LENGTH = 101;
const GPT_MODELS = ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"] as const;
const CLAUDE_MODELS = ["claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-opus-5"] as const;
const VERSION = "analytics-v2-plan-era-composition-v1";
const NO_DB = {} as never;

type PlanType = "pro" | "plus";
type Track = {
  readonly account: number;
  readonly accountTrackId: string;
  readonly provider: string;
  readonly billingSurface: string;
  readonly models: readonly string[];
  readonly planType: PlanType;
  readonly planVariant: string;
  readonly planEraId: string;
  readonly usageTokenMultiplier: number;
};
type Facts = Map<string, AnalyticsV2DayOccurrences>;
type ModelComposition = {
  readonly status: string;
  readonly planType?: string;
  readonly usageEventCount?: number;
  readonly quotaRowCount?: number;
  readonly fit?: {
    readonly status?: string;
    readonly modelCostShares?: Readonly<Record<string, number | null>>;
    readonly capacityUsdByModel?: Readonly<Record<string, number | null>> | null;
    readonly observationCount?: number;
  };
};
type Candidate = {
  readonly candidateId: string;
  readonly composition: ModelComposition;
  readonly excludedAttributionBinCount: number;
  readonly excludedBoundaryBinCount: number;
};
type Partitioned = {
  readonly schemaVersion: typeof VERSION;
  readonly status: "partitioned";
  readonly inputFingerprint: string;
  readonly candidates: readonly Candidate[];
};
type WindowInput = Parameters<typeof evaluateAnalyticsV2ModelDate>[0];

const accountId = (account: number) => "account-track:v2:" + account.toString(16).padStart(64, "0");
const eraId = (era: number) => "plan-era:v1:" + era.toString(16).padStart(64, "0");
const stamp = (at: number) => new Date(at).toISOString();
const ordered = (left: EffectiveTelemetryOccurrence, right: EffectiveTelemetryOccurrence) =>
  left.eventTime! < right.eventTime! ? -1 : left.eventTime! > right.eventTime! ? 1
    : left.occurrenceId < right.occurrenceId ? -1 : left.occurrenceId > right.occurrenceId ? 1 : 0;

function makeTrack(input: {
  account: number;
  era: number;
  planType?: PlanType;
  planVariant?: string;
  provider?: string;
  models?: readonly string[];
  usageTokenMultiplier?: number;
}): Track {
  const provider = input.provider ?? "openai_codex";
  const anthropic = provider === "anthropic_claude_code";
  return {
    account: input.account,
    accountTrackId: accountId(input.account),
    provider,
    billingSurface: anthropic ? "claude_subscription" : "chatgpt_subscription",
    models: input.models ?? (anthropic ? CLAUDE_MODELS : GPT_MODELS),
    planType: input.planType ?? "pro",
    planVariant: input.planVariant ?? "unknown",
    planEraId: eraId(input.era),
    usageTokenMultiplier: input.usageTokenMultiplier ?? 1,
  };
}

function attribution(track: Track) {
  return {
    accountBasis: "same_source",
    accountTrackId: track.accountTrackId,
    planBasis: "same_source_occurrence",
    planType: track.planType,
    planEraId: track.planEraId,
  };
}

function makeUsage(owner: ReturnType<typeof syntheticOwner>, index: number, at: number,
  track: Track, modelId: string, sessionUuid: string, tokenMultiplier = 1): EffectiveTelemetryOccurrence {
  const base = usage(owner, index, at) as EffectiveTelemetryOccurrence;
  const sourceRecord = JSON.parse(base.recordJson!);
  const record = {
    ...sourceRecord,
    provider: track.provider,
    billingSurface: track.billingSurface,
    modelId,
    sessionUuid,
    totalInputContextTokens: sourceRecord.totalInputContextTokens * tokenMultiplier,
    components: {
      ...sourceRecord.components,
      inputUncachedTokens: sourceRecord.components.inputUncachedTokens * tokenMultiplier,
      inputCacheReadTokens: sourceRecord.components.inputCacheReadTokens * tokenMultiplier,
      inputCacheWriteTokens: sourceRecord.components.inputCacheWriteTokens * tokenMultiplier,
      outputTextTokens: sourceRecord.components.outputTextTokens * tokenMultiplier,
      outputReasoningTokens: sourceRecord.components.outputReasoningTokens * tokenMultiplier,
    },
    accountPlanAttribution: attribution(track),
  };
  return occurrence(owner, "usage", at, base.occurrenceId, record) as EffectiveTelemetryOccurrence;
}

function makeUnknownScopeUsage(owner: ReturnType<typeof syntheticOwner>, index: number, at: number,
  provider: string, modelId: string, sessionUuid: string): EffectiveTelemetryOccurrence {
  const base = usage(owner, index, at) as EffectiveTelemetryOccurrence;
  const record = {
    ...JSON.parse(base.recordJson!),
    provider,
    modelId,
    sessionUuid,
    accountPlanAttribution: {
      accountBasis: "unavailable",
      accountTrackId: null,
      planBasis: "unavailable",
      planType: "unknown",
      planEraId: null,
    },
  };
  return occurrence(owner, "usage", at, base.occurrenceId, record) as EffectiveTelemetryOccurrence;
}

function makeQuota(owner: ReturnType<typeof syntheticOwner>, index: number, at: number, usedPercent: number,
  resetsAt: number, track: Track): EffectiveTelemetryOccurrence {
  const base = quota(owner, index, at, usedPercent, resetsAt) as EffectiveTelemetryOccurrence;
  const record = {
    ...JSON.parse(base.recordJson!),
    provider: track.provider,
    planType: track.planType,
    planVariant: track.planVariant,
    accountPlanAttribution: attribution(track),
  };
  return occurrence(owner, "quota", at, base.occurrenceId, record) as EffectiveTelemetryOccurrence;
}

type ModelQuotaMovement = (ordinal: number, slot: number, modelId: string) => number;

function addRegularTrackDay(owner: ReturnType<typeof syntheticOwner>, day: string, ordinal: number, track: Track,
  rows: { usage: EffectiveTelemetryOccurrence[]; quota: EffectiveTelemetryOccurrence[] }, nextIndex: () => number,
  quotaMovement?: ModelQuotaMovement): void {
  const start = dayMs(day);
  const resetsAt = start + 8 * DAY_MS;
  let usedPercent = 5;
  for (let slot = 0; slot < 9; slot += 1) {
    const observedAt = start + 10 * MINUTE_MS + slot * 2 * HOUR_MS;
    const modelId = track.models[(ordinal + slot) % track.models.length]!;
    if (slot > 0) usedPercent = quotaMovement === undefined ? 5 + slot * 11
      : usedPercent + quotaMovement(ordinal, slot, modelId);
    rows.quota.push(makeQuota(owner, nextIndex(), observedAt, usedPercent, resetsAt, track));
    if (slot === 0) continue;
    rows.usage.push(makeUsage(owner, nextIndex(), observedAt + 10 * MINUTE_MS, track, modelId,
      "synthetic-session-" + owner.n + "-" + track.account + "-" + ordinal + "-" + slot,
      track.usageTokenMultiplier));
  }
}

function buildHistory(owner: ReturnType<typeof syntheticOwner>,
  tracksAt: (ordinal: number) => readonly Track[], targetDay = TARGET_DAY,
  quotaMovement?: ModelQuotaMovement): Facts {
  const facts: Facts = new Map();
  const windowStart = modelHistoryWindow(targetDay).fromDay;
  let next = 1;
  const nextIndex = () => next++;
  for (let ordinal = 0; ordinal < WINDOW_LENGTH; ordinal += 1) {
    const day = addDays(windowStart, ordinal);
    const rows = { usage: [] as EffectiveTelemetryOccurrence[], quota: [] as EffectiveTelemetryOccurrence[] };
    for (const track of tracksAt(ordinal)) {
      addRegularTrackDay(owner, day, ordinal, track, rows, nextIndex, quotaMovement);
    }
    rows.usage.sort(ordered);
    rows.quota.sort(ordered);
    facts.set(day, { usage: rows.usage, quota: rows.quota, session: [] });
  }
  return facts;
}

async function prepareWindow(owner: ReturnType<typeof syntheticOwner>, facts: Facts,
  targetDay = TARGET_DAY): Promise<WindowInput> {
  const dayDigests = new Map<string, string>();
  const days: AnalyticsV2PreparedDay[] = [];
  const windowStart = modelHistoryWindow(targetDay).fromDay;
  for (let ordinal = 0; ordinal < WINDOW_LENGTH; ordinal += 1) {
    const day = addDays(windowStart, ordinal);
    const rows = facts.get(day) ?? EMPTY_DAY_OCCURRENCES;
    dayDigests.set(day, await analyticsV2DayDigest(day, rows));
    days.push(await prepareAnalyticsV2Day({
      day,
      ownerDigest: owner.digest,
      usage: rows.usage,
      quota: rows.quota,
      session: rows.session,
    }, ANALYTICS_V2_DEFAULT_RESOURCES));
  }
  const pin = await buildAnalyticsV2Pin({
    owner: { participantId: owner.participant, ownerDigest: owner.digest },
    day: targetDay,
    dayDigests,
  });
  return {
    pin,
    day: targetDay,
    ownerDigest: owner.digest,
    days,
    quotaOccurrences: (day: string) => (facts.get(day) ?? EMPTY_DAY_OCCURRENCES).quota,
  };
}

async function prepareBlockInput(owner: ReturnType<typeof syntheticOwner>, facts: Facts,
  input: WindowInput): Promise<AnalyticsV2ModelBlockInput> {
  const dayDigests = new Map<string, string>();
  for (let ordinal = 0; ordinal < WINDOW_LENGTH; ordinal += 1) {
    const day = addDays(WINDOW_START, ordinal);
    dayDigests.set(day, await analyticsV2DayDigest(day, facts.get(day) ?? EMPTY_DAY_OCCURRENCES));
  }
  return {
    owner: { participantId: owner.participant, ownerDigest: owner.digest },
    dates: [input.day],
    prepared: new Map(input.days.map((day) => [day.day, day])),
    dayDigests,
    horizonQuota: new Map([...facts].map(([day, rows]) => [day, rows.quota])),
  };
}

function withUsageRecord(row: UsageRow, update: (record: Record<string, unknown>) => void): UsageRow {
  const record = JSON.parse(row.record_json) as Record<string, unknown>;
  update(record);
  return { ...row, record_json: JSON.stringify(record) };
}

function replaceCanonicalRecordString(recordJson: string, key: string, previous: string, next: string): string {
  const from = `${JSON.stringify(key)}:${JSON.stringify(previous)}`;
  const to = `${JSON.stringify(key)}:${JSON.stringify(next)}`;
  const start = recordJson.indexOf(from);
  if (start < 0 || recordJson.indexOf(from, start + from.length) >= 0) {
    throw new Error("synthetic canonical usage field is missing or ambiguous");
  }
  return recordJson.slice(0, start) + to + recordJson.slice(start + from.length);
}

function makeMappedUsageRowVariant(base: UsageRow, owner: ReturnType<typeof syntheticOwner>, index: number,
  sessionUuid: string): UsageRow {
  if (base.session_uuid === null) throw new Error("synthetic usage fixture requires a session");
  const occurrenceId = `event:v1:${(owner.n * 1_000_000 + index).toString(16).padStart(64, "0")}`;
  const recordJson = replaceCanonicalRecordString(base.record_json, "eventId", base.occurrence_id, occurrenceId);
  return {
    ...base,
    occurrence_id: occurrenceId,
    session_uuid: sessionUuid,
    record_json: replaceCanonicalRecordString(recordJson, "sessionUuid", base.session_uuid, sessionUuid),
  };
}

function completedAcquisition(input: WindowInput): V11CompletedQuotaAcquisition {
  const nowMs = Date.parse(modelHistoryWindow(input.day).fixedNow);
  const identity = createV11QuotaAcquisitionIdentity(input.pin, nowMs);
  const quotaDays = input.days.flatMap((day) => day.quota === null ? [] : [day.quota]);
  expect(quotaDays).toHaveLength(input.days.length);
  const folded = foldEffectiveQuotaDays(identity, quotaDays, input.days.map((day) => day.day));
  expect(folded?.status).toBe("complete");
  if (folded === undefined || folded.status !== "complete") throw new Error("synthetic quota fold incomplete");
  return { identity: folded.identity, planAnchors: folded.planAnchors, quotaRows: folded.quotaRows };
}

function partitioned(value: object): Partitioned {
  expect(value).toMatchObject({ schemaVersion: VERSION, status: "partitioned" });
  const result = value as unknown as Partitioned;
  expect(result.inputFingerprint).toMatch(/^[0-9a-f]{64}$/u);
  expect(result.candidates.length).toBeGreaterThan(0);
  for (const candidate of result.candidates) {
    expect(candidate.candidateId).toMatch(/^[0-9a-f]{64}$/u);
    expect(Number.isSafeInteger(candidate.excludedAttributionBinCount)).toBe(true);
    expect(candidate.excludedAttributionBinCount).toBeGreaterThanOrEqual(0);
    expect(Number.isSafeInteger(candidate.excludedBoundaryBinCount)).toBe(true);
    expect(candidate.excludedBoundaryBinCount).toBeGreaterThanOrEqual(0);
  }
  expect(new Set(result.candidates.map((candidate) => candidate.candidateId)).size).toBe(result.candidates.length);
  return result;
}

const transitionsOwner = syntheticOwner(1, "pro");
const transitionFacts = buildHistory(transitionsOwner, (ordinal) => [
  ordinal < 34 ? makeTrack({ account: 21, era: 2101, planType: "pro" })
    : ordinal < 67 ? makeTrack({ account: 21, era: 2102, planType: "plus" })
      : makeTrack({ account: 21, era: 2103, planType: "pro" }),
]);
let transitionWindow: Promise<WindowInput> | undefined;
const preparedTransitionWindow = () => transitionWindow ??= prepareWindow(transitionsOwner, transitionFacts);

describe("GCP model-era composition fallback", () => {
  it("keeps synchronous model-era evidence, eager pricing, and session ordering equivalent", async () => {
    const input = await preparedTransitionWindow();
    const context = await quotaContext(NO_DB, input.pin, {
      nowMs: Date.parse(modelHistoryWindow(input.day).fixedNow),
      quotaAcquisition: completedAcquisition(input),
    });
    if ("status" in context) throw new Error("synthetic quota context refused: " + context.reason);
    const row = input.days.at(-1)!.usageRows[0]!;
    const compare = async (candidate: UsageRow) => {
      const asyncPrevious = new Map<string, { time: number; scope: string | null }>();
      const syncPrevious = new Map<string, { time: number; scope: string | null }>();
      const generic = await usageEvent(context, asyncPrevious, { ...candidate });
      const synchronous = usageEventSync(context, syncPrevious, { ...candidate });
      expect(synchronous).toEqual(generic);
      expect([...syncPrevious]).toEqual([...asyncPrevious]);
      return { result: synchronous, previous: syncPrevious };
    };

    const ordinary = await compare(row);
    expect(ordinary.result).not.toBeNull();

    // A context price hit must still use each row's provider/session metadata.
    const alternateProvider = await compare({ ...row, provider: "anthropic_claude_code",
      session_uuid: "synthetic-context-cache-other-provider-session" });
    expect(alternateProvider.result).toMatchObject({ provider: "anthropic_claude_code" });
    expect(alternateProvider.previous.size).toBe(1);

    // The returned price object is mutable and row-owned. Mutating one result
    // must not poison a distinct clone served from the private context slot.
    const cachePriceRow = withUsageRecord(row, (record) => { record.modelId = GPT_MODELS[1]; });
    const exposedRow = { ...cachePriceRow };
    const firstPrice = usageEventSync(context, new Map(), exposedRow);
    if (firstPrice === null || "status" in firstPrice) throw new Error("synthetic priced row unexpectedly refused");
    const expectedPrice = await usageEvent(context, new Map(), { ...cachePriceRow });
    expect(firstPrice).toEqual(expectedPrice);
    firstPrice.priced.costNanousd = -1;
    firstPrice.priced.modelId = "synthetic-poisoned-model";
    const cachedClone = usageEventSync(context, new Map(), { ...cachePriceRow });
    expect(cachedClone).toEqual(expectedPrice);

    // A different context cannot import the exposed row memo's poisoned price.
    const otherContext = await quotaContext(NO_DB, input.pin, {
      nowMs: Date.parse(modelHistoryWindow(input.day).fixedNow),
      quotaAcquisition: completedAcquisition(input),
    });
    if ("status" in otherContext) throw new Error("synthetic second quota context refused: " + otherContext.reason);
    const isolatedPrice = usageEventSync(otherContext, new Map(), exposedRow);
    const isolatedExpected = await usageEvent(otherContext, new Map(), { ...cachePriceRow });
    expect(isolatedPrice).toEqual(isolatedExpected);

    const repeatedRow = { ...row };
    const firstPrevious = new Map<string, { time: number; scope: string | null }>();
    const secondPrevious = new Map<string, { time: number; scope: string | null }>();
    const firstSync = usageEventSync(context, firstPrevious, repeatedRow);
    const secondSync = usageEventSync(context, secondPrevious, repeatedRow);
    expect(secondSync).toEqual(firstSync);
    expect([...secondPrevious]).toEqual([...firstPrevious]);

    // Keep separate row identities alive across calls so each existing WeakMap
    // memo must invalidate when record_json or observed_at changes. Run sync
    // first on every stage so generic usageEvent cannot prewarm the sync row.
    const pricedRecord = withUsageRecord(row, (record) => { record.modelId = "gpt-6.1-sol"; });
    const persistentSyncRow = { ...row, record_json: pricedRecord.record_json };
    const persistentGenericRow = { ...row, record_json: pricedRecord.record_json };
    const comparePersistentRows = async () => {
      const asyncPrevious = new Map<string, { time: number; scope: string | null }>();
      const syncPrevious = new Map<string, { time: number; scope: string | null }>();
      const synchronous = usageEventSync(context, syncPrevious, persistentSyncRow);
      const generic = await usageEvent(context, asyncPrevious, persistentGenericRow);
      expect(synchronous).toEqual(generic);
      expect([...syncPrevious]).toEqual([...asyncPrevious]);
      return { result: synchronous, previous: syncPrevious };
    };
    const warmedMemo = await comparePersistentRows();
    expect(warmedMemo.result).toMatchObject({ priced: { pricingStatus: "fully_priced" } });

    const changedRecord = withUsageRecord(pricedRecord, (record) => { record.modelId = "unknown"; });
    persistentSyncRow.record_json = changedRecord.record_json;
    persistentGenericRow.record_json = changedRecord.record_json;
    const changedRecordResult = await comparePersistentRows();
    expect(changedRecordResult.result).toMatchObject({ priced: { pricingStatus: "unpriced" } });
    expect(changedRecordResult.result).not.toEqual(warmedMemo.result);

    persistentSyncRow.record_json = pricedRecord.record_json;
    persistentGenericRow.record_json = pricedRecord.record_json;
    const restoredRecordResult = await comparePersistentRows();
    expect(restoredRecordResult.result).toMatchObject({ priced: { pricingStatus: "fully_priced" } });

    const preEffectiveDate = "2026-09-28T12:00:00.000Z";
    persistentSyncRow.observed_at = preEffectiveDate;
    persistentGenericRow.observed_at = preEffectiveDate;
    const changedObservedAtResult = await comparePersistentRows();
    expect(changedObservedAtResult.result).toMatchObject({
      interval: { end: Date.parse(preEffectiveDate) },
      priced: { pricingStatus: "unpriced" },
    });
    expect(changedObservedAtResult.result).not.toEqual(restoredRecordResult.result);

    const unknownModel = withUsageRecord(row, (record) => { record.modelId = "unknown"; });
    const unknown = await compare(unknownModel);
    expect(unknown.result).toMatchObject({ priced: { pricingStatus: "unpriced" } });

    const outsideEra = withUsageRecord(row, (record) => {
      (record.accountPlanAttribution as Record<string, unknown>).planEraId = "plan-era:v1:" + "f".repeat(64);
    });
    const excluded = await compare(outsideEra);
    expect(excluded.result).toMatchObject({ eraKey: null });

    const noMeasurements = withUsageRecord(row, (record) => {
      const components = record.components as Record<string, unknown>;
      for (const key of ["inputUncachedTokens", "inputCacheReadTokens", "inputCacheWriteTokens",
        "outputTextTokens", "outputReasoningTokens", "outputCombinedTokens"]) components[key] = null;
    });
    const dropped = await compare(noMeasurements);
    expect(dropped.result).toBeNull();
    expect(dropped.previous.size).toBe(1);

    const droppedClone = await compare({ ...noMeasurements, session_uuid: "synthetic-drop-cache-clone" });
    expect(droppedClone.result).toBeNull();
    expect(droppedClone.previous.size).toBe(1);

    const invalidAttribution = withUsageRecord(row, (record) => { record.accountPlanAttribution = {}; });
    const refused = await compare(invalidAttribution);
    expect(refused.result).toMatchObject({ status: "not_testable", reason: "invalid_attribution_record" });
    expect(refused.previous.size).toBe(0);

    const malformedJson = { ...row, record_json: "{" };
    const malformed = await compare(malformedJson);
    expect(malformed.result).toMatchObject({ status: "not_testable", reason: "invalid_attribution_record" });
    expect(malformed.previous.size).toBe(0);

    const invalidPrice = withUsageRecord(row, (record) => {
      (record.components as Record<string, unknown>).inputUncachedTokens = "not-a-decimal";
    });
    const asyncPrevious = new Map<string, { time: number; scope: string | null }>();
    const syncPrevious = new Map<string, { time: number; scope: string | null }>();
    await expect(usageEvent(context, asyncPrevious, { ...invalidPrice })).rejects.toThrow();
    expect(() => usageEventSync(context, syncPrevious, { ...invalidPrice })).toThrow();
    expect(asyncPrevious.size).toBe(1);
    expect([...syncPrevious]).toEqual([...asyncPrevious]);

    const repeatedThrowPrevious = new Map<string, { time: number; scope: string | null }>();
    expect(() => usageEventSync(context, repeatedThrowPrevious, { ...invalidPrice })).toThrow();
    expect(repeatedThrowPrevious.size).toBe(1);

    const invalidPriceOutsideEra = withUsageRecord(outsideEra, (record) => {
      (record.components as Record<string, unknown>).inputUncachedTokens = "not-a-decimal";
    });
    const excludedAsyncPrevious = new Map<string, { time: number; scope: string | null }>();
    const excludedSyncPrevious = new Map<string, { time: number; scope: string | null }>();
    await expect(usageEvent(context, excludedAsyncPrevious, { ...invalidPriceOutsideEra })).rejects.toThrow();
    expect(() => usageEventSync(context, excludedSyncPrevious, { ...invalidPriceOutsideEra })).toThrow();
    expect(excludedAsyncPrevious.size).toBe(1);
    expect([...excludedSyncPrevious]).toEqual([...excludedAsyncPrevious]);
  });

  it("partitions Pro to Plus to Pro into three candidates and drops transition-crossing bins", async () => {
    const input = await preparedTransitionWindow();
    expect(input.days).toHaveLength(WINDOW_LENGTH);
    expect(input.pin.fromDay).toBe(WINDOW_START);
    expect(input.pin.throughDay).toBe(TARGET_DAY);
    const result = partitioned(await evaluateAnalyticsV2ModelDate(input));

    expect(result.candidates.map((candidate) => candidate.composition.planType).sort())
      .toEqual(["plus", "pro", "pro"]);
    expect(result.candidates.every((candidate) => candidate.composition.status === "ready")).toBe(true);
    expect(result.candidates.every((candidate) => (candidate.composition.quotaRowCount ?? 0) > 0)).toBe(true);
    // Each era has a quota bin that straddles one of its observed bounds; its
    // two-hour movement cannot be attributed wholly to either neighboring era.
    expect(result.candidates.every((candidate) => candidate.excludedBoundaryBinCount > 0)).toBe(true);
  });

  it("keeps same-plan continuity and plan-variant changes as separate candidates", async () => {
    const owner = syntheticOwner(2, "pro");
    const facts = buildHistory(owner, (ordinal) => [
      ordinal < 34
        ? makeTrack({ account: 22, era: 2201, planType: "pro", planVariant: "standard" })
        : ordinal < 67
          ? makeTrack({ account: 22, era: 2202, planType: "pro", planVariant: "standard" })
          : makeTrack({ account: 22, era: 2203, planType: "pro", planVariant: "variant_b" }),
    ]);
    const result = partitioned(await evaluateAnalyticsV2ModelDate(await prepareWindow(owner, facts)));

    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.map((candidate) => candidate.composition.planType)).toEqual(["pro", "pro", "pro"]);
    expect(result.candidates.every((candidate) => candidate.composition.status === "ready")).toBe(true);
    expect(result.candidates.every((candidate) => (candidate.composition.quotaRowCount ?? 0) < 101 * 9)).toBe(true);
  });

  it("fits distinct account and provider candidates without refusing the entire window", async () => {
    const owner = syntheticOwner(3, "pro");
    const facts = buildHistory(owner, () => [
      makeTrack({ account: 231, era: 2301, planType: "pro" }),
      makeTrack({ account: 232, era: 2302, planType: "pro" }),
      makeTrack({ account: 233, era: 2303, planType: "pro", provider: "anthropic_claude_code" }),
    ]);
    const result = partitioned(await evaluateAnalyticsV2ModelDate(await prepareWindow(owner, facts)));

    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every((candidate) => candidate.composition.status === "ready")).toBe(true);
    const modelSets = result.candidates.map((candidate) => Object.keys(candidate.composition.fit?.modelCostShares ?? {}));
    expect(modelSets.filter((models) => GPT_MODELS.every((model) => models.includes(model)))).toHaveLength(2);
    expect(modelSets.every((models) => !(models.some((model) => GPT_MODELS.includes(model as typeof GPT_MODELS[number]))
      && models.some((model) => CLAUDE_MODELS.includes(model as typeof CLAUDE_MODELS[number]))))).toBe(true);
    expect(result.candidates.every((candidate) => (candidate.composition.quotaRowCount ?? 0) < 3 * 101 * 9)).toBe(true);
  });

  it("fits post-price-card era mixtures and projects one owner's positive values for all three models", async () => {
    const owner = syntheticOwner(7, "pro");
    const targetDay = "2026-10-20";
    const windowStart = modelHistoryWindow(targetDay).fromDay;
    const pricedEraStartOrdinal = Math.round((dayMs("2026-09-29") - dayMs(windowStart)) / DAY_MS);
    const quotaMovementByModel: Readonly<Record<string, number>> = {
      "gpt-6-sol": 2,
      "gpt-6.1-sol": 5,
      "gpt-6-luna": 8,
    };
    const pricedModels = ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna", "gpt-6-luna", "gpt-6-luna"];
    const facts = buildHistory(owner, (ordinal) => [
      ordinal < pricedEraStartOrdinal
        ? makeTrack({ account: 71, era: 7101, planType: "pro", models: ["gpt-5.6-sol"] })
        : makeTrack({ account: 71, era: 7102, planType: "plus", models: pricedModels, usageTokenMultiplier: 100 }),
    ], targetDay, (ordinal, _slot, model) => ordinal < pricedEraStartOrdinal
      ? 11 : quotaMovementByModel[model] ?? 11);
    const input = await prepareWindow(owner, facts, targetDay);
    expect(input.pin.fromDay).toBe(windowStart);
    expect(input.pin.throughDay).toBe(targetDay);

    const legacy = await evaluateSharedModelDate({ pin: input.pin, day: input.day,
      ownerDigest: input.ownerDigest, days: input.days as never });
    expect(legacy).toMatchObject({ status: "not_testable", reason: "multi_plan_window_unsupported" });

    const result = partitioned(await evaluateAnalyticsV2ModelDate(input));
    expect(result.candidates).toHaveLength(2);
    const latestEra = result.candidates.find((candidate) => candidate.composition.planType === "plus");
    expect(latestEra).toBeDefined();
    if (latestEra === undefined) throw new Error("synthetic priced era candidate missing");
    expect(latestEra.composition.status).toBe("ready");
    expect(latestEra.composition.fit?.status).toBe("fitted");
    expect(latestEra.composition.fit?.observationCount).toBeGreaterThan(100);
    const capacities = latestEra.composition.fit?.capacityUsdByModel;
    expect(capacities).not.toBeNull();
    if (capacities === null || capacities === undefined) throw new Error("synthetic target-model capacities missing");
    for (const model of GPT_MODELS) {
      expect(latestEra.composition.fit?.modelCostShares?.[model]).toBeGreaterThan(0);
      expect(capacities[model]).toBeGreaterThan(0);
    }

    const publicDay = buildAnalyticsV2ModelCompositionDay([{ ownerDigest: owner.digest, result }], 0, targetDay);
    expect(publicDay).toMatchObject({ fittedParticipantCount: 1, refusedParticipantCount: 0, v1ParticipantCount: 1 });
    const values = new Map(publicDay.values.map(([model, capacity, participantCount]) =>
      [model, { capacity, participantCount }]));
    for (const model of GPT_MODELS) {
      expect(values.get(model)?.capacity).toBeGreaterThan(0);
      expect(values.get(model)?.participantCount).toBe(1);
    }
  });

  it("pads unknown-scope attribution hazards through delayed quota crossings and excludes whole bins", async () => {
    const owner = syntheticOwner(4, "pro");
    const tracksAt = (ordinal: number) => [
      makeTrack({ account: 241, era: 2401, planType: "pro" }),
      makeTrack({ account: 242, era: 2402, planType: "pro" }),
    ];
    const facts = buildHistory(owner, tracksAt);
    const targetOrdinal = 70;
    const specialDay = addDays(WINDOW_START, targetOrdinal);
    const rows = facts.get(specialDay)!;
    const firstTrack = tracksAt(targetOrdinal)[0]!;
    const isFirstTrackEra = (row: EffectiveTelemetryOccurrence) => {
      const item = JSON.parse(row.recordJson!);
      return item.accountPlanAttribution.accountTrackId === firstTrack.accountTrackId
        && item.accountPlanAttribution.planEraId === firstTrack.planEraId;
    };
    const keptUsage = rows.usage.filter((row) => !isFirstTrackEra(row));
    const keptQuota = rows.quota.filter((row) => !isFirstTrackEra(row));
    let next = 10_000_000;
    const nextIndex = () => next++;
    const start = dayMs(specialDay);
    const resetA = start + 8 * DAY_MS;
    const resetB = resetA + 4 * HOUR_MS;
    const specialQuota: EffectiveTelemetryOccurrence[] = [];
    const q = (hour: number, minute: number, used: number, reset: number) =>
      specialQuota.push(makeQuota(owner, nextIndex(), start + hour * HOUR_MS + minute * MINUTE_MS, used, reset, firstTrack));
    // Pool A crosses from 10:00 into 12:30's two-hour bin. Pool B establishes
    // an 11:00 envelope and crosses at exactly 14:00, exactly three hours later.
    for (const [hour, used] of [[0, 5], [2, 15], [4, 25], [6, 35], [8, 45]] as const) {
      q(hour, 10, used, resetA);
    }
    q(10, 0, 55, resetA);
    q(11, 0, 20, resetB);
    q(12, 30, 65, resetA);
    q(14, 0, 30, resetB);
    for (const [hour, used] of [[16, 75], [18, 85], [20, 92], [22, 98]] as const) {
      q(hour, 10, used, resetA);
    }

    const specialUsage: EffectiveTelemetryOccurrence[] = [];
    // The same session changes from a known account at 10:30 to unknown scope
    // at 11:00, making precisely this interval ambiguous for both accounts.
    specialUsage.push(makeUsage(owner, nextIndex(), start + 10 * HOUR_MS + 30 * MINUTE_MS,
      firstTrack, GPT_MODELS[0], "synthetic-ambiguous-session-241"));
    specialUsage.push(makeUnknownScopeUsage(owner, nextIndex(), start + 11 * HOUR_MS, "openai_codex",
      GPT_MODELS[1], "synthetic-ambiguous-session-241"));
    // These priced, uniquely named models fall in the later 12:00 and 14:00
    // observations. The 3-hour conservative pad must remove their whole bins.
    specialUsage.push(makeUsage(owner, nextIndex(), start + 12 * HOUR_MS, firstTrack, "gpt-5.6-sol",
      "synthetic-delayed-crossing-12"));
    specialUsage.push(makeUsage(owner, nextIndex(), start + 14 * HOUR_MS + 5 * MINUTE_MS, firstTrack, "gpt-5.5",
      "synthetic-delayed-crossing-14"));
    facts.set(specialDay, {
      usage: [...keptUsage, ...specialUsage].sort(ordered),
      quota: [...keptQuota, ...specialQuota].sort(ordered),
      session: rows.session,
    });

    const result = partitioned(await evaluateAnalyticsV2ModelDate(await prepareWindow(owner, facts)));
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every((candidate) => candidate.excludedAttributionBinCount >= 2)).toBe(true);
    // One candidate has all three supported observations at 10:00, 12:00, and
    // 14:00; the last is exactly the inclusive three-hour padding bound.
    expect(Math.max(...result.candidates.map((candidate) => candidate.excludedAttributionBinCount))).toBeGreaterThanOrEqual(3);
    expect(result.candidates.every((candidate) => candidate.composition.status === "ready")).toBe(true);
    const allShares = result.candidates.flatMap((candidate) =>
      Object.keys(candidate.composition.fit?.modelCostShares ?? {}));
    expect(allShares).not.toContain("gpt-5.6-sol");
    expect(allShares).not.toContain("gpt-5.5");
  });

  it("does not allocate a priced session interval across conflicting plan anchors", async () => {
    const owner = syntheticOwner(6, "pro");
    const track = makeTrack({ account: 61, era: 6101, planType: "pro" });
    const facts = buildHistory(owner, () => [track]);
    const ordinal = 70;
    const day = addDays(WINDOW_START, ordinal);
    const start = dayMs(day);
    const rows = facts.get(day)!;
    const conflictAt = start + 12 * HOUR_MS + 10 * MINUTE_MS;
    const conflictingTrack = makeTrack({ account: 61, era: 6102, planType: "pro" });
    let next = 30_000_000;
    const conflictingAnchor = makeQuota(owner, next++, conflictAt, 71, start + 8 * DAY_MS, conflictingTrack);
    const crossingSession = "synthetic-plan-conflict-session";
    const ambiguousUsage = [
      makeUsage(owner, next++, start + 11 * HOUR_MS, track, GPT_MODELS[0], crossingSession),
      makeUsage(owner, next++, start + 13 * HOUR_MS, track, "gpt-5.6-sol", crossingSession),
    ];
    facts.set(day, { ...rows,
      usage: [...rows.usage, ...ambiguousUsage].sort(ordered),
      quota: [...rows.quota, conflictingAnchor].sort(ordered),
    });

    const prepared = await prepareWindow(owner, facts);
    const pagedConflictInput: WindowInput = { ...prepared,
      days: prepared.days.map((value) => value.day === day ? { ...value, quota: null } : value) };
    const result = partitioned(await evaluateAnalyticsV2ModelDate(pagedConflictInput));
    expect(result.candidates.every((candidate) => candidate.composition.status === "ready")).toBe(true);
    expect(result.candidates.every((candidate) => (candidate.composition.quotaRowCount ?? 0) > 0)).toBe(true);
    // The competing same-time anchor makes the session interval unresolved.
    // The unique priced model at its endpoint must not leak into any candidate,
    // even if this conflict does not overlap a retained diagnostic bin.
    expect(result.candidates.flatMap((candidate) =>
      Object.keys(candidate.composition.fit?.modelCostShares ?? {}))).not.toContain("gpt-5.6-sol");
  });

  it("matches when some prepared days lose their modelUsage fold and raw usageRows remain", async () => {
    const input = await preparedTransitionWindow();
    expect(input.days.some((day) => day.modelUsage !== null)).toBe(true);
    const mixed: WindowInput = {
      ...input,
      days: input.days.map((day, index) => index % 3 === 0 ? { ...day, modelUsage: null } : day),
    };
    expect(mixed.days.some((day) => day.modelUsage === null)).toBe(true);
    expect(mixed.days.some((day) => day.modelUsage !== null)).toBe(true);

    const [preparedResult, mixedResult] = await Promise.all([
      evaluateAnalyticsV2ModelDate(input),
      evaluateAnalyticsV2ModelDate(mixed),
    ]);
    expect(canonicalJson(mixedResult)).toBe(canonicalJson(preparedResult));
  });

  it("does not read quota or usage evidence after the requested historical date", async () => {
    const input = await preparedTransitionWindow();
    const futureFacts = new Map(transitionFacts);
    const nextDay = addDays(TARGET_DAY, 1);
    const futureTrack = makeTrack({ account: 21, era: 2199, planType: "plus" });
    const futureRows = { usage: [] as EffectiveTelemetryOccurrence[], quota: [] as EffectiveTelemetryOccurrence[] };
    addRegularTrackDay(transitionsOwner, nextDay, 101, futureTrack, futureRows, () => 20_000_000);
    futureFacts.set(nextDay, { usage: futureRows.usage, quota: futureRows.quota, session: [] });
    const requestedQuotaDays: string[] = [];
    const withFuture: WindowInput = {
      ...input,
      quotaOccurrences: (day) => {
        requestedQuotaDays.push(day);
        return (futureFacts.get(day) ?? EMPTY_DAY_OCCURRENCES).quota;
      },
    };

    const [baseResult, futureResult] = await Promise.all([
      evaluateAnalyticsV2ModelDate(input),
      evaluateAnalyticsV2ModelDate(withFuture),
    ]);
    expect(canonicalJson(futureResult)).toBe(canonicalJson(baseResult));
    expect(requestedQuotaDays.every((day) => day <= TARGET_DAY)).toBe(true);
    expect(input.days.at(-1)?.day).toBe(TARGET_DAY);
    expect(input.pin.throughDay).toBe(TARGET_DAY);
  });

  it("preserves exact legacy result bytes for a valid single-era window", async () => {
    const owner = syntheticOwner(5, "pro");
    const facts = buildHistory(owner, () => [makeTrack({ account: 25, era: 2501, planType: "pro" })]);
    const input = await prepareWindow(owner, facts);
    expect(input.days.every(isSharedAnalyticsDay)).toBe(true);
    const legacy = await evaluateSharedModelDate({ pin: input.pin, day: input.day,
      ownerDigest: input.ownerDigest, days: input.days as never });
    const current = await evaluateAnalyticsV2ModelDate(input);

    expect(JSON.stringify(current)).toBe(JSON.stringify(legacy));
  });

  it("strips private fingerprints and identifiers from persisted partitioned model-block results", async () => {
    const input = await preparedTransitionWindow();
    const direct = partitioned(await evaluateAnalyticsV2ModelDate(input));
    const block = await prepareBlockInput(transitionsOwner, transitionFacts, input);
    const [unit] = await evaluateModelBlock(block);
    expect(unit).toBeDefined();
    if (unit === undefined || !("composition" in unit) || unit.composition === null) {
      throw new Error("synthetic model block did not emit a composition");
    }
    expect(unit.composition).toEqual(direct);
    expect(unit.emission.kind).toBe("modelDate");
    if (unit.emission.kind !== "modelDate") throw new Error("synthetic model block emitted refusal");
    const stored = unit.emission.row.result as unknown as Record<string, unknown>;
    const { inputFingerprint: _outerFingerprint, ...publicResult } = direct;
    const expectedStored = {
      ...publicResult,
      candidates: direct.candidates.map((candidate) => {
        const { inputFingerprint: _nestedFingerprint, ...composition } = candidate.composition as
          ModelComposition & { readonly inputFingerprint?: string };
        return { ...candidate, composition };
      }),
    };
    expect(stored).toEqual(expectedStored);
    expect(stored).not.toHaveProperty("inputFingerprint");
    for (const candidate of stored.candidates as Candidate[]) {
      expect(candidate.composition).not.toHaveProperty("inputFingerprint");
    }
    const serialized = JSON.stringify(stored);
    for (const privateId of [accountId(21), eraId(2101), eraId(2102), eraId(2103), "synthetic-session-"]) {
      expect(serialized).not.toContain(privateId);
    }
  });

  it("fails closed at the million-row multi-era window bound without expanding row records", async () => {
    const input = await preparedTransitionWindow();
    const quotaAcquisition = completedAcquisition(input);
    const base = input.days.flatMap((day) => day.usageRows)[0]!;
    const repeated = new Array<UsageRow>(MAX_WINDOWED_USAGE_ROWS + 1).fill(base);
    const rows = input.days.map((day) => ({ day: day.day, usageRows: day.day === TARGET_DAY ? repeated : [] }));
    const result = await evaluateAnalyticsV2PlanEraComposition({
      pin: input.pin,
      nowMs: Date.parse(modelHistoryWindow(input.day).fixedNow),
      quotaAcquisition,
      days: rows,
    });

    expect(result).toEqual({ status: "not_testable", reason: "windowed_usage_limit_exceeded" });
  });

  it("enforces the 8 MiB shared reduction-state budget before session or row caps", async () => {
    const input = await preparedTransitionWindow();
    const quotaAcquisition = completedAcquisition(input);
    const uniqueSessions = 75_000;
    const sessionPrefix = "synthetic-session-budget-";
    const sessionSuffixLength = 128 - sessionPrefix.length - 8;
    const observedAt = stamp(dayMs(TARGET_DAY) + 12 * HOUR_MS + 20 * MINUTE_MS);
    // Map one complete synthetic record, then vary only its canonical event
    // and session identity fields. Representative variants below are sent
    // through the mapper; all 75,000 rows still pass through the evaluator's
    // real record decoder, validation, pricing, and refusal path.
    const baseOccurrence = makeUnknownScopeUsage(transitionsOwner, 50_000_000,
      Date.parse(observedAt), "openai_codex", GPT_MODELS[0],
      sessionPrefix + "00000000" + "x".repeat(sessionSuffixLength));
    const baseRow = mapEffectiveUsagePageRow(baseOccurrence);
    const longSessionRows = Array.from({ length: uniqueSessions }, (_, index) => {
      const sessionUuid = sessionPrefix + index.toString(16).padStart(8, "0") + "x".repeat(sessionSuffixLength);
      return makeMappedUsageRowVariant(baseRow, transitionsOwner, 50_000_000 + index, sessionUuid);
    });
    expect(longSessionRows).toHaveLength(uniqueSessions);
    expect(longSessionRows.length).toBeLessThan(MAX_WINDOWED_USAGE_ROWS);
    expect(longSessionRows.every((row) => row.session_uuid?.length === 128)).toBe(true);
    for (const index of [0, Math.floor(uniqueSessions / 2), uniqueSessions - 1]) {
      const row = longSessionRows[index]!;
      expect(mapEffectiveUsagePageRow({ ...baseOccurrence,
        occurrenceId: row.occurrence_id,
        eventTime: row.observed_at,
        recordJson: row.record_json,
      })).toEqual(row);
    }

    const rows = input.days.map((day) => ({ day: day.day,
      usageRows: day.day === TARGET_DAY ? longSessionRows : [] }));
    const startedAt = performance.now();
    const result = await evaluateAnalyticsV2PlanEraComposition({
      pin: input.pin,
      nowMs: Date.parse(modelHistoryWindow(input.day).fixedNow),
      quotaAcquisition,
      days: rows,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(result).toEqual({ status: "not_testable", reason: "reduced_usage_limit_exceeded" });
    // This is a deliberately generous regression ceiling around the bounded
    // walk; fixture construction is outside the timed region.
    expect(elapsedMs).toBeLessThan(20_000);
  });

  it("fails closed at the window-wide distinct-session bound for multi-era input", async () => {
    const input = await preparedTransitionWindow();
    const quotaAcquisition = completedAcquisition(input);
    const dayRows = input.days.at(-1)!.usageRows;
    const base = mapEffectiveUsagePageRow(makeUnknownScopeUsage(transitionsOwner, 40_000_000,
      dayMs(TARGET_DAY) + 12 * HOUR_MS + 20 * MINUTE_MS, "openai_codex", GPT_MODELS[0],
      "synthetic-session-limit-base"));
    expect(dayRows.length).toBeGreaterThan(0);
    const sessionRows = Array.from({ length: 100_001 }, (_, index) => ({
      ...base,
      session_uuid: index.toString().padStart(6, "0"),
    }));
    sessionRows[sessionRows.length - 1] = withUsageRecord(sessionRows.at(-1)!, (record) => {
      (record.components as Record<string, unknown>).inputUncachedTokens = "not-a-decimal";
    });
    const rows = input.days.map((day) => ({ day: day.day,
      usageRows: day.day === TARGET_DAY ? sessionRows : [] }));
    const result = await evaluateAnalyticsV2PlanEraComposition({
      pin: input.pin,
      nowMs: Date.parse(modelHistoryWindow(input.day).fixedNow),
      quotaAcquisition,
      days: rows,
    });

    expect(result).toMatchObject({ status: "not_testable", reason: "session_interval_scope_limit_exceeded" });
  });
});
