// The GCP-only vocabulary copies against the vocabularies generated from the
// vendored kernels (src/analytics-v2/kernel-vocabularies.generated.ts, written
// by scripts/vendor-analytics-kernels.mjs and held to the vendored tree by
// scripts/vendor-analytics-kernels.check.mjs). A re-vendor that changes a
// kernel vocabulary regenerates that module, and this spec then fails until
// every GCP copy, including the primary 0059 CHECK sets, has been ported.
//
// The named copies are compared exactly. Copies this spec does not name are
// found by scanning the GCP code (see COPY_ROOTS): a read schema version, a
// band list or a counter list there must hold the whole kernel vocabulary, so
// a copy added later, or one that arrives with another branch, is checked too.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANALYTICS_V2_CACHE_COUNTERS as PARITY_CACHE_COUNTERS,
  REFUSAL_REASONS as PARITY_REFUSAL_REASONS,
} from "../scripts/analytics-v2-owner-parity-compare.mjs";
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
 * Later primary migrations that name an analytics_v2 table the closed sets live
 * on without restating a set, reviewed and pinned by the sha256 of their bytes
 * (an edit re-arms the guard). K-CORE-A's run stamps (0069) add the kernel_id
 * and manifest_version stamp columns and their NOT VALID checks to the seven
 * analytics_v2 tables, analytics_v2_cache_bands and analytics_v2_owner_day
 * among them; it adds no counter, band or refusal column and no CHECK on one.
 * Reviewed where K-VENDOR2's spec met it, at the PROD-PREP merge.
 */
const REVIEWED_LATER_MIGRATIONS: Readonly<Record<string, string>> = {
  "0069_analytics_v2_run_stamps.sql": "97d4ef47627dec182f61eb5f94478e5cd2e5f87d6044d891f4d756155170e59d",
};

/**
 * Refusal reasons that are the fast path's own, raised by GCP code and by no
 * kernel. Pinned: adding one is a contract change through the lead.
 */
const GCP_OWN_REFUSAL_REASONS = ["non_effective_source_unported", "day_occurrences_exceeded", "memory_budget"];

const sorted = (values: readonly string[]) => [...values].sort();
const camelCase = (name: string) => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

/**
 * Whether a migration file comes after 0059: every primary migration but 0059
 * itself and the numbered ones before it, so a staged NNNN_ placeholder counts.
 */
function laterMigration(name: string): boolean {
  return name.endsWith(".sql") && name !== MIGRATION && !(/^\d{4}_/.test(name) && name < MIGRATION);
}

/**
 * Whether a later migration touches a closed set this spec reads from 0059:
 * it names analytics_v2_cache_bands (the band CHECK and the counter columns),
 * names analytics_v2_owner_day together with its refusal column or constraint,
 * or restates a refusal or band set in any CHECK form (`IN (...)`,
 * `= ANY (ARRAY[...])`, `<> ALL (...)`).
 */
function touchesClosedSet(sql: string): boolean {
  return /analytics_v2_cache_bands/i.test(sql)
    || (/analytics_v2_owner_day/i.test(sql) && /refusal/i.test(sql))
    || /\b(?:refusal|band)\b"?\)?\s*(?:::\s*[a-z_ ]+(?:\[\])?\s*\)?\s*)?(?:(?:NOT\s+)?IN\s*\(|(?:=|<>|!=)\s*(?:ANY|ALL)\s*\()/i.test(sql);
}

/**
 * Where GCP code may hold a vocabulary copy, relative to apps/worker. Tests,
 * checks and their fixtures are left out: they may quote an old or invalid
 * value on purpose.
 */
const COPY_ROOTS = ["src/analytics-v2", "cloud-run", "scripts", "postgres"];
const COPY_SKIPPED_DIRECTORIES = new Set(["node_modules", "dist"]);
const COPY_FILE = /\.(?:ts|mjs|js|sql)$/;
const TEST_FILE = /\.(?:check|spec|test)\.[cm]?[jt]s$/;

function copyCandidates(): { readonly path: string; readonly text: string }[] {
  const files: { path: string; text: string }[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !COPY_SKIPPED_DIRECTORIES.has(entry.name)) walk(path);
      } else if (entry.isFile() && COPY_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
        files.push({ path: relative(WORKER_ROOT, path).split(sep).join("/"), text: readFileSync(path, "utf8") });
      }
    }
  };
  for (const root of COPY_ROOTS) walk(join(WORKER_ROOT, root));
  return files.sort((left, right) => (left.path < right.path ? -1 : 1));
}

