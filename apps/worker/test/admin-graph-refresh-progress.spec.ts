import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { readAdminGraphRefreshProgress } from "../src/admin-graph-refresh-progress";
import { readCommunityRefreshLane, recordCommunityRefreshLane } from "../src/community-refresh-lanes";
import { COMMUNITY_ATTRIBUTION_METHOD_VERSION } from "../src/community-allowance";

const db = () => env.USAGE_MONITOR_DB;
const NOW = Date.parse("2026-09-07T12:00:00.000Z");
beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

describe("independent owner refresh progress", () => {
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
