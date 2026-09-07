import { describe, expect, it } from "vitest";
import {
  ADMIN_MODEL_HISTORY_CATALOG_VERSION,
  projectAdminModelHistoryDay,
} from "@app-usagemonitor/telemetry-contract";
import {
  ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
  ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS,
  PREVIEW_CACHE_JSON_LIMIT_BYTES,
  buildAdminCommunityAllowancePreview,
} from "../src/admin-community-allowance";
import { COMMUNITY_ALLOWANCE_BASIS } from "../src/community-allowance";
import { projectPublicAllowanceBreakdowns } from "../src/public-allowance-breakdowns";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const YESTERDAY = "2026-09-06";

function modelDay(day: string) {
  const value = projectAdminModelHistoryDay({
    day,
    catalogVersion: ADMIN_MODEL_HISTORY_CATALOG_VERSION,
    values: [["gpt-6-astra", 1_166, 1]],
    fittedParticipantCount: 1,
    unstableParticipantCount: 1,
    staleParticipantCount: 0,
    refusedParticipantCount: 1,
    v1ParticipantCount: 3,
    unsupportedSourceParticipantCount: 1,
  });
  if (value === null) throw new Error("invalid synthetic model day");
  return value;
}

function preview() {
  return buildAdminCommunityAllowancePreview([
    { participantId: "synthetic-private-pro", planType: "pro",
      capacityNanousd: 1_200_000_000_000, lastObservedAt: `${YESTERDAY}T12:00:00.000Z` },
    { participantId: "synthetic-private-plus", planType: "plus",
      capacityNanousd: 60_000_000_000, lastObservedAt: `${YESTERDAY}T12:00:00.000Z` },
  ], NOW, undefined, {
    modelConfig: ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
    basis: ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
    gate: ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
    days: [modelDay(YESTERDAY), modelDay("2026-09-07")],
  });
}

function cacheRow(value: unknown = preview()) {
  return { generated_at: new Date(NOW).toISOString(), payload_json: JSON.stringify(value) };
}

const OPTIONS = { allowanceState: "ready" as const, publishedDays: [YESTERDAY], nowMs: NOW };

