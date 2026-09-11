import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  telemetryV11DomainManifestDigestInput,
  type TelemetryV11Attribution,
  type TelemetryV11QuotaObservation,
  type TelemetryV11UsageEvent,
} from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "../src/crypto";
import {
  accountScopedModelCompositionV11,
  accountScopedQuotaAnalysisV11,
  V11_PLAN_ATTRIBUTION_ADAPTER_VERSION,
  V11_USAGE_PAGE_SQL,
} from "../src/quota-analysis-v11";
import {
  activateTelemetryV11Domain,
  assertV11SourcePinCurrent,
  createTelemetryV11DomainPredecessor,
  loadV11SourcePin,
} from "../src/telemetry-v11-domain";
import { createV11DeviceFixture, makeV11Day, stageV11Day, v11UsageRecord } from "./helpers/telemetry-v11";

interface TestBindings extends Env { TEST_MIGRATIONS: D1Migration[] }
const DAY_MS = 86_400_000;
const MINUTE = 60_000;
const DAY = new Date(Date.now() - 10 * DAY_MS).toISOString().slice(0, 10);
const START = Date.parse(DAY + "T00:00:00.000Z");
const NOW = Date.now();
const ACCOUNT_A = "account-track:v2:" + "a".repeat(64);
const ACCOUNT_B = "account-track:v2:" + "b".repeat(64);
type Fixture = Awaited<ReturnType<typeof createV11DeviceFixture>>;
type Candidate = Awaited<ReturnType<typeof stageV11Day>>;
function db(): D1Database { return (env as TestBindings).USAGE_MONITOR_DB; }

function series(ordinal: number, options: {
  plan?: "pro" | "plus" | "unknown"; account?: string | null; accountBasis?: TelemetryV11Attribution["accountBasis"];
  offsetMinutes?: number; continuityId?: string | null; scale?: number; flatCopies?: number;
} = {}) {
  const plan = options.plan ?? "pro";
  const account = options.account === undefined ? ACCOUNT_A : options.account;
  const attribution: TelemetryV11Attribution = {
    accountBasis: options.accountBasis ?? (account === null ? "unavailable" : "same_source"),
    accountTrackId: account, planBasis: plan === "unknown" ? "unavailable" : "same_source_occurrence",
    planType: plan, planEraId: options.continuityId ?? null,
  };
  const start = START + (options.offsetMinutes ?? ordinal * 60) * MINUTE;
  const quota: TelemetryV11QuotaObservation[] = [];
  const usage: TelemetryV11UsageEvent[] = [];
  for (let point = 0; point < 9; point += 1) {
    for (let copy = 0; copy < (options.flatCopies ?? 1); copy += 1) {
      quota.push({
        schemaVersion: "quota-observation-v1.1", observationId: "quota:synthetic:" + ordinal + ":" + point + ":" + copy,
        observedTime: new Date(start + point * 5 * MINUTE + copy * 5_000).toISOString(),
        provider: "openai_codex", planType: plan, planVariant: "unknown", limitId: "codex",
        slot: "seven_day", usedPercent: 10 + point * 5, windowDurationMinutes: 10_080,
        resetsAt: new Date(START + 7 * DAY_MS).toISOString(), accountPlanAttribution: { ...attribution },
      });
    }
    if (point < 8) {
      const scale = options.scale ?? 1;
      usage.push(v11UsageRecord(DAY, "a", {
        eventId: "usage:synthetic:" + ordinal + ":" + point,
        eventTime: new Date(start + point * 5 * MINUTE + 150_000).toISOString(),
        sessionUuid: "synthetic-session-" + ordinal, apiServiceTier: "standard",
        totalInputContextTokens: 10_000 * scale,
        components: { inputUncachedTokens: 1_000 * scale, inputCacheReadTokens: 9_000 * scale,
          inputCacheWriteTokens: 0, outputTextTokens: 500 * scale,
          outputReasoningTokens: 250 * scale, outputCombinedTokens: null },
        accountPlanAttribution: { ...attribution },
      }));
    }
  }
  return { quota, usage };
}

