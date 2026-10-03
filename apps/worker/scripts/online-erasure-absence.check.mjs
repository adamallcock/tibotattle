#!/usr/bin/env node

/*
 * Online-erasure absence gate (LEAD-SIMP, SIMP-1).
 *
 * Decision D2 of 2026-09-26 (Variant B) makes erasure a rare, manual,
 * offline owner procedure: the running PostgreSQL service has no owner
 * erasure, analytics-owner retirement or erasure preflight. This check scans
 * every PostgreSQL module under apps/worker/src and every module under
 * cloud-run, and fails when a retired online-erasure symbol is declared,
 * exported or called, or when a deleted erasure module is loaded. A pinned
 * site is a negative assertion that names a retired symbol to prove it is
 * gone; each is pinned at its exact count and the map only shrinks.
 *
 * The only erasure path is the Variant B offline owner purge (PURGE-1, not
 * yet built), which deletes the participant's objects first and then the
 * participant (owner decision on the SIMP-1 order, 2026-10-02); it is owner
 * tooling, not a module of the running service. The A2 synthetic cleanup
 * that deleted participants online is retired (owner decision OD-6).
 *
 * The saved owner sets (E-OWNERSET, the owner-sets migration) are deleted
 * only by that purge: their trigger allows a DELETE when the transaction
 * names the owner in the offline-purge session setting, and the runtime role
 * holds DELETE on every table, so the trigger is the only barrier. This check
 * therefore also fails when any production module of the running service
 * (every module under src and cloud-run except checks and specs) names that
 * setting, or deletes in a module that names a saved-set table, its contract
 * key or the purge inventory. Each is pinned at zero.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED = /^(?:src\/postgres-[^/]+\.ts|cloud-run\/.+\.(?:[cm]?js|ts))$/u;
/** The running service's production modules (the saved-set purge rule). */
const SERVICE_MODULE = /^(?:src\/.+\.ts|cloud-run\/.+\.(?:[cm]?js|ts))$/u;
const NOT_PRODUCTION = /(?:\.(?:check|spec|test)\.[cm]?[jt]s|\.d\.ts)$/u;

/** The offline-purge session setting the owner-sets migration's trigger reads. */
export const OFFLINE_PURGE_SETTING = "analytics_v2_offline_purge";
/**
 * The tables only the offline purge deletes from, with their contract.ts
 * ANALYTICS_V2_TABLES keys: the saved owner sets and contributions (the
 * setting's trigger) and the per-day receipt (never deleted).
 */
export const PURGE_ONLY_TABLES = Object.freeze({
  dailyOwnerSets: "analytics_v2_daily_owner_sets",
  dailyContributions: "analytics_v2_daily_contributions",
  ownerSetBootstrap: "analytics_v2_daily_owner_set_bootstrap",
});
const PURGE_INVENTORY = "ANALYTICS_V2_OWNER_SCOPED_TABLES";
const SQL_DELETE = /\bDELETE\s+FROM\b/iu;
const PURGE_ONLY_NAME = new RegExp(String.raw`\b(?:${[...Object.keys(PURGE_ONLY_TABLES),
  ...Object.values(PURGE_ONLY_TABLES), PURGE_INVENTORY].join("|")})\b`, "u");

/** The five deleted online-erasure modules. */
export const DELETED_MODULES = Object.freeze([
  "postgres-owner-erasure",
  "postgres-social-owner-erasure",
  "postgres-social-owner-erasure-preflight",
  "postgres-accountless-owner-erasure",
  "postgres-analytics-owner-retirement",
]);

