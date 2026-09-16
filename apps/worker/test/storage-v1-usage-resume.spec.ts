import { env, reset, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { advanceStorageV1CurrentFitAnalysis, type StorageV1HistoryCheckpoint } from "../src/storage-v1-history";
import { accountScopedQuotaAnalysisV1, advanceV1UsageReduction, createV1UsageReductionCheckpoint,
  MAX_V1_USAGE_REDUCTION_CHECKPOINT_BYTES, MAX_WINDOWED_USAGE_ROWS,
  V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION } from "../src/quota-analysis-v1";
import { loadV1SourcePin } from "../src/telemetry-v1-source-selection";
import { modelHistoryWindow } from "../src/model-history-window";
import { loadStorageHistoryCheckpoint, saveStorageHistoryCheckpoint, type StorageHistoryKey } from "../src/storage-history-checkpoint";
import { insertModelHistoryRecords, pricedModelHistoryUsage, seedModelHistoryFixture,
  MODEL_HISTORY_TEST_DAY as DAY } from "./helpers/model-history";

const db = () => env.USAGE_MONITOR_DB;
const bindings = () => env as Env & { TEST_MIGRATIONS: D1Migration[]; TEST_ANALYTICS_MIGRATIONS: D1Migration[];
  STORAGE_ANALYTICS_DB: D1Database };
const migrations = () => bindings().TEST_MIGRATIONS;
const target = () => bindings().STORAGE_ANALYTICS_DB;
const budget = () => ({ remainingQueries: 1_000, deadlineMs: Date.now() + 60_000 });
const BASE = Date.parse("2026-09-01T00:00:00.000Z");

function observeUsageReads(database: D1Database) {
  let usageRowsRead = 0;
  const cursors: unknown[][] = [];
  type Wrapped = D1PreparedStatement & { inner?: D1PreparedStatement };
  const wrap = (inner: D1PreparedStatement, sql: string, args: unknown[] = []): Wrapped =>
    new Proxy(inner as Wrapped, { get(value, key) {
      if (key === "bind") return (...bindings: unknown[]) => wrap(inner.bind(...bindings), sql, bindings);
      if (key === "all") return async (...callArgs: unknown[]) => {
        const result = await Reflect.apply(Reflect.get(inner, key) as Function, inner, callArgs) as D1Result<unknown>;
        if (sql.includes("telemetry_v1_records") && sql.includes("stream = 'usage'")) {
          usageRowsRead += result.results.length;
          cursors.push(args);
        }
        return result;
      };
      const member = Reflect.get(inner, key);
      return typeof member === "function" ? member.bind(inner) : member;
    } });
  return {
    database: new Proxy(database, { get(value, key) {
      if (key === "prepare") return (sql: string) => wrap(value.prepare(sql), sql);
      if (key === "batch") return async (statements: Wrapped[]) => value.batch(
        statements.map(statement => statement.inner ?? statement));
      const member = Reflect.get(value, key);
      return typeof member === "function" ? member.bind(value) : member;
    } }),
    usageRowsRead: () => usageRowsRead,
    cursors: () => cursors,
  };
}

async function seedPagedFixture(equalTime = false) {
  const fixture = await seedModelHistoryFixture();
  await insertModelHistoryRecords(fixture, "paged", Array.from({ length: 5_001 }, (_, index) =>
    pricedModelHistoryUsage("gpt-5.6-sol", 0.0001,
      new Date(BASE + (equalTime ? 8.5 * 3_600_000 : 3 * 3_600_000 + index * 1_000)).toISOString()).record));
  if (equalTime) {
    const prior = await db().prepare(`SELECT id FROM telemetry_v1_records WHERE participant_id=? AND stream='usage'
      AND observed_at=? ORDER BY id LIMIT 1`).bind(fixture.participantId,
        new Date(BASE + 6.5 * 3_600_000).toISOString()).first<number>('id');
    const final = await db().prepare(`SELECT MAX(id) AS id FROM telemetry_v1_records
      WHERE participant_id=? AND stream='usage' AND chunk_row_id LIKE '%-paged-%'`).bind(fixture.participantId).first<number>('id');
    if (prior === null || final === null) throw new Error('synthetic equal-time fixture missing');
    await db().batch([
      db().prepare("UPDATE telemetry_v1_records SET plan_type='plus' WHERE stream='quota' AND observed_at=?")
        .bind(new Date(BASE + 7 * 3_600_000).toISOString()),
      db().prepare("UPDATE telemetry_v1_records SET session_uuid='synthetic-equal-time-session',occurrence_id='prior' WHERE id=?")
        .bind(prior),
      db().prepare(`UPDATE telemetry_v1_records SET session_uuid='synthetic-equal-time-session',
        occurrence_id=CASE WHEN id=? THEN 'a-final-drop' ELSE printf('z-%08d',id) END,
        record_json=CASE WHEN id=? THEN '{}' ELSE record_json END
        WHERE participant_id=? AND stream='usage' AND chunk_row_id LIKE '%-paged-%'`)
        .bind(final,final,fixture.participantId),
    ]);
  }
  const window = modelHistoryWindow(DAY);
  const sourcePin = await loadV1SourcePin(db(), { participantId: fixture.participantId, fromDay: window.fromDay });
  return { fixture, sourcePin, window };
}

async function acquireFinishCheckpoint(input: Awaited<ReturnType<typeof seedPagedFixture>>) {
  let checkpoint: StorageV1HistoryCheckpoint | null = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await advanceStorageV1CurrentFitAnalysis({ source: db(), participantId: input.fixture.participantId,
      day: DAY, sourcePin: input.sourcePin, budget: budget(), checkpoint, maxPages: 32 });
    expect(result.status).toBe("deferred");
    if (result.status !== "deferred" || !result.checkpoint) throw new Error("expected acquisition checkpoint");
    checkpoint = result.checkpoint;
    if (checkpoint.phase === "finish") return checkpoint;
  }
  throw new Error("synthetic acquisition did not finish");
}

