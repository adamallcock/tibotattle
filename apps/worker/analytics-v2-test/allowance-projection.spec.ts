import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAdminCommunityAllowancePreview, buildCommunityModelCompositionDay,
  projectPublicAllowanceGraphForGcp as projectBaseGraph, validReadableAdminCommunityAllowancePreview,
  validCachedAdminCommunityAllowancePreview, ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS, ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE } from "../src/analytics-v2/allowance-projection";
import { normalizeCommunityModelCompositionForDay, validRetainedPro10AdminCommunityAllowancePreview,
  type AdminCommunityAllowanceSummary } from "../src/admin-community-allowance";
import { COMMUNITY_ALLOWANCE_PROJECTION_METHOD_VERSION, COMMUNITY_ATTRIBUTION_METHOD_VERSION,
  COMMUNITY_ALLOWANCE_NORMALIZATION } from "../src/community-allowance";
import { projectRetainedPro10PublicAllowanceGraph } from "../src/public-allowance-breakdowns";
import { buildAdminCommunityAllowancePreview as buildLegacyPreview,
  projectPublicAllowanceGraph as projectLegacyGraph, type CommunityModelComposition } from "../vendor/analytics-d43c8f92/entry";
import { reducePublicAllowanceBreakdownsV13 } from "../src/analytics-v2/public-allowance-breakdowns-v13";
import { reducePublicAllowanceBreakdownsV14, wrapPublicAllowanceBreakdownsV14 } from "../src/analytics-v2/public-allowance-breakdowns-v14";
import { reducePublicAllowanceBreakdownsV15, wrapPublicAllowanceBreakdownsV15 } from "../src/analytics-v2/public-allowance-breakdowns-v15";
import { readPostgresAdminAllowancePreview } from "../src/postgres-admin-allowance-preview";
import type { PostgresPool } from "../src/postgres-client";
import { buildCurrentPublicModelMetadata, withCurrentPublicModelMetadata } from "../src/analytics-v2/public-model-metadata-current";
import { goldenAllowanceInputs, goldenPublishedDays } from "./fixtures/allowance-golden-inputs.mjs";
const projectPublicAllowanceGraphForGcp = (...args: Parameters<typeof projectBaseGraph>) => withCurrentPublicModelMetadata(projectBaseGraph(...args));
const NOW = Date.parse("2026-10-09T12:00:00.000Z"), DAY = "2026-10-08";
const options = { publishedDays: [DAY], nowMs: NOW };
const metadata = [{ id: "gpt-6-astra", label: "GPT-6 Astra", family: "astra", order: 0 }];
const row = (preview: unknown) => ({ generated_at: new Date(NOW).toISOString(), payload_json: JSON.stringify(preview) });
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").trimEnd();
const fits = ["pro", "prolite", "promax", "plus"].map((planType, i) => ({ participantId: `synthetic-owner-${i}`,
  planType, capacityNanousd: 1_000_000_000_000, lastObservedAt: `${DAY}T12:00:00.000Z` }));
