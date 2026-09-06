import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { warmCommunityModelHistory, COMMUNITY_MODEL_HISTORY_METHOD, MODEL_HISTORY_CENSUS_SQL } from "../src/community-model-history";
import { createD1InvocationBudget } from "../src/d1-invocation-budget";
import { COMMUNITY_ATTRIBUTION_METHOD_VERSION, validCompleteCachedComposition } from "../src/community-allowance";
import { MODEL_HISTORY_METHOD_VERSION, type V1ModelComposition } from "../src/quota-analysis-v1";
import { createV11DeviceFixture, makeV11Day, stageV11Day } from "./helpers/telemetry-v11";
import { MODEL_HISTORY_TEST_DAY, seedModelHistoryFixture, insertModelHistoryRecords, modelHistorySourceInput } from "./helpers/model-history";
import { createUploadAuthorizationMaterial, storeUploadAuthorization, claimUploadAuthorization } from "../src/session";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest } from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "../src/crypto";

const db = () => env.USAGE_MONITOR_DB;
const DAY = MODEL_HISTORY_TEST_DAY, NOW = Date.parse("2026-09-06T12:00:00.000Z");
const TIME = `${DAY}T12:00:00.000Z`, LEASE = "synthetic-model-history-lease";
const migrations = () => (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
type DeviceFixture = Awaited<ReturnType<typeof createV11DeviceFixture>>;

async function lease() {
  await db().prepare(`UPDATE retention_state SET maintenance_lease_token=?,
    maintenance_lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day') WHERE singleton=1`)
    .bind(LEASE).run();
}

beforeEach(async () => { await reset(); await applyD1Migrations(db(), migrations()); await lease(); });

/** Observes executed statements, including every batch member, while keeping
 * races outside the operation under test and away from any real database. */
function observed(hook?: (sql: string, moment: "before" | "after") => Promise<void>) {
  const queries: string[] = [], originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const texts = new WeakMap<D1PreparedStatement, string>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, { get(target, property) {
      if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
      if (["first", "all", "run", "raw"].includes(String(property))) return async (...args: unknown[]) => {
        queries.push(sql); await hook?.(sql, "before");
        const value: unknown = await Reflect.apply(Reflect.get(target, property), target, args);
        await hook?.(sql, "after"); return value;
      };
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    originals.set(proxy, statement); texts.set(proxy, sql); return proxy;
  };
  const database = new Proxy(db(), { get(target, property) {
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      const sql = statements.map(statement => texts.get(statement) ?? "");
      queries.push(...sql);
      for (const text of sql) await hook?.(text, "before");
      const value = await target.batch(statements.map(statement => originals.get(statement) ?? statement));
      for (const text of sql) await hook?.(text, "after");
      return value;
    };
    const value: unknown = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { database, queries };
}

async function warm(maxQueries = 900, observation = observed(), nowMs = NOW, deadlineMs = Date.now() + 30_000) {
  const meter = createD1InvocationBudget(maxQueries);
  const progress = await warmCommunityModelHistory(meter.wrap(observation.database), nowMs,
    { meter, deadlineMs, maintenanceLease: LEASE });
  expect(meter.queriesUsed).toBe(observation.queries.length);
  expect(meter.remainingQueries).toBeGreaterThanOrEqual(12);
  return { progress, meter, observation };
}

async function participant(participantId: string) {
  const fixture = await createV11DeviceFixture(db(), { participantId });
  await insertModelHistoryRecords(fixture, "minimum", [
    { stream: "quota", observedAt: TIME, usedPercent: 5, resetsAt: "2026-09-08T00:00:00.000Z" },
  ]);
  return fixture;
}

function ready(fingerprint: string, capacity = 1000): V1ModelComposition {
  // This is a synthetic terminal cache envelope, not a new calibration method.
  // The acquisition suite separately proves identifiable fits from raw rows.
  return { status: "ready", planType: "pro", fit: {
    status: "fitted", observationCount: 30, totalCostUsd: 120,
    modelCostShares: { "gpt-6-astra": 1 }, capacityUsdByModel: { "gpt-6-astra": capacity },
    singleConstantUsd: capacity, r2: 0.99, singleConstantR2: 0.5, solverConverged: true,
    identification: { adjustedR2: 0.98, singleConstantAdjustedR2: 0.4,
      splitHalfIdentified: true, splitHalfMaxCapacityDriftFraction: 0 },
  }, voidedBinCount: 0, poolCount: 1, quotaRowCount: 31, usageEventCount: 30,
  unpricedUsageEventCount: 0, poisonedBinCount: 0, latestQuotaObservedAt: TIME,
  attributionStatus: "legacy_conditional", attributionMethod: MODEL_HISTORY_METHOD_VERSION,
  inputFingerprint: fingerprint };
}

async function cache(participantId: string, capacity = 1000, value?: unknown) {
  const { sourcePin } = await modelHistorySourceInput(participantId, DAY);
  const result = value ?? ready(sourcePin.fingerprint, capacity);
  if (value === undefined) expect(validCompleteCachedComposition(result, sourcePin.fingerprint, MODEL_HISTORY_METHOD_VERSION)).toBe(true);
  await db().prepare(`INSERT INTO community_model_history_results
    (participant_id,day,input_revision,input_fingerprint,method_version,result_json,computed_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(participant_id,day) DO UPDATE SET
    input_revision=excluded.input_revision,input_fingerprint=excluded.input_fingerprint,
    method_version=excluded.method_version,result_json=excluded.result_json`)
    .bind(participantId, DAY, sourcePin.inputRevision, sourcePin.fingerprint,
      COMMUNITY_MODEL_HISTORY_METHOD, JSON.stringify(result), TIME).run();
  return sourcePin;
}

async function snapshot(day = DAY, history: string | null = COMMUNITY_MODEL_HISTORY_METHOD, payload = "{}") {
  await db().prepare(`INSERT INTO community_model_composition_days
    (day,payload_json,computed_at,attribution_method_version,source_mutation_epoch,history_method_version)
    VALUES(?,?,?, ?, (SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1), ?)`)
    .bind(day, payload, TIME, COMMUNITY_ATTRIBUTION_METHOD_VERSION, history).run();
}

async function dayRow(day = DAY) {
  return db().prepare("SELECT * FROM community_model_composition_days WHERE day=?").bind(day)
    .first<{ day: string; payload_json: string; history_method_version: string | null }>();
}

async function seedCurrentCaches(participantId: string) {
  await db().batch([
    db().prepare(`INSERT INTO community_allowance_fit_cache(participant_id,cache_key,fits_json,computed_at)
      VALUES(?,'synthetic-current','[]',?)`).bind(participantId, TIME),
    db().prepare(`INSERT INTO community_model_composition_cache(participant_id,cache_key,composition_json,computed_at)
      VALUES(?,'synthetic-current','{}',?)`).bind(participantId, TIME),
    db().prepare(`INSERT INTO admin_community_allowance_preview_cache(singleton,generated_at,payload_json)
      VALUES(1,?,'{"synthetic":"retained-preview"}')`).bind(TIME),
  ]);
}

async function currentCaches() {
  const tables = ["community_allowance_fit_cache", "community_model_composition_cache", "admin_community_allowance_preview_cache"] as const;
  return Promise.all(tables.map(async table => (await db().prepare(`SELECT * FROM ${table}`).all()).results));
}

async function legacy(fixture: DeviceFixture) {
  await db().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE format_rank=2").run();
  const authorization = await createUploadAuthorizationMaterial(fixture.participantId, fixture.sessionId, "b".repeat(64), 1);
  await storeUploadAuthorization(db(), authorization);
  const claimed = await claimUploadAuthorization(db(), `Upload ${authorization.encoded}`,
    { envelopeDigest: "b".repeat(64), bodyBytes: 1, contentType: "application/json" });
  await db().prepare(`INSERT INTO telemetry_contributions(id,participant_id,plaintext_digest,envelope_digest,r2_key,status,
    schema_version,transport_schema_version,range_start,range_end,client_platform,provider_policy_epoch,
    estimated_api_cost_usd,priced_event_coverage_percent,unknown_model_event_count,unknown_billable_units,
    price_basis,declared_record_count,created_at,upload_authorization_id)
    VALUES(?,?,?,?,?,'accepted','telemetry-contribution-v0.1','telemetry-contribution-v0.2',?,?,'macos','unknown',
      NULL,0,0,0,'unavailable',0,?,?)`)
    .bind(`legacy:${fixture.participantId}`, fixture.participantId, "a".repeat(64), "b".repeat(64),
      `synthetic/model-history/legacy/${fixture.participantId}`, TIME, `${DAY}T23:59:59.999Z`, TIME, claimed.authorizationId).run();
}

async function successor(fixture: DeviceFixture) {
  const day = new Date().toISOString().slice(0, 10);
  const staged = await stageV11Day(db(), fixture, await makeV11Day(day, {}));
  const predecessor = await createTelemetryV11DomainPredecessor(db(), fixture);
  const manifest: TelemetryV11DomainManifest = { schemaVersion: "telemetry-domain-manifest-v1.1", fromDay: day, throughDay: day,
    predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint },
    days: [{ day, manifestId: staged.manifestId, manifestDigest: staged.manifestDigest }], manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  await activateTelemetryV11Domain(db(), fixture, manifest);
}

describe("historical model warmer and retrospective publication", () => {
  it("refuses the pre-0048 schema without touching current caches or their forward snapshot", async () => {
    await reset(); await applyD1Migrations(db(), migrations().filter(migration => Number(migration.name.slice(0, 4)) < 48));
    await lease(); await createV11DeviceFixture(db(), { participantId: "history-pre-migration" });
    await seedCurrentCaches("history-pre-migration");
    await db().prepare(`INSERT INTO community_model_composition_days
      (day,payload_json,computed_at,attribution_method_version,source_mutation_epoch)
      VALUES(?,'{"synthetic":"pre-migration-forward"}',?,?,0)`)
      .bind(DAY, TIME, COMMUNITY_ATTRIBUTION_METHOD_VERSION).run();
    const forward = await dayRow();
    const before = await currentCaches();
    const run = await warm();
    expect(run.progress).toEqual({ status: "unavailable", day: null, requiredAccounts: 0, resolvedAccounts: 0, publishedDays: 0 });
    expect(run.observation.queries).toHaveLength(1);
    expect(await currentCaches()).toEqual(before);
    expect(await dayRow()).toEqual(forward);
  });

  it("admits the shared query reserve and deadline before issuing any SQL", async () => {
    for (const [limit, deadline] of [[15, Date.now() + 30_000], [900, Date.now() - 1]]) {
      const run = await warm(limit, observed(), NOW, deadline);
      expect(run.progress).toEqual({ status: "deferred", day: null, requiredAccounts: 0, resolvedAccounts: 0, publishedDays: 0 });
      expect(run.observation.queries).toEqual([]);
    }
  });

  it("never publishes a partial account median and later publishes the complete cohort", async () => {
    await participant("history-a"); await participant("history-b");
    await cache("history-a", 1000);
    const partial = await warm(40);
    expect(partial.progress).toEqual({ status: "deferred", day: DAY, requiredAccounts: 2, resolvedAccounts: 1, publishedDays: 0 });
    expect(await dayRow()).toBeNull();
    await cache("history-b", 3000);
    const complete = await warm(40);
    expect(complete.progress).toMatchObject({ day: DAY, requiredAccounts: 2, resolvedAccounts: 2, publishedDays: 1 });
    const row = await dayRow();
    expect(row?.history_method_version).toBe(COMMUNITY_MODEL_HISTORY_METHOD);
    expect(JSON.parse(row!.payload_json)).toMatchObject({ values: [["gpt-6-astra", 2000, 2]], fittedParticipantCount: 2 });
    expect(complete.observation.queries.some(sql => sql.includes("telemetry_v1_records"))).toBe(false);
    expect(row!.payload_json).not.toContain("history-a");
    expect(row!.payload_json).not.toContain("history-b");
  });

  it("defers an incomplete physical census rather than treating its prefix as an empty cohort", async () => {
    await db().prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1025)
      INSERT INTO participants(id,access_token_id,access_token_hash,recovery_token_id,recovery_token_hash,
        state,consent_version,consented_at,created_at)
      SELECT 'history-census-'||printf('%04d',x),'access-'||x,zeroblob(32),'recovery-'||x,zeroblob(32),
        'active','privacy-safe-telemetry-v0.1',?,? FROM n`).bind(TIME, TIME).run();
    const run = await warm(40);
    expect(run.progress).toEqual({ status: "deferred", day: DAY, requiredAccounts: 0, resolvedAccounts: 0, publishedDays: 0 });
    expect(run.observation.queries.filter(sql => sql === MODEL_HISTORY_CENSUS_SQL)).toHaveLength(16);
    expect(await dayRow()).toBeNull();
  });

  it("preserves a current-method forward snapshot, including a writer racing historical publication", async () => {
    await participant("history-forward"); await cache("history-forward");
    await seedCurrentCaches("history-forward");
    const before = await currentCaches();
    let inserted = false;
    const run = await warm(40, observed(async (sql, moment) => {
      if (!inserted && moment === "before" && sql.includes("INSERT INTO community_model_composition_days")) {
        inserted = true; await snapshot(DAY, null, '{"synthetic":"forward-snapshot"}');
      }
    }));
    expect(inserted).toBe(true); expect(run.progress.publishedDays).toBe(0);
    expect(await dayRow()).toMatchObject({ payload_json: '{"synthetic":"forward-snapshot"}', history_method_version: null });
    expect(await currentCaches()).toEqual(before);
    expect((await warm(40)).progress.day).toBe("2026-09-04");
    expect(await dayRow()).toMatchObject({ payload_json: '{"synthetic":"forward-snapshot"}', history_method_version: null });
  });

  it("resumes an acquisition-only pass and publishes only after the finished result is reread", async () => {
    const fixture = await seedModelHistoryFixture({ participantId: "history-resumable" });
    await seedCurrentCaches(fixture.participantId);
    const before = await currentCaches();
    const first = await warm(100);
    expect(first.progress).toMatchObject({ day: DAY, requiredAccounts: 1, resolvedAccounts: 0, publishedDays: 0 });
    const saved = await db().prepare("SELECT run_id,phase,progress_revision FROM community_model_history_work").first<{
      run_id: string; phase: string; progress_revision: number;
    }>();
    expect(saved).not.toBeNull(); expect(saved!.progress_revision).toBeGreaterThan(0);
    expect(await currentCaches()).toEqual(before);
    expect(await dayRow()).toBeNull();
    const second = await warm();
    expect(second.progress).toMatchObject({ day: DAY, requiredAccounts: 1, resolvedAccounts: 1, publishedDays: 0 });
    expect(await db().prepare("SELECT run_id,phase FROM community_model_history_work").first())
      .toEqual({ run_id: saved!.run_id, phase: "complete" });
    expect(await dayRow()).toBeNull();
    const third = await warm(40);
    expect(third.progress.publishedDays).toBe(1);
    const payload = JSON.parse((await dayRow())!.payload_json);
    expect(payload.fittedParticipantCount).toBe(1);
    expect(payload.values.map((value: [string, number, number]) => value[0])).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
    expect((await currentCaches()).slice(0, 2)).toEqual(before.slice(0, 2));
    expect(await db().prepare("SELECT count(*) AS n FROM community_analysis_work").first()).toEqual({ n: 0 });
  });

  it.each(["source", "lease", "expiry"] as const)("fences a %s race before whole-day publication", async action => {
    await participant("history-race"); await cache("history-race");
    await seedCurrentCaches("history-race");
    const before = await currentCaches();
    let raced = false;
    const run = await warm(40, observed(async (sql, moment) => {
      if (!raced && moment === "before" && sql.includes("INSERT INTO community_model_composition_days")) {
        raced = true;
        if (action === "source") await db().prepare("UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1").run();
        if (action === "lease") await db().prepare("UPDATE retention_state SET maintenance_lease_token='synthetic-new-owner' WHERE singleton=1").run();
        if (action === "expiry") await db().prepare("UPDATE retention_state SET maintenance_lease_expires_at='2000-01-01T00:00:00.000Z' WHERE singleton=1").run();
      }
    }));
    expect(raced).toBe(true); expect(run.progress.publishedDays).toBe(0);
    expect(await dayRow()).toBeNull();
    // 0043 invalidates the preview in the mutation transaction itself. A
    // losing history writer must not refill that invalidated preview.
    expect(await currentCaches()).toEqual(action === "source" ? [before[0], before[1], []] : before);
  });

  it.each(["source", "lease"] as const)("fences a %s race at individual historical result promotion", async action => {
    const fixture = await seedModelHistoryFixture({ participantId: "history-result-race" });
    let raced = false;
    const run = await warm(900, observed(async (sql, moment) => {
      if (!raced && moment === "before" && sql.includes("INSERT INTO community_model_history_results")) {
        raced = true;
        if (action === "source") await db().prepare("UPDATE telemetry_v1_chunks SET parser_version='synthetic-corrected' WHERE participant_id=?")
          .bind(fixture.participantId).run();
        else await db().prepare("UPDATE retention_state SET maintenance_lease_token='synthetic-new-owner' WHERE singleton=1").run();
      }
    }));
    expect(raced).toBe(true);
    expect(run.progress).toMatchObject({ requiredAccounts: 1, resolvedAccounts: 0, publishedDays: 0 });
    expect(await db().prepare("SELECT count(*) AS n FROM community_model_history_results").first()).toEqual({ n: 0 });
    expect(await dayRow()).toBeNull();
  });

  it("keeps unsupported legacy and successor sources explicit without initiating a v1 downgrade", async () => {
    await participant("history-supported"); await cache("history-supported");
    await legacy(await createV11DeviceFixture(db(), { participantId: "history-legacy" }));
    await successor(await createV11DeviceFixture(db(), { participantId: "history-successor", grant: true }));
    const run = await warm(40);
    expect(run.progress).toMatchObject({ requiredAccounts: 1, resolvedAccounts: 1, publishedDays: 1 });
    expect(JSON.parse((await dayRow())!.payload_json)).toMatchObject({ v1ParticipantCount: 1,
      unsupportedSourceParticipantCount: 2, fittedParticipantCount: 1, refusedParticipantCount: 0 });
    expect(run.observation.queries.some(sql => sql.includes("telemetry_v1_records"))).toBe(false);
    expect(await db().prepare("SELECT count(*) AS n FROM community_model_history_work").first()).toEqual({ n: 0 });
  });

  it("does not admit malformed, stale or unfinished terminal envelopes as a resolved account", async () => {
    await participant("history-malformed");
    const pin = await cache("history-malformed"), base = ready(pin.fingerprint);
    for (const value of [
      { status: "deferred" }, { status: "not_testable", reason: "INTERNAL_ERROR" },
      { status: "not_testable", reason: "multi_plan_window_unsupported", extra: "not-allowlisted" },
      { ...base, inputFingerprint: "e".repeat(64) }, { ...base, attributionMethod: "old-method" },
      { ...base, quotaRowCount: 60_001 }, { ...base, fit: {} },
      { ...base, fit: { ...base.fit, capacityUsdByModel: { "gpt-6-astra": -1 } } },
    ]) {
      await cache("history-malformed", 1000, value);
      const run = await warm(40);
      expect(run.progress).toMatchObject({ requiredAccounts: 1, resolvedAccounts: 0, publishedDays: 0 });
      expect(await dayRow()).toBeNull();
    }
    for (const [column, value] of [["input_revision", pin.inputRevision! - 1], ["method_version", "obsolete-history-method"]] as const) {
      await cache("history-malformed");
      await db().prepare(`UPDATE community_model_history_results SET ${column}=? WHERE participant_id='history-malformed'`).bind(value).run();
      expect((await warm(40)).progress).toMatchObject({ requiredAccounts: 1, resolvedAccounts: 0, publishedDays: 0 });
      expect(await dayRow()).toBeNull();
    }
    await cache("history-malformed", 1000, { status: "not_testable", reason: "multi_plan_window_unsupported" });
    const refused = await warm(40);
    expect(refused.progress).toMatchObject({ requiredAccounts: 1, resolvedAccounts: 1, publishedDays: 1 });
    expect(JSON.parse((await dayRow())!.payload_json)).toMatchObject({ values: [], fittedParticipantCount: 0, refusedParticipantCount: 1 });
  });

  it("rejects an otherwise valid result whose newest quota reading is beyond the closed day", async () => {
    await participant("history-future"); const pin = await cache("history-future");
    await cache("history-future", 1000, { ...ready(pin.fingerprint), latestQuotaObservedAt: "2026-09-06T00:00:00.000Z" });
    const run = await warm(40);
    expect(run.progress.status).toBe("unavailable"); expect(run.progress.publishedDays).toBe(0);
    expect(await dayRow()).toBeNull();
  });

  it("invalidates only retrospective days whose input range includes a correction and preserves earlier days for future uploads", async () => {
    const fixture = await participant("history-correction");
    const days = ["2026-09-04", DAY, "2026-12-14", "2026-12-15"];
    for (const day of days) await snapshot(day);
    await snapshot("2026-09-07", null, '{"synthetic":"forward-snapshot"}');
    await db().prepare("UPDATE telemetry_v1_chunks SET chunk_digest=? WHERE participant_id=?")
      .bind("c".repeat(64), fixture.participantId).run();
    expect((await db().prepare("SELECT day FROM community_model_composition_days ORDER BY day").all()).results)
      .toEqual([{ day: "2026-09-04" }, { day: "2026-09-07" }, { day: "2026-12-15" }]);
    await snapshot(DAY);
    await insertModelHistoryRecords(fixture, "future", [{ stream: "quota", observedAt: "2026-09-06T12:00:00.000Z",
      usedPercent: 6, resetsAt: "2026-09-08T00:00:00.000Z" }]);
    expect(await dayRow()).not.toBeNull();
    expect(await dayRow("2026-09-04")).not.toBeNull();
    expect(await dayRow("2026-09-07")).toMatchObject({ history_method_version: null });
  });

  it.each(["withdrawal", "erasure"] as const)("removes historical results and checkpoints after participant %s", async action => {
    const fixture = await seedModelHistoryFixture({ participantId: "history-withdrawal" });
    await warm(100);
    expect(await db().prepare("SELECT count(*) AS n FROM community_model_history_work").first()).toEqual({ n: 1 });
    expect((await db().prepare("SELECT count(*) AS n FROM community_model_history_work_parts").first<{ n: number }>())!.n).toBeGreaterThan(0);
    await cache(fixture.participantId); await snapshot(); await seedCurrentCaches(fixture.participantId);
    if (action === "withdrawal") await db().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(fixture.participantId).run();
    else await db().prepare("DELETE FROM participants WHERE id=?").bind(fixture.participantId).run();
    for (const table of ["community_model_history_results", "community_model_history_work",
      "community_model_history_work_parts", "community_model_history_work_stage", "community_model_composition_days"] as const) {
      expect(await db().prepare(`SELECT count(*) AS n FROM ${table}`).first()).toEqual({ n: 0 });
    }
    expect(await db().prepare("SELECT count(*) AS n FROM admin_community_allowance_preview_cache").first()).toEqual({ n: 0 });
  });
});