const named = (text: string, word: string) => new RegExp(`(?<![\\w$])${word}(?![\\w$])`).exec(text)?.index ?? -1;

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
  const later = files.filter((file) => laterMigration(file.name)).map((file) => file.path);
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
    // A later primary migration, numbered or staged, that touches either closed
    // set or the counter columns makes 0059 no longer the whole authority this
    // spec reads: point the spec at that migration.
    for (const path of later) {
      const text = readFileSync(path, "utf8");
      const reviewed = REVIEWED_LATER_MIGRATIONS[path.split(sep).at(-1)!];
      if (reviewed !== undefined) {
        expect(createHash("sha256").update(text).digest("hex"), `${path} changed since its review`).toBe(reviewed);
        continue;
      }
      expect(touchesClosedSet(text), `${path} touches a closed analytics_v2 set; repoint this spec at it`).toBe(false);
    }
  });

  it("a reviewed later migration restates no closed set: no band, refusal or counter column", () => {
    for (const name of Object.keys(REVIEWED_LATER_MIGRATIONS)) {
      const text = readFileSync(join(WORKER_ROOT, "postgres/migrations/primary", name), "utf8");
      const code = text.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
      expect(named(code, "band"), `${name} names the band column`).toBe(-1);
      expect(named(code, "refusal"), `${name} names the refusal column`).toBe(-1);
      for (const counter of KERNEL_CACHE_BAND_COUNTERS) expect(named(code, counter), `${name} names ${counter}`).toBe(-1);
      expect(/\bbigint\b/i.test(code), `${name} adds a bigint column`).toBe(false);
    }
  });

  it("the later-migration guard sees staged placeholders and every way a closed set can be restated", () => {
    for (const name of ["0060_x.sql", "0100_x.sql", "NNNN_x.sql", "nnnn_x.sql", "staged.sql"]) expect(laterMigration(name), name).toBe(true);
    for (const name of [MIGRATION, "0058_x.sql", "0001_x.sql", "NNNN_x.md"]) expect(laterMigration(name), name).toBe(false);
    for (const sql of [
      "ALTER TABLE analytics_v2_cache_bands ADD COLUMN excluded_other bigint NOT NULL DEFAULT 0;",
      "ALTER TABLE ONLY public.ANALYTICS_V2_CACHE_BANDS DROP CONSTRAINT analytics_v2_cache_bands_band_check;",
      "ALTER TABLE analytics_v2_owner_day DROP CONSTRAINT analytics_v2_owner_day_refusal_check;",
      "ALTER TABLE x ADD CONSTRAINT y CHECK (refusal IN ('a'));",
      "ALTER TABLE x ADD CONSTRAINT y CHECK (band NOT IN ('a'));",
      "CHECK ((refusal = ANY (ARRAY['a'::text, 'b'::text])))",
      "CHECK (((band)::text = ANY ((ARRAY['a'::character varying])::text[])))",
      "CHECK (\"refusal\" <> ALL ('{a}'::text[]))",
    ]) expect(touchesClosedSet(sql), sql).toBe(true);
    for (const sql of [
      "CREATE INDEX analytics_v2_published_daily_day ON analytics_v2_published_daily(day);",
      "-- served is the first GCP publication (any analytics_v2_published_daily row",
      "ALTER TABLE analytics_v2_runs ADD COLUMN note text;",
      "CREATE TABLE bands_of_x (id text PRIMARY KEY);",
    ]) expect(touchesClosedSet(sql), sql).toBe(false);
  });

  it("the owner parity compare's counters and refusal mapping are the kernel's", () => {
    expect([...PARITY_CACHE_COUNTERS]).toEqual(KERNEL_CACHE_BAND_COUNTERS.map(camelCase));
    for (const [family, reasons] of Object.entries(PARITY_REFUSAL_REASONS)) {
      for (const reason of reasons as readonly string[]) expect(ANALYTICS_V2_REFUSAL_REASONS, `${family}: ${reason}`).toContain(reason);
    }
  });

  it("every other copy in GCP code holds the whole kernel vocabulary", () => {
    const files = copyCandidates();
    expect(files.some((file) => file.path === `postgres/migrations/primary/${MIGRATION}`)).toBe(true);
    const counters = KERNEL_CACHE_BAND_COUNTERS.map((counter) => [counter, camelCase(counter)] as const);
    const distinctive = counters.filter(([counter]) => counter.includes("_"));
    for (const { path, text } of files) {
      // The community daily read version: any mention is the kernel's.
      for (const match of text.matchAll(/community-daily-read-v\d+(?:\.\d+)*/g)) {
        expect(match[0], `${path} names a community daily read version`).toBe(KERNEL_COMMUNITY_DAILY_READ_SCHEMA_VERSION);
      }
      // A band list names every band, first in the kernel's order. A file that
      // takes its bands from a checked constant derives them and is exempt.
      const bandAt = KERNEL_CACHE_RETENTION_BAND_IDS.map((band) => named(text, band));
      if (bandAt.some((index) => index >= 0) && !/\bANALYTICS_V2_CACHE_(?:RETENTION_BAND_IDS|BANDS)\b/.test(text)) {
        expect(KERNEL_CACHE_RETENTION_BAND_IDS.filter((_, index) => bandAt[index] < 0), `${path} names some cache bands but not these`).toEqual([]);
        expect([...bandAt].sort((left, right) => left - right), `${path} names the cache bands out of the kernel's order`).toEqual(bandAt);
      }
      // A counter list names every counter, snake_case or camelCase. A file that
      // takes its counters from the checked constant derives them and is exempt.
      if (distinctive.some((forms) => forms.some((form) => named(text, form) >= 0))
          && !/\bANALYTICS_V2_CACHE_BAND_COUNTERS\b/.test(text)) {
        const missing = counters.filter((forms) => forms.every((form) => named(text, form) < 0)).map(([counter]) => counter);
        expect(missing, `${path} names some cache band counters but not these`).toEqual([]);
      }
    }
  });
});
