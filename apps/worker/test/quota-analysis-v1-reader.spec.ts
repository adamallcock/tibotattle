import { describe, expect, it } from "vitest";
import { buildPlanAttributionIndex, planEraForInterval } from "@app-usagemonitor/quota-analysis";
import {
  advanceV1QuotaAcquisition,
  advanceV1QuotaAcquisitionPage,
  createV1QuotaAcquisitionCheckpoint,
  createV1QuotaWorkInterner,
  decodeV1QuotaWorkCheckpoint,
  encodeV1QuotaWorkCheckpoint,
  validateV1QuotaWorkControl,
  validateV1QuotaWorkPart,
  validateV1QuotaPageReplay,
  validateV1CompletedQuotaAcquisition,
  V1_QUOTA_ACQUISITION_PAGE_SIZE,
} from "../src/quota-analysis-v1-reader";
import type {
  V1FitSourceRow, V1PlanSourceRow, V1QuotaAcquisitionCheckpoint,
  V1QuotaAcquisitionIdentity, V1QuotaAcquisitionStep, V1QuotaPageReader,
} from "../src/quota-analysis-v1-reader";

const BASE = Date.parse("2026-08-01T00:00:00.000Z");
const RESET = "2026-08-08T00:00:00.000Z";
const IDENTITY: V1QuotaAcquisitionIdentity = {
  participantId: "synthetic-reader-participant", inputFingerprint: "a".repeat(64),
  sourceMethodVersion: "synthetic-pinned-source", observedAtCutoff: "2026-07-01T00:00:00.000Z",
  resetsAtCutoff: "2026-07-08T00:00:00.000Z", windowMinutes: 10_080, maxQuotaRows: 60_000,
};
const at = (offset: number) => new Date(BASE + offset).toISOString();
function row(id: number, percent: number, offset = id * 1000, patch: Partial<V1FitSourceRow> = {}): V1FitSourceRow {
  return { id, occurrence_id: `synthetic-occurrence-${id}`, observed_at: at(offset), observed_day: "2026-08-01",
    device_id: "winner", provider: "openai_codex", plan_type: "pro", plan_variant: "unknown",
    limit_id: "codex", slot: "seven_day", used_percent: percent, window_duration_minutes: 10_080,
    resets_at: RESET, ...patch };
}
function fixtureReader(plan: V1PlanSourceRow[], fit: V1FitSourceRow[]) {
  const orderedPlan = [...plan].sort((left, right) => left.observed_at.localeCompare(right.observed_at) || left.id - right.id);
  const orderedFit = [...fit].sort((left, right) => left.resets_at.localeCompare(right.resets_at)
    || left.observed_at.localeCompare(right.observed_at) || left.id - right.id);
  const calls: string[] = [];
  const reader: V1QuotaPageReader = {
    async readPlanPage(cursor, limit) {
      calls.push("plan");
      return orderedPlan.filter((value) => value.observed_at > cursor.observedAt
        || (value.observed_at === cursor.observedAt && value.id > cursor.id)).slice(0, limit);
    },
    async readFitPage(cursor, limit) {
      calls.push("fit");
      return orderedFit.filter((value) => value.resets_at > cursor.resetsAt
        || (value.resets_at === cursor.resetsAt && (value.observed_at > cursor.observedAt
          || (value.observed_at === cursor.observedAt && value.id > cursor.id)))).slice(0, limit);
    },
  };
  return { reader, calls };
}
async function finish(plan: V1PlanSourceRow[], fit: V1FitSourceRow[], options: {
  maxQuotaRows?: number; queriesPerInvocation?: number; winners?: ReadonlyMap<string, string>;
} = {}) {
  const identity = { ...IDENTITY, maxQuotaRows: options.maxQuotaRows ?? IDENTITY.maxQuotaRows };
  const fixture = fixtureReader(plan, fit);
  let checkpoint: V1QuotaAcquisitionCheckpoint | undefined;
  const phases = new Set<string>();
  let result: V1QuotaAcquisitionStep;
  for (let invocation = 0; invocation < 1000; invocation++) {
    const queries = options.queriesPerInvocation ?? 1;
    const budget = { remainingQueries: queries, deadlineMs: 1, now: () => 0 };
    const before = fixture.calls.length;
    result = await advanceV1QuotaAcquisition(fixture.reader, identity,
      options.winners ?? new Map([["2026-08-01", "winner"]]), budget, checkpoint);
    expect(fixture.calls.length - before).toBeLessThanOrEqual(queries);
    expect(budget.remainingQueries).toBe(queries - (fixture.calls.length - before));
    if (result.status !== "deferred") return { result, phases, calls: fixture.calls };
    phases.add(result.checkpoint.phase);
    // A real resume loses object identity: endpoints and equal-time anchors
    // must survive serialization, not rely on Map or shared object references.
    const encoded = JSON.parse(JSON.stringify(encodeV1QuotaWorkCheckpoint(result.checkpoint)));
    checkpoint = decodeV1QuotaWorkCheckpoint(identity, encoded.control, encoded.components);
  }
  throw new Error("synthetic acquisition did not finish");
}

