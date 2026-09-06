import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  backfillV1QuotaFitProjection, createV1QuotaPageReader,
  V1QuotaFitProjectionUnavailableError, V1_PLAN_QUOTA_PAGE_SQL, V1_FIT_QUOTA_PAGE_SQL,
  V1_QUOTA_PROJECTION_BACKFILL_INSERT_SQL, V1_QUOTA_PROJECTION_BACKFILL_ADVANCE_SQL,
} from "../src/quota-fit-projection";

const db = (): D1Database => env.USAGE_MONITOR_DB;
const migrations = (): D1Migration[] => (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
const projectionMigration = (): D1Migration => {
  const migration = migrations().find((item) => item.name === "0046_v1_quota_fit_projection.sql");
  if (!migration) throw new Error("projection migration fixture missing");
  return migration;
};
const TIME = "2026-08-01T00:00:00.000Z";
const RESET = "2026-08-08T00:00:00.000Z";
const ELIGIBLE = `stream='quota' AND limit_id='codex' AND window_duration_minutes=10080
  AND provider IS NOT NULL AND plan_type IS NOT NULL AND plan_variant IS NOT NULL
  AND resets_at IS NOT NULL AND slot IS NOT NULL AND used_percent IS NOT NULL`;
async function fixtureStatements(sql: string): Promise<void> {
  await db().batch(sql.split(";").map(item=>item.trim()).filter(Boolean).map(item=>db().prepare(item)));
}

// Minimal, synthetic source tables retain the canonical rowid, nullable scalar
// fields, and deletion-cascade relationships used by this read projection.
async function sourceFixture(): Promise<void> {
  await fixtureStatements(`CREATE TABLE participants(id TEXT PRIMARY KEY,state TEXT NOT NULL);
    CREATE TABLE chunks(id TEXT PRIMARY KEY,participant_id TEXT REFERENCES participants(id) ON DELETE CASCADE);
    CREATE TABLE telemetry_v1_records(id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_row_id TEXT REFERENCES chunks(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      stream TEXT NOT NULL,observed_at TEXT NOT NULL,observed_day TEXT NOT NULL,
      device_id TEXT NOT NULL,occurrence_id TEXT NOT NULL,provider TEXT,plan_type TEXT,
      plan_variant TEXT,limit_id TEXT,slot TEXT,used_percent REAL,window_duration_minutes INTEGER,resets_at TEXT);
    CREATE INDEX telemetry_v1_records_participant_stream_observed ON telemetry_v1_records(participant_id,stream,observed_at);
    INSERT INTO participants VALUES('synthetic-p','active'),('synthetic-other','active');
    INSERT INTO chunks VALUES('chunk-one','synthetic-p'),('chunk-two','synthetic-p');`);
}
async function seed(count: number): Promise<void> {
  await db().prepare(`WITH RECURSIVE s(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM s WHERE n < ?)
    INSERT INTO telemetry_v1_records(chunk_row_id,participant_id,stream,observed_at,observed_day,
      device_id,occurrence_id,provider,plan_type,plan_variant,limit_id,slot,used_percent,window_duration_minutes,resets_at)
    SELECT 'chunk-one','synthetic-p','quota',?,'2026-08-01',
      CASE WHEN n<=1024 THEN 'losing-device' ELSE 'winning-device' END,'q-'||n,
      'openai_codex','pro','default','codex','primary',n%100,10080,? FROM s`)
    .bind(count,TIME,RESET).run();
}
async function migrate(): Promise<void> { await applyD1Migrations(db(),[projectionMigration()]); }
async function projectionIds(): Promise<number[]> {
  return (await db().prepare("SELECT record_id FROM telemetry_v1_quota_fit_rows ORDER BY record_id").all<{record_id:number}>()).results.map(r=>r.record_id);
}
async function expectParity(): Promise<void> {
  const expected=await db().prepare(`SELECT id AS record_id,participant_id,resets_at,observed_at FROM telemetry_v1_records WHERE ${ELIGIBLE} ORDER BY id`).all();
  const actual=await db().prepare("SELECT * FROM telemetry_v1_quota_fit_rows ORDER BY record_id").all();
  expect(actual.results).toEqual(expected.results);
}
beforeEach(async()=>{await reset();});

describe("lossless bounded quota fit projection",()=>{
  it("applies after the complete deployed migration chain without backfilling inside the migration",async()=>{
    await applyD1Migrations(db(),migrations());
    expect(await db().prepare("SELECT through_record_id,last_record_id,is_complete FROM telemetry_v1_quota_fit_backfill").first())
      .toEqual({through_record_id:0,last_record_id:0,is_complete:1});
    expect(await projectionIds()).toEqual([]);
  });

  it("refuses an incomplete read path and resumes bounded canonical pages including ineligible prefixes",async()=>{
    await sourceFixture();await seed(10);
    await fixtureStatements("UPDATE telemetry_v1_records SET provider=NULL WHERE id<=6;");
    await migrate();expect(await projectionIds()).toEqual([]);
    await expect(createV1QuotaPageReader(db(),"synthetic-p")).rejects.toBeInstanceOf(V1QuotaFitProjectionUnavailableError);
    expect(await backfillV1QuotaFitProjection(db(),{maxPages:1,pageSize:3}))
      .toEqual({status:"deferred",pagesRun:1,queriesUsed:4,lastRecordId:3,throughRecordId:10});
    expect(await projectionIds()).toEqual([]);
    expect((await backfillV1QuotaFitProjection(db(),{maxPages:1,pageSize:3})).lastRecordId).toBe(6);
    expect((await backfillV1QuotaFitProjection(db(),{maxPages:2,pageSize:3})).status).toBe("complete");
    await expectParity();expect(await projectionIds()).toEqual([7,8,9,10]);
    expect((await backfillV1QuotaFitProjection(db())).queriesUsed).toBe(1);
  });

  it("uses cursor compare-and-swap to prevent a stale caller from copying or skipping another range",async()=>{
    await sourceFixture();await seed(8);await migrate();
    await backfillV1QuotaFitProjection(db(),{maxPages:1,pageSize:3});
    const stale=await db().batch([
      db().prepare(V1_QUOTA_PROJECTION_BACKFILL_INSERT_SQL).bind(0,8,3),
      db().prepare(V1_QUOTA_PROJECTION_BACKFILL_ADVANCE_SQL).bind(0,8,3),
    ]);
    expect(stale.map(r=>r.meta.changes)).toEqual([0,0]);expect(await projectionIds()).toEqual([1,2,3]);
    await Promise.all([backfillV1QuotaFitProjection(db(),{maxPages:1,pageSize:3}),
      backfillV1QuotaFitProjection(db(),{maxPages:1,pageSize:3})]);
    await backfillV1QuotaFitProjection(db());await expectParity();
  });

  it("rolls back the page copy when an atomic batch fails before advancing the cursor",async()=>{
    await sourceFixture();await seed(8);await migrate();
    await expect(db().batch([
      db().prepare(V1_QUOTA_PROJECTION_BACKFILL_INSERT_SQL).bind(0,8,3),
      db().prepare("INSERT INTO telemetry_v1_quota_fit_backfill(singleton_id,through_record_id) VALUES(2,8)"),
      db().prepare(V1_QUOTA_PROJECTION_BACKFILL_ADVANCE_SQL).bind(0,8,3),
    ])).rejects.toThrow();
    expect(await projectionIds()).toEqual([]);
    expect(await db().prepare("SELECT last_record_id FROM telemetry_v1_quota_fit_backfill").first()).toEqual({last_record_id:0});
    await backfillV1QuotaFitProjection(db());await expectParity();
  });

  it("preserves corrections, deleted ranges, post-bound inserts and participant/chunk cascades during backfill",async()=>{
    await sourceFixture();await seed(10);await migrate();await backfillV1QuotaFitProjection(db(),{maxPages:1,pageSize:3});
    await fixtureStatements(`UPDATE telemetry_v1_records SET provider=NULL WHERE id=2;
      UPDATE telemetry_v1_records SET observed_at='2026-08-02T00:00:00.000Z',resets_at='2026-08-09T00:00:00.000Z' WHERE id=5;
      UPDATE telemetry_v1_records SET id=90000 WHERE id=8;
      DELETE FROM telemetry_v1_records WHERE id IN(3,6,10);`);
    await seed(1);await backfillV1QuotaFitProjection(db(),{maxPages:16,pageSize:3});await expectParity();
    expect(await db().prepare("SELECT through_record_id,last_record_id,is_complete FROM telemetry_v1_quota_fit_backfill").first())
      .toEqual({through_record_id:10,last_record_id:10,is_complete:1});
    await fixtureStatements("UPDATE telemetry_v1_records SET chunk_row_id='chunk-two' WHERE id IN(1,4);DELETE FROM chunks WHERE id='chunk-two';");
    await expectParity();expect(await projectionIds()).not.toContain(1);
    await fixtureStatements("DELETE FROM participants WHERE id='synthetic-p';");expect(await projectionIds()).toEqual([]);
  });

  it("reads exact physical pages across large equal-time ties without hiding losing source rows",async()=>{
    await sourceFixture();await migrate();await seed(2050);
    await fixtureStatements("UPDATE telemetry_v1_records SET limit_id='other',provider=NULL WHERE id=1;");
    const reader=await createV1QuotaPageReader(db(),"synthetic-p");
    const plan1=await reader.readPlanPage({observedAt:TIME,id:0},1024);
    expect(plan1).toHaveLength(1024);expect(plan1[0]).toMatchObject({id:1,provider:null,limit_id:"other"});
    expect(plan1.every(r=>r.device_id==="losing-device")).toBe(true);
    const plan2=await reader.readPlanPage({observedAt:TIME,id:1024},1024);
    expect(plan2[0]?.id).toBe(1025);expect(plan2.at(-1)?.id).toBe(2048);
    const plan3=await reader.readPlanPage({observedAt:TIME,id:2048},1024);
    expect(plan3.map(r=>r.id)).toEqual([2049,2050]);
    const fit1=await reader.readFitPage({resetsAt:RESET,observedAt:TIME,id:0},1024);
    expect(fit1).toHaveLength(1024);expect(fit1[0]?.id).toBe(2);expect(fit1.at(-1)?.id).toBe(1025);
    const fit2=await reader.readFitPage({resetsAt:RESET,observedAt:TIME,id:1025},1024);
    expect(fit2[0]?.id).toBe(1026);expect(fit2.at(-1)?.id).toBe(2049);
    expect((await reader.readFitPage({resetsAt:RESET,observedAt:TIME,id:2049},1024)).map(r=>r.id)).toEqual([2050]);
  });

  it("crosses timestamp and reset boundaries in indexed order, retains nullable plan evidence and refuses oversize pages",async()=>{
    await sourceFixture();await migrate();await seed(8);
    await fixtureStatements(`UPDATE telemetry_v1_records SET observed_at='2026-08-02T00:00:00.000Z' WHERE id IN(2,4);
      UPDATE telemetry_v1_records SET resets_at='2026-08-09T00:00:00.000Z' WHERE id IN(3,5);
      UPDATE telemetry_v1_records SET provider=NULL WHERE id=8;`);
    const reader=await createV1QuotaPageReader(db(),"synthetic-p");
    const seen:number[]=[];let cursor={resetsAt:"",observedAt:"",id:0};
    for(let page=0;page<10;page++){
      const rows=await reader.readFitPage(cursor,3);if(rows.length===0)break;
      seen.push(...rows.map(r=>r.id));const last=rows.at(-1)!;
      cursor={resetsAt:last.resets_at,observedAt:last.observed_at,id:last.id};
    }
    const expected=(await db().prepare(`SELECT id FROM telemetry_v1_records WHERE ${ELIGIBLE} ORDER BY resets_at,observed_at,id`).all<{id:number}>()).results.map(r=>r.id);
    expect(seen).toEqual(expected);expect(new Set(seen).size).toBe(seen.length);
    await expect(reader.readPlanPage({observedAt:"",id:0},1025)).rejects.toThrow("page bound invalid");
    await expect(reader.readFitPage(cursor,0)).rejects.toThrow("page bound invalid");
    await fixtureStatements("UPDATE participants SET state='inactive' WHERE id='synthetic-p';");
    await expect(createV1QuotaPageReader(db(),"synthetic-p")).rejects.toBeInstanceOf(V1QuotaFitProjectionUnavailableError);
  });

  it("requires indexed key seeks for raw acquisition and rejects invalid backfill budgets before writes",async()=>{
    await sourceFixture();await migrate();await seed(3);
    for(const [sql,bindings,index] of [
      [V1_PLAN_QUOTA_PAGE_SQL,["synthetic-p",TIME,1,3],"telemetry_v1_records_participant_stream_observed"],
      [V1_FIT_QUOTA_PAGE_SQL,["synthetic-p",RESET,TIME,1,3],"telemetry_v1_quota_fit_rows_cursor"],
    ] as const){
      const plan=(await db().prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...bindings).all<{detail:string}>()).results.map(r=>r.detail).join("\n");
      expect(plan).toContain(index);expect(plan).toMatch(/rowid>\?/u);
    }
    for(const options of [{maxPages:17},{maxPages:0},{pageSize:4097},{pageSize:0}]){
      await expect(backfillV1QuotaFitProjection(db(),options)).rejects.toThrow("backfill bound invalid");
    }
    await expectParity();
  });

  it("spends one readiness query and exactly one query per callback, and fails closed on a corrupt projection",async()=>{
    await sourceFixture();await migrate();await seed(3);
    let prepares=0;
    const counted=new Proxy(db(),{get(target,key){
      if(key==="prepare")return (sql:string)=>{prepares++;return target.prepare(sql);};
      const value=Reflect.get(target,key);
      return typeof value==="function"?value.bind(target):value;
    }});
    const reader=await createV1QuotaPageReader(counted,"synthetic-p");expect(prepares).toBe(1);
    await reader.readPlanPage({observedAt:"",id:0},3);expect(prepares).toBe(2);
    await reader.readFitPage({resetsAt:"",observedAt:"",id:0},3);expect(prepares).toBe(3);
    await fixtureStatements("UPDATE telemetry_v1_quota_fit_rows SET observed_at='2026-08-03T00:00:00.000Z' WHERE record_id=1;");
    await expect(reader.readFitPage({resetsAt:"",observedAt:"",id:0},3)).rejects.toBeInstanceOf(V1QuotaFitProjectionUnavailableError);
    await fixtureStatements("DELETE FROM telemetry_v1_quota_fit_backfill;");
    await expect(createV1QuotaPageReader(db(),"synthetic-p")).rejects.toBeInstanceOf(V1QuotaFitProjectionUnavailableError);
  });
});
