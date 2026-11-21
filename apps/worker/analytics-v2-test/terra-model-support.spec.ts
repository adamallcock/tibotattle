import { describe, expect, it } from "vitest";
import { ADMIN_MODEL_CONFIG, ADMIN_MODEL_HISTORY_CATALOG_VERSION,
  OCTOBER26_ADMIN_MODEL_CONFIG, OCTOBER26_ADMIN_MODEL_HISTORY_CATALOG_VERSION,
  SEPTEMBER29_ADMIN_MODEL_CONFIG, SEPTEMBER29_ADMIN_MODEL_HISTORY_CATALOG_VERSION,
  projectAdminModelHistoryDay } from "@app-usagemonitor/telemetry-contract";
import { buildAdminCommunityAllowancePreview, readCachedAdminCommunityAllowancePreview,
  validCachedAdminCommunityAllowancePreview } from "../src/admin-community-allowance";
import { buildCurrentPublicModelMetadata } from "../src/analytics-v2/public-model-metadata-current";
import { projectAdminAllowancePreview } from "../../web/public/admin-client.js";

const NOW = Date.parse("2026-11-18T12:00:00.000Z"), DAY = "2026-11-17";
const SEPTEMBER23 = "reviewed-model-catalog-2026-09-23.1";
const catalogs = [
  { models: SEPTEMBER29_ADMIN_MODEL_CONFIG.slice(0, 42), version: SEPTEMBER23, model: "gpt-6-astra" },
  { models: SEPTEMBER29_ADMIN_MODEL_CONFIG, version: SEPTEMBER29_ADMIN_MODEL_HISTORY_CATALOG_VERSION, model: "gpt-6.1-sol" },
  { models: OCTOBER26_ADMIN_MODEL_CONFIG, version: OCTOBER26_ADMIN_MODEL_HISTORY_CATALOG_VERSION, model: "gpt-6.1-terra" },
  { models: ADMIN_MODEL_CONFIG, version: ADMIN_MODEL_HISTORY_CATALOG_VERSION, model: "gpt-6.2-astra" },
];
function previewFor(index: number) {
  const catalog = catalogs[index]!;
  const modelDay = projectAdminModelHistoryDay({ day: DAY, catalogVersion: catalog.version,
    values: [[catalog.model, 123.45, 1]], fittedParticipantCount: 1, unstableParticipantCount: 0,
    staleParticipantCount: 0, refusedParticipantCount: 0, v1ParticipantCount: 1, unsupportedSourceParticipantCount: 0 });
  if (modelDay === null) throw Error("SYNTHETIC_MODEL_DAY_INVALID");
  const preview = buildAdminCommunityAllowancePreview([{ participantId: "synthetic-terra-owner", planType: "pro",
    capacityNanousd: 123_450_000_000, lastObservedAt: `${DAY}T12:00:00.000Z` }], NOW);
  return { ...preview, models: { ...preview.models, modelConfig: catalog.models, days: [modelDay] } };
}

describe("server and admin model catalog contracts", () => {
  it("appends the three GPT-6.2 identities after the retained October roster", () => {
    const preview = buildAdminCommunityAllowancePreview([], NOW);
    expect(preview.models.modelConfig).toHaveLength(47);
    expect(preview.models.modelConfig.slice(0, 44)).toEqual(OCTOBER26_ADMIN_MODEL_CONFIG);
    expect(preview.models.modelConfig.slice(44)).toEqual([
      { modelId: "gpt-6.2-astra", label: "GPT-6.2 Astra", allowanceTrack: "primary", pricingStatus: "published" },
      { modelId: "gpt-6.2-sol", label: "GPT-6.2 Sol", allowanceTrack: "primary", pricingStatus: "published" },
      { modelId: "gpt-6.2-astra-law", label: "GPT-6.2 Astra for Law", allowanceTrack: "primary", pricingStatus: "published" },
    ]);
    expect(buildCurrentPublicModelMetadata().map(model => model.id)).toEqual([
      "gpt-6.2-astra", "gpt-6.2-sol",
      "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-terra",
      "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna",
    ]);
  });

  it("reads all four exact headers without changing stored values, dates or historical coverage", async () => {
    for (const [index, catalog] of catalogs.entries()) {
      const preview = previewFor(index), before = JSON.stringify(preview);
      expect(validCachedAdminCommunityAllowancePreview(preview, preview.generatedAt, NOW)).toBe(true);
      const db = { prepare: () => ({ bind: () => ({ first: async () => ({
        generated_at: preview.generatedAt, payload_json: before,
      }) }) }) } as unknown as D1Database;
      const read = await readCachedAdminCommunityAllowancePreview(db, NOW);
      expect(read).toEqual(preview);
      const browser = projectAdminAllowancePreview(read);
      expect(browser.days).toEqual(preview.days);
      expect(browser.generatedAt).toBe(preview.generatedAt);
      expect(browser.models.modelConfig).toEqual(catalog.models);
      expect(browser.models.days[0].catalogVersion).toBe(catalog.version);
      expect(browser.models.days[0].values).toEqual(preview.models.days[0]!.values);
      if (index === 1) expect("gpt-6.1-terra" in browser.models.days[0].byModel).toBe(false);
      if (index === 2) expect("gpt-6.2-astra" in browser.models.days[0].byModel).toBe(false);
      expect(JSON.stringify(preview)).toBe(before);
    }
  });

  it("refuses crossed catalog claims even when the newer day's sparse values contain only old models", () => {
    for (const index of [0, 1, 2]) for (const newer of catalogs.slice(index + 1)) {
      const preview = previewFor(index);
      preview.models.days = [{ ...preview.models.days[0]!, catalogVersion: newer.version }];
      expect(validCachedAdminCommunityAllowancePreview(preview, preview.generatedAt, NOW)).toBe(false);
      expect(() => projectAdminAllowancePreview(preview)).toThrow();
    }
    for (const mutate of [
      (preview: any) => { preview.models.modelConfig = preview.models.modelConfig.slice(0, 46); },
      (preview: any) => { preview.models.modelConfig.reverse(); },
      (preview: any) => { preview.models.modelConfig[45].modelId = "unreviewed-model"; },
      (preview: any) => { preview.models.modelConfig[45].pricingStatus = "unpriced"; },
      (preview: any) => { preview.models.modelConfig[45].allowanceTrack = "spark"; },
      (preview: any) => { preview.models.days[0].catalogVersion = "reviewed-model-catalog-2026-10-27.1"; },
    ]) {
      const preview = structuredClone(previewFor(3)); mutate(preview);
      expect(validCachedAdminCommunityAllowancePreview(preview, preview.generatedAt, NOW)).toBe(false);
      expect(() => projectAdminAllowancePreview(preview)).toThrow();
    }
  });
});