const EMPTY = { fitCount: 0, participantCount: 0, centralUsd: null, band80Usd: null };
const PUBLIC_EMPTY = { centralUsd: null, participantCount: 0, fitCount: 0, band80Usd: null };
const B_PRIME = {
  basis: "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d_promax25",
  normalization: "pro_x1_prolite_x4_promax_x0_8_plus_x20",
  modelBasis: "seven_day_codex_pro20x_equivalent_per_model_composition_promax25",
  plans: [
    { planType: "pro", label: "Pro 20x", multiplier: 1 },
    { planType: "prolite", label: "Pro 5x", multiplier: 4 },
    { planType: "promax", label: "Pro Max 25x", multiplier: 0.8 },
    { planType: "plus", label: "Plus", multiplier: 20 },
  ],
} as const;
function composition(planType: string): CommunityModelComposition {
  return { participantId: "synthetic-owner", composition: { status: "ready", planType,
    latestQuotaObservedAt: `${DAY}T12:00:00.000Z`, fit: { status: "fitted", capacityUsdByModel: { "gpt-6-astra": 100 } } } } as CommunityModelComposition;
}
/** The retained v0.4 golden, built by the Pro 10x builder at 22d9d90f. */
function golden() {
  const text = fixture("allowance-preview-v04.json");
  const value = JSON.parse(text);
  return { text, value, row: { generated_at: value.generatedAt as string, payload_json: text } };
}
/** The golden's raw inputs rebuilt by the CURRENT builder (v0.5). */
function currentFromGoldenInputs() {
  const inputs = goldenAllowanceInputs();
  const modelDays = inputs.modelDayDates.map((day) => buildCommunityModelCompositionDay({
    compositions: inputs.compositions as unknown as CommunityModelComposition[],
    v1ParticipantCount: inputs.compositions.length + 1, refusedParticipantCount: 1,
    unsupportedSourceParticipantCount: 0 }, day));
  return buildAdminCommunityAllowancePreview(inputs.fits, inputs.nowMs, inputs.participantIds, {
    modelConfig: ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG, basis: ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
    gate: ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE, days: modelDays });
}
/** Deterministic non-round synthetic fits on the given plans, inside the preview horizon. */
function randomFits(seed: number, plans: readonly string[], nowMs: number) {
  let state = seed >>> 0;
  const rand = () => { state = (state * 1_103_515_245 + 12_345) >>> 0; return state / 2 ** 32; };
  const scale: Record<string, number> = { pro: 1_400, prolite: 350, promax: 1_750, plus: 70, team: 500 };
  return Array.from({ length: 20 + Math.floor(rand() * 60) }, (_, index) => {
    const planType = plans[Math.floor(rand() * plans.length)]!;
    return { participantId: `synthetic-random-${seed}-${index % 11}`, planType,
      capacityNanousd: Math.round(scale[planType]! * (0.5 + rand()) * 1e9) + Math.floor(rand() * 997),
      lastObservedAt: new Date(nowMs - rand() * 99 * 86_400_000).toISOString() };
  });
}

