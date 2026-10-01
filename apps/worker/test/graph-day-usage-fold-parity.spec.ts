import { describe, expect, it } from "vitest";
import { buildPlanAttributionIndex } from "@app-usagemonitor/quota-analysis";
import type { PlanAttributionIndex } from "@app-usagemonitor/quota-analysis";
import { canonicalJson } from "../src/canonical-json";
import {
  createV11UsageModelState,
  foldV11UsageModel,
  reduceV11UsageModelEvent,
  v11ModelCompositionFromModelHalf,
  v11UsageEventEra,
  v11UsageModelHalf,
  v11FoldedUsageRowCount,
  v11FoldedUsageWindowRefusal,
  v11UsageModelRefusal,
  type V11UsageModelSeed,
} from "../src/quota-analysis-v11";
import { assertV11PreparedDayCoverage } from "../src/quota-analysis-v11-reader";
import { reduceGraphDayProjection, type GraphDayUsageInput } from "../src/graph-day-projection";
import { validGraphDayProjection, type GraphDayProjection } from "../src/graph-day-projection-values";
import type { V11AcquiredQuotaRow, V11PlanAnchor } from "../src/quota-analysis-v11-reader";

/** Why no fixture distinguishes the era instant the two sides resolve at: the
 * stream resolves an event's era at the event instant and the fold resolves a
 * cell's at its bin start. They can only differ if an era boundary falls
 * between the two — and a window with more than one era is exactly what
 * `v11UsageModelRefusal` refuses the model metric on, so such a window never
 * reaches either resolution. The `era boundary inside a two-hour bin` fixture
 * below is that case, and asserts the refusal rather than a value. */

/**
 * The model-composition parity oracle for the prepared usage fold.
 *
 * A prepared day aggregates usage into `(2-hour bin, attribution, account
 * break, model)` cells, holds each session's first event of the day alone, and
 * carries out each session's tail. The fold must reach the same model half —
 * and therefore the same composition, byte for byte — as feeding every event
 * through the reduction one at a time.
 *
 * Both sides drive the SAME two kernel entry points the streaming reduction
 * itself drives (`v11UsageEventEra`, `reduceV11UsageModelEvent`); what differs
 * is the aggregation, which is the entire content of the fold.
 */

const DAY_MS = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const BASE = Date.parse("2026-05-01T00:00:00.000Z");
const ACCOUNT = `account-track:v2:${"a".repeat(64)}`;
const OTHER_ACCOUNT = `account-track:v2:${"b".repeat(64)}`;
const PROVIDER = "openai_codex";
const FINGERPRINT = "e".repeat(64);

