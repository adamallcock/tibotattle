import { describe, expect, it } from "vitest";
import { ADMIN_MODEL_CONFIG, ADMIN_MODEL_HISTORY_CATALOG_VERSION,
  LEGACY_ADMIN_MODEL_HISTORY_CATALOG_VERSION, expandAdminModelHistoryDay,
  projectAdminModelHistoryDay } from "@app-usagemonitor/telemetry-contract";

import {
  ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_BASIS,
  ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS,
  ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_SCHEMA_VERSION,
  buildAdminCommunityAllowancePreview,
  buildAdminCommunityAllowancePreviewFromSource,
  readCachedAdminCommunityAllowancePreview,
  warmAdminCommunityAllowancePreviewCache,
} from "../src/admin-community-allowance";
import {
  COMMUNITY_ATTRIBUTION_METHOD_VERSION,
  readCachedCommunityAllowanceCorpus,
  readCachedCommunityAllowanceFits,
  summarizeCommunityAllowanceDay,
} from "../src/community-allowance";
import type { CommunityAllowanceFit } from "../src/community-allowance";

interface CacheRow {
  participant_id: string;
  source: "v0.2" | "v1";
  expected_cache_key: string | null;
  cache_key: string | null;
  fits_json: string | null;
  input_fingerprint: string;
  source_method_version: string;
}

const ACTIVE_V11_SOURCE_QUERY =
  "SELECT 1 AS present FROM telemetry_v11_domain_heads WHERE participant_id = ? LIMIT 1";

