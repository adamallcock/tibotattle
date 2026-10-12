// GCP cap raise: the analytics-v2 native path (src/analytics-v2/native-path.ts)
// against production's native effective analysis.
//
// The oracle is d43c8f92's own advanceStorageEffectiveAnalysis
// (vendor/.../storage-effective-history.ts), driven exactly as production's
// computeEffective drives its original paged job (no prepared stores): one
// step per call, its checkpoint persisted between steps as canonical JSON
// text and parsed back, until it completes. The only stand-ins are its D1
// reads: the owner-authority row is a constant, and the effective occurrence
// reader (readEffectiveTelemetryOwnerDays / readEffectiveTelemetryOwnerDayPage)
// serves the same synthetic occurrences A-2 receives, with the reader's page
// contract (rows after the (observedAtMs, occurrenceId) cursor, `limit` rows,
// `next` null exactly when no row follows). The reader itself is A-1's to
// prove (the Q-1 golden rehearsal); this spec proves the analysis.
//
// Every case is beyond one bound of the d43c8f92 shared reducers, which the
// fast path used to turn into a refusal; each case first shows that refusal,
// then shows the native path equal to the production oracle. All data is
// synthetic and content-free.
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  effectiveUsageWindowRepresentable,
  evaluateSharedModelDate,
  evaluateSharedScalarDate,
  foldV11DailyProjectionValues,
  createV11DailyProjectionValues,
  finalizeV11DailyProjectionValues,
  modelHistoryWindow,
  prepareSharedAnalyticsDay,
  SharedAnalyticsUnavailable,
  type EffectiveTelemetryOccurrence,
  type V11SourcePin,
} from "../vendor/analytics-d43c8f92/entry";
import { advanceStorageEffectiveAnalysis } from "../vendor/analytics-d43c8f92/apps/worker/src/storage-effective-history";
import { canonicalJson } from "../src/canonical-json";
import {
  evaluateAnalyticsV2ModelDate,
  evaluateAnalyticsV2ScalarDate,
  isSharedAnalyticsDay,
  prepareAnalyticsV2Day,
  type AnalyticsV2PreparedDay,
} from "../src/analytics-v2/native-path";
import { analyticsV2DayDigest, buildAnalyticsV2Pin, EMPTY_DAY_OCCURRENCES,
  type AnalyticsV2DayOccurrences } from "../src/analytics-v2/pin";
import { ANALYTICS_V2_DEFAULT_RESOURCES } from "../src/analytics-v2/resources";
import { createHash } from "node:crypto";
import {
  addDays,
  capFacts,
  denseFacts,
  DENSE_OWNER_PINS,
  effectiveV2Owner,
  syntheticOwner,
  TODAY,
} from "./fixtures/synthetic-occurrences.mjs";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const MODEL_DATES = Array.from({ length: 70 }, (_, index) => addDays(TODAY, index - 69));

type Facts = Map<string, AnalyticsV2DayOccurrences>;

/** The occurrences the stand-in effective reader serves, per `${stream}|${day}`. */
const reader = vi.hoisted(() => ({
  rows: new Map<string, readonly { eventTime: string | null; occurrenceId: string }[]>(),
  pages: 0,
}));