const DELETED_IMPORT = new RegExp(
  String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|ssrLoadModule\(\s*|\bload\(\s*)["'][^"']*/(?:${
    DELETED_MODULES.join("|")})(?:\.[cm]?[jt]s)?["']`, "gu");

/** A retired online-erasure symbol. */
export const RETIRED_SYMBOL =
  /^(?:(?:erase|retire)[A-Za-z0-9_$]*Owner[A-Za-z0-9_$]*|[A-Za-z0-9_$]*OwnerResidue[A-Za-z0-9_$]*|[A-Za-z0-9_$]*OwnerErasure[A-Za-z0-9_$]*|[A-Za-z0-9_$]*OwnerRetirement[A-Za-z0-9_$]*|OWNER_DIGEST_TABLES|[A-Z0-9_]*PARTICIPANT_TABLES)$/u;

/**
 * Identifiers that match the retired shape but are not erasure machinery,
 * per file. Empty since the retired A2 synthetic discovery (OD-6) took its
 * closed table allowlist with it; an entry needs review.
 */
export const ALLOWED_SYMBOLS = Object.freeze({});

/**
 * Pinned negative assertions: {file: {symbol: exact count}}. Shrink-only.
 */
export const PINNED_SITES = Object.freeze({
  // FC-11's removal: the family contract asserts these names are gone.
  "cloud-run/postgres-family-contract.check.mjs": {
    OWNER_DIGEST_TABLES: 1, KNOWN_PARTICIPANT_TABLES: 1, ACCOUNTLESS_PARTICIPANT_TABLES: 1,
  },
});

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/gu;

export function inScope(path) {
  return SCANNED.test(path);
}

/** A production module of the running service (the saved-set purge rule's scope). */
export function inServiceScope(path) {
  return SERVICE_MODULE.test(path) && !NOT_PRODUCTION.test(path);
}

/**
 * The saved-set purge rule's counts for one service module: each naming of
 * the offline-purge setting, and a SQL delete in a module that names a
 * purge-only table, its contract key or the purge inventory.
 */
export function scanPurgeText(text) {
  const counts = {};
  const settings = text.split(OFFLINE_PURGE_SETTING).length - 1;
  if (settings > 0) counts["offline-purge setting"] = settings;
  if (SQL_DELETE.test(text) && PURGE_ONLY_NAME.test(text)) counts["saved-set delete"] = 1;
  return counts;
}

/** Retired-symbol and deleted-import counts of one module's text. */
export function scanText(path, text, allowedSymbols = ALLOWED_SYMBOLS) {
  const counts = {};
  const allowed = allowedSymbols[path] ?? [];
  IDENTIFIER.lastIndex = 0;
  for (const [identifier] of text.matchAll(IDENTIFIER)) {
    if (RETIRED_SYMBOL.test(identifier) && !allowed.includes(identifier)) {
      counts[identifier] = (counts[identifier] ?? 0) + 1;
    }
  }
  const imports = [...text.matchAll(DELETED_IMPORT)].length;
  if (imports > 0) counts["deleted-module import"] = imports;
  return counts;
}

export function violations(scanned, sites = PINNED_SITES) {
  const problems = [];
  const files = new Set([...Object.keys(scanned), ...Object.keys(sites)]);
  for (const file of [...files].sort()) {
    const actual = scanned[file] ?? {};
    const pinned = sites[file] ?? {};
    for (const symbol of new Set([...Object.keys(actual), ...Object.keys(pinned)])) {
      const found = actual[symbol] ?? 0;
      const allowed = pinned[symbol] ?? 0;
      if (found > allowed) problems.push(`${file}: ${found} ${symbol} (pinned ${allowed})`);
      else if (found < allowed) problems.push(`${file}: ${symbol} pinned at ${allowed} but found ${found}; shrink the pin`);
    }
  }
  return problems;
}

async function modules(root) {
  const output = execFileSync("git", [
    "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src", "cloud-run",
  ], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return output.split("\0").filter((path) => path.length > 0 && (inScope(path) || inServiceScope(path)));
}

export async function scanTree(root = WORKER_ROOT, paths = undefined) {
  const scanned = {};
  for (const path of paths ?? await modules(root)) {
    let text;
    try {
      text = await readFile(join(root, path), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const counts = { ...(inScope(path) ? scanText(path, text) : {}),
      ...(inServiceScope(path) ? scanPurgeText(text) : {}) };
    if (Object.keys(counts).length > 0) scanned[path] = counts;
  }
  return scanned;
}

if (process.argv.includes("--print")) {
  console.log(JSON.stringify(await scanTree(), null, 2));
} else {
  test("no online-erasure symbol or module survives in the PostgreSQL line", async () => {
    assert.deepEqual(violations(await scanTree()), []);
  });

  test("the five erasure modules and their specs are deleted", async () => {
    for (const name of DELETED_MODULES) {
      await assert.rejects(readFile(join(WORKER_ROOT, "src", `${name}.ts`)), { code: "ENOENT" }, name);
      await assert.rejects(readFile(join(WORKER_ROOT, "postgres-test", `${name}.spec.mjs`)),
        { code: "ENOENT" }, name);
    }
  });

  test("each retired symbol shape fails in an unpinned module", () => {
    for (const symbol of [
      "eraseSyntheticPostgresV12Owner", "erasePostgresSocialOwner", "erasePostgresAccountlessOwner",
      "retirePostgresAnalyticsOwner", "hasPostgresAnalyticsOwnerResidue",
      "PostgresSocialOwnerErasureError", "inspectPostgresSocialOwnerErasureTarget",
      "PostgresAnalyticsOwnerRetirementResult", "OWNER_DIGEST_TABLES",
      "KNOWN_PARTICIPANT_TABLES", "ACCOUNTLESS_PARTICIPANT_TABLES",
    ]) {
      for (const [path, text] of [
        ["src/postgres-synthetic.ts", `export async function ${symbol}() {}`],
        ["cloud-run/synthetic.mjs", `const value = ${symbol};`],
        ["cloud-run/routes/synthetic.mjs", `await ${symbol}(pool);`],
      ]) {
        const scanned = { [path]: scanText(path, text) };
        assert.deepEqual(scanned[path], { [symbol]: 1 }, `${symbol} in ${path}`);
        assert.equal(violations(scanned, {}).length, 1, `${symbol} in ${path}`);
      }
    }
    for (const name of DELETED_MODULES) {
      for (const text of [
        `import { x } from "../src/${name}.ts";`,
        `await vite.ssrLoadModule("/src/${name}.ts")`,
        `const module = await import("./${name}.mjs")`,
      ]) {
        assert.equal(scanText("cloud-run/synthetic.mjs", text)["deleted-module import"], 1, text);
      }
    }
  });

  test("the allowlist is file-scoped and does not hide a retired symbol elsewhere", () => {
    assert.deepEqual(ALLOWED_SYMBOLS, {}, "no allowed symbol remains after the A2 discovery's retirement");
    const allowed = { "cloud-run/synthetic-discovery.mjs": ["ALLOWED_PARTICIPANT_TABLES", "MAX_PARTICIPANT_TABLES"] };
    const text = "const ALLOWED_PARTICIPANT_TABLES = {}; const MAX_PARTICIPANT_TABLES = 1;";
    assert.deepEqual(scanText("cloud-run/synthetic-discovery.mjs", text, allowed), {});
    assert.deepEqual(scanText("cloud-run/synthetic-cleanup.mjs", text, allowed),
      { ALLOWED_PARTICIPANT_TABLES: 1, MAX_PARTICIPANT_TABLES: 1 });
    assert.deepEqual(scanText("cloud-run/synthetic-discovery.mjs", "eraseSyntheticPostgresV12Owner()", allowed),
      { eraseSyntheticPostgresV12Owner: 1 });
    // With the real (empty) allowlist, the former discovery names are refused.
    assert.deepEqual(scanText("cloud-run/synthetic-v12-discovery.mjs", text),
      { ALLOWED_PARTICIPANT_TABLES: 1, MAX_PARTICIPANT_TABLES: 1 });
  });

  test("ordinary participant and maintenance names are not retired symbols", () => {
    for (const text of [
      "cleanupSyntheticV12Participant", "readSyntheticV12CleanupTarget", "ownerErasureJobsComplete",
      "storage_owner_erasure_receipts", "createGcsErasureBucketHistoryProof", "pendingErasureJobs",
      "renewPostgresAccountlessUploadOwner", "createPostgresAccountlessUploadOwner", "eraseRange",
      "retirementWindow", "participantTables",
    ]) {
      assert.deepEqual(scanText("cloud-run/synthetic.mjs", text), {}, text);
    }
  });

  test("the scope is the PostgreSQL line, and a pin that shrinks must be lowered", () => {
    assert.equal(inScope("src/postgres-client.ts"), true);
    assert.equal(inScope("cloud-run/server.mjs"), true);
    assert.equal(inScope("cloud-run/routes/v11-composition.mjs"), true);
    // The D1 Worker's own erasure stays with Cloudflare production.
    assert.equal(inScope("src/participant-erasure.ts"), false);
    assert.equal(inScope("scripts/online-erasure-absence.check.mjs"), false);
    assert.deepEqual(violations({}, { "cloud-run/synthetic.mjs": { OWNER_DIGEST_TABLES: 1 } }),
      ["cloud-run/synthetic.mjs: OWNER_DIGEST_TABLES pinned at 1 but found 0; shrink the pin"]);
  });

  test("no service module names the offline-purge setting or deletes from a saved-set table", async () => {
    const scanned = await scanTree();
    for (const [file, counts] of Object.entries(scanned)) {
      assert.deepEqual(Object.keys(counts).filter((key) => key === "offline-purge setting" || key === "saved-set delete"),
        [], file);
    }
  });

  test("the setting and each saved-set delete shape fail in a service module, and only there", () => {
    const purge = (path, text) => ({ [path]: { ...(inScope(path) ? scanText(path, text) : {}),
      ...(inServiceScope(path) ? scanPurgeText(text) : {}) } });
    for (const [path, text] of [
      ["src/analytics-v2/store-owner-sets.ts", "await client.query(\"SELECT set_config('tibotattle.analytics_v2_offline_purge', $1, true)\");"],
      ["cloud-run/purge-job.mjs", "SET LOCAL tibotattle.analytics_v2_offline_purge = 'x'"],
      ["src/postgres-maintenance.ts", "// names tibotattle.analytics_v2_offline_purge in a comment"],
    ]) {
      assert.deepEqual(purge(path, text)[path], { "offline-purge setting": 1 }, path);
      assert.equal(violations(purge(path, text), {}).length, 1, path);
    }
    for (const text of [
      "await client.query(`DELETE FROM ${relation(schema, tables.dailyContributions)} WHERE owner_digest = $1`);",
      'await client.query(`DELETE FROM "s".analytics_v2_daily_owner_sets WHERE day = $1`);',
      "for (const key of ANALYTICS_V2_OWNER_SCOPED_TABLES) await client.query(`delete from ${relation(schema, key)}`);",
      "const table = tables.ownerSetBootstrap; await client.query(`DELETE FROM ${table}`);",
    ]) {
      const path = "src/analytics-v2/retire.ts";
      assert.deepEqual(purge(path, text)[path], { "saved-set delete": 1 }, text);
      assert.equal(violations(purge(path, text), {}).length, 1, text);
    }
    // The derived families a run replaces, a route's DELETE method, and a
    // saved-set table named without a delete are not the rule's.
    for (const text of [
      "await client.query(`DELETE FROM ${relation(schema, tables.ownerDay)} WHERE owner_digest = ANY($1)`);",
      'const methods = ["GET", "POST", "DELETE"]; const key = "dailyContributions";',
      "await client.query(`INSERT INTO ${relation(schema, tables.dailyOwnerSets)} SELECT 1`);",
    ]) {
      assert.deepEqual(scanPurgeText(text), {}, text);
    }
    // Checks, specs and type declarations are not service modules; the rule
    // covers every other module under src and cloud-run.
    for (const path of ["cloud-run/host.check.mjs", "src/analytics-v2/owner-sets.spec.ts", "src/env.d.ts",
      "scripts/purge.mjs", "postgres-test/analytics-v2-owner-sets.spec.mjs"]) {
      assert.equal(inServiceScope(path), false, path);
    }
    for (const path of ["src/analytics-v2/store-owner-sets.ts", "src/participant-erasure.ts", "cloud-run/server.mjs",
      "cloud-run/routes/v11-composition.mjs"]) {
      assert.equal(inServiceScope(path), true, path);
    }
  });

  test("the purge-only tables are the owner-sets migration's, with the setting its trigger reads", async () => {
    const directories = [join(WORKER_ROOT, "postgres", "migrations", "primary"),
      join(WORKER_ROOT, "postgres", "staged-migrations", "primary")];
    const found = [];
    for (const directory of directories) {
      for (const name of await readdir(directory)) {
        if (name.endsWith("_analytics_v2_owner_sets.sql")) found.push(join(directory, name));
      }
    }
    assert.equal(found.length, 1, "exactly one owner-sets migration, staged or promoted");
    const sql = await readFile(found[0], "utf8");
    assert.match(sql, new RegExp(String.raw`current_setting\('tibotattle\.${OFFLINE_PURGE_SETTING}', true\)`, "u"));
    const guarded = [...sql.matchAll(/BEFORE UPDATE OR DELETE ON (\w+)\s+FOR EACH ROW EXECUTE FUNCTION (\w+)\(\)/gu)]
      .map(([, table, fn]) => [table, fn]).sort();
    assert.deepEqual(guarded, [
      [PURGE_ONLY_TABLES.dailyContributions, "analytics_v2_owner_sets_append_only"],
      [PURGE_ONLY_TABLES.ownerSetBootstrap, "analytics_v2_owner_set_bootstrap_immutable"],
      [PURGE_ONLY_TABLES.dailyOwnerSets, "analytics_v2_owner_sets_append_only"],
    ].sort());
    // contract.ts names each table under the same key.
    const contract = await readFile(join(WORKER_ROOT, "src", "analytics-v2", "contract.ts"), "utf8");
    for (const [key, table] of Object.entries(PURGE_ONLY_TABLES)) {
      assert.match(contract, new RegExp(String.raw`\b${key}: "${table}"`, "u"), key);
    }
  });

  test("the scan reads a temporary copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "w3-simp-online-erasure-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "postgres-synthetic.ts"),
        "export function retirePostgresAnalyticsOwner() {}\n");
      const scanned = await scanTree(root, ["src/postgres-synthetic.ts"]);
      assert.deepEqual(violations(scanned, {}),
        ["src/postgres-synthetic.ts: 1 retirePostgresAnalyticsOwner (pinned 0)"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
