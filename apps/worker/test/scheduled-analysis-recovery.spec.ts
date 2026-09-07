import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1InvocationBudget } from "../src/d1-invocation-budget";

const inspection = vi.hoisted(() => ({
  limit: 900, meter: null as D1InvocationBudget | null,
  rawFits: vi.fn(), rawModels: vi.fn(), backfill: vi.fn(),
}));
vi.mock("../src/d1-invocation-budget", async original => {
  const actual = await original<typeof import("../src/d1-invocation-budget")>();
  return { ...actual, createD1InvocationBudget: () => {
    inspection.meter = actual.createD1InvocationBudget(inspection.limit);
    return inspection.meter;
  } };
});
vi.mock("../src/community-allowance", async original => ({
  ...await original<typeof import("../src/community-allowance")>(),
  collectCommunityAllowanceFits: inspection.rawFits,
  collectCommunityModelCompositions: inspection.rawModels,
}));
vi.mock("../src/quota-fit-projection", async original => {
  const actual = await original<typeof import("../src/quota-fit-projection")>();
  return { ...actual, backfillV1QuotaFitProjection: (...args: Parameters<typeof actual.backfillV1QuotaFitProjection>) => {
    inspection.backfill();
    return actual.backfillV1QuotaFitProjection(...args);
  } };
});

import { runScheduledMaintenance } from "../src/index";
import { validCachedAdminCommunityAllowancePreview } from "../src/admin-community-allowance";
import { readCachedAdminMetricsHistory } from "../src/admin-metrics-history";
import { putTrackedQuarantineObject } from "../src/quarantine-reconciliation";
import { createV11DeviceFixture } from "./helpers/telemetry-v11";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";
import { V1_PLAN_QUOTA_PAGE_SQL, V1_FIT_QUOTA_PAGE_SQL, V1_QUOTA_PROJECTION_BACKFILL_INSERT_SQL } from "../src/quota-fit-projection";

interface Bindings extends Env { TEST_MIGRATIONS: D1Migration[]; TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[] }
const runtime = env as Bindings, db = () => runtime.USAGE_MONITOR_DB;
const NOW = Date.parse("2026-09-01T12:00:00.000Z"), DAY = "2026-08-01", TIME = `${DAY}T00:00:00.000Z`;
const PARTICIPANT = "synthetic-scheduled-participant";
type Observation = { binding: "primary" | "ledger"; sql: string };