async function seedSessionPlanSwitchFixture() {
  const fixture = await seedModelHistoryFixture();
  const at = (hours: number) => new Date(BASE + hours * 3_600_000).toISOString();
  await db().prepare("UPDATE telemetry_v1_records SET plan_type='plus' WHERE stream='quota' AND observed_at=?")
    .bind(at(7)).run();
  const updateSessions = async (hours: number, occurrences: (string | null)[]) => {
    const rows = (await db().prepare("SELECT id FROM telemetry_v1_records WHERE participant_id=? AND stream='usage'\n"
      + "AND observed_at=? ORDER BY id").bind(fixture.participantId, at(hours)).all<{ id: number }>()).results;
    expect(rows.length).toBeGreaterThanOrEqual(occurrences.length);
    for (const [index, occurrence] of occurrences.entries()) {
      if (occurrence === null) continue;
      const row = rows[index]!;
      await db().prepare("UPDATE telemetry_v1_records SET session_uuid=?,occurrence_id=? WHERE id=?")
        .bind("synthetic-session-switch", occurrence, row.id).run();
    }
  };
  await updateSessions(6.5, ["session-prior", null]);
  await updateSessions(8.5, ["session-z", "session-a"]);
  const window = modelHistoryWindow(DAY);
  const sourcePin = await loadV1SourcePin(db(), { participantId: fixture.participantId, fromDay: window.fromDay });
  return { fixture, sourcePin, window };
}

beforeEach(async () => { await reset(); await applyD1Migrations(db(), migrations());
  await applyD1Migrations(target(), bindings().TEST_ANALYTICS_MIGRATIONS); });

