import { describe, expect, it } from "vitest";
import { ADMIN_MODEL_CONFIG, expandAdminModelHistoryDay,
  projectAdminModelHistoryDay } from "@app-usagemonitor/telemetry-contract";
import * as canonical from "../src/admin-community-allowance";
import * as vendored from "../vendor/analytics-d43c8f92/apps/worker/src/admin-community-allowance";
import { projectPublicAllowanceGraphForGcp, validReadableAdminCommunityAllowancePreview }
  from "../src/analytics-v2/allowance-projection";
import { reducePublicAllowanceBreakdownsV13 } from "../src/analytics-v2/public-allowance-breakdowns-v13";
import { projectPublicAllowanceGraph as vendoredGraph } from "../vendor/analytics-d43c8f92/apps/worker/src/public-allowance-breakdowns";
import { normalizePublicAllowanceBreakdowns } from "../../web/public/community-data.js";

const GENERATED = Date.parse("2026-10-05T12:00:00.000Z");
const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const DAY = "2026-10-04";
const HISTORICAL_CATALOG = "reviewed-model-catalog-2026-09-23.1";

// Synthetic values matching the known kernel10 42-model catalog shape.
// No production payload, participant, input evidence or private diagnostic.
function historicalPreview() {
  // The retained DTO was published under Pro 20x v0.3. A current builder would
  // create v0.4/Pro 10x values and no longer exercise historical compatibility.
  const built = structuredClone(vendored.buildAdminCommunityAllowancePreview([
    { participantId: "synthetic-preview-owner", planType: "pro",
      capacityNanousd: 1_200_000_000_000, lastObservedAt: `${DAY}T12:00:00.000Z` },
    { participantId: "synthetic-preview-plus", planType: "plus",
      capacityNanousd: 1_200_000_000_000, lastObservedAt: `${DAY}T12:00:00.000Z` },
  ], GENERATED));
  const preview = { ...built, models: { ...built.models,
    modelConfig: ADMIN_MODEL_CONFIG.slice(0, 42).map(model => ({ ...model })),
    days: [] as NonNullable<ReturnType<typeof projectAdminModelHistoryDay>>[] } };
  const modelDay = projectAdminModelHistoryDay({ day: DAY,
    catalogVersion: HISTORICAL_CATALOG, values: [["gpt-6-astra", 1_166, 1]],
    fittedParticipantCount: 1, unstableParticipantCount: 0, staleParticipantCount: 0,
    refusedParticipantCount: 0, v1ParticipantCount: 1, unsupportedSourceParticipantCount: 0 });
  if (modelDay === null) throw new Error("invalid synthetic history");
  preview.models.days = [modelDay];
  return preview;
}

