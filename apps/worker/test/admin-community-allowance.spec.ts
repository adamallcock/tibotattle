import { describe, expect, it } from "vitest";
import {
  calibrateCompositionCapacities,
  MODEL_COMPOSITION_POLICY,
} from "@app-usagemonitor/quota-analysis";

import {
  ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
  ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_BASIS,
  ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS,
  ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_SCHEMA_VERSION,
  buildAdminCommunityAllowancePreview,
  buildAdminCommunityAllowancePreviewFromSource,
  readCachedAdminCommunityAllowancePreview,
  warmAdminCommunityAllowancePreviewCache,
} from "../src/admin-community-allowance";
import {
  readCachedCommunityAllowanceCorpus,
  readCachedCommunityAllowanceFits,
  summarizeCommunityAllowanceDay,
} from "../src/community-allowance";
import type {
  CommunityAllowanceFit,
  CommunityModelCompositionObservation,
} from "../src/community-allowance";

interface CacheRow {
  participant_id: string;
  source: "v0.2" | "v1";
  has_v1: number;
  expected_cache_key: string | null;
  cache_key: string | null;
  fits_json: string | null;
  model_observations_json: string | null;
}

function cacheDatabase(rows: CacheRow[], { fail = false } = {}) {
  const statements: string[] = [];
  const bindings: unknown[][] = [];
  const database = {
    prepare(statement: string) {
      statements.push(statement);
      return {
        bind(...values: unknown[]) {
          bindings.push(values);
          return {
            async all() {
              if (fail) throw new Error("cache unavailable");
              return { results: rows };
            },
            async run() {
              throw new Error("read-only cache reader attempted a write");
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { database, statements, bindings };
}

function previewCacheDatabase(
  row: { generated_at: string; payload_json: string } | null,
  { fail = false }: { fail?: boolean } = {},
) {
  const statements: string[] = [];
  const bindings: unknown[][] = [];
  const database = {
    prepare(statement: string) {
      statements.push(statement);
      if (fail) throw new Error("preview cache unavailable");
      return {
        bind(...values: unknown[]) {
          bindings.push(values);
          return {
            async first() {
              return row;
            },
            async all() {
              throw new Error("interactive preview attempted a corpus read");
            },
            async run() {
              throw new Error("interactive preview attempted a write");
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { database, statements, bindings };
}

function previewRow(
  preview: ReturnType<typeof buildAdminCommunityAllowancePreview>,
): { generated_at: string; payload_json: string } {
  return {
    generated_at: preview.generatedAt,
    payload_json: JSON.stringify(preview),
  };
}

function previewWarmDatabase(
  rows: CacheRow[],
  options: {
    existing?: { generated_at: string; payload_json: string } | null;
    failWrite?: boolean;
  } = {},
) {
  const statements: string[] = [];
  const bindings: unknown[][] = [];
  let stored = options.existing ?? null;
  const database = {
    prepare(statement: string) {
      statements.push(statement);
      return {
        bind(...values: unknown[]) {
          bindings.push(values);
          return {
            async first() {
              if (!statement.includes("admin_community_allowance_preview_cache")) {
                throw new Error("unexpected first query");
              }
              return stored;
            },
            async all() {
              if (!/^\s*WITH\b/u.test(statement)) {
                throw new Error("unexpected corpus query");
              }
              return { results: rows };
            },
            async run() {
              if (!/^\s*INSERT INTO admin_community_allowance_preview_cache\b/u
                .test(statement)) {
                throw new Error("unexpected cache write");
              }
              if (options.failWrite) throw new Error("cache write unavailable");
              stored = {
                generated_at: String(values[0]),
                payload_json: String(values[1]),
              };
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { database, statements, bindings, stored: () => stored };
}

function recoveringPreviewWarmDatabase({
  retryChanges = 1,
}: { retryChanges?: number } = {}) {
  const statements: string[] = [];
  let corpusReads = 0;
  let collectorRuns = 0;
  let retryClaims = 0;
  let stored: { generated_at: string; payload_json: string } | null = null;
  const database = {
    prepare(statement: string) {
      statements.push(statement);
      const execution = {
        async first() {
          if (!statement.includes("admin_community_allowance_preview_cache")) {
            throw new Error("unexpected first query");
          }
          return stored;
        },
        async all() {
          if (statement.includes("SELECT participant_id, source")) {
            collectorRuns += 1;
            return { results: [] };
          }
          if (/^\s*WITH\b/u.test(statement)) {
            corpusReads += 1;
            return {
              results: corpusReads === 1
                ? [cacheRow({ cache_key: null })]
                : [],
            };
          }
          throw new Error("unexpected all query");
        },
        async run() {
          throw new Error("unbound cache write");
        },
      };
      return {
        ...execution,
        bind(...values: unknown[]) {
          return {
            ...execution,
            async run() {
              if (/^\s*UPDATE admin_community_allowance_preview_refresh_state\b/u
                .test(statement)) {
                retryClaims += 1;
                return { meta: { changes: retryChanges } };
              }
              if (!/^\s*INSERT INTO admin_community_allowance_preview_cache\b/u
                .test(statement)) {
                throw new Error("unexpected cache write");
              }
              stored = {
                generated_at: String(values[0]),
                payload_json: String(values[1]),
              };
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return {
    database,
    statements,
    corpusReads: () => corpusReads,
    collectorRuns: () => collectorRuns,
    retryClaims: () => retryClaims,
    stored: () => stored,
  };
}

function cacheRow(overrides: Partial<CacheRow> = {}): CacheRow {
  const participantId = overrides.participant_id ?? "participant-1";
  return {
    participant_id: participantId,
    source: "v1",
    has_v1: 1,
    expected_cache_key: "current-cache-key",
    cache_key: "current-cache-key",
    fits_json: JSON.stringify([fit({ participantId })]),
    model_observations_json: "[]",
    ...overrides,
  };
}

function modelObservation(
  overrides: Partial<CommunityModelCompositionObservation> = {},
): CommunityModelCompositionObservation {
  return {
    participantId: "participant-1",
    planType: "pro",
    binStartMs: Date.parse("2026-08-22T12:00:00.000Z"),
    ppDelta: 1,
    costByModel: { "gpt-5.6-sol": 24 },
    ...overrides,
  };
}

function identifiedModelObservations(
  participantId: string,
  capacities = { sol: 2_400, terra: 1_100, luna: 700 },
): CommunityModelCompositionObservation[] {
  const startMs = Date.parse("2026-08-15T00:00:00.000Z");
  return Array.from({ length: 36 }, (_, index) => {
    const sol = index % 2 === 0 ? 18 + (index % 5) : 0;
    const terra = index % 2 === 1 ? 9 + (index % 4) : 0;
    const luna = 0.02 + (index % 3) * 0.005;
    return modelObservation({
      participantId,
      binStartMs: startMs + index * 2 * 60 * 60 * 1_000,
      ppDelta: sol * 100 / capacities.sol
        + terra * 100 / capacities.terra
        + luna * 100 / capacities.luna,
      costByModel: {
        "gpt-5.6-sol": sol,
        "gpt-5.6-terra": terra,
        "gpt-5.6-luna": luna,
      },
    });
  });
}

function fit(overrides: Partial<CommunityAllowanceFit> = {}): CommunityAllowanceFit {
  return {
    participantId: "participant-1",
    planType: "pro",
    capacityNanousd: 2_000_000_000_000,
    lastObservedAt: "2026-08-22T12:00:00.000Z",
    ...overrides,
  };
}

describe("admin community allowance preview", () => {
  it("normalizes eligible fits before merging and deduplicates participants", () => {
    const fits = [
      fit(),
      fit({
        participantId: "participant-2",
        planType: "prolite",
        capacityNanousd: 500_000_000_000,
      }),
      fit({
        participantId: "participant-3",
        planType: "plus",
        capacityNanousd: 100_000_000_000,
      }),
      fit({
        participantId: "participant-1",
        planType: "plus",
        capacityNanousd: 120_000_000_000,
      }),
      // Unknown has no evidenced conversion and must not enter the combined
      // estimate or the eligible per-plan series.
      fit({
        participantId: "participant-4",
        planType: "unknown",
        capacityNanousd: 150_000_000_000,
      }),
    ];
    const preview = buildAdminCommunityAllowancePreview(
      fits,
      Date.parse("2026-08-23T10:30:00.000Z"),
    );

    expect(preview.schemaVersion)
      .toBe(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_SCHEMA_VERSION);
    expect(preview.basis).toBe(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_BASIS);
    expect(preview.coverage).toEqual({
      uploadingParticipantCount: 4,
      cachedParticipantCount: 4,
      recentFittedParticipantCount: 4,
      mergeEligibleParticipantCount: 3,
      noQualifyingFitParticipantCount: 0,
      noRecentFitParticipantCount: 0,
      unsupportedPlanParticipantCount: 1,
    });
    expect(preview.days).toHaveLength(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS);
    expect(preview.from).toBe("2026-06-15");
    expect(preview.to).toBe("2026-08-23");
    const latest = preview.days.at(-1)!;
    expect(latest.combined).toEqual({
      fitCount: 4,
      participantCount: 3,
      centralUsd: 2_000,
      band80Usd: { lowerUsd: 2_000, upperUsd: 2_280 },
    });
    expect(preview.models).toEqual(ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG);
    expect(Object.keys(latest.byModelId)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(latest.byModelId["gpt-5.6-luna"]).toMatchObject({
      status: "no_usage",
      contributingParticipantCount: 0,
      centralUsd: null,
      band80Usd: null,
    });
    expect(latest.byPlanType.pro).toMatchObject({
      fitCount: 1,
      participantCount: 1,
      centralUsd: 2_000,
      band80Usd: null,
    });
    expect(latest.byPlanType.prolite.centralUsd).toBe(2_000);
    expect(latest.byPlanType.plus).toMatchObject({
      fitCount: 2,
      participantCount: 2,
      centralUsd: 2_200,
      band80Usd: null,
    });
    expect(Object.keys(latest.byPlanType)).toEqual(["pro", "prolite", "plus"]);
    const publicSummary = summarizeCommunityAllowanceDay(fits, "2026-08-23");
    expect(latest.combined).toEqual({
      fitCount: publicSummary.fitCount,
      participantCount: publicSummary.participantCount,
      centralUsd: publicSummary.centralUsd,
      band80Usd: publicSummary.band80Usd,
    });
  });

  it("fits configured targets in the pooled corpus below the discovery floor", () => {
    const observations = [
      ...identifiedModelObservations("participant-1", {
        sol: 2_400,
        terra: 1_100,
        luna: 700,
      }),
      ...identifiedModelObservations("participant-2", {
        sol: 2_400,
        terra: 1_100,
        luna: 700,
      }),
    ];
    const preview = buildAdminCommunityAllowancePreview(
      [fit(), fit({ participantId: "participant-2" })],
      Date.parse("2026-08-23T10:30:00.000Z"),
      ["participant-1", "participant-2"],
      observations,
    );
    const latest = preview.days.at(-1)!;
    expect(latest.byModelId["gpt-5.6-sol"]).toMatchObject({
      status: "fitted",
      contributingParticipantCount: 2,
      eligibleParticipantCount: 2,
      centralUsd: 2_400,
      band80Usd: null,
    });
    expect(latest.byModelId["gpt-5.6-terra"]).toMatchObject({
      status: "fitted",
      contributingParticipantCount: 2,
      eligibleParticipantCount: 2,
      centralUsd: 1_100,
      band80Usd: null,
    });
    expect(latest.byModelId["gpt-5.6-luna"]).toMatchObject({
      status: "fitted",
      contributingParticipantCount: 2,
      eligibleParticipantCount: 2,
      centralUsd: 700,
      band80Usd: null,
    });
    expect(latest.byModelId["gpt-5.6-luna"].apiCostShare).toBeLessThan(0.03);
    expect(JSON.stringify(preview)).not.toContain("participant-1");
  });

  it("accumulates three rows from each of ten contributors into one Luna fit", () => {
    const participantIds = Array.from(
      { length: 10 },
      (_, index) => `participant-${index + 1}`,
    );
    const plans = [
      { planType: "pro", multiplier: 1 },
      { planType: "prolite", multiplier: 4 },
      { planType: "plus", multiplier: 20 },
    ] as const;
    const patterns = [
      { sol: 10, terra: 1, luna: 0.05 },
      { sol: 1, terra: 8, luna: 0.08 },
      { sol: 3, terra: 2, luna: 0.12 },
    ] as const;
    const startMs = Date.parse("2026-08-10T00:00:00.000Z");
    const observations = participantIds.flatMap((participantId, participantIndex) => (
      patterns.map((costs, rowIndex) => {
        const plan = plans[rowIndex]!;
        return modelObservation({
          participantId,
          planType: plan.planType,
          binStartMs: startMs
            + (participantIndex * patterns.length + rowIndex)
              * 2 * 60 * 60 * 1_000,
          ppDelta: costs.sol * 100 / 2_400
            + costs.terra * 100 / 1_100
            + costs.luna * 100 / 700,
          costByModel: {
            "gpt-5.6-sol": costs.sol / plan.multiplier,
            "gpt-5.6-terra": costs.terra / plan.multiplier,
            "gpt-5.6-luna": costs.luna / plan.multiplier,
          },
        });
      })
    ));
    const preview = buildAdminCommunityAllowancePreview(
      participantIds.map((participantId) => fit({ participantId })),
      Date.parse("2026-08-23T10:30:00.000Z"),
      participantIds,
      observations,
    );
    const latest = preview.days.at(-1)!;

    expect(observations).toHaveLength(30);
    expect(Math.max(...participantIds.map((participantId) => (
      observations.filter((row) => row.participantId === participantId).length
    )))).toBe(3);
    expect(latest.byModelId["gpt-5.6-luna"]).toMatchObject({
      status: "fitted",
      contributingParticipantCount: 10,
      eligibleParticipantCount: 10,
      observationCount: 30,
      centralUsd: 700,
      band80Usd: null,
    });
    expect(latest.byModelId["gpt-5.6-luna"].apiCostShare).toBeLessThan(0.03);
  });

  it("keeps a high-drift identified Luna fitted without suppressing other targets", () => {
    const startMs = Date.parse("2026-08-15T00:00:00.000Z");
    const observations = Array.from({ length: 72 }, (_, index) => {
      const sol = index % 2 === 0 ? 18 + index % 5 : 4 + index % 3;
      const terra = index % 2 === 1 ? 9 + index % 4 : 2 + index % 2;
      const luna = 0.03 + ((index * 7) % 11) * 0.02;
      const lunaCapacity = index % 2 === 0 ? 150 : 3_000;
      return modelObservation({
        binStartMs: startMs + index * 2 * 60 * 60 * 1_000,
        ppDelta: sol * 100 / 2_400
          + terra * 100 / 1_100
          + luna * 100 / lunaCapacity,
        costByModel: {
          "gpt-5.6-sol": sol,
          "gpt-5.6-terra": terra,
          "gpt-5.6-luna": luna,
        },
      });
    });
    const preview = buildAdminCommunityAllowancePreview(
      [fit()],
      Date.parse("2026-08-23T10:30:00.000Z"),
      ["participant-1"],
      observations,
    );
    const latest = preview.days.at(-1)!;

    // The shared default remains conservative: this exact Luna target clears
    // positive split-half identification but exceeds its generic drift ceiling.
    const packageDefault = calibrateCompositionCapacities(
      observations.map(({ binStartMs, ppDelta, costByModel }) => ({
        binStartMs,
        ppDelta,
        costByModel,
      })),
      { forcedModels: ["gpt-5.6-luna"] },
    );
    expect(packageDefault.status).toBe("fallback_blended");
    expect(packageDefault.identification?.splitHalfIdentified).toBe(true);
    expect(packageDefault.identification?.splitHalfMaxCapacityDriftFraction)
      .toBeGreaterThan(MODEL_COMPOSITION_POLICY
        .maxSplitHalfCapacityDriftFraction);

    expect(latest.byModelId["gpt-5.6-sol"].status).toBe("fitted");
    expect(latest.byModelId["gpt-5.6-terra"].status).toBe("fitted");
    expect(latest.byModelId["gpt-5.6-luna"]).toMatchObject({
      status: "fitted",
      contributingParticipantCount: 1,
      eligibleParticipantCount: 1,
      observationCount: 72,
      band80Usd: null,
    });
    expect(latest.byModelId["gpt-5.6-luna"].centralUsd)
      .toBeGreaterThan(0);
  });

  it("balances pooled fit influence by participant rather than row volume", () => {
    const grainMs = 2 * 60 * 60 * 1_000;
    const startMs = Date.parse("2026-08-15T00:00:00.000Z");
    const participantRows = (
      participantId: string,
      capacities: { sol: number; terra: number; luna: number },
      count: number,
      firstBinMs: number,
    ) => Array.from({ length: count }, (_, index) => {
      const patternIndex = index % 36;
      const sol = 10 + patternIndex % 5;
      const terra = 5 + (patternIndex * 3) % 7;
      const luna = 0.05 + ((patternIndex * 7) % 11) * 0.02;
      return modelObservation({
        participantId,
        binStartMs: firstBinMs + index * grainMs,
        ppDelta: sol * 100 / capacities.sol
          + terra * 100 / capacities.terra
          + luna * 100 / capacities.luna,
        costByModel: {
          "gpt-5.6-sol": sol,
          "gpt-5.6-terra": terra,
          "gpt-5.6-luna": luna,
        },
      });
    });
    const light = participantRows(
      "participant-light",
      { sol: 2_400, terra: 1_100, luna: 700 },
      36,
      startMs,
    );
    const heavy = participantRows(
      "participant-heavy",
      { sol: 1_200, terra: 550, luna: 350 },
      144,
      startMs - 144 * grainMs,
    );
    const preview = buildAdminCommunityAllowancePreview(
      [
        fit({ participantId: "participant-light" }),
        fit({ participantId: "participant-heavy" }),
      ],
      Date.parse("2026-08-23T10:30:00.000Z"),
      ["participant-light", "participant-heavy"],
      [...light, ...heavy],
    );
    const latest = preview.days.at(-1)!;

    // Equal account influence averages inverse capacities, giving the harmonic
    // mean. Row-count weighting would land much closer to the heavy account.
    expect(latest.byModelId["gpt-5.6-sol"].centralUsd).toBe(1_600);
    expect(latest.byModelId["gpt-5.6-terra"].centralUsd).toBe(733.33);
    expect(latest.byModelId["gpt-5.6-luna"].centralUsd).toBe(466.67);
    expect(latest.byModelId["gpt-5.6-luna"]).toMatchObject({
      contributingParticipantCount: 2,
      eligibleParticipantCount: 2,
      band80Usd: null,
    });
  });

  it("normalizes mixed personal-plan eras row by row before the pooled fit", () => {
    const capacities = { sol: 2_400, terra: 1_100, luna: 700 };
    const multipliers = [1, 4, 20] as const;
    const planTypes = ["pro", "prolite", "plus"] as const;
    const observations = identifiedModelObservations(
      "participant-mixed",
      capacities,
    ).map((observation, index) => {
      const planIndex = index % planTypes.length;
      const multiplier = multipliers[planIndex]!;
      return {
        ...observation,
        planType: planTypes[planIndex]!,
        costByModel: Object.fromEntries(
          Object.entries(observation.costByModel).map(([modelId, cost]) => [
            modelId,
            cost / multiplier,
          ]),
        ),
      };
    });
    const unsupported = (["team", "unknown"] as const).map((planType, index) => ({
      participantId: "participant-mixed",
      planType,
      binStartMs: Date.parse("2026-08-18T12:00:00.000Z")
        + index * 2 * 60 * 60 * 1_000,
      ppDelta: 90,
      costByModel: { "gpt-5.6-sol": 50_000 },
    })) as unknown as CommunityModelCompositionObservation[];

    const preview = buildAdminCommunityAllowancePreview(
      [fit({ participantId: "participant-mixed" })],
      Date.parse("2026-08-23T10:30:00.000Z"),
      ["participant-mixed"],
      [...observations, ...unsupported],
    );
    const latest = preview.days.at(-1)!;

    expect(preview.modelEvidence).toMatchObject({
      qualification: "pooled_target_identified_halves_personal_plans",
      planNormalization: "pro_x1_prolite_x4_plus_x20",
      aggregation: "participant_balanced_pooled_fit",
    });
    expect(latest.byModelId["gpt-5.6-sol"]).toMatchObject({
      status: "fitted",
      observationCount: 18,
      centralUsd: capacities.sol,
    });
    expect(latest.byModelId["gpt-5.6-terra"]).toMatchObject({
      status: "fitted",
      observationCount: 18,
      centralUsd: capacities.terra,
    });
    expect(latest.byModelId["gpt-5.6-luna"]).toMatchObject({
      status: "fitted",
      observationCount: 36,
      centralUsd: capacities.luna,
    });
  });

  it("keeps the trailing window half-open and publishes honest empty days", () => {
    const preview = buildAdminCommunityAllowancePreview([
      // Exact lower bound for Aug 23's end-of-day window: excluded.
      fit({ lastObservedAt: "2026-07-25T00:00:00.000Z" }),
      // One millisecond inside: included.
      fit({
        participantId: "inside",
        lastObservedAt: "2026-07-25T00:00:00.001Z",
      }),
      // After Aug 23: excluded.
      fit({
        participantId: "future",
        lastObservedAt: "2026-08-24T00:00:00.001Z",
      }),
    ], Date.parse("2026-08-23T10:30:00.000Z"));

    const latest = preview.days.at(-1)!;
    expect(latest.combined).toMatchObject({
      fitCount: 1,
      participantCount: 1,
      centralUsd: 2_000,
      band80Usd: null,
    });
    expect(preview.days[0]!.combined).toEqual({
      fitCount: 0,
      participantCount: 0,
      centralUsd: null,
      band80Usd: null,
    });
  });

  it("rejects an invalid preview clock", () => {
    expect(() => buildAdminCommunityAllowancePreview([], Number.NaN))
      .toThrow("invalid admin community allowance preview time");
  });

  it("partitions every non-eligible uploader into one honest gap reason", () => {
    const preview = buildAdminCommunityAllowancePreview([
      fit({ participantId: "stale", lastObservedAt: "2026-01-01T00:00:00.000Z" }),
      fit({
        participantId: "unsupported",
        planType: "unknown",
        lastObservedAt: "2026-08-22T12:00:00.000Z",
      }),
    ], Date.parse("2026-08-23T10:30:00.000Z"), [
      "empty",
      "stale",
      "unsupported",
    ]);

    expect(preview.coverage).toEqual({
      uploadingParticipantCount: 3,
      cachedParticipantCount: 3,
      recentFittedParticipantCount: 1,
      mergeEligibleParticipantCount: 0,
      noQualifyingFitParticipantCount: 1,
      noRecentFitParticipantCount: 1,
      unsupportedPlanParticipantCount: 1,
    });
    const coverage = preview.coverage;
    expect(
      coverage.noQualifyingFitParticipantCount
      + coverage.noRecentFitParticipantCount
      + coverage.unsupportedPlanParticipantCount,
    ).toBe(
      coverage.uploadingParticipantCount
      - coverage.mergeEligibleParticipantCount,
    );
  });

  it("builds the scheduled aggregate from the existing SELECT-only fit-cache source", async () => {
    const observation = modelObservation();
    const { database, statements, bindings } = cacheDatabase([cacheRow({
      model_observations_json: JSON.stringify([observation]),
    })]);
    const corpus = await readCachedCommunityAllowanceCorpus(database);
    const cachedFits = await readCachedCommunityAllowanceFits(database);

    expect(corpus).toEqual({
      participantIds: ["participant-1"],
      fits: [fit()],
      modelObservations: [observation],
    });
    expect(cachedFits).toEqual([fit()]);
    expect(statements).toHaveLength(2);
    expect(statements[0]!.trimStart()).toMatch(/^WITH\b/u);
    expect(statements[0]).toContain("WHERE sources.has_v1 = 1");
    expect(statements[0]).toContain("sources.has_v1,");
    expect(statements[0]).toContain("':' || sources.source AS expected_cache_key");
    expect(statements[0]).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM)\b/iu,
    );
    expect(bindings).toHaveLength(2);
    expect(bindings[0]).toHaveLength(3);

    const preview = await buildAdminCommunityAllowancePreviewFromSource(
      database,
      Date.parse("2026-08-23T10:30:00.000Z"),
    );
    expect(preview?.days.at(-1)?.combined).toMatchObject({
      fitCount: 1,
      participantCount: 1,
      centralUsd: 2_000,
    });
    const serializedPreview = JSON.stringify(preview);
    expect(serializedPreview).not.toContain("participant-1");
    expect(serializedPreview).not.toContain("capacityNanousd");
    expect(serializedPreview).not.toContain("lastObservedAt");
    expect(statements).toHaveLength(3);
    expect(statements.every((statement) => (
      /^WITH\b/u.test(statement.trimStart())
      && !/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM)\b/iu
        .test(statement)
    ))).toBe(true);
  });

  it("reports the production-shaped 8/8/6/5 coverage without exposing IDs", async () => {
    const rows = Array.from({ length: 8 }, (_, index) => {
      const participantId = `participant-${index + 1}`;
      const fits = index < 2
        ? []
        : [fit({
          participantId,
          planType: index === 2 ? "unknown" : "pro",
        })];
      return cacheRow({
        participant_id: participantId,
        fits_json: JSON.stringify(fits),
      });
    });
    const { database } = cacheDatabase(rows);
    const preview = await buildAdminCommunityAllowancePreviewFromSource(
      database,
      Date.parse("2026-08-23T10:30:00.000Z"),
    );

    expect(preview?.coverage).toEqual({
      uploadingParticipantCount: 8,
      cachedParticipantCount: 8,
      recentFittedParticipantCount: 6,
      mergeEligibleParticipantCount: 5,
      noQualifyingFitParticipantCount: 2,
      noRecentFitParticipantCount: 0,
      unsupportedPlanParticipantCount: 1,
    });
    const serialized = JSON.stringify(preview);
    for (let index = 1; index <= 8; index += 1) {
      expect(serialized).not.toContain(`participant-${index}`);
    }
  });

  it("fails closed instead of analyzing incomplete or untrusted cache state", async () => {
    const cases: CacheRow[][] = [
      // A dual-source participant has a valid v1 epoch but still cannot supply
      // a complete SELECT-only corpus because its scalar source is v0.2.
      [cacheRow({ source: "v0.2" })],
      [cacheRow({
        source: "v0.2",
        has_v1: 0,
        expected_cache_key: null,
      })],
      [cacheRow({ has_v1: 0 })],
      [cacheRow({ cache_key: null, fits_json: null })],
      [cacheRow({ cache_key: "stale-cache-key" })],
      [cacheRow({ fits_json: "not-json" })],
      [cacheRow({ model_observations_json: null })],
      [cacheRow({ model_observations_json: "not-json" })],
      [cacheRow({
        model_observations_json: JSON.stringify([{
          ...modelObservation(),
          planType: "team",
        }]),
      })],
      [cacheRow({
        model_observations_json: JSON.stringify([{
          participantId: "participant-1",
          binStartMs: modelObservation().binStartMs,
          ppDelta: 1,
          costByModel: { "gpt-5.6-sol": 24 },
        }]),
      })],
      [cacheRow({
        model_observations_json: JSON.stringify([
          modelObservation(),
          modelObservation(),
        ]),
      })],
      [cacheRow({
        model_observations_json: JSON.stringify([
          modelObservation({
            binStartMs: Date.parse("2026-08-22T14:00:00.000Z"),
          }),
          modelObservation({
            binStartMs: Date.parse("2026-08-22T12:00:00.000Z"),
          }),
        ]),
      })],
      [cacheRow({
        fits_json: JSON.stringify([fit({ participantId: "other-participant" })]),
      })],
    ];
    for (const rows of cases) {
      const { database } = cacheDatabase(rows);
      await expect(readCachedCommunityAllowanceFits(database))
        .resolves.toBeNull();
      await expect(buildAdminCommunityAllowancePreviewFromSource(database))
        .resolves.toBeNull();
    }

    const failed = cacheDatabase([], { fail: true });
    await expect(readCachedCommunityAllowanceFits(failed.database))
      .resolves.toBeNull();
  });

  it("treats an empty, fully covered cache cohort as honest empty evidence", async () => {
    const { database } = cacheDatabase([]);
    await expect(readCachedCommunityAllowanceFits(database)).resolves.toEqual([]);
    const preview = await buildAdminCommunityAllowancePreviewFromSource(
      database,
      Date.parse("2026-08-23T10:30:00.000Z"),
    );
    expect(preview?.days).toHaveLength(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS);
    expect(preview?.days.every((day) => (
      day.combined.fitCount === 0 && day.combined.centralUsd === null
    ))).toBe(true);
  });

  it("serves exactly one bounded singleton SELECT on the interactive path", async () => {
    const nowEpoch = Date.parse("2026-08-23T10:30:00.000Z");
    const preview = buildAdminCommunityAllowancePreview(
      [fit()],
      nowEpoch,
    );
    const { database, statements, bindings } = previewCacheDatabase(
      previewRow(preview),
    );

    const cached = await readCachedAdminCommunityAllowancePreview(
      database,
      nowEpoch + 1_000,
    );
    expect(cached).toEqual(preview);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(
      /^\s*SELECT generated_at, payload_json\s+FROM admin_community_allowance_preview_cache/u,
    );
    expect(statements[0]).toContain("WHERE singleton = 1");
    expect(statements[0]).toContain("LIMIT 1");
    expect(statements[0]).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM)\b/iu,
    );
    expect(bindings).toEqual([[128 * 1_024]]);
    expect(JSON.stringify(cached)).not.toContain("participant-1");
  });

  it("fails closed for missing, stale, oversized, corrupt, or non-exact rows", async () => {
    const nowEpoch = Date.parse("2026-08-23T10:30:00.000Z");
    const preview = buildAdminCommunityAllowancePreview([], nowEpoch);
    const withIdentifier = JSON.parse(JSON.stringify(preview)) as Record<
      string,
      unknown
    >;
    withIdentifier.participantId = "must-not-cross-the-cache-boundary";
    const cases = [
      null,
      previewRow(buildAdminCommunityAllowancePreview(
        [],
        nowEpoch - 3 * 60 * 60 * 1_000,
      )),
      { generated_at: preview.generatedAt, payload_json: "x".repeat(128 * 1_024 + 1) },
      { generated_at: preview.generatedAt, payload_json: "{" },
      { generated_at: preview.generatedAt, payload_json: JSON.stringify(withIdentifier) },
    ];
    for (const row of cases) {
      const { database, statements } = previewCacheDatabase(row);
      await expect(readCachedAdminCommunityAllowancePreview(database, nowEpoch))
        .rejects.toMatchObject({
          status: 503,
          code: "ADMIN_ALLOWANCE_CACHE_UNAVAILABLE",
        });
      expect(statements).toHaveLength(1);
    }
    const failed = previewCacheDatabase(null, { fail: true });
    await expect(readCachedAdminCommunityAllowancePreview(
      failed.database,
      nowEpoch,
    )).rejects.toMatchObject({
      status: 503,
      code: "ADMIN_ALLOWANCE_CACHE_UNAVAILABLE",
    });
  });

  it("scheduled refresh stores the actual bounded aggregate and self-throttles", async () => {
    const nowEpoch = Date.parse("2026-08-23T10:30:00.000Z");
    const source = previewWarmDatabase([cacheRow()]);
    await expect(warmAdminCommunityAllowancePreviewCache(
      source.database,
      nowEpoch,
    )).resolves.toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_REFRESHED" });
    expect(source.statements).toHaveLength(3);
    expect(source.statements[0]).toMatch(
      /^\s*SELECT generated_at, payload_json\s+FROM admin_community_allowance_preview_cache/u,
    );
    expect(source.statements[1]!.trimStart()).toMatch(/^WITH\b/u);
    expect(source.statements[1]).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM)\b/iu,
    );
    expect(source.statements[2]).toMatch(
      /^\s*INSERT INTO admin_community_allowance_preview_cache\b/u,
    );
    const stored = source.stored();
    expect(stored).not.toBeNull();
    expect(new TextEncoder().encode(stored?.payload_json ?? "").byteLength)
      .toBeLessThanOrEqual(128 * 1_024);
    const payload = JSON.parse(stored?.payload_json ?? "{}") as {
      coverage: { uploadingParticipantCount: number };
      days: { combined: { participantCount: number } }[];
    };
    expect(payload.coverage.uploadingParticipantCount).toBe(1);
    expect(payload.days.at(-1)?.combined.participantCount).toBe(1);
    expect(stored?.payload_json).not.toContain("participant-1");
    expect(stored?.payload_json).not.toContain("capacityNanousd");

    const current = previewWarmDatabase([], { existing: stored });
    await expect(warmAdminCommunityAllowancePreviewCache(
      current.database,
      nowEpoch + 10 * 60 * 1_000,
    )).resolves.toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_CURRENT" });
    expect(current.statements).toHaveLength(1);
  });

  it("repairs stale participant evidence without the public publication path", async () => {
    const nowEpoch = Date.parse("2026-08-23T10:30:00.000Z");
    const source = recoveringPreviewWarmDatabase();
    await expect(warmAdminCommunityAllowancePreviewCache(
      source.database,
      nowEpoch,
    )).resolves.toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_REFRESHED" });
    expect(source.retryClaims()).toBe(1);
    expect(source.collectorRuns()).toBe(1);
    expect(source.corpusReads()).toBe(1);
    expect(source.stored()).not.toBeNull();
  });

  it("does not rescan raw evidence inside the scheduled retry interval", async () => {
    const source = recoveringPreviewWarmDatabase({ retryChanges: 0 });
    await expect(warmAdminCommunityAllowancePreviewCache(
      source.database,
      Date.parse("2026-08-23T10:30:00.000Z"),
    )).resolves.toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE" });
    expect(source.retryClaims()).toBe(1);
    expect(source.collectorRuns()).toBe(0);
    expect(source.stored()).toBeNull();
  });

  it("reports scheduled source and write failures without throwing", async () => {
    const nowEpoch = Date.parse("2026-08-23T10:30:00.000Z");
    const sourceUnavailable = {
      prepare() {
        throw new Error("source unavailable");
      },
    } as unknown as D1Database;
    await expect(warmAdminCommunityAllowancePreviewCache(
      sourceUnavailable,
      nowEpoch,
    )).resolves.toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE" });

    const writeUnavailable = previewWarmDatabase([cacheRow()], {
      failWrite: true,
    });
    await expect(warmAdminCommunityAllowancePreviewCache(
      writeUnavailable.database,
      nowEpoch,
    )).resolves.toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE" });
  });
});
