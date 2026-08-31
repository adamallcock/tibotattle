import { describe, expect, it } from "vitest";

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
}

function cacheDatabase(rows: CacheRow[], { fail = false } = {}) {
  const statements: string[] = [];
  const bindings: unknown[][] = [];
  const database = {
    prepare(statement: string) {
      statements.push(statement);
      const handle = {
        async first() {
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
          if (statement.includes("day_device_evidence")
              || statement.includes("community_model_composition_days")) {
            return { results: [] };
          }
          return { results: rows };
        },
        async run() {
          // The per-model day series is the single write this scheduled
          // source path is allowed; anything else stays a hard failure.
          if (statement.includes("community_model_composition_days")) {
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
    prepare(statement: string) {
      statements.push(statement);
      let bound: unknown[] = [];
      const handle = {
        async first() {
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
          if (statement.includes("community_model_composition_days")) {
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
    // The single bound value is the shared writer/reader cache-key suffix, so
    // the two compositions can never diverge again.
    expect(bindings[0]).toHaveLength(1);

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
    expect(statements).toHaveLength(9);
    const writes = statements.filter((statement) => (
      /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM)\b/iu
        .test(statement)
    ));
    // The per-model day upsert is the scheduled source path's single write;
    // everything else stays SELECT-only.
    expect(writes).toHaveLength(1);
    expect(writes[0]!.trimStart()).toMatch(
      /^INSERT INTO community_model_composition_days\b/u,
    );
    expect(preview?.models.days).toEqual([]);
    expect(preview?.models.modelConfig.map((model) => model.modelId)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
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
    expect(source.statements).toHaveLength(9);
    const warmWrites = source.statements.filter((statement) => (
      /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM)\b/iu
        .test(statement)
    ));
    expect(warmWrites).toHaveLength(2);
    expect(warmWrites[0]!.trimStart()).toMatch(
      /^INSERT INTO community_model_composition_days\b/u,
    );
    expect(warmWrites[1]!.trimStart()).toMatch(
      /^INSERT INTO admin_community_allowance_preview_cache\b/u,
    );
    expect(source.statements[0]).toMatch(
      /^\s*SELECT generated_at, payload_json\s+FROM admin_community_allowance_preview_cache/u,
    );
    expect(source.statements[1]!.trimStart()).toMatch(/^WITH\b/u);
    expect(source.statements[1]).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM)\b/iu,
    );
    expect(source.statements.at(-1)).toMatch(
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
