import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { advanceCommunityAnalysisRun, communityAnalysisAcquisitionIdentity } from "../src/community-analysis-runner";
import { beginCommunityAnalysisWork, commitCommunityAnalysisWorkPage, readCommunityAnalysisWork,
  type CommunityAnalysisWorkIdentity, type CommunityAnalysisWorkBudget } from "../src/community-analysis-work";
import { advanceV1QuotaAcquisition, createV1QuotaAcquisitionCheckpoint, encodeV1QuotaWorkCheckpoint } from "../src/quota-analysis-v1-reader";
import { createV1QuotaPageReader, V1_PLAN_QUOTA_PAGE_SQL, V1_FIT_QUOTA_PAGE_SQL } from "../src/quota-fit-projection";
import { loadV1SourcePin } from "../src/telemetry-v1-source-selection";
import { createV11DeviceFixture, makeV11Day, stageV11Day } from "./helpers/telemetry-v11";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest } from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "../src/crypto";

const db = () => env.USAGE_MONITOR_DB;
const PARTICIPANT = "synthetic-runner-participant";
const TIME = "2026-08-01T00:00:00.000Z", RESET = "2026-08-08T00:00:00.000Z";
const budget = (remainingQueries = 1000, reserveQueries = 0): CommunityAnalysisWorkBudget =>
  ({ remainingQueries, reserveQueries, deadlineMs: 100, now: () => 0 });
beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