function seeded(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const planEra = (index: number) => `plan-era:v1:${index.toString(16).padStart(64, "0")}`;
const anchor = (observedAtMs: number, planType: string, continuityId: string | null = null): V11PlanAnchor => ({
  contextKey: `${PROVIDER}|codex`, observedAtMs, planType, planVariant: "unknown",
  continuityId, conflicted: false, accountScopeId: ACCOUNT, planBasis: "same_source_occurrence",
});

/** Quota evidence for the composition. Its exact content is irrelevant to the
 * comparison — both sides get the identical rows — but it must be real enough
 * for the composition kernel to produce a result rather than refuse. */
function quotaRows(): V11AcquiredQuotaRow[] {
  return Array.from({ length: 12 }, (_, index) => ({
    occurrence_id: `quota-occurrence:v1:${String(index + 1).padStart(48, "0")}`,
    observed_at: new Date(BASE + index * 4 * HOUR).toISOString(), provider: PROVIDER,
    account_scope_id: ACCOUNT, limit_id: "codex", plan_type: "pro", plan_variant: "unknown",
    continuity_id: null, plan_basis: "same_source_occurrence" as const, slot: "seven_day",
    used_percent: index * 7, window_duration_minutes: 10_080,
    resets_at: new Date(BASE + 9 * DAY_MS).toISOString(),
    plan_era_key: JSON.stringify([`${PROVIDER}|codex`, ACCOUNT, "pro", "unknown", BASE]),
  }));
}

interface Fixture {
  index: PlanAttributionIndex;
  seeds: V11UsageModelSeed[];
  events: GraphDayUsageInput[];
}

function fixture(events: GraphDayUsageInput[], anchors: V11PlanAnchor[] = [
  anchor(BASE, "pro"), anchor(BASE + 3 * DAY_MS, "pro")]): Fixture {
  const index = buildPlanAttributionIndex(anchors);
  const era = index.eras[0];
  return { index, seeds: era === undefined ? [] : [{ provider: PROVIDER,
    accountScopeId: ACCOUNT, planEraKey: era.eraKey }], events };
}

/** Every event, one at a time, exactly as the reduction traverses them: the
 * session carry advances at the session step — before pricing — so an event
 * the reduction stores nothing for still moves its session's tail.
 *
 * NOTE for the next reader: this is a hand-written traversal, not
 * `advanceV11UsageReduction`. It drives the same two kernel entry points the
 * real reduction drives (`v11UsageEventEra`, `reduceV11UsageModelEvent`), so
 * what it proves is the FOLD'S AGGREGATION against per-event semantics — which
 * is the whole content of the fold. It does NOT prove row mapping, session
 * admission or refusal ordering; those are `v11PreparedUsageDayRow`'s, proven
 * by its own single shared `usageRowEvidence` and by the D1-backed reduction
 * specs. Anchoring this to the real reduction needs the full device, day, pin
 * and acquisition harness and is deliberately left undone. */
function streamed(input: Fixture) {
  const state = createV11UsageModelState();
  // The same admission rule the reduction runtime applies, not a restatement.
  const refusal = v11UsageModelRefusal(input.index, input.seeds.length);
  const carry = new Map<string, { time: number; scope: string | null }>();
  for (const event of input.events) {
    const prior = event.sessionDigest === null ? undefined : carry.get(event.sessionDigest);
    if (event.sessionDigest !== null) {
      carry.set(event.sessionDigest, { time: event.observedAtMs, scope: event.accountScopeId });
    }
    if (event.kind === "unmeasurable") continue;
    const accountBreak = prior !== undefined && prior.scope !== event.accountScopeId;
    const eraKey = v11UsageEventEra(input.index, { provider: event.provider,
      accountScopeId: event.accountScopeId, planBasis: event.planBasis, planType: event.planType,
      planEraId: event.planEraId, observedAtMs: event.observedAtMs, accountBreak,
      ...(prior ? { priorObservedAtMs: prior.time } : {}) });
    reduceV11UsageModelEvent(state, input.seeds[0] ?? null, refusal, { provider: event.provider,
      scope: event.accountScopeId, accountBreak, eraKey, observedAtMs: event.observedAtMs,
      fullyPriced: event.kind === "priced", model: event.model ?? "unknown",
      costNanousd: event.costNanousd, events: 1 });
  }
  return state;
}

function projected(input: Fixture): GraphDayProjection[] {
  const byDay = new Map<string, GraphDayUsageInput[]>();
  for (const event of input.events) {
    const day = new Date(event.observedAtMs).toISOString().slice(0, 10);
    const list = byDay.get(day);
    if (list === undefined) byDay.set(day, [event]); else list.push(event);
  }
  return [...byDay.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1))
    // Every event is one source row the day's reader returned, which is what
    // the day's own meter counts.
    .map(([day, events]) => reduceGraphDayProjection(day, [], { events, rowsRead: events.length }));
}

function composition(input: Fixture, half: ReturnType<typeof v11UsageModelHalf>) {
  return v11ModelCompositionFromModelHalf({ reason: null, half, quota: quotaRows(),
    planType: "pro", inputFingerprint: FINGERPRINT });
}

/** The comparison: the model half and the composition it produces must be
 * byte-identical between the streamed events and the folded prepared days. */
function parity(input: Fixture, label: string): { bins: number; poisoned: number } {
  const days = projected(input);
  for (const day of days) expect(validGraphDayProjection(day), `${label}: ${day.day}`).toBe(true);
  const stream = v11UsageModelHalf(streamed(input));
  const fold = v11UsageModelHalf(foldV11UsageModel(days, input.index, input.seeds));
  expect(canonicalJson(fold), `${label}: model half`).toBe(canonicalJson(stream));
  expect(canonicalJson(composition(input, fold)), `${label}: composition`)
    .toBe(canonicalJson(composition(input, stream)));
  return { bins: fold.modelCosts.length, poisoned: fold.poisoned.length };
}

/** Opaque 64-hex session digests, exactly the shape the builder derives. */
const session = (index: number) => index.toString(16).padStart(64, "0");

const event = (patch: Partial<GraphDayUsageInput> & { observedAtMs: number }): GraphDayUsageInput => ({
  sessionDigest: session(1), provider: PROVIDER, accountScopeId: ACCOUNT,
  planBasis: "same_source_occurrence", planType: "pro", planEraId: null,
  kind: "priced", model: "gpt-5.5", costNanousd: 1_000_000, ...patch,
});

