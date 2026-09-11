import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { readAdminGraphRefreshProgress, readAdminPreparationProgress } from "../src/admin-graph-refresh-progress";
import { readCommunityRefreshLane, recordCommunityRefreshLane } from "../src/community-refresh-lanes";
import { COMMUNITY_ATTRIBUTION_METHOD_VERSION } from "../src/community-allowance";
import { seedModelHistoryFixture, MODEL_HISTORY_TEST_PARTICIPANT, MODEL_HISTORY_TEST_DAY } from "./helpers/model-history";
import { loadV1SourcePin } from "../src/telemetry-v1-source-selection";
import { ensurePreparedV1Window } from "../src/prepared-v1-evidence";
import { modelHistoryWindow } from "../src/model-history-window";

const db = () => env.USAGE_MONITOR_DB;
const NOW = Date.parse("2026-09-07T12:00:00.000Z");
beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

describe("independent owner refresh progress", () => {
  it("reports saved preparation independently of completed accounts without advancing it on reads", async () => {
    await seedModelHistoryFixture();
    const window = modelHistoryWindow(MODEL_HISTORY_TEST_DAY);
    const source = await loadV1SourcePin(db(), { participantId: MODEL_HISTORY_TEST_PARTICIPANT,
      fromDay: window.fromDay, throughDay: window.day }, { includeDayDependencies: true });
    await ensurePreparedV1Window(db(), source, { maxPages: 1, pageSize: 3, deadlineMs: Date.now() + 60000 });
    const first = await readAdminPreparationProgress(db());
    expect(first).toEqual({ trackedDays: 1, completeDays: 0, buildingDays: 1, retiringDays: 0,
      checkpointSteps: 1, quotaObservations: 3, usageEvents: 0 });
    const detailed = await readAdminGraphRefreshProgress(db(), NOW, "resumable", { includePreparation: true });
    expect(detailed).toMatchObject({ schemaVersion: 2, preparation: first, history: { completeAccounts: 0 } });
    expect(Object.keys(detailed).sort()).toEqual(["generatedAt", "history", "preparation", "publication", "schemaVersion", "work"]);
    expect(JSON.stringify(detailed)).not.toMatch(/participant|fingerprint|lease|token|accountId|source_day/u);
    expect(await readAdminPreparationProgress(db())).toEqual(first);

    const prepared = await ensurePreparedV1Window(db(), source, { maxPages: 64, pageSize: 256, deadlineMs: Date.now() + 60000 });
    expect(prepared.status).toBe("complete");
    const complete = await readAdminPreparationProgress(db());
    expect(complete).toMatchObject({ trackedDays: 5, completeDays: 5, buildingDays: 0, retiringDays: 0,
      quotaObservations: 61, usageEvents: 120 });
    expect(complete!.checkpointSteps).toBeGreaterThan(first!.checkpointSteps);
    const statements: string[] = [];
    const database = new Proxy(db(), { get(target, key) {
      if (key === "prepare") return (sql: string) => { statements.push(sql); return target.prepare(sql); };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    expect(await readAdminPreparationProgress(database)).toEqual(complete);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("FROM community_preparation_progress_counters WHERE singleton_id=1");
    expect(statements[0]).not.toMatch(/\b(?:community_prepared_source_days|telemetry_v1_records|INSERT|UPDATE|DELETE)\b/u);
    await db().prepare("UPDATE community_prepared_source_days SET phase='discarding' WHERE source_day='2026-09-01'").run();
    expect(await readAdminPreparationProgress(db())).toMatchObject({ trackedDays: 5, completeDays: 4, retiringDays: 1 });
  });

  it("keeps preparation unknown on unsafe totals, inexact metadata or optional storage failure", async () => {
    const empty = { is_exact: 1, tracked_days: 0, complete_days: 0, building_days: 0, retiring_days: 0,
      checkpoint_steps: 0, quota_observations: 0, usage_events: 0 };
    for (const row of [null, { ...empty, is_exact: 0 }, { ...empty, checkpoint_steps: Number.MAX_SAFE_INTEGER + 1 },
      { ...empty, usage_events: -1 }, { ...empty, quota_observations: Infinity }, { ...empty, building_days: 1 }]) {
      const database = new Proxy(db(), { get(target, key) {
        if (key === "prepare") return (sql: string) => new Proxy(target.prepare(sql), { get(statement, method) {
          if (method === "first") return async () => row;
          const value = Reflect.get(statement, method, statement);
          return typeof value === "function" ? value.bind(statement) : value;
        } });
        const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
      } });
      expect(await readAdminPreparationProgress(database)).toBeNull();
    }
    await db().prepare("DROP TABLE community_preparation_progress_counters").run();
    const result = await readAdminGraphRefreshProgress(db(), NOW, "resumable", { includePreparation: true });
    expect(result).toMatchObject({ schemaVersion: 2, preparation: null, history: { resolvedDays: 0 } });
    const legacy = await readAdminGraphRefreshProgress(db(), NOW, "resumable");
    expect(legacy.schemaVersion).toBe(1);
    expect(Object.hasOwn(legacy, "preparation")).toBe(false);
  });

  it("returns closed content-free metadata without advancing or inventing completion", async () => {
    const result = await readAdminGraphRefreshProgress(db(), NOW, "resumable");
    const epoch = (await readCommunityRefreshLane(db(), "current", NOW)).sourceEpoch;
    expect(Object.keys(result).sort()).toEqual(["generatedAt", "history", "publication", "schemaVersion", "work"]);
    expect(result.schemaVersion).toBe(1);
    expect(result.publication).toEqual({ state: "empty", requestedGeneration: epoch, preparedGeneration: null,
      publishedGeneration: null, publishedAt: null });
    expect(result.work).toMatchObject({ state: "queued", phase: "current", trigger: null, restartReason: null });
    expect(result.history.resolvedDays).toBe(0);
    expect(result.history.requiredDays).toBe(69);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM community_refresh_lanes").first()).toEqual({ n: 0 });
    expect(await db().prepare("SELECT COUNT(*) AS n FROM community_model_history_work").first()).toEqual({ n: 0 });
    expect(JSON.stringify(result)).not.toMatch(/participant|fingerprint|lease|token|accountId|source_day/u);
  });

  it("distinguishes a preserved published generation from a new requested generation and hard invalidation", async () => {
    const pin = await readCommunityRefreshLane(db(), "current", NOW), epoch = pin.sourceEpoch;
    await recordCommunityRefreshLane(db(), pin, true, NOW);
    await db().prepare(`INSERT INTO admin_community_allowance_preview_cache
      (singleton,generated_at,payload_json,attribution_method_version,source_mutation_epoch) VALUES(1,?,'{}',?,?)`)
      .bind(new Date(NOW).toISOString(), COMMUNITY_ATTRIBUTION_METHOD_VERSION, epoch).run();
    const before = await readAdminGraphRefreshProgress(db(), NOW, "resumable");
    expect(before.publication).toMatchObject({ state: "ready", requestedGeneration: epoch, preparedGeneration: null, publishedGeneration: epoch });
    await db().prepare(`UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1,
      graph_append_epoch=mutation_epoch+1,graph_append_reason='accepted-correction' WHERE singleton_id=1`).run();
    const correcting = await readAdminGraphRefreshProgress(db(), NOW, "resumable");
    expect(correcting.publication).toMatchObject({ state: "ready", requestedGeneration: epoch + 1, preparedGeneration: null, publishedGeneration: epoch });
    expect(correcting.work.trigger).toBe("correction");
    await db().prepare("UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1").run();
    expect((await readAdminGraphRefreshProgress(db(), NOW, "paused")).publication)
      .toMatchObject({ state: "invalidated", publishedGeneration: null });
    expect((await readAdminGraphRefreshProgress(db(), NOW, "paused")).work.state).toBe("paused");
  });

  it("separates transient storage errors and refuses pre-migration data", async () => {
    await db().prepare("DROP TABLE community_refresh_lanes").run();
    await expect(readAdminGraphRefreshProgress(db(), NOW, "resumable"))
      .rejects.toMatchObject({ status: 503, code: "ADMIN_RECONSTRUCTION_PROGRESS_UNAVAILABLE" });
  });

  it("refuses a mixed progress response when the publication changes during its metadata reads", async () => {
    const base=db(); let raced=false;
    const database=new Proxy(base,{get(target,key){
      if(key==="prepare")return(sql:string)=>{
        const statement=target.prepare(sql);
        if(!sql.startsWith("SELECT s.mutation_epoch,p.source_mutation_epoch,p.generated_at"))return statement;
        const wrap=(handle:D1PreparedStatement):D1PreparedStatement=>new Proxy(handle,{get(inner,property){
          if(property==="bind")return(...args:unknown[])=>wrap(inner.bind(...args));
          if(property==="first")return async()=>{
            raced=true;
            const epoch=(await readCommunityRefreshLane(base,"current",NOW)).sourceEpoch;
            await base.prepare(`INSERT INTO admin_community_allowance_preview_cache
              (singleton,generated_at,payload_json,attribution_method_version,source_mutation_epoch)
              VALUES(1,?,'{}',?,?)`).bind(new Date(NOW).toISOString(),COMMUNITY_ATTRIBUTION_METHOD_VERSION,epoch).run();
            return inner.first();
          };
          const value=Reflect.get(inner,property,inner);return typeof value==="function"?value.bind(inner):value;
        }});
        return wrap(statement);
      };
      const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
    }});
    await expect(readAdminGraphRefreshProgress(database,NOW,"resumable"))
      .rejects.toMatchObject({status:503,code:"ADMIN_RECONSTRUCTION_PROGRESS_UNAVAILABLE"});
    expect(raced).toBe(true);
    expect((await readAdminGraphRefreshProgress(base,NOW,"resumable")).publication.state).toBe("ready");
  });
});
