import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { readAdminReconstructionProgress, ADMIN_RECONSTRUCTION_DAYS_SQL, ADMIN_RECONSTRUCTION_NEWEST_SQL,
  ADMIN_RECONSTRUCTION_PHASES_SQL } from "../src/admin-reconstruction-progress";
import { readAdminOverview } from "../src/admin-operations";
import { V1_ANALYSIS_WINDOW_DAYS, V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION } from "../src/quota-analysis-v1";
import { COMMUNITY_DAILY_SPEND_BASIS, COMMUNITY_DAILY_SPEND_PRICING_METHOD,
  COMMUNITY_DAILY_SPEND_REGISTRY_SHA256 } from "../src/community-daily-spend";

const NOW = Date.parse("2026-09-06T20:30:00.000Z"), ISO = new Date(NOW).toISOString();
const CUTOFF = `${new Date(NOW - V1_ANALYSIS_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`;
const db = () => env.USAGE_MONITOR_DB;
type Bindings = Env & { TEST_MIGRATIONS: D1Migration[]; TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[] };
beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), (env as Bindings).TEST_MIGRATIONS);
  await applyD1Migrations(env.DELETION_LEDGER, (env as Bindings).TEST_DELETION_LEDGER_MIGRATIONS);
});

async function head(id: string, phase = "plan", progress = 0) {
  await db().prepare(`INSERT INTO participants (id,access_token_id,access_token_hash,recovery_token_id,
    recovery_token_hash,state,consent_version,consented_at,created_at)
    VALUES (?,?,?,?,?,'active','privacy-safe-telemetry-v0.1',?,?)`)
    .bind(id, `access:${id}`, new Uint8Array(32), `recovery:${id}`, new Uint8Array(32), ISO, ISO).run();
  await db().prepare(`INSERT INTO community_analysis_work (participant_id,run_id,input_revision,input_fingerprint,
    source_kind,source_method_version,fixed_now,observed_at_cutoff,resets_at_cutoff,window_minutes,max_quota_rows,
    phase,progress_revision,control_json,manifest_json,state_sha256)
    SELECT ?,?,v.revision,?,'v1',?,?,?,? ,10080,60000,?,?,'{}','[]',?
    FROM community_analytical_input_versions v WHERE participant_id=?`)
    .bind(id, `synthetic-run:${id}`, "a".repeat(64), V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION,
      ISO, CUTOFF, "2026-06-05T00:00:00.000Z", phase, progress, "b".repeat(64), id).run();
}
const priced = () => ({ basis: COMMUNITY_DAILY_SPEND_BASIS, currency: "USD", knownCostUsd: 12.5,
  coverage: "partial", usageEvents: 2, fullyPricedUsageEvents: 1, partiallyPricedUsageEvents: 0,
  unpricedUsageEvents: 1, pricingMethodVersion: COMMUNITY_DAILY_SPEND_PRICING_METHOD,
  registrySha256: COMMUNITY_DAILY_SPEND_REGISTRY_SHA256 });
async function daily(day: string, revision = 1, spend: unknown = undefined, releaseState = "published") {
  const payload = JSON.stringify({ apiEquivalentSpend: spend, totals: { usageEvents: 2 },
    cells: [{ privateFixtureMarker: "NEVER_RETURN_CELLS" }] });
  await db().prepare(`INSERT INTO community_daily_aggregates (aggregate_id,day,revision,source_mutation_epoch,
    policy_version,payload_json,payload_sha256,release_state,released_at,withdrawn_at)
    VALUES (?,?,?,0,'synthetic',?,?,?,?,?)`)
    .bind(`daily:${day}:${revision}`, day, revision, payload, "c".repeat(64), releaseState, ISO,
      releaseState === "withdrawn" ? ISO : null).run();
}