vi.mock("../vendor/analytics-d43c8f92/apps/worker/src/telemetry-usage-effective-reader", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const DAY = 86_400_000;
  const at = (row: { eventTime: string | null }) => Date.parse(row.eventTime!);
  return {
    ...original,
    // Production: days of [fromDay, throughDay] (at most 101) with at least one occurrence.
    async readEffectiveTelemetryOwnerDays(_db: unknown, input: { fromDay: string; throughDay: string; stream: string }) {
      const from = Date.parse(`${input.fromDay}T00:00:00.000Z`), through = Date.parse(`${input.throughDay}T00:00:00.000Z`);
      if (through < from || through - from > 100 * DAY) throw new Error("EFFECTIVE_USAGE_LIMIT");
      const days: string[] = [];
      for (let day = from; day <= through; day += DAY) {
        const label = new Date(day).toISOString().slice(0, 10);
        if ((reader.rows.get(`${input.stream}|${label}`) ?? []).length > 0) days.push(label);
      }
      return Object.freeze(days);
    },
    // Production: complete occurrence groups after the cursor, `limit` of them,
    // `next` = the last returned coordinate exactly when more remain.
    async readEffectiveTelemetryOwnerDayPage(_db: unknown, input: { day: string; stream: string; limit: number;
      after?: { observedAtMs: number; occurrenceId: string }; ownerDigest: string }) {
      reader.pages += 1;
      const rows = (reader.rows.get(`${input.stream}|${input.day}`) ?? []).filter((row) => input.after === undefined
        || at(row) > input.after.observedAtMs
        || at(row) === input.after.observedAtMs && row.occurrenceId > input.after.occurrenceId);
      const page = rows.slice(0, input.limit);
      const last = page.at(-1);
      return { methodVersion: "effective-telemetry-owner-day-v1", stream: input.stream, participantId: "synthetic",
        ownerDigest: input.ownerDigest, day: input.day, rows: page,
        next: rows.length > input.limit && last ? { observedAtMs: at(last), occurrenceId: last.occurrenceId } : null };
    },
  };
});

/** The owner-authority row assertEffectiveHistoryOwner reads; nothing else touches D1. */
const AUTHORITY_DB = {
  prepare: () => ({ bind: () => ({ first: async () => ({ revision: 1, authority_epoch: 1 }) }) }),
} as unknown as D1Database;

/** Production's native analysis for one owner, metric and date, as computeEffective drives the paged job. */
async function nativeAnalysis(metric: "fits" | "model", owner: ReturnType<typeof syntheticOwner>, facts: Facts,
  pin: V11SourcePin, day: string): Promise<object> {
  reader.pages = 0;
  reader.rows = new Map();
  for (const [label, streams] of facts) {
    for (const stream of ["usage", "quota", "session"] as const) reader.rows.set(`${stream}|${label}`, streams[stream]);
  }
  const storageOwner = { participantId: owner.participant, ownerDigest: owner.digest, inputRevision: 1,
    ownerRevision: 1, authorityEpoch: 1, hasV1: false, hasV11: false, hasV12: true, hasLegacy: false,
    hasEffective: true };
  let checkpoint = null;
  for (let step = 0; step < 100_000; step += 1) {
    const next = await advanceStorageEffectiveAnalysis({ source: AUTHORITY_DB, sourceNamespace: "synthetic-namespace",
      owner: storageOwner, pin, day, metric, nowMs: Date.parse(modelHistoryWindow(day).fixedNow), checkpoint,
      budget: { remainingQueries: 10_000, deadlineMs: Number.MAX_SAFE_INTEGER, now: () => 0 } });
    if (next.status === "complete") {
      // The original paged job read its occurrences page by page.
      if (reader.pages === 0) throw new Error("native analysis read no page");
      return next.analysis;
    }
    if (next.checkpoint === null) throw new Error("native step deferred without a checkpoint");
    // The durable save and reload between invocations (storage-history-checkpoint.ts).
    checkpoint = JSON.parse(canonicalJson(next.checkpoint));
  }
  throw new Error("native analysis did not complete");
}

/** Prepare an owner's 170 analysis days with the fast path's preparation. */
async function prepareOwner(owner: ReturnType<typeof syntheticOwner>, facts: Facts) {
  const prepared = new Map<string, AnalyticsV2PreparedDay>();
  const dayDigests = new Map<string, string>();
  for (let back = 169; back >= 0; back -= 1) {
    const day = addDays(TODAY, -back);
    const value = facts.get(day) ?? EMPTY_DAY_OCCURRENCES;
    dayDigests.set(day, await analyticsV2DayDigest(day, value));
    prepared.set(day, await prepareAnalyticsV2Day({ day, ownerDigest: owner.digest, usage: value.usage,
      quota: value.quota, session: value.session }, ANALYTICS_V2_DEFAULT_RESOURCES));
  }
  const windowFor = (day: string) => {
    const days: AnalyticsV2PreparedDay[] = [];
    for (let label = modelHistoryWindow(day).fromDay; label <= day; label = addDays(label, 1)) days.push(prepared.get(label)!);
    return days;
  };
  const windowInput = async (day: string) => ({
    pin: await buildAnalyticsV2Pin({ owner: effectiveV2Owner(owner), day, dayDigests }),
    day, ownerDigest: owner.digest, days: windowFor(day),
    quotaOccurrences: (label: string) => (facts.get(label) ?? EMPTY_DAY_OCCURRENCES).quota,
  });
  return { prepared, windowInput };
}