describe("public allowance breakdown allowlist", () => {
  it("publishes approved single-account dollars/counts without private admin diagnostics", () => {
    const projected = projectPublicAllowanceBreakdowns(cacheRow(), OPTIONS);
    expect(projected).toEqual({
      schemaVersion: "community-allowance-breakdowns-v1.0",
      basis: COMMUNITY_ALLOWANCE_BASIS,
      referencePlanType: "pro",
      normalization: "pro_x1_prolite_x4_plus_x20",
      modelBasis: ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
      modelGate: ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
      generatedAt: new Date(NOW).toISOString(),
      days: [{
        day: YESTERDAY,
        byPlanType: {
          pro: { centralUsd: 1_200, participantCount: 1, fitCount: 1, band80Usd: null },
          prolite: { centralUsd: null, participantCount: 0, fitCount: 0, band80Usd: null },
          plus: { centralUsd: 1_200, participantCount: 1, fitCount: 1, band80Usd: null },
        },
        models: [["gpt-6-astra", 1_166, 1]],
      }],
    });
    const wire = JSON.stringify(projected);
    for (const field of ["synthetic-private", "coverage", "modelConfig", "catalogVersion",
      "refusedParticipantCount", "unsupportedSourceParticipantCount", "fittedParticipantCount",
      "combined", "qualification", "byModel"]) expect(wire).not.toContain(field);
  });

  it("intersects the requested published closed dates and never carries a model estimate backward", () => {
    const projected = projectPublicAllowanceBreakdowns(cacheRow(), {
      ...OPTIONS,
      publishedDays: ["2026-09-05", YESTERDAY, "2026-09-07", "2026-09-08", "2025-01-01"],
    });
    expect(projected?.days.map((day) => day.day)).toEqual(["2026-09-05", YESTERDAY]);
    expect(projected?.days[0]?.models).toEqual([]);
    expect(projected?.days[0]?.byPlanType.pro.centralUsd).toBeNull();
    expect(projected?.days[1]?.models).toEqual([["gpt-6-astra", 1_166, 1]]);
    expect(projectPublicAllowanceBreakdowns(cacheRow(), { ...OPTIONS, publishedDays: [] })).toBeNull();
    expect(projectPublicAllowanceBreakdowns(cacheRow(), {
      ...OPTIONS, publishedDays: ["2026-09-07"],
    })).toBeNull();
  });

  it("is bounded by the 70-day validated preview, even with a full requested year", () => {
    const days = Array.from({ length: 366 }, (_, index) =>
      new Date(NOW - index * 86_400_000).toISOString().slice(0, 10));
    const projected = projectPublicAllowanceBreakdowns(cacheRow(), { ...OPTIONS, publishedDays: days });
    expect(projected?.days).toHaveLength(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS - 1);
    expect(projected?.days.at(-1)?.day).toBe(YESTERDAY);
  });

  it("does not relabel a still-open source day as closed just after midnight", () => {
    const generatedAt = "2026-09-06T23:30:00.000Z";
    const value = buildAdminCommunityAllowancePreview([], Date.parse(generatedAt));
    const projected = projectPublicAllowanceBreakdowns({
      generated_at: generatedAt, payload_json: JSON.stringify(value),
    }, { ...OPTIONS, nowMs: Date.parse("2026-09-07T00:30:00.000Z"),
      publishedDays: ["2026-09-05", YESTERDAY] });
    expect(projected?.days.map((day) => day.day)).toEqual(["2026-09-05"]);
  });

  it("copies numerical uncertainty bands into fresh public objects", () => {
    const fits = [1_000, 1_200, 1_400].map((dollars) => ({
      participantId: "synthetic-private-pro", planType: "pro", capacityNanousd: dollars * 1_000_000_000,
      lastObservedAt: `${YESTERDAY}T12:00:00.000Z`,
    }));
    const value = buildAdminCommunityAllowancePreview(fits, NOW);
    const projected = projectPublicAllowanceBreakdowns(cacheRow(value), OPTIONS);
    expect(projected?.days[0]?.byPlanType.pro).toEqual(value.days.at(-2)?.byPlanType.pro);
    expect(projected?.days[0]?.byPlanType.pro.band80Usd).not.toBeNull();
    expect(projected?.days[0]?.byPlanType.pro.band80Usd).not.toBe(value.days.at(-2)?.byPlanType.pro.band80Usd);
  });

  it("fails closed on missing, malformed, oversized, stale, future, and mismatched cache generations", () => {
    const row = cacheRow();
    for (const candidate of [null, { ...row, payload_json: "{" },
      { ...row, payload_json: `${row.payload_json}${" ".repeat(PREVIEW_CACHE_JSON_LIMIT_BYTES)}` },
      { ...row, generated_at: "2026-09-07T11:59:00.000Z" }]) {
      expect(projectPublicAllowanceBreakdowns(candidate, OPTIONS)).toBeNull();
    }
    expect(projectPublicAllowanceBreakdowns(row, { ...OPTIONS, nowMs: NOW + 2 * 60 * 60 * 1_000 + 1 })).toBeNull();
    expect(projectPublicAllowanceBreakdowns(row, { ...OPTIONS, nowMs: NOW - 5 * 60 * 1_000 - 1 })).toBeNull();
    expect(projectPublicAllowanceBreakdowns(row, { ...OPTIONS, nowMs: NaN })).toBeNull();
    expect(projectPublicAllowanceBreakdowns(row, { ...OPTIONS, allowanceState: "updating" })).toBeNull();
  });

  it("rejects extra private fields and unreviewed or malformed model values instead of forwarding them", () => {
    const value = preview();
    const rawDay = value.models.days[0]!;
    const invalid = [
      { ...value, privateAccountId: "synthetic-private-canary" },
      { ...value, models: { ...value.models, privateSource: "synthetic-private-canary" } },
      { ...value, models: { ...value.models, days: [{ ...rawDay,
        values: [["synthetic-private-custom-model", 1_166, 1]] }] } },
      { ...value, models: { ...value.models, days: [{ ...rawDay,
        values: [["gpt-6-astra", 0, 1]] }] } },
      { ...value, models: { ...value.models, days: [{ ...rawDay,
        values: [["gpt-6-astra", 1_166, 2]] }] } },
      { ...value, models: { ...value.models, days: [{ ...rawDay,
        values: [["gpt-6-astra", 1_166, 1, "synthetic-private-canary"]] }] } },
      { ...value, days: value.days.map((day) => day.day === YESTERDAY ? {
        ...day, byPlanType: { ...day.byPlanType, pro: {
          ...day.byPlanType.pro, privateSource: "synthetic-private-canary",
        } },
      } : day) },
    ];
    for (const candidate of invalid) {
      expect(projectPublicAllowanceBreakdowns(cacheRow(candidate), OPTIONS)).toBeNull();
    }
  });
});