describe("resumable v1 quota acquisition", () => {
  it("retains exact dense endpoints across pages and serialized phase boundaries", async () => {
    const rows: V1FitSourceRow[] = [];
    const expected: string[] = [];
    for (let level = 0; level < 9; level++) {
      for (let repeat = 0; repeat < 150; repeat++) {
        const value = row(rows.length + 1, level * 10);
        rows.push(value);
        if (repeat === 0 || repeat === 149) expected.push(value.occurrence_id);
      }
    }
    const { result, phases } = await finish(rows, rows);
    expect([...phases].sort()).toEqual(["endpoints", "fitability", "plan"]);
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.quotaRows.map((value) => value.occurrence_id)).toEqual(expected);
    expect(result.attributionIndex.eras).toHaveLength(1);
  });

  it("uses numeric insertion IDs through an equal-time run, not occurrence order", async () => {
    const rows = Array.from({ length: V1_QUOTA_ACQUISITION_PAGE_SIZE + 17 }, (_, offset) =>
      row(offset + 1, 0, 0, { occurrence_id: `reversed-${99999 - offset}` }));
    for (let level = 1; level < 9; level++) rows.push(row(rows.length + 1, level * 10, level * 1000));
    const { result } = await finish(rows, rows);
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.quotaRows.filter((value) => value.used_percent === 0).map((value) => value.occurrence_id))
      .toEqual([rows[0]!.occurrence_id, rows[V1_QUOTA_ACQUISITION_PAGE_SIZE + 16]!.occurrence_id]);
  });

  it("advances through full losing-device pages without treating them as end of input", async () => {
    const losers = Array.from({ length: V1_QUOTA_ACQUISITION_PAGE_SIZE * 2 }, (_, offset) =>
      row(offset + 1, 10, 0, { device_id: "loser" }));
    const winners = Array.from({ length: 9 }, (_, offset) => row(losers.length + offset + 1, offset * 10));
    const { result, calls } = await finish([...losers, ...winners], [...losers, ...winners]);
    expect(calls.filter((call) => call === "plan")).toHaveLength(3);
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.quotaRows.map((value) => value.occurrence_id)).toEqual(winners.map((value) => value.occurrence_id));
  });

  it("keeps short-window equal-time contradictions and separates returning plan eras", async () => {
    const rows: V1FitSourceRow[] = [];
    for (let level = 0; level < 17; level++) for (let repeat = 0; repeat < 2; repeat++) {
      rows.push(row(rows.length + 1, level * 5, level * 1000));
    }
    const contradictory = row(9999, 40, 8000, { plan_type: "plus", window_duration_minutes: 300 });
    const { result } = await finish([...rows, contradictory], rows);
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.attributionIndex.conflicts).toHaveLength(1);
    expect(new Set(result.quotaRows.map((value) => value.plan_era_key)).size).toBe(2);
    expect(result.quotaRows).toHaveLength(32);
    expect(result.quotaRows.some((value) => value.observed_at === at(8000))).toBe(false);
  });

  it("matches the full plan builder at conflict boundaries regardless of lexical labels or page splits", async () => {
    for (const [ordinary, contradictory] of [["plus", "pro"], ["pro", "plus"]]) {
      for (const conflictOffset of [0, 8000, 16000]) {
        // Place the contradictory equal-time bucket before, across, and after
        // a physical page boundary. IDs, not lexical labels, drive paging.
        for (const padding of [0, 1022, 1023, 1024]) {
          const observations = Array.from({ length: 17 }, (_, index) => row(index + 1, index * 5,
            index * 1000, { plan_type: ordinary }));
          for (let index = 0; index < padding; index++) observations.push(row(index + 100, 10,
            conflictOffset, { plan_type: ordinary }));
          observations.push(row(99999, 10, conflictOffset, { plan_type: contradictory, window_duration_minutes: 300 }));
          const full = buildPlanAttributionIndex(observations.map((value) => ({
            contextKey: `${value.provider}|${value.limit_id}`, accountScopeId: null,
            observedAtMs: Date.parse(value.observed_at), planType: value.plan_type, planVariant: value.plan_variant,
          })));
          const { result } = await finish(observations, []);
          expect(result.status).toBe("complete");
          if (result.status !== "complete") throw new Error("expected complete");
          expect(result.attributionIndex.eras).toEqual(full.eras);
          expect(result.attributionIndex.conflicts).toEqual(full.conflicts);
          for (const offset of [-1000, 0, 1, 7999, 8000, 8001, 9000, 15999, 16000, 17000]) {
            const query = { contextKey: "openai_codex|codex", observedAtMs: BASE + offset };
            expect(planEraForInterval(result.attributionIndex, query)).toEqual(planEraForInterval(full, query));
          }
        }
      }
    }
  });

  it("does not turn unknown and known labels at one timestamp into a conflict", async () => {
    const observations = [row(1, 0, 0), row(2, 10, 1000, { plan_type: "unknown" }), row(3, 10, 1000), row(4, 20, 2000)];
    const { result } = await finish(observations, []);
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.attributionIndex.conflicts).toEqual([]);
    expect(result.attributionIndex.eras).toEqual(buildPlanAttributionIndex(observations.map((value) => ({
      contextKey: "openai_codex|codex", accountScopeId: null, observedAtMs: Date.parse(value.observed_at),
      planType: value.plan_type, planVariant: value.plan_variant,
    }))).eras);
  });

  it("does not apply the output cap to sparse nonfitable resets or arbitrary slot tokens", async () => {
    const rows = Array.from({ length: 4097 }, (_, offset) => row(offset + 1, 10, offset * 1000, {
      resets_at: new Date(Date.parse(RESET) + offset * 1000).toISOString(), slot: `slot-${offset}`,
    }));
    const { result } = await finish(rows, rows, { maxQuotaRows: 1 });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.quotaRows).toEqual([]);
  });

  it("keeps winner changes, provider contexts and gapped returning plan evidence separate", async () => {
    const first = Array.from({ length: 9 }, (_, index) => row(index + 1, index * 10, index * 1000));
    const second = Array.from({ length: 9 }, (_, index) => row(index + 101, index * 10, 86400000 + index * 1000,
      { observed_day: "2026-08-02", device_id: "next-winner", plan_type: "plus" }));
    const other = Array.from({ length: 9 }, (_, index) => row(index + 201, index * 10, index * 1000,
      { provider: "another_provider", slot: "another_slot" }));
    const losers = [...first.map((value) => ({ ...value, id: value.id + 1000, device_id: "next-winner", plan_type: "free" })),
      ...second.map((value) => ({ ...value, id: value.id + 1000, device_id: "winner", plan_type: "free" }))];
    const observations = [...first, ...second, ...other, ...losers];
    const { result } = await finish([...observations, { ...row(9999, 10, 0), provider: null }], observations,
      { winners: new Map([["2026-08-01", "winner"], ["2026-08-02", "next-winner"]]) });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.quotaRows).toHaveLength(27);
    expect(result.attributionIndex.eras).toHaveLength(3);
    expect(result.quotaRows.some((value) => value.plan_type === "free")).toBe(false);
    expect(result.quotaRows.filter((value) => value.provider === "another_provider")).toHaveLength(9);
    expect(result.quotaRows.filter((value) => value.plan_type === "plus").map((value) => value.occurrence_id))
      .toEqual(second.map((value) => value.occurrence_id));
  });

  it("caps arbitrary slot state only after the shared fitability threshold", async () => {
    const below = Array.from({ length: 2049 }, (_, offset) => row(offset + 1, (offset % 7) * 10,
      offset * 1000, { slot: `slot-${offset}` }));
    const absent = await finish(below, below, { maxQuotaRows: 1 });
    expect(absent.result).toMatchObject({ status: "complete", quotaRows: [] });
    const atThreshold = Array.from({ length: 9 }, (_, offset) =>
      row(offset + 1, offset * 10, offset * 1000, { slot: `slot-${offset}` }));
    expect((await finish(atThreshold, atThreshold, { maxQuotaRows: 9 })).result)
      .toMatchObject({ status: "complete", quotaRows: expect.arrayContaining(atThreshold.map((value) =>
        expect.objectContaining({ occurrence_id: value.occurrence_id }))) });
    expect((await finish(atThreshold, atThreshold, { maxQuotaRows: 8 })).result)
      .toEqual({ status: "not_testable", reason: "downsampled_quota_limit_exceeded" });
  });

  it("defers without querying on exhausted invocation budget or deadline", async () => {
    const fixture = fixtureReader([], []);
    for (const budget of [
      { remainingQueries: 0, deadlineMs: 1, now: () => 0 },
      { remainingQueries: 10, deadlineMs: 1, now: () => 1 },
    ]) {
      expect(await advanceV1QuotaAcquisition(fixture.reader, IDENTITY, new Map(), budget))
        .toMatchObject({ status: "deferred", checkpoint: { phase: "plan" } });
    }
    expect(fixture.calls).toEqual([]);
  });

  it("rejects cross-source checkpoints and unordered or oversized adapter pages", async () => {
    const fixture = fixtureReader([], []);
    const checkpoint = createV1QuotaAcquisitionCheckpoint(IDENTITY);
    await expect(advanceV1QuotaAcquisition(fixture.reader, { ...IDENTITY, inputFingerprint: "b".repeat(64) }, new Map(),
      { remainingQueries: 1, deadlineMs: 1, now: () => 0 }, checkpoint)).rejects.toThrow("checkpoint invalid");
    expect(fixture.calls).toEqual([]);
    const invalidReader: V1QuotaPageReader = {
      ...fixture.reader, async readPlanPage() { return [row(2, 20), row(1, 10)]; },
    };
    await expect(advanceV1QuotaAcquisition(invalidReader, IDENTITY, new Map(),
      { remainingQueries: 1, deadlineMs: 1, now: () => 0 })).rejects.toThrow("page order invalid");
    invalidReader.readPlanPage = async () => Array.from({ length: V1_QUOTA_ACQUISITION_PAGE_SIZE + 1 }, (_, id) => row(id + 1, 0));
    await expect(advanceV1QuotaAcquisition(invalidReader, IDENTITY, new Map(),
      { remainingQueries: 1, deadlineMs: 1, now: () => 0 })).rejects.toThrow("page overflow");
  });

  it("refuses private/unknown checkpoint fields and malformed cross-part state without repair", () => {
    const encoded = encodeV1QuotaWorkCheckpoint(createV1QuotaAcquisitionCheckpoint(IDENTITY));
    const canary = "private-checkpoint-canary";
    expect(validateV1QuotaWorkControl({ ...encoded.control, prompt: canary })).toBe(false);
    const anchor = { observedAtMs: BASE, sourceContext: '["openai_codex","codex"]', contextKey: "openai_codex|codex",
      planType: "pro", planVariant: "unknown", accountScopeId: null };
    expect(validateV1QuotaWorkPart("plan-anchors", [anchor])).toBe(true);
    expect(validateV1QuotaWorkPart("plan-anchors", [{ ...anchor, prompt: canary }])).toBe(false);
    expect(validateV1QuotaWorkPart("fit-stats", [["invalid-era", { values: [0], minimum: 0, maximum: 0 }]])).toBe(false);
    expect(validateV1QuotaWorkPart("eligible", ["not-json"])).toBe(false);
    for (const [control, components] of [
      [{ ...encoded.control, prompt: canary }, encoded.components],
      [encoded.control, { ...encoded.components, prompt: canary }],
      [encoded.control, { ...encoded.components, "plan-equal-time": [anchor] }],
      [encoded.control, { ...encoded.components, endpoints: [null] }],
    ]) {
      try {
        decodeV1QuotaWorkCheckpoint(IDENTITY, control, components);
        throw new Error("expected checkpoint refusal");
      } catch (error) {
        expect((error as Error).message).toBe("v1 quota acquisition checkpoint invalid");
        expect((error as Error).message).not.toContain(canary);
      }
    }
  });

  it("interns bounded endpoint parts losslessly and rejects conflicting content for one record ID", () => {
    const input = row(1, 0, 0);
    const { id, device_id: _device, observed_day: _day, ...quota } = input;
    const era = JSON.stringify(["openai_codex|codex", null, "pro", "unknown", BASE]);
    const endpoint = { id, row: { ...quota, plan_era_key: era } };
    const firstPart = JSON.parse(JSON.stringify([endpoint]));
    const runPart = JSON.parse(JSON.stringify([[era, input.slot, { firstId: id, last: endpoint }]]));
    const interner = createV1QuotaWorkInterner();
    interner.internPart("endpoints", firstPart);
    interner.internPart("endpoint-runs", runPart);
    expect(runPart[0][2].last).toBe(firstPart[0]);
    expect(JSON.parse(JSON.stringify(firstPart))).toEqual([endpoint]);
    const corrupted = JSON.parse(JSON.stringify(runPart));
    corrupted[0][2].last.row.used_percent = 50;
    expect(() => interner.internPart("endpoint-runs", corrupted)).toThrow("v1 quota acquisition checkpoint invalid");
    interner.release();
  });

  it("replays exactly one physical page and its phase transition independently of deadline timing", async () => {
    const rows = Array.from({ length: 1350 }, (_, index) => row(index + 1, Math.floor(index / 150) * 10));
    const fixture = fixtureReader(rows, rows);
    let checkpoint = createV1QuotaAcquisitionCheckpoint(IDENTITY);
    const phases = new Set<string>();
    for (let step = 0; step < 20; step++) {
      let clock = 0;
      const delayedReader: V1QuotaPageReader = {
        async readPlanPage(cursor, limit) { const rows = await fixture.reader.readPlanPage(cursor, limit); clock = 2; return rows; },
        async readFitPage(cursor, limit) { const rows = await fixture.reader.readFitPage(cursor, limit); clock = 2; return rows; },
      };
      const original = JSON.parse(JSON.stringify(checkpoint));
      const firstBudget = { remainingQueries: 10, deadlineMs: 1, now: () => clock };
      const first = await advanceV1QuotaAcquisitionPage(delayedReader, IDENTITY, new Map([["2026-08-01", "winner"]]),
        firstBudget, JSON.parse(JSON.stringify(original)));
      const replayBudget = { remainingQueries: 10, deadlineMs: 1, now: () => 0 };
      const replay = await advanceV1QuotaAcquisitionPage(fixture.reader, IDENTITY, new Map([["2026-08-01", "winner"]]),
        replayBudget, JSON.parse(JSON.stringify(original)));
      expect(firstBudget.remainingQueries).toBe(9);
      expect(replayBudget.remainingQueries).toBe(9);
      expect(first).toEqual(replay);
      expect(validateV1QuotaPageReplay(first.replay)).toBe(true);
      expect(first.replay?.from).toEqual({ phase: original.phase, cursor: original.cursor });
      expect(validateV1QuotaPageReplay({ ...first.replay, privateNote: "private-replay-canary" })).toBe(false);
      phases.add(first.replay!.through.phase);
      if (first.result.status === "complete") {
        expect(validateV1CompletedQuotaAcquisition({ planAnchors: first.result.planAnchors, quotaRows: first.result.quotaRows })).toBe(true);
        expect(first.checkpoint?.phase).toBe("endpoints");
        const encoded = JSON.parse(JSON.stringify(encodeV1QuotaWorkCheckpoint(first.checkpoint!)));
        const restored = decodeV1QuotaWorkCheckpoint(IDENTITY, encoded.control, encoded.components);
        expect(restored.endpoints.map((endpoint) => endpoint.row)).toEqual(first.result.quotaRows);
        expect(restored.endpoints.map((endpoint) => endpoint.id)).toEqual(first.checkpoint!.endpoints.map((endpoint) => endpoint.id));
        expect([...phases].sort()).toEqual(["complete", "endpoints", "fitability", "plan"]);
        return;
      }
      if (first.result.status !== "deferred") throw new Error("unexpected analytical refusal");
      checkpoint = first.result.checkpoint;
    }
    throw new Error("bounded replay fixture did not complete");
  });

  it("never marks a zero-query deferral as resolved and validates only the closed completed shape", async () => {
    const fixture = fixtureReader([], []);
    const result = await advanceV1QuotaAcquisitionPage(fixture.reader, IDENTITY, new Map(),
      { remainingQueries: 0, deadlineMs: 1, now: () => 0 });
    expect(result.replay).toBeNull();
    expect(result.checkpoint).toBeNull();
    expect(fixture.calls).toEqual([]);
    expect(validateV1CompletedQuotaAcquisition({ planAnchors: [], quotaRows: [] })).toBe(true);
    expect(validateV1CompletedQuotaAcquisition({ planAnchors: [], quotaRows: [], prompt: "private-completed-canary" })).toBe(false);
    expect(validateV1CompletedQuotaAcquisition({ planAnchors: [null], quotaRows: [] })).toBe(false);
    expect(validateV1CompletedQuotaAcquisition({ planAnchors: [], quotaRows: [null] })).toBe(false);
  });
});