describe("resumable current-fit v1 usage reduction", () => {
  it("persists a page cursor, resumes without rereading it, and matches the old scalar result", async () => {
    const input = await seedPagedFixture();
    const finishCheckpoint = await acquireFinishCheckpoint(input);
    const observed = observeUsageReads(db());
    const first = await advanceStorageV1CurrentFitAnalysis({ source: observed.database,
      participantId: input.fixture.participantId, day: DAY, sourcePin: input.sourcePin,
      budget: budget(), checkpoint: finishCheckpoint, maxPages: 1 });
    expect(first.status).toBe("deferred");
    if (first.status !== "deferred" || !first.checkpoint || first.checkpoint.phase !== "usage") {
      throw new Error("expected a persisted usage checkpoint");
    }
    const usageCheckpoint = first.checkpoint;
    expect(usageCheckpoint.usage.rowsRead).toBe(5_000);
    expect(usageCheckpoint.usage.cursorId).toBeGreaterThan(0);
    expect(observed.usageRowsRead()).toBe(5_000);

    const resumed = await advanceStorageV1CurrentFitAnalysis({ source: observed.database,
      participantId: input.fixture.participantId, day: DAY, sourcePin: input.sourcePin,
      budget: budget(), checkpoint: usageCheckpoint, maxPages: 1 });
    expect(resumed.status).toBe("complete");
    if (resumed.status !== "complete") throw new Error("expected resumed scalar result");
    expect(observed.usageRowsRead()).toBe(5_121);
    expect(observed.cursors().some(args => args.includes(usageCheckpoint.usage.cursorObservedAt))).toBe(true);

    const baseline = await accountScopedQuotaAnalysisV1(db(), input.fixture.participantId,
      { nowMs: Date.parse(input.window.fixedNow), sourcePin: input.sourcePin });
    const normalize = (value: object) => {
      const copy = structuredClone(value) as Record<string, unknown>;
      delete copy.attributionMethod;
      return copy;
    };
    expect(normalize(resumed.analysis)).toEqual(normalize(baseline));

    await db().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(input.fixture.participantId).run();
    await expect(advanceStorageV1CurrentFitAnalysis({ source: observed.database,
      participantId: input.fixture.participantId, day: DAY, sourcePin: input.sourcePin,
      budget: budget(), checkpoint: usageCheckpoint, maxPages: 1 })).rejects
      .toMatchObject({ message: "STORAGE_GRAPH_OPERATION_UNAVAILABLE",
        stage: "graph_current_fit_compute", reason: "source_changed" });
  }, 60_000);

  it("persists valid terminal refusals at the row and encoded-payload boundaries", async () => {
    const input = await seedPagedFixture();
    const finishCheckpoint = await acquireFinishCheckpoint(input);
    const rowBound = createV1UsageReductionCheckpoint(finishCheckpoint.identity);
    rowBound.rowsRead = MAX_WINDOWED_USAGE_ROWS - 1;
    const rowResult = await advanceV1UsageReduction(db(), input.fixture.participantId,
      { identity: finishCheckpoint.identity, acquisition: finishCheckpoint.acquisition },
      { remainingQueries: 9, deadlineMs: Date.now() + 60_000 },
      { nowMs: Date.parse(input.window.fixedNow), sourcePin: input.sourcePin }, rowBound, 1);
    expect(rowResult.status).toBe('deferred');
    if (rowResult.status !== 'deferred') throw new Error('expected bounded row refusal');
    expect(rowResult.checkpoint).toMatchObject({ complete: true, rowsRead: MAX_WINDOWED_USAGE_ROWS,
      commonRefusal: 'windowed_usage_limit_exceeded', sessions: [], scopes: [], buckets: [] });

    const payloadBound = createV1UsageReductionCheckpoint(finishCheckpoint.identity);
    payloadBound.complete = true;
    payloadBound.sessions = Array.from({ length: 16_000 }, (_, index) => {
      const suffix = String(index).padStart(5, '0');
      const session = `${suffix}${'x'.repeat(500 - suffix.length)}`;
      return { key: JSON.stringify(['openai_codex',session]), time: null, pending: null };
    });
    expect(new TextEncoder().encode(JSON.stringify({ sessions: payloadBound.sessions, scopes: [], buckets: [] })).byteLength)
      .toBeGreaterThan(MAX_V1_USAGE_REDUCTION_CHECKPOINT_BYTES);
    const payloadResult = await advanceV1UsageReduction(db(), input.fixture.participantId,
      { identity: finishCheckpoint.identity, acquisition: finishCheckpoint.acquisition },
      { remainingQueries: 7, deadlineMs: Date.now() + 60_000 },
      { nowMs: Date.parse(input.window.fixedNow), sourcePin: input.sourcePin }, payloadBound, 1);
    expect(payloadResult.status).toBe('deferred');
    if (payloadResult.status !== 'deferred') throw new Error('expected bounded payload refusal');
    expect(payloadResult.checkpoint).toMatchObject({ complete: true, commonRefusal: 'reduced_usage_limit_exceeded',
      sessions: [], scopes: [], buckets: [] });
  }, 60_000);

  it("preserves occurrence-first equal-time interval semantics across a resumed page seam", async () => {
    const input = await seedPagedFixture(true);
    const finishCheckpoint = await acquireFinishCheckpoint(input);
    const first = await advanceStorageV1CurrentFitAnalysis({ source: db(), participantId: input.fixture.participantId,
      day: DAY, sourcePin: input.sourcePin, budget: budget(), checkpoint: finishCheckpoint, maxPages: 1 });
    expect(first.status).toBe('deferred');
    if (first.status !== 'deferred' || !first.checkpoint || first.checkpoint.phase !== 'usage') {
      throw new Error('expected equal-time usage checkpoint');
    }
    expect(first.checkpoint.usage.cursorObservedAt).toBe(new Date(BASE + 8.5 * 3_600_000).toISOString());
    const resumed = await advanceStorageV1CurrentFitAnalysis({ source: db(), participantId: input.fixture.participantId,
      day: DAY, sourcePin: input.sourcePin, budget: budget(), checkpoint: first.checkpoint, maxPages: 1 });
    expect(resumed.status).toBe('complete');
    if (resumed.status !== 'complete') throw new Error('expected equal-time resumed result');
    const baseline = await accountScopedQuotaAnalysisV1(db(), input.fixture.participantId,
      { nowMs: Date.parse(input.window.fixedNow), sourcePin: input.sourcePin });
    const normalize = (value: object) => {
      const copy = structuredClone(value) as Record<string, unknown>;
      delete copy.attributionMethod;
      return copy;
    };
    expect(normalize(resumed.analysis)).toEqual(normalize(baseline));
  }, 60_000);

  it("round trips the mid-usage cursor through the paged private checkpoint store", async () => {
    const key: StorageHistoryKey = { sourceId: "synthetic-v1-usage", ownerDigest: "a".repeat(64), day: DAY,
      dependencyDigest: "b".repeat(64), sourceNamespace: "synthetic-v1", method: "synthetic-current-fit-v1" };
    await target().prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')")
      .bind(key.sourceId, key.ownerDigest).run();
    const identity = { participantId: "synthetic-v1-usage-participant", inputFingerprint: "c".repeat(64),
      sourceMethodVersion: V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION, observedAtCutoff: "2026-05-28T00:00:00.000Z",
      resetsAtCutoff: "2026-06-04T00:00:00.000Z", windowMinutes: 10_080, maxQuotaRows: 60_000 };
    const usage = createV1UsageReductionCheckpoint(identity);
    usage.cursorObservedAt = "2026-09-01T04:23:45.000Z";
    usage.cursorId = 5_000;
    usage.rowsRead = 5_000;
    const checkpoint: StorageV1HistoryCheckpoint = { version: 1, day: DAY, layout: "json", identity,
      phase: "usage", acquisition: { planAnchors: [], quotaRows: [] }, usage };
    const saved = await saveStorageHistoryCheckpoint({ target: target(), key, checkpoint, expectedHead: null });
    expect(saved.status).toBe("saved");
    const loaded = await loadStorageHistoryCheckpoint({ target: target(), key });
    expect(loaded).toEqual({ status: "ready", headDigest: expect.any(String), checkpoint });
  });

  it("preserves the occurrence-selected interval when a session tie crosses a plan era", async () => {
    const input = await seedSessionPlanSwitchFixture();
    const finishCheckpoint = await acquireFinishCheckpoint(input as Awaited<ReturnType<typeof seedPagedFixture>>);
    const resumed = await advanceStorageV1CurrentFitAnalysis({ source: db(), participantId: input.fixture.participantId,
      day: DAY, sourcePin: input.sourcePin, budget: budget(), checkpoint: finishCheckpoint, maxPages: 1 });
    expect(resumed.status).toBe("complete");
    if (resumed.status !== "complete") throw new Error("expected session-switch fit result");
    const baseline = await accountScopedQuotaAnalysisV1(db(), input.fixture.participantId,
      { nowMs: Date.parse(input.window.fixedNow), sourcePin: input.sourcePin });
    const normalize = (value: object) => {
      const copy = structuredClone(value) as Record<string, unknown>;
      delete copy.attributionMethod;
      return copy;
    };
    expect(normalize(resumed.analysis)).toEqual(normalize(baseline));
  });
});
