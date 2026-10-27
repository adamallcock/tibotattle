import { describe, expect, it } from "vitest";
import {
  ADMIN_MODEL_CONFIG,
  ADMIN_MODEL_HISTORY_CATALOG_VERSION,
  SEPTEMBER29_ADMIN_MODEL_CONFIG,
  SEPTEMBER29_ADMIN_MODEL_HISTORY_CATALOG_VERSION,
  expandAdminModelHistoryDay,
  projectAdminModelHistoryDay,
} from "../vendor/analytics-d43c8f92/packages/telemetry-contract/index.js";
import {
  buildAdminCommunityAllowancePreview,
  readCachedAdminCommunityAllowancePreview,
  validCachedAdminCommunityAllowancePreview,
} from "../vendor/analytics-d43c8f92/apps/worker/src/admin-community-allowance";

const DAY = "2026-10-26";
const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const SEPTEMBER23 = "reviewed-model-catalog-2026-09-23.1";

function modelDay(catalogVersion: string, modelId = "gpt-6.1-sol") {
  const value = projectAdminModelHistoryDay({
    day: DAY, catalogVersion, values: [[modelId, 500, 1]],
    fittedParticipantCount: 1, unstableParticipantCount: 0,
    staleParticipantCount: 0, refusedParticipantCount: 0,
    v1ParticipantCount: 1, unsupportedSourceParticipantCount: 0,
  });
  if (value === null) throw new Error("SYNTHETIC_MODEL_DAY_INVALID");
  return value;
}

function preview(length: 42 | 43 | 44) {
  const built = buildAdminCommunityAllowancePreview([], NOW);
  const config = length === 44 ? ADMIN_MODEL_CONFIG : SEPTEMBER29_ADMIN_MODEL_CONFIG.slice(0, length);
  const catalog = length === 42 ? SEPTEMBER23
    : length === 43 ? SEPTEMBER29_ADMIN_MODEL_HISTORY_CATALOG_VERSION : ADMIN_MODEL_HISTORY_CATALOG_VERSION;
  return { ...structuredClone(built), models: { ...structuredClone(built.models),
    modelConfig: config.map(model => ({ ...model })),
    days: [modelDay(catalog, length === 42 ? "gpt-6-astra" : "gpt-6.1-sol")],
  } };
}

function read(value: ReturnType<typeof preview>) {
  const db = { prepare: () => ({ bind: () => ({ first: async () => ({
    generated_at: value.generatedAt, payload_json: JSON.stringify(value),
  }) }) }) } as unknown as D1Database;
  return readCachedAdminCommunityAllowancePreview(db, NOW);
}

describe("vendored Terra catalog transition preserves retained v0.3 publications", () => {
  it("binds the exact frozen 43-row predecessor and the appended 44th identity", () => {
    expect(ADMIN_MODEL_CONFIG).toHaveLength(44);
    expect(ADMIN_MODEL_CONFIG.slice(0, 43)).toEqual(SEPTEMBER29_ADMIN_MODEL_CONFIG);
    expect(ADMIN_MODEL_CONFIG[42]?.modelId).toBe("gpt-6.1-sol");
    expect(ADMIN_MODEL_CONFIG[43]?.modelId).toBe("gpt-6.1-terra");
  });

  it.each([42, 43, 44] as const)("reads the exact %i-row contract without changing values, dates or units", async length => {
    const value = preview(length);
    const bytes = JSON.stringify(value);
    expect(value.schemaVersion).toBe("admin-community-allowance-preview-v0.3");
    expect(validCachedAdminCommunityAllowancePreview(value, value.generatedAt, NOW)).toBe(true);
    expect(await read(value)).toEqual(value);
    expect(JSON.stringify(value)).toBe(bytes);
    if (length === 42) {
      expect(expandAdminModelHistoryDay(value.models.days[0])?.byModel["gpt-6.1-terra"])
        .toEqual({ capacityUsd: null, participantCount: null });
    } else if (length === 43) {
      const expanded = expandAdminModelHistoryDay(value.models.days[0]);
      expect(Object.keys(expanded!.byModel)).toEqual(SEPTEMBER29_ADMIN_MODEL_CONFIG.map(model => model.modelId));
      expect(expanded!.byModel).not.toHaveProperty("gpt-6.1-terra");
    }
  });

  it("preserves bounded September29 stored labels while returning reviewed display copy", async () => {
    const value = preview(43);
    value.models.modelConfig[0]!.label = "Retained display copy";
    expect(validCachedAdminCommunityAllowancePreview(value, value.generatedAt, NOW)).toBe(true);
    expect(await read(value)).toEqual({ ...value, models: { ...value.models,
      modelConfig: SEPTEMBER29_ADMIN_MODEL_CONFIG,
    } });
    const september23 = preview(42);
    september23.models.modelConfig[0]!.label = "Retained display copy";
    expect(validCachedAdminCommunityAllowancePreview(september23, september23.generatedAt, NOW)).toBe(false);
  });

  it("refuses newer sparse evidence beneath either retained header", () => {
    for (const length of [42, 43] as const) {
      const value = preview(length);
      value.models.days = [modelDay(ADMIN_MODEL_HISTORY_CATALOG_VERSION, "gpt-6-astra")];
      expect(validCachedAdminCommunityAllowancePreview(value, value.generatedAt, NOW)).toBe(false);
    }
    const september23 = preview(42);
    september23.models.days = [modelDay(SEPTEMBER29_ADMIN_MODEL_HISTORY_CATALOG_VERSION, "gpt-6-astra")];
    expect(validCachedAdminCommunityAllowancePreview(september23, september23.generatedAt, NOW)).toBe(false);
  });

  it("refuses arbitrary roster prefixes, duplicates, order changes, and invalid retained labels", () => {
    const changes: ((value: ReturnType<typeof preview>) => void)[] = [
      value => { value.models.modelConfig.pop(); value.models.modelConfig.pop(); },
      value => { value.models.modelConfig.reverse(); },
      value => { value.models.modelConfig[1] = { ...value.models.modelConfig[0]! }; },
      value => { value.models.modelConfig[0]!.modelId = "gpt-6.1-terra"; },
      value => { value.models.modelConfig[0]!.label = ""; },
      value => { value.models.modelConfig[0]!.label = "x".repeat(81); },
    ];
    for (const change of changes) {
      const value = preview(43);
      change(value);
      expect(validCachedAdminCommunityAllowancePreview(value, value.generatedAt, NOW)).toBe(false);
    }
  });

  it("admits actual Terra values only with the current reviewed day catalog and header", () => {
    const value = preview(44);
    value.models.days = [modelDay(ADMIN_MODEL_HISTORY_CATALOG_VERSION, "gpt-6.1-terra")];
    expect(validCachedAdminCommunityAllowancePreview(value, value.generatedAt, NOW)).toBe(true);
    expect(value.models.days[0]!.values).toEqual([["gpt-6.1-terra", 500, 1]]);
    const retained = preview(43);
    retained.models.days[0] = { ...retained.models.days[0]!, values: [["gpt-6.1-terra", 500, 1]] };
    expect(validCachedAdminCommunityAllowancePreview(retained, retained.generatedAt, NOW)).toBe(false);
  });
});
