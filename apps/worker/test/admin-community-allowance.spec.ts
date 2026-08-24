import { describe, expect, it } from "vitest";

import {
  ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_BASIS,
  ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS,
  ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_SCHEMA_VERSION,
  buildAdminCommunityAllowancePreview,
  readAdminCommunityAllowancePreview,
} from "../src/admin-community-allowance";
import { readCachedCommunityAllowanceFits } from "../src/community-allowance";
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
    const preview = buildAdminCommunityAllowancePreview([
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
    ], Date.parse("2026-08-23T10:30:00.000Z"));

    expect(preview.schemaVersion)
      .toBe(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_SCHEMA_VERSION);
    expect(preview.basis).toBe(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_BASIS);
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

  it("serves the admin preview through one SELECT-only cache read", async () => {
    const { database, statements, bindings } = cacheDatabase([cacheRow()]);
    const cachedFits = await readCachedCommunityAllowanceFits(database);

    expect(cachedFits).toEqual([fit()]);
    expect(statements).toHaveLength(1);
    expect(statements[0]!.trimStart()).toMatch(/^WITH\b/u);
    expect(statements[0]).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM)\b/iu,
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toHaveLength(2);

    const preview = await readAdminCommunityAllowancePreview(
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
    expect(statements).toHaveLength(2);
    expect(statements.every((statement) => (
      /^WITH\b/u.test(statement.trimStart())
      && !/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM)\b/iu
        .test(statement)
    ))).toBe(true);
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
      await expect(readAdminCommunityAllowancePreview(database))
        .resolves.toBeNull();
    }

    const failed = cacheDatabase([], { fail: true });
    await expect(readCachedCommunityAllowanceFits(failed.database))
      .resolves.toBeNull();
  });

  it("treats an empty, fully covered cache cohort as honest empty evidence", async () => {
    const { database } = cacheDatabase([]);
    await expect(readCachedCommunityAllowanceFits(database)).resolves.toEqual([]);
    const preview = await readAdminCommunityAllowancePreview(
      database,
      Date.parse("2026-08-23T10:30:00.000Z"),
    );
    expect(preview?.days).toHaveLength(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS);
    expect(preview?.days.every((day) => (
      day.combined.fitCount === 0 && day.combined.centralUsd === null
    ))).toBe(true);
  });
});