describe("owner-only reconstruction progress", () => {
  it("reports empty metadata without claiming a ready graph or estimated completion", async () => {
    const result = await readAdminReconstructionProgress(db(), NOW, "resumable");
    expect(result).toEqual({ schemaVersion: "admin-reconstruction-progress-v0.1", status: "available",
      observedAt: ISO, mode: "resumable", lookup: { complete: true, lastRecordId: 0, throughRecordId: 0 },
      calculations: { trackedAccounts: 0, completedAccounts: 0, preparingAccounts: 0, scanningAccounts: 0,
        finalizingAccounts: 0, sourceChangedAccounts: 0, checkpointsWritten: 0, bounded: false, newestResultAt: null },
      maintenance: { running: false, lastRunAt: null, leaseExpiresAt: null },
      publication: { state: "updating", pendingDays: 0, pendingDaysBounded: false,
        publishedDays: 0, pricedDays: 0, latestPublishedAt: null } });
  });

  it("separates current acquisition phases, changed sources, timestamps and publishing", async () => {
    for (const [id, phase, progress] of [["done", "complete", 3], ["plan", "plan", 4],
      ["fit", "fitability", 5], ["end", "endpoints", 6], ["changed", "complete", 7]] as const) {
      await head(id, phase, progress);
    }
    await db().prepare("UPDATE community_analytical_input_versions SET revision=revision+1 WHERE participant_id='changed'").run();
    await db().prepare("INSERT INTO community_allowance_fit_cache (participant_id,cache_key,fits_json,computed_at) VALUES ('done','synthetic','[]',?)").bind(ISO).run();
    await db().prepare("UPDATE telemetry_v1_quota_fit_backfill SET through_record_id=100,last_record_id=100,is_complete=1 WHERE singleton_id=1").run();
    await db().prepare("UPDATE retention_state SET maintenance_run_at=?,maintenance_lease_token='SECRET_LEASE',maintenance_lease_expires_at=? WHERE singleton=1")
      .bind(ISO, new Date(NOW + 60_000).toISOString()).run();
    await db().prepare("INSERT INTO community_daily_aggregate_rebuilds VALUES ('2026-09-01',0,?)").bind(ISO).run();
    await daily("2026-09-01", 1, priced());
    const result = await readAdminReconstructionProgress(db(), NOW, "resumable");
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("expected available");
    expect(result.calculations).toEqual({ trackedAccounts: 5, completedAccounts: 1, preparingAccounts: 1,
      scanningAccounts: 1, finalizingAccounts: 1, sourceChangedAccounts: 1, checkpointsWritten: 25,
      bounded: false, newestResultAt: ISO });
    expect(result.lookup).toEqual({ complete: true, lastRecordId: 100, throughRecordId: 100 });
    expect(result.maintenance.running).toBe(true);
    expect(result.publication).toEqual({ state: "updating", pendingDays: 1, pendingDaysBounded: false,
      publishedDays: 1, pricedDays: 1, latestPublishedAt: ISO });
    expect(JSON.stringify(result)).not.toMatch(/SECRET_LEASE|synthetic-run|participant_id|input_fingerprint|NEVER_RETURN_CELLS/u);
  });

  it("excludes inactive accounts and does not present old adapters or windows as current", async () => {
    for (const id of ["inactive", "old-method", "old-window", "old-reset", "old-minutes", "old-cap"])
      await head(id, "complete");
    await db().prepare("UPDATE participants SET state='deleting' WHERE id='inactive'").run();
    await db().prepare("UPDATE community_analysis_work SET source_method_version='old' WHERE participant_id='old-method'").run();
    await db().prepare("UPDATE community_analysis_work SET observed_at_cutoff='2026-01-01T00:00:00.000Z' WHERE participant_id='old-window'").run();
    await db().prepare("UPDATE community_analysis_work SET resets_at_cutoff='2026-01-08T00:00:00.000Z' WHERE participant_id='old-reset'").run();
    await db().prepare("UPDATE community_analysis_work SET window_minutes=1440 WHERE participant_id='old-minutes'").run();
    await db().prepare("UPDATE community_analysis_work SET max_quota_rows=1000 WHERE participant_id='old-cap'").run();
    const result = await readAdminReconstructionProgress(db(), NOW);
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("expected available");
    expect(result.mode).toBe("unknown");
    expect(result.calculations.trackedAccounts).toBe(5);
    expect(result.calculations.completedAccounts).toBe(0);
    expect(result.calculations.sourceChangedAccounts).toBe(5);
  });

  it("counts only latest published daily price coverage inside the displayed year", async () => {
    await daily("2025-09-05", 1, priced()); // Outside inclusive 366-day window.
    await daily("2025-09-06", 1, priced());
    await daily("2026-09-01", 1, priced());
    await daily("2026-09-01", 2, undefined); // Latest published revision replaces price block.
    await daily("2026-09-02", 1, { ...priced(), pricingMethodVersion: "old" });
    await daily("2026-09-03", 1, { ...priced(), usageEvents: 5 });
    await daily("2026-09-04", 1, priced(), "withdrawn");
    await daily("2026-09-05", 1, { ...priced(), extra: "x".repeat(3000) });
    await daily("2026-09-06", 1, priced());
    const result = await readAdminReconstructionProgress(db(), NOW);
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("expected available");
    expect(result.publication.publishedDays).toBe(6);
    expect(result.publication.pricedDays).toBe(2);
    const plan = await db().prepare(`EXPLAIN QUERY PLAN ${ADMIN_RECONSTRUCTION_DAYS_SQL}`)
      .bind("2025-09-06", "2026-09-06").all<{ detail: string }>();
    expect(plan.results.map(row => row.detail).join("\n")).toMatch(/USING INDEX community_daily_aggregates_latest \(day=\?\)/u);
    const phasePlan = await db().prepare(`EXPLAIN QUERY PLAN ${ADMIN_RECONSTRUCTION_PHASES_SQL}`)
      .bind(V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION, CUTOFF, 10_000, "2026-06-05T00:00:00.000Z", 10080, 60000)
      .all<{ detail: string }>();
    expect(phasePlan.results.map(row => row.detail).join("\n")).toContain("MATERIALIZE head_page");
    expect(phasePlan.results.map(row => row.detail).join("\n")).not.toMatch(/SCAN p\b/u);
    const cachePlan = await db().prepare(`EXPLAIN QUERY PLAN ${ADMIN_RECONSTRUCTION_NEWEST_SQL}`)
      .bind(10_000).all<{ detail: string }>();
    expect(cachePlan.results.map(row => row.detail).join("\n")).toContain("MATERIALIZE cache_page");
    expect(cachePlan.results.map(row => row.detail).join("\n")).not.toMatch(/SCAN p\b/u);
  });

  it("fails closed when a published row might be beyond the bounded withdrawn-revision probe", async () => {
    await daily("2026-09-01", 1, priced());
    for (let revision = 2; revision <= 33; revision++) await daily("2026-09-01", revision, undefined, "withdrawn");
    expect(await readAdminReconstructionProgress(db(), NOW)).toMatchObject({ status: "unavailable" });
    // No unbounded fallback and no falsely reported zero priced days.
    expect(await readAdminReconstructionProgress(db(), NOW)).not.toHaveProperty("publication");
  });

  it("caps physical checkpoint pages before joining inactive account rows", async () => {
    await head("page-template", "plan", 1);
    await db().prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<10000)
      INSERT INTO participants(id,access_token_id,access_token_hash,recovery_token_id,recovery_token_hash,
        state,consent_version,consented_at,created_at)
      SELECT printf('bounded-%05d',i),printf('access-%05d',i),zeroblob(32),printf('recovery-%05d',i),zeroblob(32),
        'active','privacy-safe-telemetry-v0.1',?1,?1 FROM n`).bind(ISO).run();
    await db().prepare(`INSERT INTO community_analysis_work
      (participant_id,run_id,input_revision,input_fingerprint,source_kind,source_method_version,fixed_now,
        observed_at_cutoff,resets_at_cutoff,window_minutes,max_quota_rows,phase,progress_revision,control_json,manifest_json,state_sha256)
      SELECT p.id,p.id,v.revision,h.input_fingerprint,
      h.source_kind,h.source_method_version,h.fixed_now,h.observed_at_cutoff,h.resets_at_cutoff,h.window_minutes,
      h.max_quota_rows,h.phase,h.progress_revision,h.control_json,h.manifest_json,h.state_sha256
      FROM participants p JOIN community_analytical_input_versions v ON v.participant_id=p.id
      CROSS JOIN community_analysis_work h WHERE h.participant_id='page-template' AND p.id LIKE 'bounded-%'`).run();
    await db().prepare("UPDATE participants SET state='deleting' WHERE id LIKE 'bounded-%'").run();
    const result = await readAdminReconstructionProgress(db(), NOW);
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("expected available");
    expect(result.calculations.trackedAccounts).toBe(0);
    expect(result.calculations.bounded).toBe(true);
    expect(await db().prepare("SELECT COUNT(*) AS total FROM community_analysis_work").first("total")).toBe(10001);
  });

  it("reports inconsistent lookup evidence as unavailable rather than complete", async () => {
    await db().prepare("UPDATE telemetry_v1_quota_fit_backfill SET through_record_id=100,last_record_id=25,is_complete=1 WHERE singleton_id=1").run();
    expect(await readAdminReconstructionProgress(db(), NOW)).toMatchObject({ status: "unavailable" });
  });

  it("shows paused operation and expired leases without inferring a running calculator", async () => {
    await db().prepare("UPDATE retention_state SET maintenance_lease_expires_at=? WHERE singleton=1")
      .bind(ISO).run();
    const result = await readAdminReconstructionProgress(db(), NOW, "paused");
    expect(result.mode).toBe("paused");
    expect(result.status === "available" && result.maintenance.running).toBe(false);
    expect((await readAdminReconstructionProgress(db(), NOW, "legacy")).mode).toBe("synchronous");
  });

  it("isolates a missing checkpoint schema from the existing operations overview", async () => {
    await db().prepare("DROP TABLE community_analysis_work_stage").run();
    await db().prepare("DROP TABLE community_analysis_work_parts").run();
    await db().prepare("DROP TABLE community_analysis_work").run();
    expect(await readAdminReconstructionProgress(db(), NOW, "resumable")).toEqual({
      schemaVersion: "admin-reconstruction-progress-v0.1", status: "unavailable", observedAt: ISO, mode: "resumable" });
    const result = await readAdminOverview(db(), env.DELETION_LEDGER,
      { environment: "synthetic-development", enrollmentMode: "open", accountScopedIngestMode: "disabled", nowEpoch: NOW });
    expect(result).toMatchObject({ schemaVersion: "admin-overview-v0.3",
      dailyPublication: { pendingRebuilds: 0 } });
  });
});
