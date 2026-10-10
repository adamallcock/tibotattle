import { describe, expect, it } from "vitest";
import { buildAdminCommunityAllowancePreview, buildCommunityModelCompositionDay,
  projectPublicAllowanceGraphForGcp as projectBaseGraph, validReadableAdminCommunityAllowancePreview,
  validCachedAdminCommunityAllowancePreview, ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS, ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE } from "../src/analytics-v2/allowance-projection";
import { normalizeCommunityModelCompositionForDay } from "../src/admin-community-allowance";
import { COMMUNITY_ALLOWANCE_PROJECTION_METHOD_VERSION, COMMUNITY_ATTRIBUTION_METHOD_VERSION,
  COMMUNITY_ALLOWANCE_NORMALIZATION } from "../src/community-allowance";
import { buildAdminCommunityAllowancePreview as buildLegacyPreview,
  projectPublicAllowanceGraph as projectLegacyGraph, type CommunityModelComposition } from "../vendor/analytics-d43c8f92/entry";
import { reducePublicAllowanceBreakdownsV13 } from "../src/analytics-v2/public-allowance-breakdowns-v13";
import { reducePublicAllowanceBreakdownsV14, wrapPublicAllowanceBreakdownsV14 } from "../src/analytics-v2/public-allowance-breakdowns-v14";
import { readPostgresAdminAllowancePreview } from "../src/postgres-admin-allowance-preview";
import type { PostgresPool } from "../src/postgres-client";
import { buildCurrentPublicModelMetadata, withCurrentPublicModelMetadata } from "../src/analytics-v2/public-model-metadata-current";
const projectPublicAllowanceGraphForGcp = (...args: Parameters<typeof projectBaseGraph>) => withCurrentPublicModelMetadata(projectBaseGraph(...args));
const NOW = Date.parse("2026-10-09T12:00:00.000Z"), DAY = "2026-10-08";
const options = { publishedDays: [DAY], nowMs: NOW };
const metadata = [{ id: "gpt-6-astra", label: "GPT-6 Astra", family: "astra", order: 0 }];
const row = (preview: unknown) => ({ generated_at: new Date(NOW).toISOString(), payload_json: JSON.stringify(preview) });
const fits = ["pro", "prolite", "promax", "plus"].map((planType, i) => ({ participantId: `synthetic-owner-${i}`,
  planType, capacityNanousd: 1_000_000_000_000, lastObservedAt: `${DAY}T12:00:00.000Z` }));