async function seed(count = 1200) {
  const fixture = await createV11DeviceFixture(db(), { participantId: PARTICIPANT });
  const principal = await authenticateDevice(db(), fixture.authorization);
  for (let offset = 0; offset < count; offset += 200) {
    const digest = (offset + 1).toString(16).padStart(64, "0");
    const upload = await createDeviceUploadAuthorization(db(), principal, digest, 200);
    const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`,
      { envelopeDigest: digest, bodyBytes: 200, contentType: "application/json" });
    await db().prepare(`INSERT INTO telemetry_v1_chunks (id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,
      chunk_digest,envelope_digest,parser_version,record_count,accepted_record_count,r2_key,device_upload_authorization_id,created_at)
      VALUES (?,?,?,'quota','2026-08-01',?,1,?,?,'synthetic-runner',?,?,?,?,?)`)
      .bind(`runner-chunk-${offset}`, PARTICIPANT, fixture.deviceId, offset / 200, digest, digest,
        Math.min(200, count - offset), Math.min(200, count - offset), `synthetic/runner/${offset}`, claimed.authorizationId, TIME).run();
  }
  await db().prepare(`WITH RECURSIVE s(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM s WHERE n < ?)
    INSERT INTO telemetry_v1_records(chunk_row_id,participant_id,device_id,stream,occurrence_id,observed_at,observed_day,
      provider,plan_type,plan_variant,limit_id,slot,used_percent,window_duration_minutes,resets_at,record_json)
    SELECT 'runner-chunk-'||(CAST((n-1)/200 AS INTEGER)*200),?,?,'quota','synthetic-q-'||n,
      strftime('%Y-%m-%dT%H:%M:%fZ',?,'+'||n||' seconds'),'2026-08-01','openai_codex','pro','unknown',
      'codex','seven_day',CAST((n-1)/20 AS INTEGER)%100,10080,?,'{}' FROM s`)
    .bind(count, PARTICIPANT, fixture.deviceId, TIME, RESET).run();
  return { fixture, ...await source() };
}
async function source(patch: Partial<CommunityAnalysisWorkIdentity> = {}) {
  const pin = await loadV1SourcePin(db(), { participantId: PARTICIPANT, fromDay: (patch.observedAtCutoff ?? TIME).slice(0, 10) });
  if (pin.inputRevision === null) throw new Error("synthetic input revision missing");
  const identity: CommunityAnalysisWorkIdentity = { participantId: PARTICIPANT, inputRevision: pin.inputRevision,
    inputFingerprint: pin.fingerprint, sourceKind: "v1", sourceMethodVersion: "synthetic-runner:1",
    fixedNow: "2026-09-01T00:00:00.000Z", observedAtCutoff: TIME, resetsAtCutoff: RESET,
    windowMinutes: 10080, maxQuotaRows: 60000, ...patch };
  return { identity, sourcePin: pin };
}

function meter(hook?: (sql: string, moment: "before" | "after") => Promise<void>) {
  const queries: string[] = [], originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const texts = new WeakMap<D1PreparedStatement, string>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, { get(target, property) {
      if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
      if (["first", "all", "run", "raw"].includes(String(property))) return async (...args: unknown[]) => {
        queries.push(sql); await hook?.(sql, "before");
        const result: unknown = await Reflect.apply(Reflect.get(target, property), target, args);
        await hook?.(sql, "after"); return result;
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
      const result = await target.batch(statements.map(statement => originals.get(statement) ?? statement));
      for (const text of sql) await hook?.(text, "after");
      return result;
    };
    const value: unknown = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { database, queries, raw: () => queries.filter(sql => sql === V1_PLAN_QUOTA_PAGE_SQL || sql === V1_FIT_QUOTA_PAGE_SQL) };
}

async function finish(input: Awaited<ReturnType<typeof source>>, queries = 48) {
  let priorProgress = -1;
  for (let invocation = 0; invocation < 100; invocation++) {
    const b = budget(queries, 3), measured = meter();
    const result = await advanceCommunityAnalysisRun(measured.database, { ...input, budget: b });
    expect(measured.queries.length).toBeLessThanOrEqual(queries - b.remainingQueries);
    expect(b.remainingQueries).toBeGreaterThanOrEqual(3);
    if (result.status === "ready") return result;
    expect(result).toEqual({ status: "deferred" });
    const stored = await readCommunityAnalysisWork(db(), input.identity, budget());
    if (stored.status === "ready") {
      expect(stored.head.progressRevision).toBeGreaterThanOrEqual(priorProgress);
      priorProgress = stored.head.progressRevision;
    }
  }
  throw new Error("synthetic reconstruction did not finish");
}

describe("bounded community acquisition coordinator", () => {
  it("resumes interrupted runs, preserves exact completed evidence, and never rereads raw quota after completion", async () => {
    const input = await seed(2050);
    const reader = await createV1QuotaPageReader(db(), PARTICIPANT);
    const expected = await advanceV1QuotaAcquisition(reader, communityAnalysisAcquisitionIdentity(input.identity),
      new Map(input.sourcePin.winners.map(winner => [winner.observed_day, winner.device_id])), budget());
    if (expected.status !== "complete") throw new Error("expected full reference");
    const first = await advanceCommunityAnalysisRun(db(), { ...input, budget: budget(10) });
    expect(first).toEqual({ status: "deferred" });
    expect(await db().prepare("SELECT count(*) AS n FROM community_analysis_work_stage").first()).toEqual({ n: 1 });
    const result = await finish(input);
    expect(result.evidence.acquisition.quotaRows).toEqual(expected.quotaRows);
    expect(result.evidence.acquisition.planAnchors).toEqual(expected.planAnchors);
    expect(result.evidence.acquisition.quotaRows.length).toBeGreaterThan(0);
    const measured = meter();
    expect(await advanceCommunityAnalysisRun(measured.database, { ...input, budget: budget() })).toEqual(result);
    expect(measured.raw()).toEqual([]);
    expect(measured.queries.some(sql => sql.includes("FROM telemetry_v1_quota_fit_backfill"))).toBe(false);
    expect(await db().prepare("SELECT count(*) AS n FROM community_analysis_work_stage").first()).toEqual({ n: 0 });
    expect(JSON.stringify(result.evidence)).not.toContain("attributionIndex");
    expect(JSON.stringify(result.evidence)).not.toContain(input.fixture.deviceId);
  });

  it("uses one externally shared allocation across invocations and refuses spent/deadline budgets before work", async () => {
    const input = await seed(200), measured = meter(), b = budget(12, 3);
    expect(await advanceCommunityAnalysisRun(measured.database, { ...input, budget: b })).toEqual({ status: "deferred" });
    const before = measured.queries.length;
    expect(await advanceCommunityAnalysisRun(measured.database, { ...input, budget: b })).toEqual({ status: "deferred" });
    expect(measured.queries.length - before).toBeLessThanOrEqual(12 - 3 - before);
    expect(b.remainingQueries).toBeGreaterThanOrEqual(3);
    const exhausted = meter();
    expect(await advanceCommunityAnalysisRun(exhausted.database, { ...input, budget: budget(3, 3) })).toEqual({ status: "deferred" });
    expect(await advanceCommunityAnalysisRun(exhausted.database, { ...input, budget: { ...budget(), now: () => 100 } })).toEqual({ status: "deferred" });
    expect(exhausted.queries).toEqual([]);
  });

  it("admits a completed head's follow-on reserve before reading parts without charging unexecuted work", async () => {
    const input = await seed(200), expected = await finish(input);
    const required = 4 + 3 * Math.ceil(expected.head.manifest.length / 8) + 3 + 407;
    const insufficient = meter(), short = budget(required - 1);
    expect(await advanceCommunityAnalysisRun(insufficient.database,
      { ...input, budget: short, completedEvidenceReserveQueries: 407 })).toEqual({ status: "deferred" });
    expect(insufficient.queries).toHaveLength(4);
    expect(insufficient.queries.some(sql => sql.includes("FROM wanted w JOIN community_analysis_work_parts"))).toBe(false);
    const admitted = meter(), exact = budget(required);
    expect(await advanceCommunityAnalysisRun(admitted.database,
      { ...input, budget: exact, completedEvidenceReserveQueries: 407 })).toEqual(expected);
    expect(exact.remainingQueries).toBe(407);
    expect(admitted.queries.length).toBe(required - 407);
    expect(admitted.raw()).toEqual([]);
    const zero = budget(required - 407);
    expect(await advanceCommunityAnalysisRun(db(), { ...input, budget: zero, completedEvidenceReserveQueries: 0 })).toEqual(expected);
    expect(zero.remainingQueries).toBe(0);
  });

  it("validates completed-head reserves before SQL and does not reserve follow-on work during acquisition", async () => {
    const input = await seed(1200), invalid = meter();
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "407"]) {
      await expect(advanceCommunityAnalysisRun(invalid.database,
        { ...input, budget: budget(), completedEvidenceReserveQueries: value as number })).rejects.toThrow("completed reserve invalid");
    }
    expect(invalid.queries).toEqual([]);
    expect(await advanceCommunityAnalysisRun(db(),
      { ...input, budget: budget(18), completedEvidenceReserveQueries: 407 })).toEqual({ status: "deferred" });
    const saved = await readCommunityAnalysisWork(db(), input.identity, budget());
    expect(saved.status).toBe("ready");
    if (saved.status !== "ready") throw new Error("expected durable acquisition");
    expect(saved.head.progressRevision).toBeGreaterThan(0);
  });

  it("retains the last durable page on a hard deadline crossing and replays the uncommitted page", async () => {
    const input = await seed(2050);
    let now = 0, raw = 0;
    const measured = meter(async (sql, moment) => {
      if (moment === "after" && (sql === V1_PLAN_QUOTA_PAGE_SQL || sql === V1_FIT_QUOTA_PAGE_SQL) && ++raw === 2) now = 100;
    });
    expect(await advanceCommunityAnalysisRun(measured.database, { ...input, budget: { ...budget(), now: () => now } })).toEqual({ status: "deferred" });
    const saved = await readCommunityAnalysisWork(db(), input.identity, budget());
    expect(saved).toMatchObject({ status: "ready", head: { progressRevision: 1, phase: "plan" } });
    expect((await finish(input)).evidence.acquisition.quotaRows.length).toBeGreaterThan(0);
  });

  it("does not issue an uncharged readiness query when the deadline expires between admission and debit", async () => {
    const input = await seed(200);
    let afterStageRead = false, clockChecks = 0;
    const measured = meter(async (sql, moment) => {
      if (moment === "after" && sql.includes("FROM community_analysis_work_stage s JOIN")) afterStageRead = true;
    });
    const b = { ...budget(), now: () => afterStageRead && ++clockChecks >= 3 ? 100 : 0 };
    expect(await advanceCommunityAnalysisRun(measured.database, { ...input, budget: b })).toEqual({ status: "deferred" });
    expect(clockChecks).toBe(3);
    expect(measured.queries.length).toBe(1000 - b.remainingQueries);
    expect(measured.queries.some(sql => sql.includes("FROM telemetry_v1_quota_fit_backfill"))).toBe(false);
    expect(measured.raw()).toEqual([]);
  });

  it("fences a correction during acquisition and disposes stale work in bounded steps before restarting", async () => {
    const input = await seed(1200);
    let corrected = false;
    const measured = meter(async (sql, moment) => {
      if (!corrected && moment === "after" && sql === V1_PLAN_QUOTA_PAGE_SQL) {
        corrected = true;
        await db().prepare("UPDATE telemetry_v1_chunks SET chunk_digest=? WHERE id='runner-chunk-0'").bind("e".repeat(64)).run();
      }
    });
    expect(await advanceCommunityAnalysisRun(measured.database, { ...input, budget: budget() })).toEqual({ status: "stale" });
    const next = await source();
    expect(next.identity.inputRevision).toBeGreaterThan(input.identity.inputRevision);
    expect((await finish(next)).evidence.acquisition.quotaRows.length).toBeGreaterThan(0);
    expect(await advanceCommunityAnalysisRun(db(), { ...input, budget: budget() })).toEqual({ status: "stale" });
  });

  it("refuses incomplete projection and corrupt checkpoint state without substituting empty evidence", async () => {
    const input = await seed(200);
    await db().prepare("UPDATE telemetry_v1_quota_fit_backfill SET is_complete=0").run();
    expect(await advanceCommunityAnalysisRun(db(), { ...input, budget: budget() })).toEqual({ status: "projection_unavailable" });
    expect(await db().prepare("SELECT is_complete FROM telemetry_v1_quota_fit_backfill").first()).toEqual({ is_complete: 0 });
    await db().prepare("UPDATE telemetry_v1_quota_fit_backfill SET is_complete=1").run();
    await finish(input);
    await db().prepare("DELETE FROM community_analysis_work_parts").run();
    const measured = meter();
    expect(await advanceCommunityAnalysisRun(measured.database, { ...input, budget: budget() })).toEqual({ status: "corrupt" });
    expect(measured.raw()).toEqual([]);
  });

  it("returns a current explicit analytical refusal without partial completed evidence", async () => {
    const seeded = await seed(200), input = { ...seeded, identity: { ...seeded.identity, maxQuotaRows: 1 } };
    const result = await advanceCommunityAnalysisRun(db(), { ...input, budget: budget() });
    expect(result).toEqual({ status: "not_testable", reason: "downsampled_quota_limit_exceeded" });
    expect(Object.hasOwn(result, "evidence")).toBe(false);
    expect(await readCommunityAnalysisWork(db(), input.identity, budget())).toMatchObject({
      status: "ready", head: { phase: "fitability" },
    });
  });

  it("rolls back a failed small-page commit and resumes without rereading a corrupt partial checkpoint", async () => {
    const input = await seed(200);
    await db().prepare(`CREATE TRIGGER synthetic_runner_crash BEFORE UPDATE ON community_analysis_work
      BEGIN SELECT RAISE(ABORT,'synthetic runner interruption'); END`).run();
    await expect(advanceCommunityAnalysisRun(db(), { ...input, budget: budget() })).rejects.toThrow("synthetic runner interruption");
    expect(await readCommunityAnalysisWork(db(), input.identity, budget())).toMatchObject({
      status: "ready", head: { phase: "plan", progressRevision: 0, manifest: [] },
    });
    expect(await db().prepare("SELECT count(*) AS n FROM community_analysis_work_parts").first()).toEqual({ n: 0 });
    await db().prepare("DROP TRIGGER synthetic_runner_crash").run();
    expect((await finish(input)).evidence.acquisition.quotaRows.length).toBeGreaterThan(0);
  });

  it("ignores unrelated global publication epochs while preserving the participant source pin", async () => {
    const input = await seed(200), first = await finish(input);
    await createV11DeviceFixture(db(), { participantId: "synthetic-unrelated-runner" });
    await db().prepare("UPDATE participants SET state='deleting' WHERE id='synthetic-unrelated-runner'").run();
    await db().prepare("UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1").run();
    expect(await advanceCommunityAnalysisRun(db(), { ...input, budget: budget() })).toEqual(first);
  });

  it("rebuilds a changed method at the same source revision but rejects clock-only invalidation", async () => {
    const input = await seed(200), before = await finish(input);
    expect(await advanceCommunityAnalysisRun(db(), { ...input,
      identity: { ...input.identity, fixedNow: "2026-09-02T00:00:00.000Z" }, budget: budget() })).toEqual({ status: "stale" });
    const replacement = { ...input, identity: { ...input.identity, sourceMethodVersion: "synthetic-runner:2" } };
    const after = await finish(replacement, 100);
    expect(after.head.runId).not.toBe(before.head.runId);
    expect(after.evidence.acquisition).toEqual(before.evidence.acquisition);
  });

  it("rejects completed evidence after real successor activation or owner erasure", async () => {
    // A genuinely empty canonical source isolates activation from any preceding
    // correction/transfer. Nonempty reconstruction is covered above.
    const fixture = await createV11DeviceFixture(db(), { participantId: PARTICIPANT, grant: true });
    const input = await source();
    await finish(input);
    const day = new Date().toISOString().slice(0, 10);
    const staged = await stageV11Day(db(), fixture, await makeV11Day(day, {}));
    const prior = await createTelemetryV11DomainPredecessor(db(), fixture);
    const manifest: TelemetryV11DomainManifest = { schemaVersion: "telemetry-domain-manifest-v1.1", fromDay: day, throughDay: day,
      predecessor: { token: prior.token, previousGenerationId: prior.previousGenerationId, legacyFingerprint: prior.legacyFingerprint },
      days: [{ day, manifestId: staged.manifestId, manifestDigest: staged.manifestDigest }], manifestDigest: "0".repeat(64) };
    manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
    await activateTelemetryV11Domain(db(), fixture, manifest);
    expect(await advanceCommunityAnalysisRun(db(), { ...input, budget: budget() })).toEqual({ status: "stale" });
    await db().prepare("DELETE FROM participants WHERE id=?").bind(PARTICIPANT).run();
    expect(await advanceCommunityAnalysisRun(db(), { ...input, budget: budget() })).toEqual({ status: "stale" });
    expect(await db().prepare("SELECT count(*) AS n FROM community_analysis_work").first()).toEqual({ n: 0 });
  });

  it("resumes a preexisting large phase transition and drains bounded immutable-part cleanup", async () => {
    const input = await seed(1), state = createV1QuotaAcquisitionCheckpoint(communityAnalysisAcquisitionIdentity(input.identity));
    state.cursor = { ...state.cursor, observedAt: "2026-08-01T00:01:00.000Z", id: 24000 };
    state.plan.anchors = Array.from({ length: 24000 }, (_, index) => ({
      sourceContext: JSON.stringify(["openai_codex", "codex"]), contextKey: "openai_codex|codex",
      observedAtMs: Date.parse(TIME) + 24000 - index, planType: "pro", planVariant: `variant-${"x".repeat(56)}`, accountScopeId: null,
    }));
    const started = await beginCommunityAnalysisWork(db(), input.identity,
      encodeV1QuotaWorkCheckpoint(createV1QuotaAcquisitionCheckpoint(communityAnalysisAcquisitionIdentity(input.identity))).control, budget());
    if (started.status !== "ready") throw new Error("expected synthetic checkpoint");
    let head = started.head;
    for (let offset = 0; offset < state.plan.anchors.length; offset += 384 * 32) {
      const parts = [];
      for (let start = offset; start < Math.min(offset + 384 * 32, state.plan.anchors.length); start += 384) {
        parts.push({ component: "plan-anchors" as const, partKey: start / 384, value: state.plan.anchors.slice(start, start + 384) });
      }
      const saved = await commitCommunityAnalysisWorkPage(db(), head,
        { phase: "plan", control: encodeV1QuotaWorkCheckpoint(state).control, parts }, budget());
      if (saved.status !== "ready") throw new Error("expected synthetic checkpoint page");
      head = saved.head;
    }
    expect(await advanceCommunityAnalysisRun(db(), { ...input, budget: budget(80) })).toEqual({ status: "deferred" });
    const staged = await db().prepare("SELECT json_array_length(write_manifest_json) AS n FROM community_analysis_work_stage").first<{ n: number }>();
    expect(staged?.n).toBeGreaterThan(32);
    const result = await finish(input, 150);
    expect(result.head.phase).toBe("complete");
    expect(result.evidence.acquisition.planAnchors).toEqual([...state.plan.anchors].reverse());
    expect(await db().prepare("SELECT count(*) AS n FROM community_analysis_work_stage").first()).toEqual({ n: 0 });
  });
});
