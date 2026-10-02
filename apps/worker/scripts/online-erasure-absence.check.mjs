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
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED = /^(?:src\/postgres-[^/]+\.ts|cloud-run\/.+\.(?:[cm]?js|ts))$/u;

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
  return output.split("\0").filter((path) => path.length > 0 && inScope(path));
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
    const counts = scanText(path, text);
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