function composition(planType: string): CommunityModelComposition {
  return { participantId: "synthetic-owner", composition: { status: "ready", planType,
    latestQuotaObservedAt: `${DAY}T12:00:00.000Z`, fit: { status: "fitted", capacityUsdByModel: { "gpt-6-astra": 100 } } } } as CommunityModelComposition;
}
describe("GCP current Pro 10x and retained legacy projection", () => {
  it("recomputes four plan contributions from unchanged raw fits", () => {
    const before = structuredClone(fits), preview = buildAdminCommunityAllowancePreview(fits, NOW), latest = preview.days.at(-1)!;
    expect(preview.schemaVersion).toBe("admin-community-allowance-preview-v0.4");
    expect(Object.fromEntries(Object.entries(latest.byPlanType).map(([plan, summary]) => [plan, summary.centralUsd])))
      .toEqual({ pro: 1000, prolite: 2000, promax: 400, plus: 10000 });
    expect(latest.combined.centralUsd).toBe(1500); expect(latest.combined.fitCount).toBe(4); expect(fits).toEqual(before);
    expect(COMMUNITY_ALLOWANCE_PROJECTION_METHOD_VERSION).toBe(`${COMMUNITY_ATTRIBUTION_METHOD_VERSION}:${COMMUNITY_ALLOWANCE_NORMALIZATION}`);
    expect(validReadableAdminCommunityAllowancePreview(preview, preview.generatedAt, NOW)).toBe(true);
  });
  it("uses real current ratios for models and preserves unstable/stale states", () => {
    for (const [plan, expected] of [["pro", 100], ["prolite", 200], ["promax", 40], ["plus", 1000]] as const) {
      expect(normalizeCommunityModelCompositionForDay(composition(plan).composition, DAY)).toEqual({ state: "fitted", values: { "gpt-6-astra": expected } });
      expect(buildCommunityModelCompositionDay({ compositions: [composition(plan)], v1ParticipantCount: 1,
        refusedParticipantCount: 0, unsupportedSourceParticipantCount: 0 }, DAY).values).toEqual([["gpt-6-astra", expected, 1]]);
    }
    expect(normalizeCommunityModelCompositionForDay(composition("unrecognized").composition, DAY)).toEqual({ state: "unstable" });
    const stale = composition("plus"); stale.composition.latestQuotaObservedAt = "2026-01-01T12:00:00.000Z";
    expect(normalizeCommunityModelCompositionForDay(stale.composition, DAY)).toEqual({ state: "stale" });
  });
  it("serves genuine v1.4 values, null gaps, closed days and no identifiers", () => {
    const graph = projectPublicAllowanceGraphForGcp(row(buildAdminCommunityAllowancePreview(fits, NOW)), options, metadata)!;
    expect(graph.breakdowns.schemaVersion).toBe("community-allowance-breakdowns-v1.4");
    expect(graph.breakdowns.normalization).toBe("pro_x1_prolite_x2_promax_x0_4_plus_x10");
    expect(graph.breakdowns.days[0]!.byPlanType.plus.centralUsd).toBe(10000); expect(graph.breakdowns.days[0]!.models).toEqual([]);
    expect(reducePublicAllowanceBreakdownsV14(graph.breakdowns).metadata).toEqual(buildCurrentPublicModelMetadata()); expect(graph.breakdowns.days).toHaveLength(1);
    expect(JSON.stringify(graph)).not.toContain("synthetic-owner");
    const absent = projectPublicAllowanceGraphForGcp(row(buildAdminCommunityAllowancePreview([], NOW)), options, metadata)!;
    expect(absent.breakdowns.days[0]!.combined.centralUsd).toBeNull(); expect(absent.breakdowns.days[0]!.byPlanType.plus.centralUsd).toBeNull();
  });
  it("names current reviewed models without changing a published GPT-6.1 Sol tuple", () => {
    const currentMetadata = buildCurrentPublicModelMetadata();
    expect(currentMetadata.map(entry => entry.id)).toEqual([
      "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna",
      "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna",
    ]);
    expect(currentMetadata[1]).toEqual({ id: "gpt-6.1-sol", label: "GPT-6.1 Sol", family: "sol", order: 1 });
    const raw = composition("pro"); raw.composition.fit.capacityUsdByModel = { "gpt-6.1-sol": 123.45 };
    const modelDay = buildCommunityModelCompositionDay({ compositions: [raw], v1ParticipantCount: 1,
      refusedParticipantCount: 0, unsupportedSourceParticipantCount: 0 }, DAY);
    const preview = buildAdminCommunityAllowancePreview(fits, NOW, fits.map(fit => fit.participantId), {
      modelConfig: ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG, basis: ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
      gate: ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE, days: [modelDay],
    });
    const before = structuredClone(preview);
    const graph = projectPublicAllowanceGraphForGcp(row(preview), options, metadata)!;
    expect(graph.breakdowns.days[0]!.models).toEqual([["gpt-6.1-sol", 123.45, 1]]);
    expect(graph.breakdowns.modelConfig).toEqual(currentMetadata); expect(preview).toEqual(before);
    expect(projectPublicAllowanceGraphForGcp(row(preview), { ...options, publishedDays: [] }, metadata)).toBeNull();
    const missing = projectPublicAllowanceGraphForGcp(row(buildAdminCommunityAllowancePreview(fits, NOW)), options, metadata)!;
    expect(missing.breakdowns.days[0]!.models).toEqual([]);
    const legacy = projectPublicAllowanceGraphForGcp(row(buildLegacyPreview(fits, NOW)), options, metadata)!;
    expect(legacy.breakdowns.modelConfig).toEqual(metadata);
  });
  it("keeps retained v0.3 values byte equivalent to the v1.1 oracle under v1.3", () => {
    const preview = buildLegacyPreview(fits, NOW);
    expect(validCachedAdminCommunityAllowancePreview(preview, preview.generatedAt, NOW)).toBe(false);
    expect(validReadableAdminCommunityAllowancePreview(preview, preview.generatedAt, NOW)).toBe(true);
    const graph = projectPublicAllowanceGraphForGcp(row(preview), options, metadata)!;
    expect(graph.breakdowns.schemaVersion).toBe("community-allowance-breakdowns-v1.3");
    expect(graph.breakdowns.days[0]!.byPlanType.plus.centralUsd).toBe(20000);
    expect(reducePublicAllowanceBreakdownsV13(graph.breakdowns).base).toEqual(projectLegacyGraph(row(preview), options)!.breakdowns);
  });
  it("admin readback accepts both exact contracts using one read-only snapshot", async () => {
    for (const preview of [buildAdminCommunityAllowancePreview(fits, NOW), buildLegacyPreview(fits, NOW)]) {
      const statements: string[] = [];
      let released = false;
      const pool = { connect: async () => ({
        query: async (sql: string) => {
          statements.push(sql);
          return { rows: sql.includes("SELECT preview::text") ? [{ preview_text: JSON.stringify(preview) }] : [], rowCount: null };
        },
        release: () => { released = true; },
      }) } as PostgresPool;
      expect(await readPostgresAdminAllowancePreview(pool, "synthetic_schema", NOW)).toEqual(preview);
      expect(statements.filter(sql => sql.includes("SELECT preview::text"))).toHaveLength(1);
      expect(statements[0]).toContain("READ ONLY");
      expect(statements.some(sql => /\b(?:INSERT|DELETE|UPDATE)\b/u.test(sql))).toBe(false);
      expect(released).toBe(true);
    }
  });

  it("refuses crossed meanings, unknown fields, malformed metadata and unavailable rows", () => {
    const current = buildAdminCommunityAllowancePreview(fits, NOW), legacy = buildLegacyPreview(fits, NOW);
    for (const altered of [{ ...current, schemaVersion: legacy.schemaVersion }, { ...current, basis: legacy.basis },
      { ...legacy, schemaVersion: current.schemaVersion }, { ...legacy, plans: current.plans }, { ...current, participantId: "private-field" }]) {
      expect(validReadableAdminCommunityAllowancePreview(altered, current.generatedAt, NOW)).toBe(false);
      expect(projectPublicAllowanceGraphForGcp(row(altered), options, metadata)).toBeNull();
    }
    const base = reducePublicAllowanceBreakdownsV14(projectPublicAllowanceGraphForGcp(row(current), options, metadata)!.breakdowns).base;
    expect(() => wrapPublicAllowanceBreakdownsV14({ ...base, normalization: "pro_x1_prolite_x4_plus_x20" }, metadata)).toThrow();
    expect(() => wrapPublicAllowanceBreakdownsV14(base, [{ ...metadata[0]!, order: -1 }])).toThrow();
    expect(projectPublicAllowanceGraphForGcp(null, options, metadata)).toBeNull();
    expect(projectPublicAllowanceGraphForGcp({ generated_at: current.generatedAt, payload_json: "x".repeat(256 * 1024 + 1) }, options, metadata)).toBeNull();
    expect(projectPublicAllowanceGraphForGcp(row(current), { ...options, publishedDays: [] }, metadata)).toBeNull();
  });
});
