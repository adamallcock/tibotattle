import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { advanceV1QuotaAcquisition, type V1QuotaPageReader, type V1PlanSourceRow,
  type V1FitSourceRow, type V1QuotaAcquisitionIdentity } from "../src/quota-analysis-v1-reader";
import { createV1QuotaPageReader } from "../src/quota-fit-projection";
import { createPreparedV1EvidenceReader, ensurePreparedV1Window,
  retireV1PreparedEvidence, V1_PREPARED_FIT_PAGE_SQL,
  V1PreparedEvidenceUnavailableError, V1_PREPARATION_METHOD_VERSION,
  type V1PreparedEvidenceUnavailableReason } from "../src/prepared-v1-evidence";
import { sha256Hex } from "../src/crypto";
import { prepareQuotaPage, type PreparationQuotaRow, type PreparedQuotaRuns } from "../src/prepared-v1-day";
import { loadV1SourcePin, type V1SourcePin } from "../src/telemetry-v1-source-selection";
import { createD1InvocationBudget } from "../src/d1-invocation-budget";
import { finishHistoricalModelCompositionV1, finishAccountScopedAnalysesV1,
  MODEL_HISTORY_METHOD_VERSION, V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION } from "../src/quota-analysis-v1";
import { modelHistoryWindow } from "../src/model-history-window";
import { seedModelHistoryFixture, insertModelHistoryRecords, pricedModelHistoryUsage,
  MODEL_HISTORY_TEST_PARTICIPANT as PID, MODEL_HISTORY_TEST_DAY as DAY } from "./helpers/model-history";