type Analysis = { status?: string; reason?: string; [key: string]: unknown };

/** Content-free record of each comparison, printed once for the receipt. */
const observed: Array<{ test: string; metric: string; day: string; status?: string; reason?: string;
  fits?: number; nativePages: number }> = [];
afterAll(() => { console.log(JSON.stringify({ nativeParity: observed })); });
const current = () => expect.getState().currentTestName?.split(" > ").at(-1)?.slice(0, 48) ?? "";

/** The fast path's scalar fit equals production's native analysis and its fit selection. */
async function expectScalarParity(owner: ReturnType<typeof syntheticOwner>, facts: Facts,
  windowInput: (day: string) => Promise<Parameters<typeof evaluateAnalyticsV2ScalarDate>[0]>, day = TODAY) {
  const input = await windowInput(day);
  const gcp = await evaluateAnalyticsV2ScalarDate(input);
  const native = await nativeAnalysis("fits", owner, facts, input.pin, day) as Analysis;
  const analysis = gcp.analysis as Analysis;
  if (native.status === "ready") expect(analysis).toEqual(native);
  else expect({ status: analysis.status, reason: analysis.reason }).toEqual({ status: native.status, reason: native.reason });
  observed.push({ test: current(), metric: "fits", day, status: native.status, reason: native.reason,
    fits: gcp.selectedFits.length, nativePages: reader.pages });
  return { gcp, native };
}

/** The fast path's model composition equals production's native analysis byte for byte. */
async function expectModelParity(owner: ReturnType<typeof syntheticOwner>, facts: Facts,
  windowInput: (day: string) => Promise<Parameters<typeof evaluateAnalyticsV2ModelDate>[0]>, day: string) {
  const input = await windowInput(day);
  const gcp = await evaluateAnalyticsV2ModelDate(input) as Analysis;
  const native = await nativeAnalysis("model", owner, facts, input.pin, day) as Analysis;
  expect(canonicalJson(gcp)).toBe(canonicalJson(native));
  observed.push({ test: current(), metric: "model", day, status: native.status, reason: native.reason,
    nativePages: reader.pages });
  return { gcp, native };
}

const reasonOf = async (work: Promise<unknown>) => {
  try { await work; return null; } catch (error) {
    if (error instanceof SharedAnalyticsUnavailable) return error.reason;
    throw error;
  }
};

describe("analytics-v2 day backstop (resources.ts)", () => {
  it("refuses a day only beyond the configured backstop, with the shared reducers' own reasons", async () => {
    const owner = syntheticOwner(4, "pro");
    const day = addDays(TODAY, -30);
    // 40,000 usage records: over the shared 20,000-row bound and, at about
    // 880 bytes each, over 32 MiB of record JSON.
    const value = capFacts(owner, { firstDenseBack: 30, denseDays: 1, usagePerDay: 40_000 }).get(day)!;
    const input = { day, ownerDigest: owner.digest, ...value };
    const bytes = [...value.usage, ...value.quota, ...value.session]
      .reduce((sum, row) => sum + new TextEncoder().encode(row.recordJson!).byteLength, 0);
    expect(bytes).toBeGreaterThan(32 * 1_048_576);
    expect(await reasonOf(prepareSharedAnalyticsDay(input))).toBe("day_row_limit");
    const at = (overrides: Partial<typeof ANALYTICS_V2_DEFAULT_RESOURCES>) =>
      prepareAnalyticsV2Day(input, { ...ANALYTICS_V2_DEFAULT_RESOURCES, ...overrides });
    expect(await reasonOf(at({ maxDayOccurrences: 40_009 }))).toBe("day_row_limit");
    expect(await reasonOf(at({ maxDayRecordBytes: 32 * 1_048_576 }))).toBe("day_byte_limit");
    const prepared = await at({});
    expect(prepared.daily.counts).toEqual({ usage: 40_000, quota: 9, session: 1 });
    expect(isSharedAnalyticsDay(prepared)).toBe(true);
  }, 300_000);
});