function observe(hook?: (entry: Observation, moment: "before" | "after") => Promise<void>) {
  const queries: Observation[] = [];
  const wrapDb = (database: D1Database, binding: Observation["binding"]): D1Database => {
    const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>(), sqls = new WeakMap<D1PreparedStatement, string>();
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
      const proxy = new Proxy(statement, { get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (["first", "all", "run", "raw"].includes(String(key))) return async (...args: unknown[]) => {
          const entry = { binding, sql }; queries.push(entry); await hook?.(entry, "before");
          const result: unknown = await Reflect.apply(Reflect.get(target, key), target, args);
          await hook?.(entry, "after"); return result;
        };
        const value: unknown = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
      originals.set(proxy, statement); sqls.set(proxy, sql); return proxy;
    };
    return new Proxy(database, { get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        const entries = statements.map(statement => ({ binding, sql: sqls.get(statement) ?? "" }));
        queries.push(...entries);
        for (const entry of entries) await hook?.(entry, "before");
        const result = await target.batch(statements.map(statement => originals.get(statement) ?? statement));
        for (const entry of entries) await hook?.(entry, "after");
        return result;
      };
      const value: unknown = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  return { queries, primary: wrapDb(db(), "primary"), ledger: wrapDb(runtime.DELETION_LEDGER, "ledger") };
}
function bindings(observation = observe(), mode = "resumable"): Env {
  return new Proxy(runtime, { get(target, key) {
    if (key === "USAGE_MONITOR_DB") return observation.primary;
    if (key === "DELETION_LEDGER") return observation.ledger;
    if (key === "ENVIRONMENT") return "synthetic-development";
    if (key === "ACCOUNT_SCOPED_INGEST_MODE") return "disabled";
    if (key === "ALLOWANCE_RECONSTRUCTION_MODE") return mode;
    return Reflect.get(target, key);
  } });
}
async function migrations(max = 49) {
  await applyD1Migrations(db(), runtime.TEST_MIGRATIONS.filter(migration => Number(migration.name.slice(0, 4)) <= max));
  await applyD1Migrations(runtime.DELETION_LEDGER, runtime.TEST_DELETION_LEDGER_MIGRATIONS);
}
async function queue() {
  await db().prepare(`INSERT OR IGNORE INTO community_daily_aggregate_rebuilds(day,requested_epoch,requested_at)
    SELECT ?,mutation_epoch,? FROM community_snapshot_mutation_control WHERE singleton_id=1`).bind(DAY, TIME).run();
  return (await db().prepare("SELECT * FROM community_daily_aggregate_rebuilds ORDER BY day").all()).results;
}
async function released() {
  expect(await db().prepare("SELECT maintenance_lease_token,maintenance_lease_expires_at FROM retention_state WHERE singleton=1").first())
    .toEqual({ maintenance_lease_token: null, maintenance_lease_expires_at: null });
}
function assertMeter(observation: ReturnType<typeof observe>) {
  expect(inspection.meter?.queriesUsed).toBe(observation.queries.length);
  expect(observation.queries.length).toBeLessThanOrEqual(inspection.limit);
  expect(observation.queries.some(entry => entry.binding === "primary")).toBe(true);
  expect(observation.queries.some(entry => entry.binding === "ledger")).toBe(true);
}
async function seedQuota(count = 1200) {
  const fixture = await createV11DeviceFixture(db(), { participantId: PARTICIPANT });
  const principal = await authenticateDevice(db(), fixture.authorization);
  for (let offset = 0; offset < count; offset += 200) {
    const digest = (offset + 1).toString(16).padStart(64, "0");
    const upload = await createDeviceUploadAuthorization(db(), principal, digest, 200);
    const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`,
      { envelopeDigest: digest, bodyBytes: 200, contentType: "application/json" });
    await db().prepare(`INSERT INTO telemetry_v1_chunks(id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,
      chunk_digest,envelope_digest,parser_version,record_count,accepted_record_count,r2_key,device_upload_authorization_id,created_at)
      VALUES (?,?,?,'quota',?,?,1,?,?,'synthetic-scheduled',?,?,?,?,?)`).bind(`scheduled-chunk-${offset}`,
        PARTICIPANT, fixture.deviceId, DAY, offset / 200, digest, digest, Math.min(200, count - offset),
        Math.min(200, count - offset), `synthetic/scheduled/${offset}`, claimed.authorizationId, TIME).run();
  }
  await db().prepare(`WITH RECURSIVE s(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM s WHERE n<?)
    INSERT INTO telemetry_v1_records(chunk_row_id,participant_id,device_id,stream,occurrence_id,observed_at,observed_day,
      provider,plan_type,plan_variant,limit_id,slot,used_percent,window_duration_minutes,resets_at,record_json)
    SELECT 'scheduled-chunk-'||(CAST((n-1)/200 AS INTEGER)*200),?,?,'quota','synthetic-scheduled-'||n,
      strftime('%Y-%m-%dT%H:%M:%fZ',?,'+'||n||' seconds'),?,'openai_codex','pro','unknown',
      'codex','seven_day',CAST((n-1)/20 AS INTEGER)%100,10080,'2026-08-08T00:00:00.000Z','{}' FROM s`)
    .bind(count, PARTICIPANT, fixture.deviceId, TIME, DAY).run();
  return fixture;
}

beforeEach(async () => {
  await reset(); await migrations(); inspection.limit = 900; inspection.meter = null;
  vi.clearAllMocks();
  inspection.rawFits.mockImplementation(() => { throw new Error("raw graph fit analyzer forbidden"); });
  inspection.rawModels.mockImplementation(() => { throw new Error("raw graph model analyzer forbidden"); });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe("actual scheduled resumable analysis recovery", () => {
  it("finishes required device, identity and real R2 lifecycle work before optional reconstruction failure", async () => {
    const fixture = await seedQuota(200);
    const principal = await authenticateDevice(db(), fixture.authorization);
    await createDeviceUploadAuthorization(db(), principal, "c".repeat(64), 1);
    const expired = new Date(Date.now() - 1000).toISOString();
    await db().prepare("UPDATE device_credentials SET expires_at=?,last_used_at=? WHERE id=?")
      .bind(expired, expired, fixture.deviceId).run();
    await db().prepare(`INSERT INTO google_signin_handoffs(state,code_verifier,identity_link_key,proof,created_at,expires_at,delivered_at)
      VALUES ('synthetic-expired-handoff',NULL,?,NULL,?,?,NULL)`).bind("b".repeat(64), expired, expired).run();
    const insert = "INSERT INTO identity_reenrollment_cooldowns(identity_cooldown_digest,schema_version,deleted_at,retain_until) VALUES (?,'identity-reenrollment-cooldown-v0.1',?,?)";
    for (const database of [db(), runtime.DELETION_LEDGER]) await database.prepare(insert)
      .bind("d".repeat(64), new Date(Date.now() - 7_200_000).toISOString(), expired).run();
    const r2Key = "telemetry/synthetic-scheduled-orphan";
    await putTrackedQuarantineObject(db(), runtime.QUARANTINE, { contributionId: "contribution:synthetic-orphan", objectKind: "telemetry",
      r2Key, registeredAt: new Date(NOW - 7_200_000).toISOString() }, "{}");
    await queue();
    let optionalSeen = false;
    let lifecycleAtOptionalFailure: unknown;
    const observation = observe(async (entry, moment) => {
      if (moment !== "before" || !entry.sql.includes("FROM telemetry_v1_quota_fit_backfill")) return;
      optionalSeen = true;
      lifecycleAtOptionalFailure = {
        object: await runtime.QUARANTINE.head(r2Key),
        device: await db().prepare("SELECT state FROM device_credentials WHERE id=?").bind(fixture.deviceId).first(),
        handoffs: await db().prepare("SELECT count(*) AS n FROM google_signin_handoffs").first(),
        cooldowns: await runtime.DELETION_LEDGER.prepare("SELECT count(*) AS n FROM identity_reenrollment_cooldowns").first(),
      };
      throw new Error("synthetic optional projection failure");
    });
    const result = await runScheduledMaintenance(bindings(observation), NOW);
    expect(optionalSeen).toBe(true);
    expect(lifecycleAtOptionalFailure).toEqual({ object: null, device: { state: "revoked" }, handoffs: { n: 0 }, cooldowns: { n: 0 } });
    expect(result).toMatchObject({ outcome: "success", lifecycleComplete: true, quarantineReconciliationComplete: true,
      expiredIdentityHandoffsPurged: 1, expiredPrimaryIdentityReenrollmentCooldownsPurged: 1,
      expiredIdentityReenrollmentCooldownsPurged: 1, staleDeviceCredentialsRevoked: 1, staleDeviceUploadAuthorizationsRevoked: 1,
      aggregateRebuildComplete: false });
    assertMeter(observation); await released();
  });

  it("fails optional work closed before local migrations 0046/0047 without draining the queued graph day", async () => {
    await reset(); await migrations(45);
    await seedQuota(200);
    const queued = await queue(), observation = observe();
    const result = await runScheduledMaintenance(bindings(observation), NOW);
    expect(result).toMatchObject({ outcome: "success", lifecycleComplete: true, aggregateRebuildComplete: false });
    expect((await db().prepare("SELECT * FROM community_daily_aggregate_rebuilds ORDER BY day").all()).results).toEqual(queued);
    expect(await db().prepare("SELECT name FROM sqlite_master WHERE name IN ('community_analysis_work','telemetry_v1_quota_fit_backfill')").all()).toMatchObject({ results: [] });
    expect(observation.queries.some(entry => entry.sql.includes("FROM telemetry_v1_quota_fit_backfill"))).toBe(true);
    expect(inspection.rawFits).not.toHaveBeenCalled(); expect(inspection.rawModels).not.toHaveBeenCalled();
    assertMeter(observation); await released();
  });

  it("keeps paused reconstruction inert while required maintenance still runs", async () => {
    await seedQuota(200); const queued = await queue(), observation = observe();
    const result = await runScheduledMaintenance(bindings(observation, "paused"), NOW);
    expect(result).toMatchObject({ outcome: "success", lifecycleComplete: true, aggregateRebuildComplete: false });
    expect(inspection.backfill).not.toHaveBeenCalled();
    expect(observation.queries.some(entry => /community_analysis_work|telemetry_v1_quota_fit_(?:backfill|rows)/u.test(entry.sql))).toBe(false);
    expect((await db().prepare("SELECT * FROM community_daily_aggregate_rebuilds ORDER BY day").all()).results).toEqual(queued);
    for (const table of ["community_analysis_work", "community_allowance_fit_cache", "community_model_composition_cache"])
      expect(await db().prepare(`SELECT count(*) AS n FROM ${table}`).first()).toEqual({ n: 0 });
    expect(inspection.rawFits).not.toHaveBeenCalled(); expect(inspection.rawModels).not.toHaveBeenCalled();
    assertMeter(observation); await released();
  });

  it("preserves acquisition and queue on a shared small budget, then resumes and publishes both caches", async () => {
    await seedQuota(2050); const queued = await queue(), first = observe();
    inspection.limit = 350;
    const result = await runScheduledMaintenance(bindings(first), NOW);
    expect(result).toMatchObject({ outcome: "success", lifecycleComplete: true, aggregateRebuildComplete: false });
    assertMeter(first); await released();
    const before = await db().prepare("SELECT fixed_now,run_id,phase,progress_revision FROM community_analysis_work WHERE participant_id=?").bind(PARTICIPANT).first();
    expect(before?.phase).toBe("complete");
    expect((await db().prepare("SELECT * FROM community_daily_aggregate_rebuilds ORDER BY day").all()).results).toEqual(queued);
    expect(await db().prepare("SELECT count(*) AS n FROM community_allowance_fit_cache").first()).toEqual({ n: 0 });
    inspection.limit = 900; const second = observe();
    expect(await runScheduledMaintenance(bindings(second), NOW + 60_000)).toMatchObject({ outcome: "success", lifecycleComplete: true });
    assertMeter(second); await released();
    const payloadRead = second.queries.findIndex(entry => entry.sql.includes("FROM wanted w JOIN community_analysis_work_parts p"));
    expect(payloadRead).toBeGreaterThan(0);
    // Each payload read has one head-before and one head-after statement. The
    // index below excludes the first head-before read from fixed setup cost.
    const fixedSetupQueries = payloadRead - 1;
    const setupReceipt = { fixedSetupQueries,
      primary: second.queries.slice(0, fixedSetupQueries).filter(entry => entry.binding === "primary").length,
      ledger: second.queries.slice(0, fixedSetupQueries).filter(entry => entry.binding === "ledger").length };
    // Odd-minute reconstruction has no speculative preview/cohort scan. Keep
    // the original setup budget even when the preview's inputs are incomplete.
    expect(second.queries.slice(0, payloadRead).some(entry => entry.sql.includes("FROM admin_community_allowance_preview_cache"))).toBe(false);
    expect(setupReceipt).toEqual({ fixedSetupQueries: 50, primary: 47, ledger: 3 });
    // Worst legal 1024-part head:384 reads,3 final pin/head checks,407 finish
    // reserve,24 combined warmer/scheduler headroom. Heavy sustained required
    // housekeeping can exceed the remaining33 queries and safely defer finish.
    expect(fixedSetupQueries + 384 + 3 + 407 + 24).toBeLessThanOrEqual(900);
    expect(await db().prepare("SELECT fixed_now,run_id,phase FROM community_analysis_work WHERE participant_id=?").bind(PARTICIPANT).first())
      .toMatchObject({ fixed_now: before!.fixed_now, run_id: before!.run_id, phase: "complete" });
    for (const table of ["community_allowance_fit_cache", "community_model_composition_cache"])
      expect(await db().prepare(`SELECT count(*) AS n FROM ${table}`).first()).toEqual({ n: 1 });
    const third = observe(); await runScheduledMaintenance(bindings(third), NOW + 120_000);
    assertMeter(third); await released();
    expect(third.queries.filter(entry => entry.sql === V1_PLAN_QUOTA_PAGE_SQL || entry.sql === V1_FIT_QUOTA_PAGE_SQL)).toEqual([]);
    expect(inspection.rawFits).not.toHaveBeenCalled(); expect(inspection.rawModels).not.toHaveBeenCalled();
  });

  it("counts every projection-page batch statement in the whole-call shared limit", async () => {
    await seedQuota(4097);
    // Model the freshly installed projection's historical high-water mark.
    await db().prepare("DELETE FROM telemetry_v1_quota_fit_rows").run();
    await db().prepare("UPDATE telemetry_v1_quota_fit_backfill SET last_record_id=0,through_record_id=(SELECT max(id) FROM telemetry_v1_records),is_complete=0").run();
    const observation = observe(); await runScheduledMaintenance(bindings(observation), NOW);
    assertMeter(observation); await released();
    expect(inspection.backfill.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(inspection.backfill.mock.calls.length).toBeLessThanOrEqual(8);
    expect(observation.queries.filter(entry => entry.sql === V1_QUOTA_PROJECTION_BACKFILL_INSERT_SQL)).toHaveLength(2);
    expect(await db().prepare("SELECT is_complete FROM telemetry_v1_quota_fit_backfill").first()).toEqual({ is_complete: 1 });
    expect(await db().prepare("SELECT count(*) AS n FROM telemetry_v1_quota_fit_rows").first()).toEqual({ n: 4097 });
  });

  it("refreshes an aged preview before the current-account scan consumes the optional deadline", async () => {
    await seedQuota(200);
    const setup = observe();
    expect(await runScheduledMaintenance(bindings(setup), NOW)).toMatchObject({ outcome: "success", lifecycleComplete: true });
    assertMeter(setup); await released();
    const readPreview = () => db().prepare(`SELECT generated_at, payload_json, source_mutation_epoch
      FROM admin_community_allowance_preview_cache WHERE singleton=1`)
      .first<{ generated_at: string; payload_json: string; source_mutation_epoch: number }>();
    const accountCaches = () => Promise.all([
      db().prepare("SELECT * FROM community_allowance_fit_cache ORDER BY participant_id").all(),
      db().prepare("SELECT * FROM community_model_composition_cache ORDER BY participant_id").all(),
    ]).then(results => results.map(result => result.results));
    const prior = await readPreview(), caches = await accountCaches();
    expect(prior?.generated_at).toBe(new Date(NOW).toISOString());
    expect(caches.map(rows => rows.length)).toEqual([1, 1]);
    expect(await db().prepare("SELECT count(*) AS n FROM community_daily_aggregate_rebuilds").first()).toEqual({ n: 0 });

    // Keep the same UTC/source window but make the old singleton genuinely
    // expired. Simulate slow D1 I/O, not a sleep or an invalid cached body.
    const refreshedAt = NOW + 3 * 3_600_000, started = Date.now();
    let crossed = false;
    const deadlineObservation: { preview: Awaited<ReturnType<typeof readPreview>> } = { preview: null };
    vi.spyOn(Date, "now").mockImplementation(() => started + (crossed ? 40_001 : 0));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy.mockClear(); warnSpy.mockClear();
    const observation = observe(async (entry, moment) => {
      if (crossed || moment !== "after" || !entry.sql.includes("FROM community_analysis_work w")
          || !entry.sql.includes("c.composition_json")) return;
      // This is the per-account full-body current probe, not the earlier
      // bounded composition-corpus read, which uses LEFT JOIN and paging.
      deadlineObservation.preview = await readPreview();
      crossed = true;
    });
    expect(await runScheduledMaintenance(bindings(observation), refreshedAt))
      .toMatchObject({ outcome: "success", lifecycleComplete: true });
    expect(crossed).toBe(true);
    const refreshed = await readPreview();
    expect(deadlineObservation.preview?.generated_at).toBe(new Date(refreshedAt).toISOString());
    expect(refreshed).toEqual(deadlineObservation.preview);
    expect(validCachedAdminCommunityAllowancePreview(JSON.parse(refreshed!.payload_json), refreshed!.generated_at, refreshedAt)).toBe(true);
    expect(refreshed?.source_mutation_epoch).toBe(prior?.source_mutation_epoch);
    expect(await accountCaches()).toEqual(caches);
    expect(await db().prepare("SELECT count(*) AS n FROM community_daily_aggregate_rebuilds").first()).toEqual({ n: 0 });
    const logs = logSpy.mock.calls.map(([message]) => JSON.parse(String(message)) as { event: string });
    expect(logs).toContainEqual(expect.objectContaining({ event: "scheduled_allowance_reconstruction", outcome: "complete",
      visited: 1, published: 0, resumed: 0 }));
    expect(logs).toContainEqual(expect.objectContaining({ event: "admin_allowance_preview_cache", phase: "before_analysis",
      outcome: "success", code: "ALLOWANCE_PREVIEW_CACHE_REFRESHED", elapsedMs: 0, deadlineRemainingMs: 40_000,
      queriesUsed: expect.any(Number), phaseQueries: 13 }));
    expect(observation.queries.filter(entry => entry.sql.includes("FROM admin_community_allowance_preview_cache"))).toHaveLength(1);
    expect(warnSpy.mock.calls.some(([message]) => String(message).includes("admin_allowance_preview_cache"))).toBe(false);
    expect(logs.some(log => log.event === "scheduled_model_history")).toBe(false);
    expect(observation.queries.filter(entry => entry.sql === V1_PLAN_QUOTA_PAGE_SQL || entry.sql === V1_FIT_QUOTA_PAGE_SQL)).toEqual([]);
    expect(inspection.rawFits).not.toHaveBeenCalled(); expect(inspection.rawModels).not.toHaveBeenCalled();
    assertMeter(observation); await released();
  });

  it("refreshes expired owner metrics before slow account probes and never attempts a cache twice", async () => {
    await seedQuota(200);
    const started = Date.now();
    let currentTime = started;
    vi.spyOn(Date, "now").mockImplementation(() => currentTime);
    const setup = observe();
    await runScheduledMaintenance(bindings(setup), NOW);
    const prior = await readCachedAdminMetricsHistory(db(), started);
    expect(prior.generatedAt).toBe(new Date(started).toISOString());
    assertMeter(setup); await released();

    const refreshedAt = started + 3 * 3_600_000;
    currentTime = refreshedAt;
    await expect(readCachedAdminMetricsHistory(db(), currentTime)).rejects.toMatchObject({ code: "ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const metricsAtProbe: { generatedAt?: string; capturedAt?: string } = {};
    const observation = observe(async (entry, moment) => {
      if (metricsAtProbe.generatedAt || moment !== "after" || !entry.sql.includes("FROM community_analysis_work w")
          || !entry.sql.includes("c.composition_json")) return;
      metricsAtProbe.generatedAt = (await readCachedAdminMetricsHistory(db(), refreshedAt)).generatedAt;
      metricsAtProbe.capturedAt = (await db().prepare("SELECT MAX(captured_at) AS captured_at FROM admin_metric_snapshots")
        .first<{ captured_at: string }>())!.captured_at;
      currentTime = refreshedAt + 40_001;
    });
    expect(await runScheduledMaintenance(bindings(observation), NOW + 3 * 3_600_000))
      .toMatchObject({ outcome: "success", lifecycleComplete: true });
    expect(metricsAtProbe).toEqual({ generatedAt: new Date(refreshedAt).toISOString(), capturedAt: new Date(refreshedAt).toISOString() });
    expect(observation.queries.filter(entry => entry.sql.includes("FROM admin_metrics_history_cache"))).toHaveLength(1);
    expect(observation.queries.filter(entry => entry.sql.includes("SELECT MAX(captured_at) AS captured_at FROM admin_metric_snapshots"))).toHaveLength(1);
    const logs = logSpy.mock.calls.map(([message]) => JSON.parse(String(message)) as { event: string });
    expect(logs).toContainEqual(expect.objectContaining({ event: "admin_metrics_history_cache", phase: "before_analysis",
      outcome: "success", code: "HISTORY_CACHE_REFRESHED", phaseQueries: 18, elapsedMs: 0, deadlineRemainingMs: 40_000 }));
    expect(logs).toContainEqual(expect.objectContaining({ event: "admin_metrics_snapshot", phase: "before_analysis",
      outcome: "success", code: "SNAPSHOT_CAPTURED", phaseQueries: 5 }));
    expect(inspection.rawFits).not.toHaveBeenCalled(); expect(inspection.rawModels).not.toHaveBeenCalled();
    assertMeter(observation); await released();
  });

  it.each([
    { minute: "even", offset: 0, expectedReads: 2 },
    { minute: "odd", offset: 60_000, expectedReads: 1 },
  ])("publishes missing inputs after promotion on $minute minutes, before daily reconciliation", async ({ offset, expectedReads }) => {
    await seedQuota(200); await queue();
    expect(await db().prepare("SELECT count(*) AS n FROM community_allowance_fit_cache").first()).toEqual({ n: 0 });
    expect(await db().prepare("SELECT count(*) AS n FROM admin_community_allowance_preview_cache").first()).toEqual({ n: 0 });
    const observation = observe();
    const scheduledAt = NOW + offset;
    expect(await runScheduledMaintenance(bindings(observation), scheduledAt))
      .toMatchObject({ outcome: "success", lifecycleComplete: true });
    const queries = observation.queries.map(entry => entry.sql);
    const previewReads = queries.flatMap((sql, index) => sql.includes("FROM admin_community_allowance_preview_cache") ? [index] : []);
    const cachePromotion = queries.findIndex(sql => sql.includes("INSERT INTO community_allowance_fit_cache"));
    const previewWrites = queries.flatMap((sql, index) => sql.includes("INSERT INTO admin_community_allowance_preview_cache") ? [index] : []);
    expect(previewReads).toHaveLength(expectedReads);
    expect(cachePromotion).toBeGreaterThan(0);
    if (expectedReads === 2) expect(cachePromotion).toBeGreaterThan(previewReads[0]!);
    expect(previewReads.at(-1)).toBeGreaterThan(cachePromotion);
    expect(previewWrites).toHaveLength(1);
    expect(previewWrites[0]).toBeGreaterThan(previewReads.at(-1)!);
    const dailyWrite = queries.findIndex(sql => sql.includes("INSERT INTO community_daily_aggregates"));
    expect(dailyWrite).toBeGreaterThan(previewWrites[0]!);
    for (const table of ["community_allowance_fit_cache", "community_model_composition_cache"])
      expect(await db().prepare(`SELECT count(*) AS n FROM ${table}`).first()).toEqual({ n: 1 });
    const preview = await db().prepare("SELECT generated_at, payload_json FROM admin_community_allowance_preview_cache WHERE singleton=1")
      .first<{ generated_at: string; payload_json: string }>();
    expect(preview?.generated_at).toBe(new Date(scheduledAt).toISOString());
    expect(validCachedAdminCommunityAllowancePreview(JSON.parse(preview!.payload_json), preview!.generated_at, scheduledAt)).toBe(true);
    expect(await db().prepare("SELECT count(*) AS n FROM community_daily_aggregate_rebuilds").first()).toEqual({ n: 0 });
    expect(inspection.rawFits).not.toHaveBeenCalled(); expect(inspection.rawModels).not.toHaveBeenCalled();
    assertMeter(observation); await released();
  });

  it("preserves 200-query graph headroom before the first historical projection backfill call", async () => {
    await seedQuota(200); await queue();
    await db().prepare("DELETE FROM telemetry_v1_quota_fit_rows").run();
    await db().prepare("UPDATE telemetry_v1_quota_fit_backfill SET last_record_id=0,through_record_id=(SELECT max(id) FROM telemetry_v1_records),is_complete=0").run();
    inspection.limit = 230;
    const observation = observe();
    expect(await runScheduledMaintenance(bindings(observation), NOW)).toMatchObject({ outcome: "success", lifecycleComplete: true });
    expect(inspection.backfill).not.toHaveBeenCalled();
    expect(await db().prepare("SELECT last_record_id,is_complete FROM telemetry_v1_quota_fit_backfill").first())
      .toEqual({ last_record_id: 0, is_complete: 0 });
    expect(inspection.rawFits).not.toHaveBeenCalled(); expect(inspection.rawModels).not.toHaveBeenCalled();
    assertMeter(observation); await released();
  });

  it("does not start optional reconstruction once required maintenance has consumed the deadline", async () => {
    await seedQuota(200); const queued = await queue();
    const started = Date.now(); let crossed = false;
    vi.spyOn(Date, "now").mockImplementation(() => started + (crossed ? 40_001 : 0));
    const observation = observe(async (entry, moment) => {
      if (moment === "after" && entry.sql.includes("FROM collection_controls")) crossed = true;
    });
    expect(await runScheduledMaintenance(bindings(observation), NOW)).toMatchObject({ outcome: "success", lifecycleComplete: true, aggregateRebuildComplete: false });
    expect(crossed).toBe(true); expect(inspection.backfill).not.toHaveBeenCalled();
    expect(observation.queries.some(entry => entry.sql.includes("community_analysis_work"))).toBe(false);
    expect((await db().prepare("SELECT * FROM community_daily_aggregate_rebuilds ORDER BY day").all()).results).toEqual(queued);
    assertMeter(observation); await released();
  });

  it("rejects cache promotion after lease replacement and never releases the successor's lease", async () => {
    await seedQuota(200); await queue(); let replaced = false;
    const successor = "synthetic-successor-lease";
    const expiresAt = new Date(Date.now() + 1_200_000).toISOString();
    const observation = observe(async (entry, moment) => {
      if (replaced || moment !== "before" || !entry.sql.includes("INSERT INTO community_allowance_fit_cache")) return;
      replaced = true;
      await db().prepare("UPDATE retention_state SET maintenance_lease_token=?,maintenance_lease_expires_at=? WHERE singleton=1")
        .bind(successor, expiresAt).run();
    });
    expect(await runScheduledMaintenance(bindings(observation), NOW)).toMatchObject({ outcome: "success", lifecycleComplete: true, aggregateRebuildComplete: false });
    expect(replaced).toBe(true); assertMeter(observation);
    for (const table of ["community_allowance_fit_cache", "community_model_composition_cache"])
      expect(await db().prepare(`SELECT count(*) AS n FROM ${table}`).first()).toEqual({ n: 0 });
    expect(await db().prepare("SELECT maintenance_lease_token,maintenance_lease_expires_at FROM retention_state WHERE singleton=1").first())
      .toEqual({ maintenance_lease_token: successor, maintenance_lease_expires_at: expiresAt });
    const next = observe();
    expect(await runScheduledMaintenance(bindings(next), NOW + 60_000)).toMatchObject({ code: "MAINTENANCE_IN_PROGRESS" });
    expect(next.queries).toHaveLength(1); expect(inspection.meter?.queriesUsed).toBe(1);
  });

  it("fences a source correction at final cache promotion and recovers with a new exact run", async () => {
    await seedQuota(200); await queue(); let corrected = false;
    const observation = observe(async (entry, moment) => {
      if (corrected || moment !== "before" || !entry.sql.includes("INSERT INTO community_allowance_fit_cache")) return;
      corrected = true;
      await db().prepare("UPDATE telemetry_v1_chunks SET chunk_digest=? WHERE id='scheduled-chunk-0'").bind("f".repeat(64)).run();
    });
    expect(await runScheduledMaintenance(bindings(observation), NOW)).toMatchObject({ outcome: "success", aggregateRebuildComplete: false });
    expect(corrected).toBe(true); assertMeter(observation); await released();
    const before = await db().prepare("SELECT run_id,input_revision FROM community_analysis_work WHERE participant_id=?").bind(PARTICIPANT).first();
    expect(before).not.toBeNull();
    for (const table of ["community_allowance_fit_cache", "community_model_composition_cache"])
      expect(await db().prepare(`SELECT count(*) AS n FROM ${table}`).first()).toEqual({ n: 0 });
    const next = observe(); await runScheduledMaintenance(bindings(next), NOW + 60_000);
    assertMeter(next); await released();
    const after = await db().prepare("SELECT run_id,input_revision,phase FROM community_analysis_work WHERE participant_id=?").bind(PARTICIPANT).first();
    expect(after?.run_id).not.toBe(before?.run_id);
    expect(after?.input_revision).toBeGreaterThan(before!.input_revision as number);
    expect(after?.phase).toBe("complete");
    for (const table of ["community_allowance_fit_cache", "community_model_composition_cache"])
      expect(await db().prepare(`SELECT count(*) AS n FROM ${table}`).first()).toEqual({ n: 1 });
    expect(inspection.rawFits).not.toHaveBeenCalled(); expect(inspection.rawModels).not.toHaveBeenCalled();
  });
});
