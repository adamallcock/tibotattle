import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { acknowledgeCurrentAnalysisJob, claimCurrentAnalysisJob, currentAnalysisPublicationStatements,
  prepareCurrentAnalysisQueue, retireEmptyCurrentAnalysisJob } from "../src/community-analysis-queue";
import { readCommunityRefreshLane, recordCommunityRefreshLane } from "../src/community-refresh-lanes";
import { communityAnalysisCacheVersion } from "../src/community-allowance";
import { createD1InvocationBudget } from "../src/d1-invocation-budget";

const db = () => env.USAGE_MONITOR_DB;
const migrations = () => (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
const DAY = "2026-09-08", NOW = Date.parse(`${DAY}T00:00:00.000Z`), LEASE = "synthetic-current-queue-lease";
const method = () => communityAnalysisCacheVersion();
const pass = (day = DAY, version = method()) => prepareCurrentAnalysisQueue(db(), day, version, LEASE);

async function lease() {
  await db().prepare(`UPDATE retention_state SET maintenance_lease_token=?,
    maintenance_lease_expires_at='2027-01-01T00:00:00.000Z' WHERE singleton=1`).bind(LEASE).run();
}

/** Scheduling-only fixtures: no fabricated telemetry or calculated results.
 * Production revision triggers enqueue these jobs exactly as an input change
 * would; the real calculator scale harness separately supplies real sources. */
async function metadataJobs(count: number, prefix = "synthetic-queue") {
  await db().prepare(`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i+1<?1)
    INSERT INTO participants(id,access_token_id,access_token_hash,recovery_token_id,recovery_token_hash,
      state,consent_version,consented_at,created_at)
    SELECT ?2||'-'||printf('%04d',i),?2||'-access-'||i,zeroblob(32),?2||'-recovery-'||i,zeroblob(32),
      'active','privacy-safe-telemetry-v0.1',?3,?3 FROM n`).bind(count, prefix, new Date(NOW).toISOString()).run();
  await db().prepare("UPDATE community_analytical_input_versions SET revision=revision+1 WHERE participant_id LIKE ?")
    .bind(`${prefix}-%`).run();
}

beforeEach(async () => { await reset(); await applyD1Migrations(db(), migrations()); await lease(); });

describe("durable current-account work queue", () => {
  it("serves all 300 saturated priority-slot accounts before a continuously hot account repeats", async () => {
    await metadataJobs(300);
    const seen = new Set<string>();
    let first = "";
    for (let prioritySlot = 0; prioritySlot < 300; prioritySlot++) {
      // One useful opportunity per three-minute slot, with no acknowledgement:
      // models jobs that consume the entire budget and remain unfinished.
      const initial = await pass(); expect(initial).not.toBeNull();
      const job = await claimCurrentAnalysisJob(db(), initial!, LEASE); expect(job).not.toBeNull();
      expect(seen.has(job!.participantId)).toBe(false); seen.add(job!.participantId);
      if (prioritySlot === 0) first = job!.participantId;
      await db().prepare("UPDATE community_analytical_input_versions SET revision=revision+1 WHERE participant_id=?")
        .bind(first).run();
    }
    expect(seen.size).toBe(300);
    const next = await claimCurrentAnalysisJob(db(), (await pass())!, LEASE);
    expect(next?.participantId).toBe(first);
    expect(await db().prepare("SELECT count(*) AS n FROM community_current_analysis_queue WHERE pending=1").first())
      .toEqual({ n: 300 });
  }, 30_000);

  it("does not retry a claimed account in one invocation and preserves the next job after a crash", async () => {
    await metadataJobs(2); const initial = (await pass())!;
    const first = await claimCurrentAnalysisJob(db(), initial, LEASE);
    const second = await claimCurrentAnalysisJob(db(), (await pass())!, LEASE);
    expect(first?.participantId).not.toBe(second?.participantId);
    expect(await claimCurrentAnalysisJob(db(), initial, LEASE)).toBeNull();
    const repeat = await claimCurrentAnalysisJob(db(), (await pass())!, LEASE);
    expect(repeat?.participantId).toBe(first?.participantId);
  });

  it("coalesces revisions without moving membership or service order and rejects an older acknowledgement", async () => {
    await metadataJobs(1); const job = (await claimCurrentAnalysisJob(db(), (await pass())!, LEASE))!;
    await db().prepare("UPDATE community_analytical_input_versions SET revision=revision+1").run();
    expect(await acknowledgeCurrentAnalysisJob(db(), job, LEASE)).toBe(false);
    expect(await db().prepare(`SELECT id,dirty_generation,last_served_sequence,pending
      FROM community_current_analysis_queue`).first()).toEqual({ id: job.id,
      dirty_generation: job.dirtyGeneration + 1, last_served_sequence: job.servedSequence, pending: 1 });
    const next = (await claimCurrentAnalysisJob(db(), (await pass())!, LEASE))!;
    expect(next.inputRevision).toBe(job.inputRevision + 1);
    expect(await acknowledgeCurrentAnalysisJob(db(), next, LEASE)).toBe(true);
    expect((await db().prepare("SELECT pending FROM community_current_analysis_queue").first())?.pending).toBe(0);
    await expect(db().prepare("UPDATE community_current_analysis_queue SET id=id+1").run()).rejects.toThrow();
  });

  it("enqueues cache damage during a pending attempt and keeps timestamp-only writes idle", async () => {
    await metadataJobs(1); const job = (await claimCurrentAnalysisJob(db(), (await pass())!, LEASE))!;
    await db().prepare(`INSERT INTO community_allowance_fit_cache(participant_id,cache_key,fits_json,computed_at)
      VALUES(?,'synthetic-queue-cache','[]',?)`).bind(job.participantId,new Date(NOW).toISOString()).run();
    expect(await acknowledgeCurrentAnalysisJob(db(), job, LEASE)).toBe(false);
    const next = (await claimCurrentAnalysisJob(db(), (await pass())!, LEASE))!;
    expect(await acknowledgeCurrentAnalysisJob(db(), next, LEASE)).toBe(true);
    await db().prepare("UPDATE community_allowance_fit_cache SET computed_at=computed_at,fits_json=fits_json").run();
    expect(await claimCurrentAnalysisJob(db(), (await pass())!, LEASE)).toBeNull();
    await db().prepare("UPDATE community_allowance_fit_cache SET fits_json='{}'").run();
    expect(await claimCurrentAnalysisJob(db(), (await pass())!, LEASE)).not.toBeNull();
  });

  it("atomically acknowledges only its own cache writes and rolls back a stale publication", async () => {
    await metadataJobs(1); const job = (await claimCurrentAnalysisJob(db(), (await pass())!, LEASE))!;
    const statements = currentAnalysisPublicationStatements(db(), job, LEASE);
    const cache = db().prepare(`INSERT INTO community_allowance_fit_cache(participant_id,cache_key,fits_json,computed_at)
      VALUES(?,'synthetic-queue-cache','[]',?)`).bind(job.participantId, new Date(NOW).toISOString());
    const result = await db().batch([statements.before,cache,statements.after]);
    expect(result[0]?.results).toEqual([{participant_id:job.participantId}]);
    expect(result[2]?.results).toEqual([{participant_id:job.participantId}]);
    expect((await db().prepare("SELECT dirty_generation,pending FROM community_current_analysis_queue").first()))
      .toEqual({dirty_generation:job.dirtyGeneration+1,pending:0});
    await db().prepare("UPDATE community_analytical_input_versions SET revision=revision+1").run();
    await expect(db().batch([statements.before,
      db().prepare("UPDATE community_allowance_fit_cache SET fits_json='{}'"),statements.after])).rejects.toThrow();
    expect(await db().prepare("SELECT fits_json FROM community_allowance_fit_cache").first()).toEqual({fits_json:"[]"});
    expect((await db().prepare("SELECT pending FROM community_current_analysis_queue").first())?.pending).toBe(1);
  });

  it("rolls back its cache write when authority expires before the final acknowledgement", async () => {
    await metadataJobs(1); const job = (await claimCurrentAnalysisJob(db(), (await pass())!, LEASE))!;
    const statements = currentAnalysisPublicationStatements(db(), job, LEASE);
    await expect(db().batch([statements.before,
      db().prepare(`INSERT INTO community_allowance_fit_cache(participant_id,cache_key,fits_json,computed_at)
        VALUES(?,'synthetic-queue-cache','[]',?)`).bind(job.participantId,new Date(NOW).toISOString()),
      db().prepare("UPDATE retention_state SET maintenance_lease_expires_at='2000-01-01T00:00:00.000Z'"),
      statements.after])).rejects.toThrow();
    expect(await db().prepare("SELECT participant_id FROM community_allowance_fit_cache").first()).toBeNull();
    expect(await db().prepare("SELECT dirty_generation,pending FROM community_current_analysis_queue").first())
      .toEqual({dirty_generation:job.dirtyGeneration,pending:1});
    expect(await pass()).not.toBeNull();
  });

  it("bounds rollover to 1000 indexed registered rows and cannot complete an unfinished window", async () => {
    await metadataJobs(1_001); const initial = (await pass())!;
    expect(await db().prepare(`SELECT window_generation,count(*) AS n FROM community_current_analysis_queue
      GROUP BY window_generation ORDER BY window_generation`).all().then(result => result.results))
      .toEqual([{window_generation:0,n:1},{window_generation:initial.windowGeneration,n:1_000}]);
    const pin = await readCommunityRefreshLane(db(), "current", NOW);
    expect(await recordCommunityRefreshLane(db(), pin, true, NOW, LEASE)).toBe(false);
    await pass();
    expect(await db().prepare("SELECT count(*) AS n FROM community_current_analysis_queue WHERE window_generation=?")
      .bind(initial.windowGeneration).first()).toEqual({n:1_001});
    const plan=(await db().prepare(`EXPLAIN QUERY PLAN SELECT id FROM community_current_analysis_queue
      WHERE window_generation<? ORDER BY window_generation,id LIMIT 1000`).bind(initial.windowGeneration).all<{detail:string}>())
      .results.map(row=>row.detail).join("\n");
    expect(plan).toContain("SEARCH community_current_analysis_queue USING COVERING INDEX community_current_analysis_queue_window");
    const next = (await pass("2026-09-09"))!; expect(next.windowGeneration).toBe(initial.windowGeneration+1);
    expect(await db().prepare("SELECT count(*) AS n FROM community_current_analysis_queue WHERE window_generation=?")
      .bind(next.windowGeneration).first()).toEqual({n:1_000});
  });

  it("does not scan or claim noncontributing physical participants", async () => {
    await metadataJobs(1);
    await db().prepare(`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<1_500)
      INSERT INTO participants(id,access_token_id,access_token_hash,recovery_token_id,recovery_token_hash,
        state,consent_version,consented_at,created_at)
      SELECT 'unrelated-'||i,'unrelated-access-'||i,zeroblob(32),'unrelated-recovery-'||i,zeroblob(32),
        'active','privacy-safe-telemetry-v0.1',?1,?1 FROM n`).bind(new Date(NOW).toISOString()).run();
    const initial = (await pass())!, meter = createD1InvocationBudget(900);
    const job = await claimCurrentAnalysisJob(meter.wrap(db()), initial, LEASE);
    expect(job?.participantId).toBe("synthetic-queue-0000"); expect(meter.queriesUsed).toBe(2);
    expect(await retireEmptyCurrentAnalysisJob(db(), job!, LEASE)).toBe(true);
    expect(await claimCurrentAnalysisJob(db(), initial, LEASE)).toBeNull();
  });

  it("removes revoked/erased membership immediately and rejects stale or expired authority", async () => {
    await metadataJobs(2); const initial = (await pass())!;
    const job = (await claimCurrentAnalysisJob(db(), initial, LEASE))!;
    await db().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(job.participantId).run();
    expect(await acknowledgeCurrentAnalysisJob(db(), job, LEASE)).toBe(false);
    expect(await db().prepare("SELECT id FROM community_current_analysis_queue WHERE participant_id=?")
      .bind(job.participantId).first()).toBeNull();
    const other = (await claimCurrentAnalysisJob(db(), initial, LEASE))!;
    await db().prepare("UPDATE retention_state SET maintenance_lease_expires_at='2000-01-01T00:00:00.000Z'").run();
    expect(await acknowledgeCurrentAnalysisJob(db(), other, LEASE)).toBe(false);
    expect(await pass()).toBeNull();
    await db().prepare("DELETE FROM participants WHERE id=?").bind(other.participantId).run();
    expect(await db().prepare("SELECT count(*) AS n FROM community_current_analysis_queue").first()).toEqual({n:0});
  });

  it("fails current closed before 0054 while retaining unrelated daily receipt compatibility", async () => {
    await reset(); await applyD1Migrations(db(), migrations().filter(migration => migration.name < "0054"));
    await expect(readCommunityRefreshLane(db(), "current", NOW)).rejects.toThrow();
    const daily = await readCommunityRefreshLane(db(), "daily", NOW);
    expect(await recordCommunityRefreshLane(db(), daily, true, NOW)).toBe(true);
    expect((await readCommunityRefreshLane(db(), "daily", NOW)).current).toBe(true);
  });
});
