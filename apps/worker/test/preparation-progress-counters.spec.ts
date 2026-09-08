import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { readAdminPreparationProgress } from "../src/admin-graph-refresh-progress";
import { ensurePreparedV1Window, retireV1PreparedEvidence } from "../src/prepared-v1-evidence";
import { loadV1SourcePin } from "../src/telemetry-v1-source-selection";
import { modelHistoryWindow } from "../src/model-history-window";
import { MODEL_HISTORY_TEST_DAY, MODEL_HISTORY_TEST_PARTICIPANT, seedModelHistoryFixture } from "./helpers/model-history";

const db = () => env.USAGE_MONITOR_DB;
const migrations = () => (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
const EMPTY = { trackedDays: 0, completeDays: 0, buildingDays: 0, retiringDays: 0,
  checkpointSteps: 0, quotaObservations: 0, usageEvents: 0 };
const OWNER = "synthetic-preparation-counter-owner";
const DAY = "2026-09-01";
const HEAD_INSERT = `INSERT INTO community_prepared_source_days
  (participant_id,source_day,generation,source_fingerprint,method_version,device_id,phase,progress_revision,
   cursor_time,cursor_id,quota_count,usage_count,plan_count,fit_count,fragment_count,control_json,control_sha256)
  VALUES (?1,?2,?3,?3,'synthetic-counter-fixture','synthetic-device',?4,?5,?2||'T00:00:00.000Z',0,?6,?7,0,0,0,'{}',?3)`;
function head(day = DAY, phase = "quota", steps = 2, quota = 3, usage = 4) {
  return db().prepare(`${HEAD_INSERT} ON CONFLICT(participant_id,source_day) DO NOTHING`)
    .bind(OWNER, day, "a".repeat(64), phase, steps, quota, usage);
}
async function owner() {
  await db().prepare(`INSERT INTO participants
    (id,access_token_id,access_token_hash,recovery_token_id,recovery_token_hash,consent_version,consented_at,created_at)
    VALUES(?1,?1,X'00',?1,X'00','synthetic-consent','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`)
    .bind(OWNER).run();
}
async function census() {
  return db().prepare(`SELECT COUNT(*) AS trackedDays,TOTAL(phase='complete') AS completeDays,
    TOTAL(phase IN ('quota','usage')) AS buildingDays,TOTAL(phase='discarding') AS retiringDays,
    TOTAL(progress_revision) AS checkpointSteps,TOTAL(quota_count) AS quotaObservations,
    TOTAL(usage_count) AS usageEvents FROM community_prepared_source_days`).first();
}
async function prepareRealFixture() {
  await seedModelHistoryFixture();
  const window = modelHistoryWindow(MODEL_HISTORY_TEST_DAY);
  const source = await loadV1SourcePin(db(), { participantId: MODEL_HISTORY_TEST_PARTICIPANT,
    fromDay: window.fromDay, throughDay: window.day }, { includeDayDependencies: true });
  await ensurePreparedV1Window(db(), source, { maxPages: 64, pageSize: 256, deadlineMs: Date.now() + 60_000 });
  return source;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), migrations());
});