describe("analytics-v2 native path = d43c8f92 advanceStorageEffectiveAnalysis beyond the shared-reducer bounds", () => {
  it("a 101-day window over 120,000 usage rows: scalar and model equal native (shared refusal: usage_window_unrepresentable)", async () => {
    const owner = syntheticOwner(4, "pro");
    const facts = denseFacts(owner) as Facts;
    const { prepared, windowInput } = await prepareOwner(owner, facts);
    expect([...prepared.values()].every(isSharedAnalyticsDay)).toBe(true);
    const today = await windowInput(TODAY);
    const rows = today.days.reduce((sum, day) => sum + day.usageRows.length, 0);
    expect(rows).toBeGreaterThan(120_000);
    expect(await reasonOf(evaluateSharedScalarDate({ ...today, days: today.days as never }))).toBe("usage_window_unrepresentable");
    expect(await reasonOf(evaluateSharedModelDate({ ...today, days: today.days as never }))).toBe("usage_window_unrepresentable");

    const { gcp, native } = await expectScalarParity(owner, facts, windowInput);
    expect((native as Analysis).status).toBe("ready");
    // The same fits compute.spec.ts pins for A-2's output on this corpus.
    expect(gcp.selectedFits.length).toBe(DENSE_OWNER_PINS.fits);
    expect(sha(canonicalJson(gcp.selectedFits))).toBe(DENSE_OWNER_PINS.fitsSha256);
    // All 70 model dates, as A-2 stores them, are the pinned rows; a spread of
    // them is checked against the native oracle (each native run pages the
    // whole window).
    const modelRows = [];
    for (const day of MODEL_DATES) {
      const { inputFingerprint: _fingerprint, ...result } = await evaluateAnalyticsV2ModelDate(await windowInput(day)) as Analysis;
      modelRows.push({ ownerDigest: owner.digest, day, result });
    }
    expect(modelRows.filter((row) => row.result.status === "ready").length).toBe(DENSE_OWNER_PINS.ready);
    expect(sha(canonicalJson(modelRows))).toBe(DENSE_OWNER_PINS.modelsSha256);
    for (const day of [TODAY, addDays(TODAY, -23), addDays(TODAY, -46), addDays(TODAY, -69)]) {
      const model = await expectModelParity(owner, facts, windowInput, day);
      expect(model.native.status).toBe("ready");
    }
  }, 900_000);

  it("a window over 1,024 usage pages, scalar and an unrepresentable model window: resumed to completion, equal to native", async () => {
    const owner = syntheticOwner(5, "pro");
    // 13 days x 17,200 rows, each day over its own 600 sessions: 1,118 pages
    // and 7,800 sessions, over the 4,096 entries a model fold may hold.
    const facts = capFacts(owner, { firstDenseBack: 100, denseDays: 13, usagePerDay: 17_200, sessionsPerDay: 600,
      distinctSessionsPerDay: true }) as Facts;
    const { windowInput } = await prepareOwner(owner, facts);
    const today = await windowInput(TODAY);
    expect(today.days.every(isSharedAnalyticsDay)).toBe(true);
    expect(effectiveUsageWindowRepresentable(today.days.map((day) => day.modelUsage!))).toBe(false);
    const pages = today.days.reduce((sum, day) => sum + Math.ceil(day.usageRows.length / 200), 0);
    expect(pages).toBeGreaterThan(1_024);
    expect(await reasonOf(evaluateSharedScalarDate({ ...today, days: today.days as never }))).toBe("usage_window_unrepresentable");
    expect(await reasonOf(evaluateSharedModelDate({ ...today, days: today.days as never }))).toBe("usage_window_unrepresentable");

    const { native } = await expectScalarParity(owner, facts, windowInput);
    expect((native as Analysis).status).toBe("ready");
    const model = await expectModelParity(owner, facts, windowInput, TODAY);
    expect(model.native.status).toBe("ready");
  }, 900_000);

  it("a day over 20,000 occurrences: prepared (daily = production's one-record fold), windows equal native", async () => {
    const owner = syntheticOwner(4, "pro");
    const crowded = addDays(TODAY, -30);
    const facts = capFacts(owner, { firstDenseBack: 30, denseDays: 1, usagePerDay: 25_000 }) as Facts;
    const value = facts.get(crowded)!;
    expect(await reasonOf(prepareSharedAnalyticsDay({ day: crowded, ownerDigest: owner.digest, ...value }))).toBe("day_row_limit");
    const { prepared, windowInput } = await prepareOwner(owner, facts);
    const day = prepared.get(crowded)!;
    expect(isSharedAnalyticsDay(day)).toBe(true);
    // Production's daily lane folds every record of the owner-day, one at a time.
    let daily = createV11DailyProjectionValues(crowded);
    for (const rows of [value.usage, value.quota, value.session]) {
      for (const row of rows) daily = foldV11DailyProjectionValues(daily, [JSON.parse(row.recordJson!)]);
    }
    expect(day.daily).toEqual(finalizeV11DailyProjectionValues(daily));
    expect(day.daily.counts).toEqual({ usage: 25_000, quota: 9, session: 1 });
    const { native } = await expectScalarParity(owner, facts, windowInput);
    expect((native as Analysis).status).toBe("ready");
    await expectModelParity(owner, facts, windowInput, TODAY);
  }, 600_000);

  it("a quota day over its preparation bound: paged quota acquisition, equal to native (shared refusal: quota_day_unrepresentable)", async () => {
    const owner = syntheticOwner(4, "pro");
    const dense = addDays(TODAY, -21);
    const facts = capFacts(owner, { firstDenseBack: 21, denseDays: 1, usagePerDay: 200, quotaPerDay: 6_000 }) as Facts;
    expect(await reasonOf(prepareSharedAnalyticsDay({ day: dense, ownerDigest: owner.digest, ...facts.get(dense)! })))
      .toBe("quota_day_unrepresentable");
    const { prepared, windowInput } = await prepareOwner(owner, facts);
    expect(prepared.get(dense)!.quota).toBeNull();
    expect(prepared.get(dense)!.modelUsage).not.toBeNull();
    const { native } = await expectScalarParity(owner, facts, windowInput);
    expect((native as Analysis).status).toBe("ready");
    for (const day of [TODAY, dense]) await expectModelParity(owner, facts, windowInput, day);
  }, 600_000);

  it("a usage day over its preparation bound: paged usage reduction, equal to native (shared refusal: usage_day_unrepresentable)", async () => {
    const owner = syntheticOwner(4, "pro");
    const dense = addDays(TODAY, -10);
    const facts = capFacts(owner, { firstDenseBack: 10, denseDays: 1, usagePerDay: 8_000, sessionsPerDay: 8_000 }) as Facts;
    expect(await reasonOf(prepareSharedAnalyticsDay({ day: dense, ownerDigest: owner.digest, ...facts.get(dense)! })))
      .toBe("usage_day_unrepresentable");
    const { prepared, windowInput } = await prepareOwner(owner, facts);
    expect(prepared.get(dense)!.modelUsage).toBeNull();
    expect(prepared.get(dense)!.quota).not.toBeNull();
    const { native } = await expectScalarParity(owner, facts, windowInput);
    expect((native as Analysis).status).toBe("ready");
    const model = await expectModelParity(owner, facts, windowInput, TODAY);
    expect(model.native.status).toBe("ready");
  }, 600_000);

  it("a window whose quota fold is refused (over 4,096 fit fragments): paged acquisition, equal to native", async () => {
    const owner = syntheticOwner(4, "pro");
    // 4,200 quota rows over 10 days, each restating one reset pool a second later.
    const facts = capFacts(owner, { firstDenseBack: 60, denseDays: 10, quotaPerDay: 420, distinctResets: true }) as Facts;
    const { prepared, windowInput } = await prepareOwner(owner, facts);
    expect([...prepared.values()].every(isSharedAnalyticsDay)).toBe(true);
    const today = await windowInput(TODAY);
    expect(await reasonOf(evaluateSharedScalarDate({ ...today, days: today.days as never }))).toBe("quota_window_unrepresentable");
    const { native } = await expectScalarParity(owner, facts, windowInput);
    expect(["ready", "not_testable"]).toContain((native as Analysis).status);
    await expectModelParity(owner, facts, windowInput, TODAY);
  }, 600_000);
});