describe("prepared usage model fold parity oracle", () => {
  it("matches over 150 randomized fixtures", () => {
    let compared = 0, bins = 0, poisoned = 0;
    for (let seed = 1; seed <= 150; seed += 1) {
      const random = seeded(seed);
      const events: GraphDayUsageInput[] = [];
      const sessions = 1 + Math.floor(random() * 4);
      const days = 2 + Math.floor(random() * 3);
      for (let day = 0; day < days; day += 1) {
        const perDay = 4 + Math.floor(random() * 20);
        for (let step = 0; step < perDay; step += 1) {
          const kindRoll = random();
          events.push(event({
            observedAtMs: BASE + day * DAY_MS + Math.floor(step * (DAY_MS / (perDay + 1))),
            sessionDigest: session(Math.floor(random() * sessions)),
            // An account that changes mid-stream is what makes a session's
            // account break, and therefore its openers, do any work.
            accountScopeId: random() < 0.15 ? OTHER_ACCOUNT : ACCOUNT,
            kind: kindRoll < 0.1 ? "unpriced" : kindRoll < 0.15 ? "unmeasurable" : "priced",
            model: kindRoll < 0.15 ? null : ["gpt-5.5", "gpt-5.5-codex", "o5"][Math.floor(random() * 3)]!,
            costNanousd: kindRoll < 0.15 ? 0 : Math.floor(random() * 5_000_000),
          }));
        }
      }
      events.sort((left, right) => left.observedAtMs - right.observedAtMs);
      const measured = parity(fixture(events), `seed ${seed}`);
      compared += 1; bins += measured.bins; poisoned += measured.poisoned;
    }
    expect(compared).toBe(150);
    // The corpora have to be doing work, or the oracle proves nothing.
    expect(bins).toBeGreaterThan(500);
    expect(poisoned).toBeGreaterThan(50);
  }, 600_000);

  it("keeps a session that spans midnight on one carry", () => {
    // The session's last event of day one is its carry-out; its first event of
    // day two is an opener whose account break is decided from that carry.
    const events = [
      event({ observedAtMs: BASE + 22 * HOUR }),
      event({ observedAtMs: BASE + 23 * HOUR + 30 * MINUTE }),
      event({ observedAtMs: BASE + DAY_MS + 30 * MINUTE }),
      event({ observedAtMs: BASE + DAY_MS + 3 * HOUR }),
    ];
    const measured = parity(fixture(events), "session across midnight");
    expect(measured.bins).toBeGreaterThan(0);
  });

  it("decides an account break that falls on the first event of a day", () => {
    // The break is invisible day-locally: day two's first event only differs
    // from day one's last, which the day never saw.
    const events = [
      event({ observedAtMs: BASE + 20 * HOUR }),
      event({ observedAtMs: BASE + 23 * HOUR }),
      event({ observedAtMs: BASE + DAY_MS + HOUR, accountScopeId: OTHER_ACCOUNT }),
      event({ observedAtMs: BASE + DAY_MS + 5 * HOUR, accountScopeId: OTHER_ACCOUNT }),
    ];
    const input = fixture(events);
    parity(input, "account break on a day's first event");
    // The break really did fire: an unresolved attribution is what it settles.
    expect(v11UsageModelHalf(streamed(input)).attributionUnresolved).toBe(true);
  });

  it("poisons a whole bin from one priced-but-not-fully event", () => {
    // Two priced events either side of an unpriced one in the same bin: the
    // bin is voided whatever its cost, and the day carries the bin instant
    // because a day-level unpriced count could never reconstruct it.
    const bin = BASE + 4 * HOUR;
    const events = [
      event({ observedAtMs: bin + 5 * MINUTE }),
      event({ observedAtMs: bin + 30 * MINUTE, kind: "unpriced", model: null, costNanousd: 0 }),
      event({ observedAtMs: bin + 90 * MINUTE }),
      event({ observedAtMs: bin + 3 * HOUR }),
    ];
    const measured = parity(fixture(events), "poisoned bin");
    expect(measured.poisoned).toBe(1);
    expect(measured.bins).toBe(2);
  });

  it("refuses identically when an era boundary falls inside a two-hour bin", () => {
    // Two eras is exactly what the model metric refuses on, so a boundary
    // inside a bin never has to be resolved: both paths refuse the same way.
    const boundary = BASE + 4 * HOUR + 40 * MINUTE;
    // Two eras of the SAME plan, split by a continuity change, so the refusal
    // is the era one rather than the plan one.
    const input = fixture([
      event({ observedAtMs: BASE + 4 * HOUR + 10 * MINUTE, planEraId: planEra(1) }),
      event({ observedAtMs: boundary + 10 * MINUTE, planEraId: planEra(2) }),
    ], [anchor(BASE, "pro", planEra(1)), anchor(boundary, "pro", planEra(2))]);
    expect(input.index.eras.length).toBeGreaterThan(1);
    parity(input, "era boundary inside a bin");
    expect(v11UsageModelHalf(streamed(input)).modelRefusal).toBe("multi_era_window_unsupported");
  });

  it("carries out a session whose last event of a day the reduction dropped", () => {
    // `unmeasurable` is the reduction's own drop, and it happens AFTER the
    // session carry advances. A carry-out that omitted it would decide the
    // next day's first account break from a stale scope — once per affected
    // session boundary, and in the direction that hides a break.
    const events = [
      event({ observedAtMs: BASE + 10 * HOUR }),
      event({ observedAtMs: BASE + 23 * HOUR, accountScopeId: OTHER_ACCOUNT,
        kind: "unmeasurable", model: null, costNanousd: 0 }),
      event({ observedAtMs: BASE + DAY_MS + 2 * HOUR }),
    ];
    const input = fixture(events);
    parity(input, "dropped last event advances the carry");
    // The break is between the dropped row's scope and the next day's event,
    // so it exists only if the dropped row reached the carry at all.
    expect(v11UsageModelHalf(streamed(input)).attributionUnresolved).toBe(true);
  });

  it("fails when one prepared day is perturbed", () => {
    const events = Array.from({ length: 40 }, (_, index) => event({
      observedAtMs: BASE + index * 40 * MINUTE, costNanousd: 1_000_000 + index }));
    const input = fixture(events);
    const days = projected(input);
    const stream = v11UsageModelHalf(streamed(input));
    expect(canonicalJson(v11UsageModelHalf(foldV11UsageModel(days, input.index, input.seeds))))
      .toBe(canonicalJson(stream));
    const target = days.find((day) => day.usage.cells.length > 2)!;
    const cells = [...target.usage.cells];
    // One cell, in the middle of the day so it is inside the quota window the
    // composition measures against: a whole dollar and one event.
    const index = Math.floor(cells.length / 2);
    cells[index] = { ...cells[index]!, costNanousd: cells[index]!.costNanousd + 1_000_000_000,
      eventCount: cells[index]!.eventCount + 1 };
    const perturbed = days.map((day) => day === target
      ? { ...day, usage: { ...day.usage, cells } } : day);
    const folded = v11UsageModelHalf(foldV11UsageModel(perturbed, input.index, input.seeds));
    expect(canonicalJson(folded)).not.toBe(canonicalJson(stream));
    expect(canonicalJson(composition(input, folded)))
      .not.toBe(canonicalJson(composition(input, stream)));
  });

  it("refuses a usage window with a day missing", () => {
    // The same precondition as the quota fold: a folded window with a day
    // absent produces a complete-looking model composition without it. The
    // shared rule is the kernel's, so both folds refuse the same way.
    const events = [
      event({ observedAtMs: BASE + 3 * HOUR }),
      event({ observedAtMs: BASE + DAY_MS + 3 * HOUR }),
      event({ observedAtMs: BASE + 2 * DAY_MS + 3 * HOUR }),
    ];
    const days = projected(fixture(events));
    const expected = days.map((day) => day.day);
    expect(days.length).toBe(3);
    expect(() => assertV11PreparedDayCoverage(days.slice(1), expected))
      .toThrowError("v11 quota prepared day set incomplete");
    expect(() => assertV11PreparedDayCoverage(days, expected)).not.toThrow();
  });

  it("refuses at each window bound the folded days can measure", () => {
    // `MAX_WINDOWED_USAGE_ROWS` is measured on the rows the reader returned,
    // which each day meters itself — before the mapper, so a row the reduction
    // skips still counts. That is the same quantity the stream accumulates.
    const events = Array.from({ length: 30 }, (_, index) => event({
      observedAtMs: BASE + index * 30 * MINUTE }));
    const days = projected(fixture(events));
    const counted = v11FoldedUsageRowCount(days);
    expect(counted).toBe(events.length);
    // At the bound the window is admitted; one row past it, it refuses — the
    // exact point the streaming reduction refuses at.
    expect(v11FoldedUsageWindowRefusal(days, counted)).toBeNull();
    expect(v11FoldedUsageWindowRefusal(days, counted - 1)).toBe("windowed_usage_limit_exceeded");
    // A row the reduction drops after advancing its session is still a row the
    // reader returned, so the count MOVES. It is no longer a lower bound.
    const withDropped = projected(fixture([...events,
      event({ observedAtMs: BASE + 20 * HOUR, kind: "unmeasurable", model: null, costNanousd: 0 })]));
    expect(v11FoldedUsageRowCount(withDropped)).toBe(counted + 1);
    expect(v11FoldedUsageWindowRefusal(withDropped, counted)).toBe("windowed_usage_limit_exceeded");
    // The session bound is exact: the union of the days' tails is the
    // reduction's own `usagePrevious`.
    const sessions = new Set(days.flatMap((day) => day.usage.sessions.map((s) => s.sessionDigest)));
    expect(sessions.size).toBe(1);
  });
});
