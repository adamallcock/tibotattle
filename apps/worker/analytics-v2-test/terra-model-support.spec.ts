import { describe, expect, it } from "vitest";
import { ADMIN_MODEL_CONFIG, ADMIN_MODEL_HISTORY_CATALOG_VERSION,
  SEPTEMBER29_ADMIN_MODEL_CONFIG, SEPTEMBER29_ADMIN_MODEL_HISTORY_CATALOG_VERSION,
  projectAdminModelHistoryDay } from "@app-usagemonitor/telemetry-contract";
import { buildAdminCommunityAllowancePreview, readCachedAdminCommunityAllowancePreview,
  validCachedAdminCommunityAllowancePreview } from "../src/admin-community-allowance";
import { buildCurrentPublicModelMetadata } from "../src/analytics-v2/public-model-metadata-current";
import { projectAdminAllowancePreview } from "../../web/public/admin-client.js";

const NOW = Date.parse("2026-10-27T12:00:00.000Z"), DAY = "2026-10-26";
const SEPTEMBER23 = "reviewed-model-catalog-2026-09-23.1";
const catalogs = [
  { models: SEPTEMBER29_ADMIN_MODEL_CONFIG.slice(0, 42), version: SEPTEMBER23, model: "gpt-6-astra" },
  { models: SEPTEMBER29_ADMIN_MODEL_CONFIG, version: SEPTEMBER29_ADMIN_MODEL_HISTORY_CATALOG_VERSION, model: "gpt-6.1-sol" },
  { models: ADMIN_MODEL_CONFIG, version: ADMIN_MODEL_HISTORY_CATALOG_VERSION, model: "gpt-6.1-terra" },
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

describe("Terra server and admin catalog contracts", () => {
  it("appends the wire identity and inserts current presentation before the previous Terra", () => {
    const preview = buildAdminCommunityAllowancePreview([], NOW);
    expect(preview.models.modelConfig).toHaveLength(44);
    expect(preview.models.modelConfig.slice(0, 43)).toEqual(SEPTEMBER29_ADMIN_MODEL_CONFIG);
    expect(preview.models.modelConfig[43]).toEqual({ modelId: "gpt-6.1-terra", label: "GPT-6.1 Terra",
      allowanceTrack: "primary", pricingStatus: "published" });
    expect(buildCurrentPublicModelMetadata().map(model => model.id)).toEqual([
      "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-terra",
      "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna",
    ]);
  });

  it("reads all three exact headers without changing stored values, dates or historical coverage", async () => {
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
      expect(JSON.stringify(preview)).toBe(before);
    }
  });

  it("refuses crossed catalog claims even when the newer day's sparse values contain only old models", () => {
    for (const index of [0, 1]) for (const newer of catalogs.slice(index + 1)) {
      const preview = previewFor(index);
      preview.models.days = [{ ...preview.models.days[0]!, catalogVersion: newer.version }];
      expect(validCachedAdminCommunityAllowancePreview(preview, preview.generatedAt, NOW)).toBe(false);
      expect(() => projectAdminAllowancePreview(preview)).toThrow();
    }
    for (const mutate of [
      (preview: any) => { preview.models.modelConfig = preview.models.modelConfig.slice(0, 41); },
      (preview: any) => { preview.models.modelConfig.reverse(); },
      (preview: any) => { preview.models.modelConfig[43].modelId = "unreviewed-model"; },
      (preview: any) => { preview.models.modelConfig[43].pricingStatus = "unpriced"; },
      (preview: any) => { preview.models.modelConfig[43].allowanceTrack = "spark"; },
      (preview: any) => { preview.models.days[0].catalogVersion = "reviewed-model-catalog-2026-10-27.1"; },
    ]) {
      const preview = structuredClone(previewFor(2)); mutate(preview);
      expect(validCachedAdminCommunityAllowancePreview(preview, preview.generatedAt, NOW)).toBe(false);
      expect(() => projectAdminAllowancePreview(preview)).toThrow();
    }
  });
});