async function activate(fixture: Fixture, candidates: Candidate[]) {
  const predecessor = await createTelemetryV11DomainPredecessor(db(), fixture);
  const byDay = new Map(candidates.map((candidate) => [candidate.day, candidate]));
  const sorted = [predecessor.fromDay, predecessor.throughDay, ...byDay.keys()].sort();
  const fromDay = sorted[0]!;
  const throughDay = sorted[sorted.length - 1]!;
  const days = [];
  for (let time = Date.parse(fromDay); time <= Date.parse(throughDay); time += DAY_MS) {
    const day = new Date(time).toISOString().slice(0, 10);
    const candidate = byDay.get(day) ?? await stageV11Day(db(), fixture, await makeV11Day(day, {}));
    days.push({ day, manifestId: candidate.manifestId, manifestDigest: candidate.manifestDigest });
  }
  const manifest = {
    schemaVersion: "telemetry-domain-manifest-v1.1" as const, fromDay, throughDay,
    predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint }, days, manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  return activateTelemetryV11Domain(db(), fixture, manifest);
}

interface Analysis {
  status: string; reason?: string; fragmentSelection?: string; attributionMethod?: string; inputFingerprint?: string;
  tracks: Array<{
    continuity: { accountScopeId: string | null; planType: string; planEraKey: string };
    calibration: { tracks: Array<{ resets: Array<{
      status: string; capacityNanousd: number | null; refusalCodes: string[];
    }> }> };
    attribution: { status: string; quantityBinding: string; planEvidenceScope: string;
      refusedResets: Array<{ reason: string }> };
  }>;
}
function fits(analysis: Analysis) {
  return (analysis.tracks ?? []).flatMap((track) => track.calibration.tracks
    .flatMap((calibration) => calibration.resets)
    .filter((reset) => reset.status === "conditional_estimate")
    .map((reset) => ({ ...reset, account: track.continuity.accountScopeId, plan: track.continuity.planType })));
}