describe("transactional preparation progress counters", () => {
  it("bootstraps existing prepared work exactly and remains unavailable before migration", async () => {
    await reset();
    await applyD1Migrations(db(), migrations().filter(migration => Number(migration.name.slice(0, 4)) < 56));
    await prepareRealFixture();
    const before = await census();
    expect(before).toMatchObject({ trackedDays: 5, completeDays: 5, quotaObservations: 61, usageEvents: 120 });
    expect(await readAdminPreparationProgress(db())).toBeNull();
    const counterMigrations = migrations().filter(migration => migration.name.startsWith("0056_"));
    expect(counterMigrations).toHaveLength(1);
    await expect(db().batch([
      ...counterMigrations.flatMap(migration => migration.queries.map(sql => db().prepare(sql))),
      db().prepare("UPDATE participants SET state='invalid-state'"),
    ])).rejects.toThrow();
    expect(await readAdminPreparationProgress(db())).toBeNull();
    expect(await db().prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'community_preparation_progress%'").first())
      .toEqual({ n: 0 });
    expect(await census()).toEqual(before);
    await applyD1Migrations(db(), counterMigrations);
    expect(await readAdminPreparationProgress(db())).toEqual(before);
    expect(await census()).toEqual(before);
    await db().prepare("UPDATE community_prepared_source_days SET phase='discarding',progress_revision=progress_revision+1 WHERE source_day=?")
      .bind(DAY).run();
    expect(await readAdminPreparationProgress(db())).toEqual(await census());
  });

  it("maintains phase/checkpoint deltas, rejects replay duplication and rolls every change back atomically", async () => {
    await owner();
    await head().run();
    const initial = { trackedDays: 1, completeDays: 0, buildingDays: 1, retiringDays: 0,
      checkpointSteps: 2, quotaObservations: 3, usageEvents: 4 };
    expect(await readAdminPreparationProgress(db())).toEqual(initial);
    await head().run();
    await db().prepare("UPDATE community_prepared_source_days SET phase=phase,progress_revision=progress_revision,quota_count=quota_count,usage_count=usage_count").run();
    expect(await readAdminPreparationProgress(db())).toEqual(initial);
    for (const [phase, steps, quota, usage] of [
      ["usage", 4, 7, 4], ["complete", 6, 7, 11], ["discarding", 7, 7, 11], ["quota", 0, 0, 0],
    ]) {
      await db().prepare("UPDATE community_prepared_source_days SET phase=?,progress_revision=?,quota_count=?,usage_count=?")
        .bind(phase, steps, quota, usage).run();
      expect(await readAdminPreparationProgress(db())).toEqual(await census());
    }
    const before = await readAdminPreparationProgress(db());
    await expect(db().batch([
      head("2026-09-02", "complete"),
      db().prepare("DELETE FROM community_prepared_source_days WHERE source_day=?").bind(DAY),
      db().prepare("UPDATE community_prepared_source_days SET phase='invalid-phase'"),
    ])).rejects.toThrow();
    expect(await readAdminPreparationProgress(db())).toEqual(before);
    expect(await census()).toEqual(before);
    await db().batch([db().prepare("DELETE FROM community_prepared_source_days WHERE source_day=?").bind(DAY),
      head(DAY, "complete", 3, 2, 1)]);
    expect(await readAdminPreparationProgress(db())).toEqual({ ...initial, completeDays: 1, buildingDays: 0,
      checkpointSteps: 3, quotaObservations: 2, usageEvents: 1 });
  });

  it("tracks real source corrections, bounded derived cleanup and cascading owner erasure without counting child rows twice", async () => {
    const source = await prepareRealFixture();
    const initial = await readAdminPreparationProgress(db());
    expect(initial).toEqual(await census());
    await ensurePreparedV1Window(db(), source, { maxPages: 64, pageSize: 256, deadlineMs: Date.now() + 60_000 });
    expect(await readAdminPreparationProgress(db())).toEqual(initial);
    await db().prepare("UPDATE telemetry_v1_records SET model_id='synthetic-correction' WHERE id=(SELECT MIN(id) FROM telemetry_v1_records WHERE stream='usage')").run();
    const retired = await readAdminPreparationProgress(db());
    expect(retired).toEqual(await census());
    expect(retired).toMatchObject({ trackedDays: 5, completeDays: 4, retiringDays: 1,
      checkpointSteps: initial!.checkpointSteps + 1, quotaObservations: 61, usageEvents: 120 });
    const corrected = await loadV1SourcePin(db(), source.scope, { includeDayDependencies: true });
    const rebuilt = await ensurePreparedV1Window(db(), corrected, { maxPages: 64, pageSize: 256, deadlineMs: Date.now() + 60_000 });
    expect(rebuilt.status).toBe("complete");
    expect(await readAdminPreparationProgress(db())).toMatchObject({ trackedDays: 5, completeDays: 5, retiringDays: 0 });
    await db().prepare("UPDATE community_prepared_source_days SET phase='discarding',progress_revision=progress_revision+1 WHERE source_day=?")
      .bind(DAY).run();
    const beforeCleanup = await readAdminPreparationProgress(db());
    // Physical derived cleanup is not a new processing event. Its head ledger
    // remains until the final bounded cleanup step retires that source day.
    await db().prepare("DELETE FROM community_prepared_usage_rows WHERE source_day=?").bind(DAY).run();
    expect(await readAdminPreparationProgress(db())).toEqual(beforeCleanup);
    await retireV1PreparedEvidence(db(), { maxPages: 1, deadlineMs: Date.now() + 60_000 });
    expect(await readAdminPreparationProgress(db())).toEqual(await census());
    expect(await readAdminPreparationProgress(db())).toMatchObject({ trackedDays: 4, completeDays: 4, retiringDays: 0 });
    await db().prepare("DELETE FROM participants WHERE id=?").bind(MODEL_HISTORY_TEST_PARTICIPANT).run();
    expect(await readAdminPreparationProgress(db())).toEqual(EMPTY);
    for (const table of ["community_prepared_source_days", "community_prepared_plan_rows", "community_prepared_fit_rows",
      "community_prepared_usage_rows", "community_prepared_usage_bins"]) {
      expect(await db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).toEqual({ n: 0 });
    }
  });

  it.each(["progress_revision", "quota_count", "usage_count"])("keeps optional counters unknown after %s overflow without blocking preparation", async field => {
    await owner();
    await head().run();
    await db().prepare(`UPDATE community_prepared_source_days SET ${field}=?`).bind(Number.MAX_SAFE_INTEGER - 1).run();
    expect(await readAdminPreparationProgress(db())).not.toBeNull();
    await head("2026-09-02").run();
    expect(await readAdminPreparationProgress(db())).toBeNull();
    await db().prepare("UPDATE community_prepared_source_days SET phase='complete'").run();
    await db().prepare("DELETE FROM community_prepared_source_days").run();
    expect(await readAdminPreparationProgress(db())).toBeNull();
    expect(await census()).toEqual(EMPTY);
  });

  it.each(["progress_revision", "quota_count", "usage_count"])("detects an unsafe %s checkpoint delta without rejecting that source write", async field => {
    await owner(); await head().run(); await head("2026-09-02").run();
    await db().prepare(`UPDATE community_prepared_source_days SET ${field}=? WHERE source_day=?`)
      .bind(Number.MAX_SAFE_INTEGER - 1, DAY).run();
    expect(await readAdminPreparationProgress(db())).toBeNull();
    expect(await db().prepare(`SELECT ${field} AS n FROM community_prepared_source_days WHERE source_day=?`).bind(DAY).first())
      .toEqual({ n: Number.MAX_SAFE_INTEGER - 1 });
  });

  it("bootstraps unsafe totals as unavailable while preserving all existing heads", async () => {
    await reset();
    await applyD1Migrations(db(), migrations().filter(migration => Number(migration.name.slice(0, 4)) < 56));
    await owner(); await head().run(); await head("2026-09-02").run();
    await db().prepare("UPDATE community_prepared_source_days SET quota_count=? WHERE source_day=?")
      .bind(Number.MAX_SAFE_INTEGER - 1, DAY).run();
    const before = await census();
    await applyD1Migrations(db(), migrations().filter(migration => migration.name.startsWith("0056_")));
    expect(await readAdminPreparationProgress(db())).toBeNull();
    expect(await census()).toEqual(before);
    expect(await db().prepare("SELECT is_exact FROM community_preparation_progress_counters").first()).toEqual({ is_exact: 0 });
  });

  it("does not silently recreate a missing or inconsistent counter baseline", async () => {
    await owner(); await head().run();
    await db().prepare("UPDATE community_preparation_progress_counters SET checkpoint_steps=0").run();
    await db().prepare("UPDATE community_prepared_source_days SET progress_revision=3").run();
    expect(await readAdminPreparationProgress(db())).toBeNull();
    await db().prepare("DELETE FROM community_preparation_progress_counters").run();
    await head("2026-09-02").run();
    expect(await readAdminPreparationProgress(db())).toBeNull();
    expect(await db().prepare("SELECT COUNT(*) AS n FROM community_preparation_progress_counters").first()).toEqual({ n: 0 });
  });

  it("reads one aggregate row for 1,000 contributors and 169,000 retained source days", async () => {
    await db().prepare(`WITH RECURSIVE contributors(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM contributors WHERE n<1000)
      INSERT INTO participants(id,access_token_id,access_token_hash,recovery_token_id,recovery_token_hash,consent_version,consented_at,created_at)
      SELECT 'synthetic-preparation-scale-'||n,'synthetic-access-'||n,X'00','synthetic-recovery-'||n,X'00',
        'synthetic-consent','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z' FROM contributors`).run();
    await db().prepare(`WITH RECURSIVE days(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM days WHERE n<168)
      INSERT INTO community_prepared_source_days
        (participant_id,source_day,generation,source_fingerprint,method_version,device_id,phase,progress_revision,
         cursor_time,cursor_id,quota_count,usage_count,plan_count,fit_count,fragment_count,control_json,control_sha256)
      SELECT p.id,date('2026-01-01','+'||d.n||' days'),?1,?1,'synthetic-counter-scale','synthetic-device',
        CASE d.n%4 WHEN 0 THEN 'complete' WHEN 1 THEN 'quota' WHEN 2 THEN 'usage' ELSE 'discarding' END,
        d.n+1,'2026-01-01T00:00:00.000Z',0,2,3,0,0,0,'{}',?1
      FROM participants p CROSS JOIN days d WHERE p.id LIKE 'synthetic-preparation-scale-%'`).bind("a".repeat(64)).run();
    const statements: string[] = [];
    const database = new Proxy(db(), { get(target, key) {
      if (key === "prepare") return (sql: string) => { statements.push(sql); return target.prepare(sql); };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = await readAdminPreparationProgress(database);
    expect(result).toEqual({ trackedDays: 169_000, completeDays: 43_000, buildingDays: 84_000, retiringDays: 42_000,
      checkpointSteps: 14_365_000, quotaObservations: 338_000, usageEvents: 507_000 });
    expect(result).toEqual(await census());
    expect(statements).toHaveLength(1);
    const receipt = await db().prepare(statements[0]!).all();
    expect(receipt.meta.rows_read).toBe(1);
    expect(receipt.meta.rows_written).toBe(0);
    const plan = await db().prepare(`EXPLAIN QUERY PLAN ${statements[0]}`).all<{ detail: string }>();
    expect(plan.results.map(row => row.detail).join(" ")).toMatch(/SEARCH community_preparation_progress_counters USING INTEGER PRIMARY KEY/u);
    expect(statements[0]).not.toContain("community_prepared_source_days");
  }, 60_000);
});