describe("GCP current Pro 20x B' projection with retained Pro 10x and legacy projections", () => {
  it("recomputes four plan contributions from unchanged raw fits in Pro 20x-week units", () => {
    const before = structuredClone(fits), preview = buildAdminCommunityAllowancePreview(fits, NOW), latest = preview.days.at(-1)!;
    expect(preview.schemaVersion).toBe("admin-community-allowance-preview-v0.5");
    expect(preview.basis).toBe(`${B_PRIME.basis}_preview`);
    expect(preview.referencePlanType).toBe("pro");
    expect(preview.plans).toEqual(B_PRIME.plans);
    expect(preview.models.basis).toBe(B_PRIME.modelBasis);
    expect(preview.models.gate).toBe("shared_composition_kernel_identification");
    expect(Object.fromEntries(Object.entries(latest.byPlanType).map(([plan, summary]) => [plan, summary.centralUsd])))
      .toEqual({ pro: 1000, prolite: 4000, promax: 800, plus: 20000 });
    expect(Object.keys(latest.byPlanType)).toEqual(["pro", "prolite", "promax", "plus"]);
    expect(latest.combined).toEqual({ fitCount: 4, participantCount: 4, centralUsd: 2500,
      band80Usd: { lowerUsd: 860, upperUsd: 15200 } });
    expect(fits).toEqual(before);
    expect(COMMUNITY_ALLOWANCE_NORMALIZATION).toBe(B_PRIME.normalization);
    expect(COMMUNITY_ALLOWANCE_PROJECTION_METHOD_VERSION).toBe(`${COMMUNITY_ATTRIBUTION_METHOD_VERSION}:${B_PRIME.normalization}`);
    expect(validCachedAdminCommunityAllowancePreview(preview, preview.generatedAt, NOW)).toBe(true);
    expect(validRetainedPro10AdminCommunityAllowancePreview(preview, preview.generatedAt, NOW)).toBe(false);
    expect(validReadableAdminCommunityAllowancePreview(preview, preview.generatedAt, NOW)).toBe(true);
  });

  it("uses the B' ratios for models, with Pro Max at x0.8, and preserves unstable/stale states", () => {
    for (const [plan, expected] of [["pro", 100], ["prolite", 400], ["promax", 80], ["plus", 2000]] as const) {
      expect(normalizeCommunityModelCompositionForDay(composition(plan).composition, DAY)).toEqual({ state: "fitted", values: { "gpt-6-astra": expected } });
      expect(buildCommunityModelCompositionDay({ compositions: [composition(plan)], v1ParticipantCount: 1,
        refusedParticipantCount: 0, unsupportedSourceParticipantCount: 0 }, DAY).values).toEqual([["gpt-6-astra", expected, 1]]);
    }
    expect(normalizeCommunityModelCompositionForDay(composition("unrecognized").composition, DAY)).toEqual({ state: "unstable" });
    const stale = composition("plus"); stale.composition.latestQuotaObservedAt = "2026-01-01T12:00:00.000Z";
    expect(normalizeCommunityModelCompositionForDay(stale.composition, DAY)).toEqual({ state: "stale" });
  });

  it("converts a Pro Max 25x fit to the Pro 20x reference at x0.8 and keeps its own week invertible", () => {
    const promax = [{ participantId: "synthetic-promax", planType: "promax", capacityNanousd: 1_750_000_000_000,
      lastObservedAt: `${DAY}T12:00:00.000Z` }];
    const latest = buildAdminCommunityAllowancePreview(promax, NOW).days.at(-1)!;
    expect(latest.byPlanType.promax).toEqual({ fitCount: 1, participantCount: 1, centralUsd: 1400, band80Usd: null });
    expect(latest.combined).toEqual(latest.byPlanType.promax);
    expect(latest.byPlanType.promax.centralUsd! / 0.8).toBeCloseTo(1750, 9);
    for (const plan of ["pro", "prolite", "plus"] as const) expect(latest.byPlanType[plan]).toEqual(EMPTY);
  });

  it("serves genuine v1.5 values with the current metadata block, null gaps, closed days and no identifiers", () => {
    const graph = projectPublicAllowanceGraphForGcp(row(buildAdminCommunityAllowancePreview(fits, NOW)), options, metadata)!;
    expect(Object.keys(graph.breakdowns)).toEqual(["schemaVersion", "basis", "referencePlanType", "normalization",
      "modelBasis", "modelGate", "generatedAt", "days", "modelConfig"]);
    expect(graph.breakdowns).toMatchObject({ schemaVersion: "community-allowance-breakdowns-v1.5", basis: B_PRIME.basis,
      referencePlanType: "pro", normalization: B_PRIME.normalization, modelBasis: B_PRIME.modelBasis,
      modelGate: "shared_composition_kernel_identification" });
    const day = graph.breakdowns.days[0]!;
    expect(Object.keys(day.byPlanType)).toEqual(["pro", "prolite", "promax", "plus"]);
    expect(Object.fromEntries(Object.entries(day.byPlanType).map(([plan, summary]) => [plan, summary.centralUsd])))
      .toEqual({ pro: 1000, prolite: 4000, promax: 800, plus: 20000 });
    expect(day.combined.centralUsd).toBe(2500); expect(day.models).toEqual([]);
    const reduced = reducePublicAllowanceBreakdownsV15(graph.breakdowns);
    expect(reduced.metadata).toEqual(buildCurrentPublicModelMetadata());
    // The base already carries v1.5: the block is the only declared difference.
    expect(reduced.base.schemaVersion).toBe("community-allowance-breakdowns-v1.5");
    expect(wrapPublicAllowanceBreakdownsV15(reduced.base, reduced.metadata)).toEqual(graph.breakdowns);
    expect(graph.breakdowns.days).toHaveLength(1);
    expect(JSON.stringify(graph)).not.toContain("synthetic-owner");
    // Without the route's current presentation the caller's block is carried unchanged.
    expect(projectBaseGraph(row(buildAdminCommunityAllowancePreview(fits, NOW)), options, metadata)!.breakdowns.modelConfig)
      .toEqual(metadata);
    const absent = projectPublicAllowanceGraphForGcp(row(buildAdminCommunityAllowancePreview([], NOW)), options, metadata)!;
    expect(absent.breakdowns.days[0]!.combined.centralUsd).toBeNull(); expect(absent.breakdowns.days[0]!.byPlanType.plus.centralUsd).toBeNull();
    // Pro Max is always published, as an explicit empty summary when it has no fit.
    const withoutPromax = projectPublicAllowanceGraphForGcp(row(buildAdminCommunityAllowancePreview(
      fits.filter((fit) => fit.planType !== "promax"), NOW)), options, metadata)!;
    expect(withoutPromax.breakdowns.days[0]!.byPlanType.promax).toEqual(PUBLIC_EMPTY);
    expect(Object.keys(withoutPromax.breakdowns.days[0]!.byPlanType)).toEqual(["pro", "prolite", "promax", "plus"]);
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
    expect(graph.breakdowns.schemaVersion).toBe("community-allowance-breakdowns-v1.5");
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
    expect(validRetainedPro10AdminCommunityAllowancePreview(preview, preview.generatedAt, NOW)).toBe(false);
    expect(validReadableAdminCommunityAllowancePreview(preview, preview.generatedAt, NOW)).toBe(true);
    const graph = projectPublicAllowanceGraphForGcp(row(preview), options, metadata)!;
    expect(graph.breakdowns.schemaVersion).toBe("community-allowance-breakdowns-v1.3");
    expect(graph.breakdowns.days[0]!.byPlanType.plus.centralUsd).toBe(20000);
    expect(reducePublicAllowanceBreakdownsV13(graph.breakdowns).base).toEqual(projectLegacyGraph(row(preview), options)!.breakdowns);
  });

  it("projects the retained v0.4 golden to byte-identical v1.4 and its unchanged v1.2 base", () => {
    const { text, value, row: goldenRow } = golden(), inputs = goldenAllowanceInputs();
    const expected = fixture("allowance-breakdowns-v14-expected.json");
    // Both files are the 22d9d90f outputs, pinned so neither can be regenerated silently.
    expect(sha256(text)).toBe("d4071f52424102e622c56b4fbe97d110aff179534a1872496d59021257653a3b");
    expect(sha256(expected)).toBe("cc7f6ed051aefcbe30af249532bb622bfd9cdae6d408c27d479cc9db304ac34d");
    expect(value.schemaVersion).toBe("admin-community-allowance-preview-v0.4");
    expect(value.generatedAt).toBe(new Date(inputs.nowMs).toISOString());
    expect(validCachedAdminCommunityAllowancePreview(value, value.generatedAt, inputs.nowMs)).toBe(false);
    expect(validRetainedPro10AdminCommunityAllowancePreview(value, value.generatedAt, inputs.nowMs)).toBe(true);
    expect(validReadableAdminCommunityAllowancePreview(value, value.generatedAt, inputs.nowMs)).toBe(true);
    const goldenOptions = { publishedDays: goldenPublishedDays(value), nowMs: inputs.nowMs };
    const graph = projectPublicAllowanceGraphForGcp(goldenRow, goldenOptions, inputs.metadata)!;
    expect(JSON.stringify(graph.breakdowns)).toBe(expected);
    expect(graph.breakdowns.days.some((day) => day.byPlanType.promax.fitCount > 0)).toBe(true);
    const base = projectRetainedPro10PublicAllowanceGraph(goldenRow, goldenOptions)!.breakdowns;
    expect(base.schemaVersion).toBe("community-allowance-breakdowns-v1.2");
    expect(JSON.stringify(base)).toBe(JSON.stringify(reducePublicAllowanceBreakdownsV14(graph.breakdowns).base));
    expect(sha256(JSON.stringify(base))).toBe("e8346f3bed9dac3d66498857c90d66791dcb74cbd26b1a889f299a5a577e3f9e");
    expect(fixture("allowance-preview-v04.json")).toBe(text);
  });

  it("rebuilds the golden's raw inputs as v0.5: Pro unchanged, other own weeks within sub-cent rounding of v1.4", () => {
    const { value: retained } = golden(), current = currentFromGoldenInputs();
    expect(current.schemaVersion).toBe("admin-community-allowance-preview-v0.5");
    expect(current.coverage).toEqual(retained.coverage);
    expect(current.days.map((day) => day.day)).toEqual(retained.days.map((day: { day: string }) => day.day));
    // v1.4 published value x a and v1.5 publishes value x 2a, each rounded to
    // four decimals; the own week (published / factor) can only move by half
    // a rounding step over a.
    const tolerance = (factor: number) => 0.5e-4 / factor + 1e-9;
    const pairs = [["prolite", 4, 2], ["promax", 0.8, 0.4], ["plus", 20, 10]] as const;
    let compared = 0;
    for (const [index, day] of current.days.entries()) {
      const before = retained.days[index].byPlanType as Record<string, AdminCommunityAllowanceSummary>;
      expect(day.byPlanType.pro).toEqual(before.pro);
      for (const [plan, now, then] of pairs) {
        const after = day.byPlanType[plan], old = before[plan]!;
        expect([after.fitCount, after.participantCount]).toEqual([old.fitCount, old.participantCount]);
        expect(after.centralUsd === null).toBe(old.centralUsd === null);
        expect(after.band80Usd === null).toBe(old.band80Usd === null);
        const values = [[after.centralUsd, old.centralUsd], [after.band80Usd?.lowerUsd, old.band80Usd?.lowerUsd],
          [after.band80Usd?.upperUsd, old.band80Usd?.upperUsd]];
        for (const [next, previous] of values) {
          if (next === null || next === undefined) continue;
          expect(Math.abs(next / now - previous! / then)).toBeLessThanOrEqual(tolerance(then));
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(200);
  });

  it("matches the vendored v0.3 Pro 20x build bitwise for Pro, Pro 5x, Plus and combined without Pro Max fits", () => {
    const nowMs = Date.parse("2026-10-08T12:00:00.000Z");
    for (let trial = 1; trial <= 25; trial++) {
      const sample = randomFits(trial * 7_919, ["pro", "prolite", "plus", "team"], nowMs);
      const current = buildAdminCommunityAllowancePreview(sample, nowMs), legacy = buildLegacyPreview(sample, nowMs);
      expect(current.coverage).toEqual(legacy.coverage);
      for (const [index, day] of current.days.entries()) {
        const old = legacy.days[index]!;
        expect(JSON.stringify([day.day, day.combined, day.byPlanType.pro, day.byPlanType.prolite, day.byPlanType.plus]))
          .toBe(JSON.stringify([old.day, old.combined, old.byPlanType.pro, old.byPlanType.prolite, old.byPlanType.plus]));
        expect(day.byPlanType.promax).toEqual(EMPTY);
      }
    }
  });

  it("reproduces an Oct 5 pre-cutover Pro 20x combined value exactly under v1.5 and v1.3", () => {
    // Synthetic: the median lands on one Plus fit, $70.08732 x 20 = $1,401.7464.
    const observed = "2026-10-04T12:00:00.000Z";
    const sample = ([["pro", 1_250_500_000_000], ["pro", 1_620_250_000_000], ["prolite", 300_100_000_000],
      ["plus", 70_087_320_000], ["plus", 95_500_000_000]] as const).map(([planType, capacityNanousd], index) => ({
      participantId: `synthetic-oct5-${index}`, planType: planType as string, capacityNanousd, lastObservedAt: observed }));
    const current = buildAdminCommunityAllowancePreview(sample, NOW), legacy = buildLegacyPreview(sample, NOW);
    const oct5 = <T extends { day: string }>(days: readonly T[]) => days.find((day) => day.day === "2026-10-05")!;
    expect(oct5(current.days).combined).toEqual({ fitCount: 5, participantCount: 5, centralUsd: 1401.7464,
      band80Usd: { lowerUsd: 1220.44, upperUsd: 1794.1 } });
    expect(oct5(current.days).combined).toEqual(oct5(legacy.days).combined);
    const published = { publishedDays: ["2026-10-05"], nowMs: NOW };
    const v15 = projectPublicAllowanceGraphForGcp(row(current), published, metadata)!;
    const v13 = projectPublicAllowanceGraphForGcp(row(legacy), published, metadata)!;
    expect(v15.breakdowns.schemaVersion).toBe("community-allowance-breakdowns-v1.5");
    expect(v13.breakdowns.schemaVersion).toBe("community-allowance-breakdowns-v1.3");
    expect(v15.breakdowns.days[0]!.combined.centralUsd).toBe(1401.7464);
    expect(v15.breakdowns.days[0]!.combined).toEqual(v13.breakdowns.days[0]!.combined);
    for (const plan of ["pro", "prolite", "plus"] as const) {
      expect(v15.breakdowns.days[0]!.byPlanType[plan]).toEqual(v13.breakdowns.days[0]!.byPlanType[plan]);
    }
    expect(v15.breakdowns.days[0]!.byPlanType.promax).toEqual(PUBLIC_EMPTY);
  });

  it("admin readback accepts the three exact contracts using one read-only snapshot", async () => {
    const retained = golden().value;
    for (const preview of [buildAdminCommunityAllowancePreview(fits, NOW), retained, buildLegacyPreview(fits, NOW)]) {
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

  it("refuses crossed meanings among v0.3, v0.4 and v0.5, unknown fields, malformed metadata and unavailable rows", () => {
    const current = buildAdminCommunityAllowancePreview(fits, NOW), legacy = buildLegacyPreview(fits, NOW);
    const retained = golden().value;
    const contracts = { current, retained, legacy } as unknown as Record<string,
      Record<string, unknown> & { models: Record<string, unknown> }>;
    const altered: unknown[] = [{ ...current, participantId: "private-field" }];
    for (const [name, target] of Object.entries(contracts)) {
      for (const [other, source] of Object.entries(contracts)) {
        if (name === other) continue;
        for (const field of ["schemaVersion", "basis", "plans"]) {
          expect(source[field]).not.toEqual(target[field]);
          altered.push({ ...target, [field]: source[field] });
        }
        expect(source.models.basis).not.toEqual(target.models.basis);
        altered.push({ ...target, models: { ...target.models, basis: source.models.basis } });
      }
    }
    expect(altered).toHaveLength(1 + 6 * 4);
    for (const value of altered) {
      expect(validReadableAdminCommunityAllowancePreview(value, current.generatedAt, NOW)).toBe(false);
      expect(projectPublicAllowanceGraphForGcp(row(value), options, metadata)).toBeNull();
      expect(projectRetainedPro10PublicAllowanceGraph(row(value), options)).toBeNull();
    }
    const v15 = projectPublicAllowanceGraphForGcp(row(current), options, metadata)!.breakdowns;
    const base15 = reducePublicAllowanceBreakdownsV15(v15).base;
    const v14 = projectPublicAllowanceGraphForGcp(golden().row, { publishedDays: goldenPublishedDays(retained), nowMs: NOW },
      metadata)!.breakdowns;
    const base14 = reducePublicAllowanceBreakdownsV14(v14).base;
    // Each wrapper takes exactly its own base; neither relabels the other's meaning.
    expect(() => wrapPublicAllowanceBreakdownsV15(base14, metadata)).toThrow();
    expect(() => wrapPublicAllowanceBreakdownsV15({ ...base14, schemaVersion: "community-allowance-breakdowns-v1.5" }, metadata)).toThrow();
    expect(() => wrapPublicAllowanceBreakdownsV14(base15, metadata)).toThrow();
    expect(() => wrapPublicAllowanceBreakdownsV14({ ...base15, schemaVersion: "community-allowance-breakdowns-v1.2" }, metadata)).toThrow();
    for (const field of ["basis", "normalization", "modelBasis"]) {
      expect(() => wrapPublicAllowanceBreakdownsV15({ ...base15, [field]: base14[field] }, metadata)).toThrow();
      expect(() => wrapPublicAllowanceBreakdownsV14({ ...base14, [field]: base15[field] }, metadata)).toThrow();
    }
    expect(() => wrapPublicAllowanceBreakdownsV15({ ...base15, normalization: "pro_x1_prolite_x4_plus_x20" }, metadata)).toThrow();
    expect(() => wrapPublicAllowanceBreakdownsV15(base15, [{ ...metadata[0]!, order: -1 }])).toThrow();
    expect(() => reducePublicAllowanceBreakdownsV15(v14)).toThrow();
    expect(() => reducePublicAllowanceBreakdownsV14(v15)).toThrow();
    // An unwrapped v1.5 envelope is not a served contract.
    expect(() => reducePublicAllowanceBreakdownsV15(base15)).toThrow();
    expect(projectPublicAllowanceGraphForGcp(null, options, metadata)).toBeNull();
    expect(projectPublicAllowanceGraphForGcp({ generated_at: current.generatedAt, payload_json: "x".repeat(256 * 1024 + 1) }, options, metadata)).toBeNull();
    expect(projectPublicAllowanceGraphForGcp(row(current), { ...options, publishedDays: [] }, metadata)).toBeNull();
  });
});