const metadata = [{ id: "gpt-6-astra", label: "GPT-6 Astra", family: "astra", order: 0 }];
for (const [name, api, validHistorical, graph] of [
  ["GCP compatibility", canonical, validReadableAdminCommunityAllowancePreview,
    (row: Parameters<typeof vendoredGraph>[0], options: Parameters<typeof vendoredGraph>[1]) =>
      projectPublicAllowanceGraphForGcp(row, options, metadata)],
  ["vendored kernel10", vendored, vendored.validCachedAdminCommunityAllowancePreview, vendoredGraph],
] as const) describe(`${name} historical preview compatibility`, () => {
  it("retains the exact known kernel10 publication and leaves new Sol unobserved", async () => {
    const preview = historicalPreview();
    const before = JSON.stringify(preview);
    expect(validHistorical(preview, preview.generatedAt, NOW)).toBe(true);
    const db = { prepare: () => ({ bind: () => ({ first: async () => ({
      generated_at: preview.generatedAt, payload_json: before,
    }) }) }) } as unknown as D1Database;
    const read = await vendored.readCachedAdminCommunityAllowancePreview(db, NOW);
    expect(preview.schemaVersion).toBe("admin-community-allowance-preview-v0.3");
    // The current producer contract must not silently relabel retained units.
    expect(canonical.validCachedAdminCommunityAllowancePreview(preview, preview.generatedAt, NOW)).toBe(false);
    expect(read).toEqual(preview);
    expect(JSON.stringify(preview)).toBe(before);
    expect(expandAdminModelHistoryDay(read.models.days[0])?.byModel["gpt-6.1-sol"])
      .toEqual({ capacityUsd: null, participantCount: null });
    const published = graph({ generated_at: preview.generatedAt, payload_json: before },
      { nowMs: NOW, publishedDays: [DAY] });
    expect(published?.breakdowns.generatedAt).toBe(preview.generatedAt);
    expect(published?.breakdowns.days[0]?.models).toEqual([["gpt-6-astra", 1_166, 1]]);
    const legacy = vendoredGraph({ generated_at: preview.generatedAt, payload_json: before },
      { nowMs: NOW, publishedDays: [DAY] })!;
    expect(legacy.breakdowns.days[0]!.byPlanType.plus.centralUsd).toBe(24_000);
    if (published?.breakdowns.schemaVersion === "community-allowance-breakdowns-v1.3") {
      expect(reducePublicAllowanceBreakdownsV13(published.breakdowns).base).toEqual(legacy.breakdowns);
    } else {
      expect(published).toEqual(legacy);
    }
    const normalized = normalizePublicAllowanceBreakdowns(published?.breakdowns, [DAY], NOW);
    expect(normalized).not.toBeNull();
    expect(normalized?.days[0]?.byPlanType.plus.centralUsd).toBe(24_000);
    expect(JSON.stringify(preview)).toBe(before);
    expect(JSON.stringify(published)).not.toMatch(/synthetic-preview-owner|participantId|coverage|catalogVersion/);
  });

  it("accepts the known empty historical model series without inventing points", () => {
    const preview = historicalPreview();
    preview.models.days = [];
    expect(validHistorical(preview, preview.generatedAt, NOW)).toBe(true);
  });

  it("rejects arbitrary, reordered, edited, unknown or inconsistent historical catalogs", () => {
    const changes: ((preview: ReturnType<typeof historicalPreview>) => void)[] = [
      p => { p.models.modelConfig = p.models.modelConfig.slice(0, 41); },
      p => { p.models.modelConfig = [...p.models.modelConfig].reverse(); },
      p => { p.models.modelConfig[0] = { ...p.models.modelConfig[0]!, modelId: "unreviewed-model" }; },
      p => { p.models.modelConfig[0] = { ...p.models.modelConfig[0]!, label: "Changed stored label" }; },
      p => { p.models.modelConfig[0] = { ...p.models.modelConfig[0]!, pricingStatus: "unpriced" }; },
      p => { p.models.modelConfig[0] = { ...p.models.modelConfig[0]!, allowanceTrack: "secondary" }; },
      p => { p.models.days[0] = { ...p.models.days[0]!, catalogVersion: "unknown-catalog" }; },
      p => { p.models.days[0] = { ...p.models.days[0]!, catalogVersion: "reviewed-model-catalog-2026-09-29.1" }; },
      p => { p.models.days[0] = { ...p.models.days[0]!, values: [["gpt-6.1-sol", 1, 1]] }; },
      p => { p.models.days[0] = { ...p.models.days[0]!, fittedParticipantCount: 2 }; },
    ];
    for (const change of changes) {
      const preview = historicalPreview();
      change(preview);
      expect(validHistorical(preview, preview.generatedAt, NOW)).toBe(false);
    }
  });

  it("keeps current builders and current-catalog publications valid", () => {
    const preview = api.buildAdminCommunityAllowancePreview([], NOW);
    expect(preview.models.modelConfig).toEqual(ADMIN_MODEL_CONFIG);
    expect(validHistorical(preview, preview.generatedAt, NOW)).toBe(true);
  });
});