describe("activated v1.1 account and plan attribution", () => {
  beforeEach(async () => {
    await reset();
    await applyD1Migrations(db(), (env as TestBindings).TEST_MIGRATIONS);
  });

  it("never analyzes a complete staged day before whole-domain activation", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const day = await stageV11Day(db(), fixture, await makeV11Day(DAY, series(0)));
    expect(day.state).toBe("ready");
    expect(await loadV11SourcePin(db(), fixture.participantId)).toBeNull();
    expect(await accountScopedQuotaAnalysisV11(db(), fixture.participantId, { nowMs: NOW }))
      .toMatchObject({ status: "not_testable", reason: "activated_attribution_domain_unavailable", tracks: [] });
    expect(await accountScopedModelCompositionV11(db(), fixture.participantId, { nowMs: NOW }))
      .toMatchObject({ status: "not_testable", reason: "activated_attribution_domain_unavailable" });
  });

  it("retains purely unknown-account history as conditional, with lossless dense-quota reduction", async () => {
    const control = await createV11DeviceFixture(db(), { grant: true });
    const dense = await createV11DeviceFixture(db(), { grant: true });
    await activate(control, [await stageV11Day(db(), control, await makeV11Day(DAY, series(0, { account: null })))]);
    await activate(dense, [await stageV11Day(db(), dense, await makeV11Day(DAY, series(0, { account: null, flatCopies: 10 })))]);
    const baseline = await accountScopedQuotaAnalysisV11(db(), control.participantId, { nowMs: NOW }) as Analysis;
    const reduced = await accountScopedQuotaAnalysisV11(db(), dense.participantId,
      { nowMs: NOW, maxDownsampledQuotaRows: 20 }) as Analysis;
    expect(fits(baseline)).toHaveLength(1);
    expect(fits(reduced)).toHaveLength(1);
    expect(fits(reduced)[0]!.capacityNanousd).toBe(fits(baseline)[0]!.capacityNanousd);
    expect(reduced.attributionMethod).toBe(V11_PLAN_ATTRIBUTION_ADAPTER_VERSION);
    expect(reduced.inputFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(reduced.tracks[0]!.attribution).toMatchObject({
      status: "legacy_conditional", quantityBinding: "conditional_no_wire_interval",
      planEvidenceScope: "bounded_analysis_window",
    });
    const composition = await accountScopedModelCompositionV11(db(), dense.participantId, { nowMs: NOW });
    expect(composition.status).toBe("ready");
    if (composition.status === "ready") expect(composition.attributionStatus).toBe("legacy_conditional");
  });

  it("keeps wholly unknown-plan history conditional without assigning a named plan", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    await activate(fixture, [await stageV11Day(db(), fixture, await makeV11Day(DAY,
      series(0, { plan: "unknown", account: null })))]);
    const analysis = await accountScopedQuotaAnalysisV11(db(), fixture.participantId, { nowMs: NOW }) as Analysis;
    expect(fits(analysis)).toHaveLength(1);
    expect(fits(analysis)[0]!.plan).toBe("unknown");
    expect(analysis.tracks[0]!.attribution.status).toBe("legacy_conditional");
    expect(await accountScopedModelCompositionV11(db(), fixture.participantId, { nowMs: NOW }))
      .toMatchObject({ status: "ready", planType: "unknown", attributionStatus: "legacy_conditional" });
  });

  it("separates one account's Pro to Plus to Pro before costing and refuses mixed-plan composition", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const parts = [series(0), series(1, { plan: "plus" }), series(2)];
    await activate(fixture, [await stageV11Day(db(), fixture, await makeV11Day(DAY, {
      quota: parts.flatMap((part) => part.quota), usage: parts.flatMap((part) => part.usage),
    }))]);
    const analysis = await accountScopedQuotaAnalysisV11(db(), fixture.participantId, { nowMs: NOW }) as Analysis;
    expect(analysis.fragmentSelection).toBe("unselected_diagnostics");
    expect(fits(analysis)).toHaveLength(3);
    expect(new Set(fits(analysis).map((fit) => fit.capacityNanousd)).size).toBe(1);
    expect(new Set(analysis.tracks.map((track) => track.continuity.planEraKey)).size).toBe(3);
    expect(await accountScopedModelCompositionV11(db(), fixture.participantId, { nowMs: NOW }))
      .toMatchObject({ status: "not_testable", reason: "multi_plan_window_unsupported" });
  });

  it.each(["pro", "plus"] as const)("does not let a positively scoped B's unpriced %s usage poison A", async (plan) => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const a = series(0);
    const b = series(1, { plan, account: ACCOUNT_B, offsetMinutes: 0, scale: 10 });
    b.usage[0]!.modelId = "unknown";
    await activate(fixture, [await stageV11Day(db(), fixture, await makeV11Day(DAY,
      { quota: [...a.quota, ...b.quota], usage: [...a.usage, ...b.usage] }))]);
    const analysis = await accountScopedQuotaAnalysisV11(db(), fixture.participantId, { nowMs: NOW }) as Analysis;
    expect(fits(analysis)).toHaveLength(1);
    expect(fits(analysis)[0]!.account).toBe(ACCOUNT_A);
    const refused = analysis.tracks.find((track) => track.continuity.accountScopeId === ACCOUNT_B)!;
    expect(refused.attribution.refusedResets).toHaveLength(0); // Exclusion is not an attribution error.
    expect(refused.calibration.tracks.flatMap((track) => track.resets)
      .some((reset) => reset.refusalCodes.includes("source_evidence_refused"))).toBe(true);
    const composition = await accountScopedModelCompositionV11(db(), fixture.participantId, { nowMs: NOW });
    expect(composition.status).toBe("not_testable");
  });

  it.each(["unavailable", "provisional_marker"] as const)("does not turn 20 linked plus 80 %s into a 20-only fit", async (basis) => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const linked = series(0);
    const unknown = series(1, { account: basis === "unavailable" ? null : ACCOUNT_A,
      accountBasis: basis, offsetMinutes: 0, scale: 4 });
    await activate(fixture, [await stageV11Day(db(), fixture, await makeV11Day(DAY,
      { quota: linked.quota, usage: [...linked.usage, ...unknown.usage] }))]);
    const raw = await db().prepare(`
      SELECT COUNT(*) AS count, SUM(input_uncached_tokens) AS tokens FROM telemetry_v11_active_records
      WHERE participant_id = ? AND stream = 'usage'`).bind(fixture.participantId)
      .first<{ count: number; tokens: number }>();
    expect(raw).toEqual({ count: 16, tokens: 40_000 }); // 8k linked, 32k unresolved, all retained.
    const analysis = await accountScopedQuotaAnalysisV11(db(), fixture.participantId, { nowMs: NOW }) as Analysis;
    expect(analysis.status).toBe("ready");
    expect(fits(analysis)).toHaveLength(0);
    expect(analysis.tracks[0]!.attribution.refusedResets).toEqual([
      expect.objectContaining({ reason: "usage_attribution_unresolved" }),
    ]);
    expect(await accountScopedModelCompositionV11(db(), fixture.participantId, { nowMs: NOW }))
      .toMatchObject({ status: "not_testable", reason: "usage_attribution_unresolved" });
  });

  it("does not positively exclude a delta whose same session changes account", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const a = series(0);
    const b = series(1, { account: ACCOUNT_B, offsetMinutes: 0 });
    b.usage[0]!.sessionUuid = a.usage[0]!.sessionUuid;
    await activate(fixture, [await stageV11Day(db(), fixture, await makeV11Day(DAY,
      { quota: [...a.quota, ...b.quota], usage: [...a.usage, ...b.usage] }))]);
    const analysis = await accountScopedQuotaAnalysisV11(db(), fixture.participantId, { nowMs: NOW }) as Analysis;
    expect(analysis.tracks).toHaveLength(2);
    expect(fits(analysis)).toHaveLength(0);
    for (const track of analysis.tracks) expect(track.attribution.refusedResets).toEqual([
      expect.objectContaining({ reason: "usage_attribution_unresolved" }),
    ]);
  });

  it("uses an indexed day/time cursor across a full equal-time page and midnight without truncation", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const records = series(0, { offsetMinutes: 23 * 60 + 45 });
    const first = records.usage[0]!;
    records.usage = [...Array.from({ length: 5_001 }, (_, index) => ({ ...structuredClone(first),
      eventId: "usage:synthetic:cursor:" + String(index).padStart(6, "0") })), ...records.usage.slice(1)];
    const days = [...new Set([...records.quota.map((row) => row.observedTime.slice(0, 10)),
      ...records.usage.map((row) => row.eventTime.slice(0, 10))])].sort();
    expect(days).toHaveLength(2);
    const candidates = [];
    for (const day of days) candidates.push(await stageV11Day(db(), fixture, await makeV11Day(day, {
      quota: records.quota.filter((row) => row.observedTime.startsWith(day)),
      usage: records.usage.filter((row) => row.eventTime.startsWith(day)),
    })));
    await activate(fixture, candidates);
    const pin = await loadV11SourcePin(db(), fixture.participantId);
    expect(pin).not.toBeNull();
    const plan = await db().prepare("EXPLAIN QUERY PLAN " + V11_USAGE_PAGE_SQL).bind(
      fixture.participantId, pin!.generationId, days[0]!, DAY + "T00:00:00.000Z",
      new Date(START + 2 * DAY_MS).toISOString(), DAY + "T00:00:00.000Z", "", 5_000,
    ).all<{ detail: string }>();
    const steps = plan.results.map((row) => row.detail);
    expect(steps.some((step) => step.includes("telemetry_v11_records_time_cursor"))).toBe(true);
    expect(steps.some((step) => step.includes("observed_day=?"))).toBe(true);
    expect(steps.some((step) => step.includes("TEMP B-TREE FOR ORDER BY"))).toBe(false);
    const composition = await accountScopedModelCompositionV11(db(), fixture.participantId, { nowMs: NOW });
    expect(composition).toMatchObject({ status: "ready", usageEventCount: 5_008, unpricedUsageEventCount: 0 });
    // A cap on the combined two-day stream must refuse, not return the first
    // day's 5,003 events or treat the second day as a fresh counter/budget.
    expect(await accountScopedQuotaAnalysisV11(db(), fixture.participantId,
      { nowMs: NOW, maxWindowedUsageRows: 5_005 }))
      .toMatchObject({ status: "not_testable", reason: "windowed_usage_limit_exceeded", tracks: [] });
  });

  it("uses tiny quota-only conflicts before fitability and separates same-plan continuity returns", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const eraA = "plan-era:v1:" + "1".repeat(64);
    const eraB = "plan-era:v1:" + "2".repeat(64);
    const parts = [series(0, { continuityId: eraA }), series(1, { continuityId: eraB }),
      series(2, { continuityId: eraA })];
    await activate(fixture, [await stageV11Day(db(), fixture, await makeV11Day(DAY, {
      quota: parts.flatMap((part) => part.quota), usage: parts.flatMap((part) => part.usage),
    }))]);
    const analysis = await accountScopedQuotaAnalysisV11(db(), fixture.participantId, { nowMs: NOW }) as Analysis;
    expect(fits(analysis)).toHaveLength(3);
    expect(new Set(analysis.tracks.map((track) => track.continuity.planEraKey)).size).toBe(3);
    expect(await accountScopedModelCompositionV11(db(), fixture.participantId, { nowMs: NOW }))
      .toMatchObject({ status: "not_testable", reason: "multi_era_window_unsupported" });

    const conflictFixture = await createV11DeviceFixture(db(), { grant: true });
    const conflict = series(0);
    conflict.quota.push({ ...conflict.quota[4]!, observationId: "quota:synthetic:foreign-plan",
      planType: "plus", windowDurationMinutes: 300, slot: "five_hour",
      accountPlanAttribution: { ...conflict.quota[4]!.accountPlanAttribution, planType: "plus" } });
    await activate(conflictFixture, [await stageV11Day(db(), conflictFixture, await makeV11Day(DAY, conflict))]);
    const refused = await accountScopedQuotaAnalysisV11(db(), conflictFixture.participantId, { nowMs: NOW }) as Analysis;
    expect(fits(refused)).toHaveLength(0);
    expect(await accountScopedModelCompositionV11(db(), conflictFixture.participantId, { nowMs: NOW }))
      .toMatchObject({ status: "not_testable", reason: "multi_plan_window_unsupported" });
  });

  it("withholds a crossing quantity without rejecting the later coherent era", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const a = series(0);
    const b = series(1, { plan: "plus" });
    const c = series(2);
    // The first Plus delta still carries a start in Pro in this same session.
    b.usage[0]!.sessionUuid = a.usage[0]!.sessionUuid;
    await activate(fixture, [await stageV11Day(db(), fixture, await makeV11Day(DAY,
      { quota: [...a.quota, ...b.quota, ...c.quota], usage: [...a.usage, ...b.usage, ...c.usage] }))]);
    const analysis = await accountScopedQuotaAnalysisV11(db(), fixture.participantId, { nowMs: NOW }) as Analysis;
    expect(fits(analysis)).toHaveLength(1); // A/B overlap the crossing interval; the later C era does not.
    expect(fits(analysis)[0]!.plan).toBe("pro");
    expect(analysis.tracks.filter((track) => track.attribution.refusedResets.length === 1)).toHaveLength(2);
  });

  it("retains an explicit quota-only unknown-plan conflict as a boundary, but not ordinary missing plan evidence", async () => {
    for (const planBasis of ["conflicted", "unavailable"] as const) {
      const fixture = await createV11DeviceFixture(db(), { grant: true });
      const records = series(0);
      records.quota.push({ ...records.quota[4]!, observationId: "quota:synthetic:unknown-plan",
        planType: "unknown", slot: "five_hour", windowDurationMinutes: 300,
        accountPlanAttribution: { ...records.quota[4]!.accountPlanAttribution,
          planBasis, planType: "unknown", planEraId: null } });
      await activate(fixture, [await stageV11Day(db(), fixture, await makeV11Day(DAY, records))]);
      const analysis = await accountScopedQuotaAnalysisV11(db(), fixture.participantId, { nowMs: NOW }) as Analysis;
      expect(fits(analysis)).toHaveLength(planBasis === "conflicted" ? 0 : 1);
      const composition = await accountScopedModelCompositionV11(db(), fixture.participantId, { nowMs: NOW });
      if (planBasis === "conflicted") {
        expect(composition).toMatchObject({ status: "not_testable", reason: "multi_plan_window_unsupported" });
      } else expect(composition.status).toBe("ready");
    }
  });

  it.each(["resetsAt", "windowDurationMinutes", "usedPercent"] as const)(
    "retains a foreign-plan quota occurrence with missing %s before fitting", async (missingField) => {
      const fixture = await createV11DeviceFixture(db(), { grant: true });
      const records = series(0);
      const boundary: TelemetryV11QuotaObservation = {
        ...records.quota[4]!, observationId: "quota:synthetic:plan-only", planType: "plus", slot: "unknown",
        [missingField]: null,
        accountPlanAttribution: { ...records.quota[4]!.accountPlanAttribution, planType: "plus" },
      };
      records.quota.push(boundary);
      await activate(fixture, [await stageV11Day(db(), fixture, await makeV11Day(DAY, records))]);
      const raw = await db().prepare(`SELECT COUNT(*) AS count FROM telemetry_v11_active_records
        WHERE participant_id = ? AND stream = 'quota'`).bind(fixture.participantId).first<{ count: number }>();
      expect(raw?.count).toBe(10);
      const analysis = await accountScopedQuotaAnalysisV11(db(), fixture.participantId, { nowMs: NOW }) as Analysis;
      expect(fits(analysis)).toHaveLength(0);
      expect(await accountScopedModelCompositionV11(db(), fixture.participantId, { nowMs: NOW }))
        .toMatchObject({ status: "not_testable", reason: "multi_plan_window_unsupported" });
    },
  );

  it("refuses capped input and a stale generation pin instead of fitting a truncated or mixed snapshot", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const prepared = await makeV11Day(DAY, series(0));
    await activate(fixture, [await stageV11Day(db(), fixture, prepared)]);
    const pin = await loadV11SourcePin(db(), fixture.participantId);
    expect(pin).not.toBeNull();
    expect(await accountScopedQuotaAnalysisV11(db(), fixture.participantId,
      { nowMs: NOW, sourcePin: pin!, maxWindowedUsageRows: 1 }))
      .toMatchObject({ status: "not_testable", reason: "windowed_usage_limit_exceeded", tracks: [] });
    expect(await accountScopedQuotaAnalysisV11(db(), fixture.participantId,
      { nowMs: NOW, sourcePin: pin!, maxDownsampledQuotaRows: 1 }))
      .toMatchObject({ status: "not_testable", reason: "downsampled_quota_limit_exceeded", tracks: [] });
    const replacement = await stageV11Day(db(), fixture, await makeV11Day(DAY, series(0), "synthetic-v11-replay"));
    await expect(assertV11SourcePinCurrent(db(), pin!)).resolves.toBeUndefined(); // Merely staged is invisible.
    await activate(fixture, [replacement]);
    await expect(accountScopedQuotaAnalysisV11(db(), fixture.participantId, { nowMs: NOW, sourcePin: pin! }))
      .rejects.toThrow("v11 source changed during analysis");
    await expect(accountScopedModelCompositionV11(db(), fixture.participantId, { nowMs: NOW, sourcePin: pin! }))
      .rejects.toThrow("v11 source changed during analysis");
  });
});
