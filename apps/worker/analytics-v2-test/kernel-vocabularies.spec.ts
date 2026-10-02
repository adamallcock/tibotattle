// The GCP-only vocabulary copies against the vocabularies generated from the
// vendored kernels (src/analytics-v2/kernel-vocabularies.generated.ts, written
// by scripts/vendor-analytics-kernels.mjs and held to the vendored tree by
// scripts/vendor-analytics-kernels.check.mjs). A re-vendor that changes a
// kernel vocabulary regenerates that module, and this spec then fails until
// every GCP copy, including the primary 0059 CHECK sets, has been ported.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ANALYTICS_V2_CACHE_RETENTION_BAND_IDS } from "../src/analytics-v2/cache-windows-sql";
import { ANALYTICS_V2_COMMUNITY_DAILY_SCHEMA_VERSION } from "../src/analytics-v2/community-daily-route";
import { ANALYTICS_V2_MODEL_DATES } from "../src/analytics-v2/compute";
import {
  ANALYTICS_V2_CACHE_BAND_COUNTERS,
  ANALYTICS_V2_CACHE_ONLY_REFUSAL_REASONS,
  ANALYTICS_V2_OWNER_DAY_REFUSAL_REASONS,
  ANALYTICS_V2_OWNER_ONLY_REFUSAL_REASONS,
  ANALYTICS_V2_REFUSAL_REASONS,
} from "../src/analytics-v2/contract";
import {
  KERNEL_CACHE_BAND_COUNTERS,
  KERNEL_CACHE_RETENTION_BAND_IDS,
  KERNEL_CACHE_RETENTION_REFUSAL_REASONS,
  KERNEL_COMMUNITY_DAILY_READ_SCHEMA_VERSION,
  KERNEL_MODEL_DATES,
  KERNEL_SHARED_ANALYTICS_REFUSAL_REASONS,
  KERNEL_VOCABULARIES_SOURCE_COMMIT,
} from "../src/analytics-v2/kernel-vocabularies.generated";
import { ANALYTICS_V2_CACHE_BANDS } from "../src/analytics-v2/store";

const WORKER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION = "0059_analytics_v2.sql";
const MIGRATION_DIRECTORIES = ["postgres/migrations/primary", "postgres/staged-migrations/primary"];

/**
 * Refusal reasons that are the fast path's own, raised by GCP code and by no
 * kernel. Pinned: adding one is a contract change through the lead.
 */
const GCP_OWN_REFUSAL_REASONS = ["non_effective_source_unported", "day_occurrences_exceeded", "memory_budget"];

const sorted = (values: readonly string[]) => [...values].sort();

/** The quoted members of the `<column> ... CHECK (<column> IN (...))` list in a migration's text. */
function checkInList(sql: string, column: string): string[] {
  const match = new RegExp(`\\b${column} text(?: NOT NULL)? CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(sql);
  expect(match, `${MIGRATION} has no ${column} IN (...) CHECK`).not.toBeNull();
  return [...match![1].matchAll(/'([^']*)'/g)].map((literal) => literal[1]);
}

function migrationText(): { readonly sql: string; readonly later: readonly string[] } {
  const files = MIGRATION_DIRECTORIES.flatMap((directory) => {
    try {
      return readdirSync(join(WORKER_ROOT, directory)).map((name) => ({ name, path: join(WORKER_ROOT, directory, name) }));
    } catch {
      return [];
    }
  });
  const own = files.filter((file) => file.name === MIGRATION);
  expect(own, `${MIGRATION} must exist exactly once (promoted or staged)`).toHaveLength(1);
  const later = files.filter((file) => /^\d{4}_/.test(file.name) && file.name > MIGRATION).map((file) => file.path);
  return { sql: readFileSync(own[0].path, "utf8"), later };
}

describe("GCP-only vocabularies equal the vendored kernels'", () => {
  it("the generated module names the commit the vendored tree holds", () => {
    const manifest = JSON.parse(readFileSync(join(WORKER_ROOT, "vendor/analytics-d43c8f92/MANIFEST.json"), "utf8"));
    expect(KERNEL_VOCABULARIES_SOURCE_COMMIT).toBe(manifest.sourceCommit);
  });

  it("the model dates are the kernel's preview days", () => {
    expect(ANALYTICS_V2_MODEL_DATES).toBe(KERNEL_MODEL_DATES);
  });

  it("the closed refusal reasons are every kernel reason plus the fast path's own, and nothing stale", () => {
    const kernel = new Set<string>([...KERNEL_SHARED_ANALYTICS_REFUSAL_REASONS, ...KERNEL_CACHE_RETENTION_REFUSAL_REASONS]);
    for (const reason of kernel) expect(ANALYTICS_V2_REFUSAL_REASONS, `kernel reason ${reason}`).toContain(reason);
    expect(sorted(ANALYTICS_V2_REFUSAL_REASONS.filter((reason) => !kernel.has(reason)))).toEqual(sorted(GCP_OWN_REFUSAL_REASONS));
    expect(new Set(ANALYTICS_V2_REFUSAL_REASONS).size).toBe(ANALYTICS_V2_REFUSAL_REASONS.length);
  });

  it("the cache-only reasons are exactly the cache reducer's", () => {
    expect(sorted(ANALYTICS_V2_CACHE_ONLY_REFUSAL_REASONS)).toEqual(sorted(KERNEL_CACHE_RETENTION_REFUSAL_REASONS));
    for (const reason of ANALYTICS_V2_OWNER_ONLY_REFUSAL_REASONS) expect(GCP_OWN_REFUSAL_REASONS).toContain(reason);
  });

  it("the cache bands and counters are the kernel's, in the kernel's order", () => {
    expect([...ANALYTICS_V2_CACHE_RETENTION_BAND_IDS]).toEqual([...KERNEL_CACHE_RETENTION_BAND_IDS]);
    expect([...ANALYTICS_V2_CACHE_BANDS]).toEqual([...KERNEL_CACHE_RETENTION_BAND_IDS]);
    expect([...ANALYTICS_V2_CACHE_BAND_COUNTERS]).toEqual([...KERNEL_CACHE_BAND_COUNTERS]);
  });

  it("the community daily read's schema version is production's", () => {
    expect(ANALYTICS_V2_COMMUNITY_DAILY_SCHEMA_VERSION).toBe(KERNEL_COMMUNITY_DAILY_READ_SCHEMA_VERSION);
  });

  it("the primary 0059 CHECK sets hold the same vocabularies", () => {
    const { sql, later } = migrationText();
    expect(sorted(checkInList(sql, "refusal"))).toEqual(sorted(ANALYTICS_V2_OWNER_DAY_REFUSAL_REASONS));
    expect(checkInList(sql, "band")).toEqual([...KERNEL_CACHE_RETENTION_BAND_IDS]);
    const table = /CREATE TABLE analytics_v2_cache_bands \(([\s\S]*?)\n\);/.exec(sql);
    expect(table).not.toBeNull();
    const counters = [...table![1].matchAll(/^ {2}([a-z_]+) bigint NOT NULL CHECK \(\1 >= 0\),$/gm)].map((column) => column[1]);
    expect(counters).toEqual([...KERNEL_CACHE_BAND_COUNTERS]);
    // A later primary migration that redefines either closed set makes 0059 no
    // longer the authority this spec reads: point the spec at that migration.
    for (const path of later) {
      expect(readFileSync(path, "utf8"), `${path} redefines a closed analytics_v2 set`).not.toMatch(/\b(?:refusal|band)\s+IN\s*\(/);
    }
  });
});