const db = () => env.USAGE_MONITOR_DB;
const migrations = () => (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
const budget = () => ({ remainingQueries: 1000, deadlineMs: Date.now() + 60000 });
const time = (minutes: number) => new Date(Date.parse("2026-09-01T00:00:00.000Z") + minutes * 60000).toISOString();
const resetTime = "2026-09-08T00:00:00.000Z";
async function pin(day = DAY, current = false) {
  const window = modelHistoryWindow(day);
  return loadV1SourcePin(db(), { participantId: PID, fromDay: window.fromDay, ...(current ? {} : { throughDay: day }) },
    { includeDayDependencies: true });
}
function identity(source: V1SourcePin, day = DAY, current = false): V1QuotaAcquisitionIdentity {
  const window = modelHistoryWindow(day);
  return { participantId: PID, inputFingerprint: source.fingerprint,
    sourceMethodVersion: current ? V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION : MODEL_HISTORY_METHOD_VERSION,
    observedAtCutoff: window.observedAtCutoff,
    resetsAtCutoff: new Date(Date.parse(window.observedAtCutoff) + 7 * 86400000).toISOString(),
    windowMinutes: 10080, maxQuotaRows: 60000 };
}
async function acquire(reader: V1QuotaPageReader, source: V1SourcePin, day = DAY, current = false) {
  const key = identity(source, day, current);
  const step = await advanceV1QuotaAcquisition(reader, key,
    new Map(source.winners.map(winner => [winner.observed_day, winner.device_id])), budget());
  if (step.status !== "complete") throw new Error("synthetic acquisition must complete");
  return { identity: key, acquisition: { planAnchors: step.planAnchors, quotaRows: step.quotaRows } };
}
async function prepare(source: V1SourcePin, pageSize = 256) {
  for (let pass = 0; pass < 100; pass++) {
    const result = await ensurePreparedV1Window(db(), source, { maxPages: 64, pageSize, deadlineMs: Date.now() + 60000 });
    if (result.status === "complete") return result;
  }
  throw new Error("synthetic preparation must complete");
}
async function expectUnavailable(result: Promise<unknown>, reason: V1PreparedEvidenceUnavailableReason) {
  await expect(result).rejects.toBeInstanceOf(V1PreparedEvidenceUnavailableError);
  await expect(result).rejects.toMatchObject({
    code: "V1_PREPARED_EVIDENCE_UNAVAILABLE", message: "v1 prepared evidence unavailable", reason,
  });
}
beforeEach(async () => { await reset(); await applyD1Migrations(db(), migrations()); });

describe("reusable elected source-day preparation", () => {
  it("preserves the existing error contract and confines diagnostic reasons to fixed values", () => {
    const error = new V1PreparedEvidenceUnavailableError();
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: "V1_PREPARED_EVIDENCE_UNAVAILABLE",
      message: "v1 prepared evidence unavailable", reason: "invalid_evidence" });
    for (const reason of ["invalid_evidence", "source_not_current", "control_invalid", "day_count_mismatch"] as const) {
      expect(new V1PreparedEvidenceUnavailableError(reason).reason).toBe(reason);
    }
    expect(new V1PreparedEvidenceUnavailableError("untrusted runtime detail" as V1PreparedEvidenceUnavailableReason).reason)
      .toBe("invalid_evidence");
  });

  it("reuses neighbouring days without reading or repricing source rows, preserving exact fits and counts", async () => {
    await seedModelHistoryFixture();
    const source = await pin(), prepared = await prepare(source, 7);
    expect(prepared.status).toBe("complete");
    const reader = await createPreparedV1EvidenceReader(db(), source), raw = await createV1QuotaPageReader(db(), PID, modelHistoryWindow(DAY).observedAtBefore);
    const expectedEvidence = await acquire(raw, source), actualEvidence = await acquire(reader.quotaReader, source);
    expect(actualEvidence).toEqual(expectedEvidence);
    const expected = await finishHistoricalModelCompositionV1(db(), PID, DAY, expectedEvidence, budget(), { sourcePin: source });
    const actual = await finishHistoricalModelCompositionV1(db(), PID, DAY, actualEvidence, budget(),
      { sourcePin: source, preparedEvidence: reader });
    expect(actual).toEqual(expected);
    expect(actual).toMatchObject({ status: "complete", analysis: { status: "ready", usageEventCount: 120,
      quotaRowCount: 61, fit: { status: "fitted", observationCount: 60 } } });
    const next = await pin("2026-09-06");
    expect(await prepare(next)).toMatchObject({ status: "complete", pagesRun: 0, queriesUsed: 1 });
    expect((await createPreparedV1EvidenceReader(db(), next)).usageBins.totalRowCount).toBe(120);
    const counts = await db().prepare(`SELECT SUM(usage_count) AS usage_count,SUM(quota_count) AS quota_count,
      SUM(plan_count) AS plan_count,SUM(fragment_count) AS fragment_count FROM community_prepared_source_days`).first();
    expect(counts).toMatchObject({ usage_count: 120, quota_count: 61, plan_count: 10 });
  });

  it("keeps scalar session/grid attribution and the model calculation byte-identical using prepared event prices", async () => {
    const fixture = await seedModelHistoryFixture();
    await insertModelHistoryRecords(fixture, "ties", [
      pricedModelHistoryUsage("gpt-5.6-terra", 2, time(30)).record,
      { stream: "usage", observedAt: time(30), recordJson: "{}" },
      { stream: "usage", observedAt: time(31), recordJson: JSON.stringify({ provider: "openai_codex", modelId: "unknown-model",
        components: { outputCombinedTokens: 10 } }) },
    ]);
    const source = await pin(DAY, true); await prepare(source, 3);
    const reader = await createPreparedV1EvidenceReader(db(), source), evidence = await acquire(reader.quotaReader, source, DAY, true);
    const options = { sourcePin: source, nowMs: Date.parse(modelHistoryWindow(DAY).fixedNow) };
    const expected = await finishAccountScopedAnalysesV1(db(), PID, evidence, budget(), options);
    expect(await finishAccountScopedAnalysesV1(db(), PID, evidence, budget(), { ...options, preparedEvidence: reader })).toEqual(expected);
    expect(await finishAccountScopedAnalysesV1(db(), PID, evidence, budget(), { ...options, maxWindowedUsageRows: 122,
      preparedEvidence: reader })).toMatchObject({ status: "complete", modelComposition: {
        status: "not_testable", reason: "windowed_usage_limit_exceeded" } });
  });

  it("defers at the shared actual-query bound and resumes committed pages without duplication", async () => {
    await seedModelHistoryFixture(); const source = await pin();
    const meter = createD1InvocationBudget(8);
    const first = await ensurePreparedV1Window(meter.wrap(db()), source, { maxPages: 64, pageSize: 3, deadlineMs: Date.now() + 60000 });
    expect(first.status).toBe("deferred"); expect(meter.queriesUsed).toBeLessThanOrEqual(8);
    expect(first.pagesRun).toBeGreaterThan(0);
    await expect(createPreparedV1EvidenceReader(db(), source)).rejects.toBeInstanceOf(V1PreparedEvidenceUnavailableError);
    await prepare(source, 3);
    expect(await db().prepare("SELECT COUNT(*) AS count FROM community_prepared_usage_rows").first()).toEqual({ count: 120 });
    expect((await prepare(source)).pagesRun).toBe(0);
  });

  it("invalidates only the changed elected day and never admits stale source or cutover writes", async () => {
    const fixture = await seedModelHistoryFixture(); const original = await pin(); await prepare(original);
    const headsBefore = (await db().prepare("SELECT source_day,generation FROM community_prepared_source_days ORDER BY source_day").all<{source_day:string;generation:string}>()).results;
    await insertModelHistoryRecords(fixture, "late-one-day", [pricedModelHistoryUsage("gpt-5.6-terra", 1, time(60)).record]);
    await expectUnavailable(prepare(original), "source_not_current");
    // Repinning omitted dependencies must reject the same stale source before
    // looking up prepared heads; supplied dependencies use the source guard.
    await expectUnavailable(prepare({ ...original, dayDependencies: undefined }), "source_not_current");
    const next = await pin(); await prepare(next);
    const headsAfter = (await db().prepare("SELECT source_day,generation FROM community_prepared_source_days ORDER BY source_day").all<{source_day:string;generation:string}>()).results;
    expect(headsAfter.slice(1)).toEqual(headsBefore.slice(1)); expect(headsAfter[0]?.generation).not.toBe(headsBefore[0]?.generation);
    expect((await createPreparedV1EvidenceReader(db(), next)).usageBins.totalRowCount).toBe(121);
    expect(await db().prepare("SELECT COUNT(*) AS count FROM community_prepared_usage_rows").first()).toEqual({ count: 121 });
    await db().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(PID).run();
    await expectUnavailable(createPreparedV1EvidenceReader(db(), next), "source_not_current");
  });

  it("owner erasure cascades every allowlisted derived table and retains no raw payload JSON", async () => {
    await seedModelHistoryFixture(); await prepare(await pin());
    for (const table of ["community_prepared_source_days", "community_prepared_plan_rows", "community_prepared_fit_rows",
      "community_prepared_usage_rows", "community_prepared_usage_bins"]) {
      const columns = await db().prepare(`PRAGMA table_info(${table})`).all<{name:string}>();
      expect(columns.results.some(column => column.name === "record_json")).toBe(false);
    }
    await db().prepare("DELETE FROM participants WHERE id=?").bind(PID).run();
    for (const table of ["community_prepared_source_days", "community_prepared_plan_rows", "community_prepared_fit_rows",
      "community_prepared_usage_rows", "community_prepared_usage_bins"]) {
      expect(await db().prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).toEqual({ count: 0 });
    }
  });

  it("refuses changed preparation methods and corrupted persisted runs", async () => {
    await seedModelHistoryFixture(); const source = await pin();
    await ensurePreparedV1Window(db(), source, { maxPages: 1, pageSize: 3, deadlineMs: Date.now() + 60000 });
    await db().prepare("UPDATE community_prepared_source_days SET control_json='{}' WHERE participant_id=?").bind(PID).run();
    await expectUnavailable(prepare(source), "control_invalid");
    expect(V1_PREPARATION_METHOD_VERSION).toContain("server-api-price-equivalent-v0.5");
  });

  it.each(["control shape", "run shape", "plan row", "fit row"] as const)(
    "classifies invalid saved %s even when its persisted digest matches", async (corruption) => {
      await seedModelHistoryFixture(); const source = await pin();
      await ensurePreparedV1Window(db(), source, { maxPages: 1, pageSize: 3, deadlineMs: Date.now() + 60000 });
      const head = await db().prepare(`SELECT source_day,control_json,progress_revision FROM community_prepared_source_days
        WHERE participant_id=? ORDER BY source_day LIMIT 1`).bind(PID)
        .first<{ source_day: string; control_json: string; progress_revision: number }>();
      expect(head).not.toBeNull();
      const control = JSON.parse(head!.control_json);
      expect(control.plan).not.toBeNull(); expect(control.fit).not.toBeNull();
      if (corruption === "control shape") control.equalTimeChanged = "invalid";
      else if (corruption === "run shape") control.plan.extra = true;
      else if (corruption === "plan row") control.plan.first.observed_day = "2026-08-31";
      else control.fit.last.window_duration_minutes = 300;
      const json = JSON.stringify(control), digest = await sha256Hex(json);
      await db().prepare(`UPDATE community_prepared_source_days SET control_json=?,control_sha256=?
        WHERE participant_id=? AND source_day=?`).bind(json, digest, PID, head!.source_day).run();
      await expectUnavailable(prepare(source), "control_invalid");
      expect(await db().prepare(`SELECT control_json,control_sha256,progress_revision FROM community_prepared_source_days
        WHERE participant_id=? AND source_day=?`).bind(PID, head!.source_day).first())
        .toEqual({ control_json: json, control_sha256: digest, progress_revision: head!.progress_revision });
    });

  it.each(["quota_count", "usage_count"] as const)(
    "classifies an EOF %s mismatch without publishing the incomplete day", async (counter) => {
      await seedModelHistoryFixture(); const source = await pin();
      await ensurePreparedV1Window(db(), source, { maxPages: 1, deadlineMs: Date.now() + 60000 });
      const day = source.winners[0]!.observed_day;
      expect(await db().prepare(`SELECT phase FROM community_prepared_source_days
        WHERE participant_id=? AND source_day=?`).bind(PID, day).first()).toEqual({ phase: "usage" });
      await db().prepare(`UPDATE community_prepared_source_days SET ${counter}=${counter}+1
        WHERE participant_id=? AND source_day=?`).bind(PID, day).run();
      const before = await db().prepare(`SELECT phase,quota_count,usage_count,progress_revision FROM community_prepared_source_days
        WHERE participant_id=? AND source_day=?`).bind(PID, day).first();
      await expectUnavailable(prepare(source), "day_count_mismatch");
      expect(await db().prepare(`SELECT phase,quota_count,usage_count,progress_revision FROM community_prepared_source_days
        WHERE participant_id=? AND source_day=?`).bind(PID, day).first()).toEqual(before);
      expect(await db().prepare(`SELECT COUNT(*) AS count FROM community_prepared_usage_rows
        WHERE participant_id=? AND source_day=?`).bind(PID, day).first()).toEqual({ count: 0 });
    });

  it("never converts a concurrently retired generation into EOF and drains retained derivatives in bounded pages", async () => {
    await seedModelHistoryFixture(); const source = await pin(); await prepare(source);
    const reader = await createPreparedV1EvidenceReader(db(), source);
    // Simulate a method upgrade with identical raw source revision. Raw source
    // fences alone cannot distinguish this from a genuinely empty page.
    await db().prepare("UPDATE community_prepared_source_days SET phase='discarding' WHERE source_day='2026-09-01'").run();
    await expect(reader.quotaReader.readPlanPage({observedAt:time(0),id:0},128)).rejects.toBeInstanceOf(V1PreparedEvidenceUnavailableError);
    await expect(reader.quotaReader.readFitPage({resetsAt:resetTime,observedAt:"",id:0},128)).rejects.toBeInstanceOf(V1PreparedEvidenceUnavailableError);
    await expect(reader.usageReader.readPage(time(0),0,5000)).rejects.toBeInstanceOf(V1PreparedEvidenceUnavailableError);
    await expect(reader.usageBins.readPage(time(0),0,256)).rejects.toBeInstanceOf(V1PreparedEvidenceUnavailableError);
    await prepare(source);
    await db().prepare("DELETE FROM telemetry_v1_records WHERE participant_id=? AND observed_day='2026-09-01'").bind(PID).run();
    expect(await db().prepare("SELECT phase FROM community_prepared_source_days WHERE source_day='2026-09-01'").first()).toEqual({phase:"discarding"});
    const meter = createD1InvocationBudget(12);
    expect(await retireV1PreparedEvidence(meter.wrap(db()), {maxPages:2,deadlineMs:Date.now()+60000}))
      .toMatchObject({status:"complete",pagesRun:1});
    expect(meter.queriesUsed).toBe(7);
    expect(await db().prepare("SELECT COUNT(*) AS count FROM community_prepared_usage_rows WHERE source_day='2026-09-01'").first()).toEqual({count:0});
    expect(await db().prepare("SELECT COUNT(*) AS count FROM community_prepared_source_days").first()).toEqual({count:4});
  });

  it("uses bounded exact-generation reset seeks and ignores arbitrarily dense future prepared days", async () => {
    await seedModelHistoryFixture(); const source = await pin(); await prepare(source);
    const reader = await createPreparedV1EvidenceReader(db(),source);
    const expected = await reader.quotaReader.readFitPage({resetsAt:resetTime,observedAt:"",id:0},128);
    const base = await db().prepare("SELECT * FROM community_prepared_source_days WHERE source_day='2026-09-01'").first<{generation:string}>();
    await db().prepare(`INSERT INTO community_prepared_source_days
      SELECT participant_id,'2026-12-01',generation,source_fingerprint,method_version,device_id,phase,progress_revision,
        cursor_time,cursor_id,quota_count,usage_count,plan_count,fit_count,fragment_count,control_json,control_sha256
      FROM community_prepared_source_days WHERE source_day='2026-09-01'`).run();
    await db().prepare(`WITH RECURSIVE s(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM s WHERE n<20000)
      INSERT INTO community_prepared_fit_rows
      SELECT ?,'2026-12-01',?,100000+n,'2026-12-01T00:00:00.000Z','synthetic-device','openai_codex','codex','pro','unknown',
        'synthetic-future-'||n,'seven_day',n%100,10080,? FROM s`).bind(PID,base!.generation,resetTime).run();
    expect(await reader.quotaReader.readFitPage({resetsAt:resetTime,observedAt:"",id:0},128)).toEqual(expected);
    const heads = (await db().prepare("SELECT source_day,generation FROM community_prepared_source_days WHERE source_day<'2026-12-01' ORDER BY source_day")
      .all<{source_day:string;generation:string}>()).results;
    const plan = await db().prepare(`EXPLAIN QUERY PLAN ${V1_PREPARED_FIT_PAGE_SQL}`)
      .bind(PID,resetTime,"",0,128,JSON.stringify(heads.map(row=>[row.source_day,row.generation]))).all<{detail:string}>();
    const details = plan.results.map(row=>row.detail).join("\n");
    expect(details).toContain("community_prepared_fit_cursor (participant_id=? AND source_day=? AND generation=? AND (resets_at,observed_at,id)>(?,?,?))");
    expect(details).not.toContain("SCAN community_prepared_fit_rows");
  });

  it("materially reduces dense historical I/O and pricing with exact Workerd result parity", async () => {
    const fixture = await seedModelHistoryFixture();
    const usage = pricedModelHistoryUsage("gpt-5.6-sol", 0.0001, time(30)).record;
    await insertModelHistoryRecords(fixture, "dense", [
      ...Array.from({length:6000},()=>({stream:"quota" as const,observedAt:time(0),usedPercent:0})),
      ...Array.from({length:12000},()=>({...usage})),
    ]);
    const source = await pin();
    const measure = (reader: V1QuotaPageReader) => {
      const stats = {queries:0,rows:0,maxPageBytes:0};
      const record = <T>(rows:T[]) => {
        stats.queries += 1; stats.rows += rows.length;
        stats.maxPageBytes = Math.max(stats.maxPageBytes,new TextEncoder().encode(JSON.stringify(rows)).byteLength); return rows;
      };
      const measured: V1QuotaPageReader = { ...(reader.pageSize ? {pageSize:reader.pageSize} : {}),
        async readPlanPage(cursor,limit) {return record(await reader.readPlanPage(cursor,limit));},
        async readFitPage(cursor,limit) {return record(await reader.readFitPage(cursor,limit));} };
      return {reader:measured,stats};
    };
    const raw = measure(await createV1QuotaPageReader(db(),PID,modelHistoryWindow(DAY).observedAtBefore));
    const rawStart = Date.now(), rawEvidence = await acquire(raw.reader,source);
    const rawMeter=createD1InvocationBudget();
    const expected = await finishHistoricalModelCompositionV1(rawMeter.wrap(db()),PID,DAY,rawEvidence,budget(),{sourcePin:source});
    const rawElapsedMs=Date.now()-rawStart;
    await prepare(source);
    // Reader callbacks close over their DB: create them through the same meter
    // as the finisher, exactly as production does. Otherwise bin reads escape
    // this fixture's counter even though the production path is fully metered.
    const preparedMeter=createD1InvocationBudget();
    const prepared = await createPreparedV1EvidenceReader(preparedMeter.wrap(db()),source), measured = measure(prepared.quotaReader);
    const preparedStart=Date.now(), evidence=await acquire(measured.reader,source);
    const beforePreparedFinish=preparedMeter.queriesUsed;
    const actual = await finishHistoricalModelCompositionV1(preparedMeter.wrap(db()),PID,DAY,evidence,budget(),
      {sourcePin:source,preparedEvidence:prepared});
    const preparedElapsedMs=Date.now()-preparedStart;
    console.log(JSON.stringify({benchmark:"synthetic-prepared-history-18061-measured",rawElapsedMs,preparedElapsedMs,
      rawAcquisition:raw.stats,preparedAcquisition:measured.stats,rawFinishQueries:rawMeter.queriesUsed,
      preparedFinishQueries:preparedMeter.queriesUsed-beforePreparedFinish,usageRows:prepared.usageBins.totalRowCount,
      usageFragments:prepared.usageBins.fragmentCount}));
    expect(evidence).toEqual(rawEvidence); expect(actual).toEqual(expected);
    expect(actual).toMatchObject({status:"complete",analysis:{status:"ready",usageEventCount:12120}});
    expect(raw.stats.rows).toBe(18183); expect(measured.stats.rows).toBeLessThan(200);
    expect(measured.stats.queries).toBe(3); expect(raw.stats.queries).toBe(18);
    expect(prepared.usageBins.fragmentCount).toBeLessThan(200);
    expect(preparedMeter.queriesUsed-beforePreparedFinish).toBe(6); // Five fences plus one fragment page.
    // Raw: five fences + two initial seeks + one full equal-time tie page +
    // two final seeks. The short final page ends the scan without an EOF read.
    expect(rawMeter.queriesUsed).toBe(10);
    expect(await prepare(await pin("2026-09-06"))).toMatchObject({status:"complete",pagesRun:0,queriesUsed:1});
    console.log(JSON.stringify({benchmark:"synthetic-prepared-history-18061",rawElapsedMs,preparedElapsedMs,
      rawAcquisition:raw.stats,preparedAcquisition:measured.stats,rawFinishQueries:rawMeter.queriesUsed,
      preparedFinishQueries:preparedMeter.queriesUsed-beforePreparedFinish,usageRows:prepared.usageBins.totalRowCount,
      usageFragments:prepared.usageBins.fragmentCount}));
  },60000);

  it("bounds maximum 128-day reset fanout to 16,384 candidate IDs and a 128-row result", async () => {
    await seedModelHistoryFixture(); await prepare(await pin());
    await db().prepare(`WITH RECURSIVE days(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM days WHERE n<127)
      INSERT INTO community_prepared_source_days
      SELECT h.participant_id,date('2026-01-01','+'||n||' days'),h.generation,h.source_fingerprint,h.method_version,h.device_id,
        h.phase,h.progress_revision,h.cursor_time,h.cursor_id,h.quota_count,h.usage_count,h.plan_count,h.fit_count,
        h.fragment_count,h.control_json,h.control_sha256 FROM days CROSS JOIN community_prepared_source_days h
      WHERE h.source_day='2026-09-01'`).run();
    await db().prepare(`WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<16383)
      INSERT INTO community_prepared_fit_rows
      SELECT h.participant_id,h.source_day,h.generation,200000+x,h.source_day||'T00:00:00.000Z',h.device_id,
        'openai_codex','codex','pro','unknown','synthetic-fanout-'||x,'seven_day',x%100,10080,?
      FROM n JOIN community_prepared_source_days h ON h.source_day=date('2026-01-01','+'||CAST(x/128 AS INTEGER)||' days')`)
      .bind(resetTime).run();
    const heads = (await db().prepare("SELECT source_day,generation FROM community_prepared_source_days WHERE source_day<'2026-09-01' ORDER BY source_day")
      .all<{source_day:string;generation:string}>()).results;
    expect(heads).toHaveLength(128);
    const start=Date.now();
    const page = await db().prepare(V1_PREPARED_FIT_PAGE_SQL).bind(PID,resetTime,"",0,128,
      JSON.stringify(heads.map(row=>[row.source_day,row.generation]))).all<V1FitSourceRow>();
    const elapsedMs=Date.now()-start;
    expect(page.results).toHaveLength(128);
    expect(page.results.map(row=>row.id)).toEqual(Array.from({length:128},(_,i)=>200000+i));
    expect(page.meta.rows_read).toBeLessThan(100000);
    const bytes = new TextEncoder().encode(JSON.stringify(page.results)).byteLength;
    expect(bytes).toBeLessThan(65536);
    console.log(JSON.stringify({benchmark:"synthetic-prepared-maximum-day-fanout",days:128,candidateIdBound:16384,
      returnedRows:page.results.length,returnedBytes:bytes,rowsRead:page.meta.rows_read,elapsedMs}));
  });
});