function cacheDatabase(rows: CacheRow[], { fail = false,
  modelDays = [] as { day: string; payload_json: string }[],
} = {}) {
  const statements: string[] = [];
  const bindings: unknown[][] = [];
  const database = {
    async batch(prepared: D1PreparedStatement[]) {
      return Promise.all(prepared.map((statement) => statement.all()));
    },
    prepare(statement: string) {
      statements.push(statement);
      const handle = {
        async first() {
          if (statement === ACTIVE_V11_SOURCE_QUERY) return null;
          if (statement.includes("community_snapshot_mutation_control")) {
            return { mutation_epoch: 1, input_revision: 1 };
          }
          if (statement.includes("community_model_composition_cache")) {
            return null;
          }
          if (statement.includes("telemetry_v1_chunks")
              && statement.includes("COUNT(*)")) {
            return { n: 0, newest: "", revsum: 0 };
          }
          throw new Error("unexpected first query");
        },
        async all() {
          if (fail) throw new Error("cache unavailable");
          if (statement.includes("community_snapshot_mutation_control")) {
            return { results: [{ mutation_epoch: 1, input_revision: 1 }] };
          }
          if (!/^\s*WITH\b/u.test(statement) && /telemetry_(?:v1|analytical)_chunks/u.test(statement)) {
            return { results: [] };
          }
          if (statement.includes("community_model_composition_days")) {
            return { results: modelDays };
          }
          if (statement.includes("day_device_evidence")) {
            return { results: [] };
          }
          return { results: rows };
        },
        async run() {
          // Scheduled construction may cache a composition refusal and its
          // model day. The fit-cache reader itself remains SELECT-only.
          if (/^\s*INSERT INTO community_model_composition_(?:cache|days)\b/u.test(statement)) {
            return { meta: { changes: 1 } };
          }
          throw new Error("read-only cache reader attempted a write");
        },
      };
      return {
        ...handle,
        bind(...values: unknown[]) {
          bindings.push(values);
          return handle;
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
    async batch(prepared: D1PreparedStatement[]) {
      return Promise.all(prepared.map((statement) => statement.all()));
    },
    prepare(statement: string) {
      statements.push(statement);
      let bound: unknown[] = [];
      const handle = {
        async first() {
          if (statement === ACTIVE_V11_SOURCE_QUERY) return null;
          if (statement.includes("community_snapshot_mutation_control")) {
            return { mutation_epoch: 1, input_revision: 1 };
          }
          if (statement.includes("admin_community_allowance_preview_cache")) {
            return stored;
          }
          if (statement.includes("community_model_composition_cache")) {
            return null;
          }
          if (statement.includes("telemetry_v1_chunks")
              && statement.includes("COUNT(*)")) {
            return { n: 0, newest: "", revsum: 0 };
          }
          throw new Error("unexpected first query");
        },
        async all() {
          if (statement.includes("community_snapshot_mutation_control")) {
            return { results: [{ mutation_epoch: 1, input_revision: 1 }] };
          }
          if (!/^\s*WITH\b/u.test(statement) && /telemetry_(?:v1|analytical)_chunks/u.test(statement)) {
            return { results: [] };
          }
          if (statement.includes("day_device_evidence")
              || statement.includes("community_model_composition_days")) {
            return { results: [] };
          }
          if (!/^\s*WITH\b/u.test(statement)) {
            throw new Error("unexpected corpus query");
          }
          return { results: rows };
        },
        async run() {
          if (/^\s*INSERT INTO community_model_composition_(?:cache|days)\b/u.test(statement)) {
            return { meta: { changes: 1 } };
          }
          if (!/^\s*INSERT INTO admin_community_allowance_preview_cache\b/u
            .test(statement)) {
            throw new Error("unexpected cache write");
          }
          if (options.failWrite) throw new Error("cache write unavailable");
          stored = {
            generated_at: String(bound[0]),
            payload_json: String(bound[1]),
          };
          return { meta: { changes: 1 } };
        },
      };
      return {
        ...handle,
        bind(...values: unknown[]) {
          bindings.push(values);
          bound = values;
          return handle;
        },
      };
    },
  } as unknown as D1Database;
  return { database, statements, bindings, stored: () => stored };
}

function cacheRow(overrides: Partial<CacheRow> = {}): CacheRow {
  const participantId = overrides.participant_id ?? "participant-1";
  return {
    participant_id: participantId,
    source: "v1",
    expected_cache_key: "current-cache-key",
    cache_key: "current-cache-key",
    fits_json: JSON.stringify([fit({ participantId })]),
    input_fingerprint: "a".repeat(64),
    source_method_version: COMMUNITY_ATTRIBUTION_METHOD_VERSION,
    ...overrides,
  };
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

function expectPinnedCompositionRefresh(statements: string[]) {
  // Both callers have two preliminary reads. Assert the complete successful
  // refusal-cache path, not merely its count: an unsupported mock query must
  // not masquerade as an optimization by aborting the analyzer before its pin
  // recheck and cache write.
  expect(statements.slice(2, 16)).toEqual([
    expect.stringMatching(/^\s*SELECT mutation_epoch FROM community_snapshot_mutation_control\b/u),
    expect.stringMatching(/^\s*WITH\b[\s\S]*community_allowance_fit_cache\b/u),
    expect.stringMatching(/^\s*WITH\b[\s\S]*FROM participant_sources\b/u),
    "SELECT 1 FROM community_model_composition_cache LIMIT 1",
    expect.stringMatching(/^\s*SELECT mutation_epoch,[\s\S]*community_analytical_input_versions\b/u),
    expect.stringMatching(/^\s*SELECT c\.id,[\s\S]*FROM telemetry_analytical_chunks c\b/u),
    expect.stringMatching(/^\s*SELECT composition_json FROM community_model_composition_cache\b/u),
    ACTIVE_V11_SOURCE_QUERY,
    expect.stringMatching(/^\s*SELECT mutation_epoch,[\s\S]*community_analytical_input_versions\b/u),
    expect.stringMatching(/^\s*SELECT c\.id,[\s\S]*FROM telemetry_analytical_chunks c\b/u),
    expect.stringMatching(/^\s*INSERT INTO community_model_composition_cache\b/u),
    expect.stringMatching(/^\s*INSERT INTO community_model_composition_days\b/u),
    expect.stringMatching(/^\s*SELECT day, payload_json\s+FROM community_model_composition_days\b/u),
    expect.stringMatching(/^\s*SELECT mutation_epoch FROM community_snapshot_mutation_control\b/u),
  ]);
  expect(statements[6]).toBe(statements[10]);
  expect(statements[7]).toBe(statements[11]);
  expect(statements[7]).toContain("p.state = 'active'");
  expect(statements[7]).toMatch(/\bLIMIT \?/u);
  expect(statements[8]).toContain("input_fingerprint = ? AND source_method_version = ?");
  expect(statements[12]).toContain("p.state = 'active'");
  expect(statements[12]).toContain("v.revision = ?6");
  expect(statements[13]).toContain("mutation_epoch = ?4");
  expect(statements.join("\n")).not.toMatch(/\bFROM telemetry_(?:v1|v11_active|analytical)_records\b/u);
}

describe("admin community allowance preview", () => {
  it("scheduled reads retain legacy model days without inventing newer-model coverage", async () => {
    const legacy = { day: "2026-08-22", byModel: Object.fromEntries([
      "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
    ].map((id) => [id, { capacityUsd: null, participantCount: 0 }])),
    fittedParticipantCount: 0, unstableParticipantCount: 1, staleParticipantCount: 0,
    refusedParticipantCount: 0, v1ParticipantCount: 1, unsupportedSourceParticipantCount: 0 };
    const source = cacheDatabase([cacheRow()], { modelDays: [
      { day: "2026-08-23", payload_json: JSON.stringify({ ...legacy, day: "2026-08-23", rawModel: "private-canary" }) },
      { day: legacy.day, payload_json: JSON.stringify(legacy) },
    ] });
    const preview = await buildAdminCommunityAllowancePreviewFromSource(
      source.database, Date.parse("2026-08-23T10:30:00.000Z"),
    );
    expect(preview?.models.days).toHaveLength(1);
    const kept = preview!.models.days[0]!;
    expect(kept.catalogVersion).toBe(LEGACY_ADMIN_MODEL_HISTORY_CATALOG_VERSION);
    expect(kept.day).toBe(legacy.day);
    expect(expandAdminModelHistoryDay(kept)!.byModel["gpt-6-astra"])
      .toEqual({ capacityUsd: null, participantCount: null });
    expect(JSON.stringify(preview)).not.toContain("private-canary");
  });

  it("serves all 70 fully populated catalog days inside the bounded cache", async () => {
    const now = Date.parse("2026-09-03T12:00:00.000Z");
    const base = buildAdminCommunityAllowancePreview([], now);
    const models = { ...base.models, days: base.days.map(({ day }) => {
      const projected = projectAdminModelHistoryDay({
        day, catalogVersion: ADMIN_MODEL_HISTORY_CATALOG_VERSION,
        values: ADMIN_MODEL_CONFIG.filter((model) => model.allowanceTrack === "primary")
          .map((model) => [model.modelId, 1.7976931348623157e308, Number.MAX_SAFE_INTEGER]),
        fittedParticipantCount: Number.MAX_SAFE_INTEGER,
        unstableParticipantCount: 0, staleParticipantCount: 0, refusedParticipantCount: 0,
        v1ParticipantCount: Number.MAX_SAFE_INTEGER, unsupportedSourceParticipantCount: 0,
      });
      expect(projected).not.toBeNull();
      return projected!;
    }) };
    const preview = { ...base, models };
    const payload = JSON.stringify(preview);
    expect(new TextEncoder().encode(payload).byteLength).toBeLessThan(256 * 1024);
    const cached = previewCacheDatabase({ generated_at: preview.generatedAt, payload_json: payload });
    await expect(readCachedAdminCommunityAllowancePreview(cached.database, now)).resolves.toEqual(preview);
    expect(cached.statements).toHaveLength(1);
  });

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
    const { database, statements, bindings } = cacheDatabase([cacheRow()]);
    const corpus = await readCachedCommunityAllowanceCorpus(database);
    const cachedFits = await readCachedCommunityAllowanceFits(database);

    expect(corpus).toEqual({
      participantIds: ["participant-1"],
      fits: [fit()],
    });
    expect(cachedFits).toEqual([fit()]);
    expect(statements).toHaveLength(2);
    expect(statements[0]!.trimStart()).toMatch(/^WITH\b/u);
    expect(statements[0]).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM)\b/iu,
    );
    expect(bindings).toHaveLength(2);
    // One UTC horizon and one shared method/pricing suffix keep the SELECT
    // cache reader aligned with the scheduled writer without scanning inputs.
    expect(bindings[0]).toHaveLength(2);
    expect(bindings[0]?.[1]).toContain(COMMUNITY_ATTRIBUTION_METHOD_VERSION);

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
    // Publication epochs, both source-pin reads and the active-successor guard
    // remain bounded; no raw usage scan is introduced on a cache read.
    expect(statements).toHaveLength(16);
    expectPinnedCompositionRefresh(statements);
    const writes = statements.filter((statement) => (
      /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM)\b/iu
        .test(statement)
    ));
    // Two writes only: the per-participant composition cache row (refusals are
    // cached too, so a thin participant is not recomputed every warm) and the
    // per-model day upsert; everything else stays SELECT-only.
    expect(writes).toHaveLength(2);
    expect(writes[0]!.trimStart()).toMatch(
      /^INSERT INTO community_model_composition_cache\b/u,
    );
    expect(writes[1]!.trimStart()).toMatch(
      /^INSERT INTO community_model_composition_days\b/u,
    );
    expect(preview?.models.days).toEqual([]);
    expect(preview?.models.modelConfig).toEqual(ADMIN_MODEL_CONFIG);
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
      [cacheRow({ source: "v0.2", expected_cache_key: null })],
      [cacheRow({ cache_key: null, fits_json: null })],
      [cacheRow({ cache_key: "stale-cache-key" })],
      [cacheRow({ input_fingerprint: "untrusted" })],
      [cacheRow({ source_method_version: "old-attribution" })],
      [cacheRow({ fits_json: "not-json" })],
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
    expect(bindings).toEqual([[256 * 1_024, COMMUNITY_ATTRIBUTION_METHOD_VERSION]]);
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
      { generated_at: preview.generatedAt, payload_json: "x".repeat(256 * 1_024 + 1) },
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
    expect(source.statements).toHaveLength(17);
    expectPinnedCompositionRefresh(source.statements);
    const warmWrites = source.statements.filter((statement) => (
      /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM)\b/iu
        .test(statement)
    ));
    expect(warmWrites).toHaveLength(3);
    expect(warmWrites[0]!.trimStart()).toMatch(
      /^INSERT INTO community_model_composition_cache\b/u,
    );
    expect(warmWrites[1]!.trimStart()).toMatch(
      /^INSERT INTO community_model_composition_days\b/u,
    );
    expect(warmWrites[2]!.trimStart()).toMatch(
      /^INSERT INTO admin_community_allowance_preview_cache\b/u,
    );
    expect(source.statements[0]).toMatch(
      /^\s*SELECT generated_at, payload_json\s+FROM admin_community_allowance_preview_cache/u,
    );
    expect(source.statements[1]).toContain("community_snapshot_mutation_control");
    expect(source.statements[2]).toContain("community_snapshot_mutation_control");
    expect(source.statements[3]!.trimStart()).toMatch(/^WITH\b/u);
    expect(source.statements[3]).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM)\b/iu,
    );
    expect(source.statements.at(-1)).toMatch(
      /^\s*INSERT INTO admin_community_allowance_preview_cache\b/u,
    );
    expect(source.statements.at(-1)).toContain("mutation_epoch = ?4");
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