describe("lossless daily quota run projection", () => {
  it("preserves exact global acquisition through day/page seams, short-window changes and equal-time conflicts", async () => {
    const rows: PreparationQuotaRow[] = Array.from({ length: 12000 }, (_, i) => ({ id: i + 1, observed_at: time(i / 100),
      observed_day: "2026-09-01", device_id: "synthetic-device", occurrence_id: `synthetic-${i}`,
      provider: "openai_codex", limit_id: "codex", plan_type: "pro", plan_variant: "unknown", slot: "seven_day",
      used_percent: Math.floor(i / 1000) * 5, window_duration_minutes: 10080, resets_at: resetTime }));
    rows[4999] = { ...rows[4999]!, window_duration_minutes: 300, plan_type: "plus" };
    rows[5000] = { ...rows[5000]!, observed_at: rows[4999]!.observed_at };
    rows[7000] = { ...rows[7000]!, window_duration_minutes: 300, plan_type: null, plan_variant: null };
    const runs: PreparedQuotaRuns = { plan: null, fit: null, lastTime: null, lastSignature: null, equalTimeChanged: false },
      plans: V1PlanSourceRow[] = [], fits: V1FitSourceRow[] = [];
    for (let offset = 0; offset < rows.length; offset += 17) {
      const output = prepareQuotaPage(rows.slice(offset, offset + 17), runs, offset + 17 >= rows.length);
      plans.push(...output.plans); fits.push(...output.fits);
    }
    const makeReader = (plan: V1PlanSourceRow[], fit: V1FitSourceRow[]): V1QuotaPageReader => ({
      async readPlanPage(cursor, limit) { return plan.filter(row => row.observed_at > cursor.observedAt
        || row.observed_at === cursor.observedAt && row.id > cursor.id).sort((a,b) => a.observed_at.localeCompare(b.observed_at) || a.id-b.id).slice(0,limit); },
      async readFitPage(cursor, limit) { return fit.filter(row => row.resets_at > cursor.resetsAt
        || row.resets_at === cursor.resetsAt && (row.observed_at > cursor.observedAt
          || row.observed_at === cursor.observedAt && row.id > cursor.id))
        .sort((a,b) => a.resets_at.localeCompare(b.resets_at) || a.observed_at.localeCompare(b.observed_at) || a.id-b.id).slice(0,limit); },
    });
    const rawFits = rows.filter(row => row.window_duration_minutes === 10080) as V1FitSourceRow[];
    const key = { participantId: "synthetic", inputFingerprint: "a".repeat(64), sourceMethodVersion: V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION,
      observedAtCutoff: time(0), resetsAtCutoff: resetTime, windowMinutes: 10080, maxQuotaRows: 60000 };
    const winners = new Map([["2026-09-01", "synthetic-device"]]);
    const expected = await advanceV1QuotaAcquisition(makeReader(rows, rawFits), key, winners, budget());
    const actual = await advanceV1QuotaAcquisition(makeReader(plans, fits), key, winners, budget());
    expect(actual).toEqual(expected); expect(actual.status).toBe("complete");
    expect(plans.length).toBeLessThan(12); expect(fits.length).toBeLessThan(40);
  });
});
