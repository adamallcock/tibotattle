#!/usr/bin/env node

/*
 * Ledger absence gate (LEAD-SIMP, SIMP-4).
 *
 * Decisions D2, D4 and D6 of 2026-09-26 remove the independent deletion
 * ledger from the PostgreSQL line: no ledger pool, schema, migration role,
 * receipt, per-request tombstone read, re-enrollment cooldown or PT-1 ledger
 * mirror. This check scans every tracked module under apps/worker/src,
 * cloud-run and scripts (the Cloudflare D1 tooling excepted, which still runs
 * Cloudflare production) and fails on any retired token outside the pinned
 * refusal sites below. A refusal site is code that refuses a stale caller or
 * a negative test that proves that refusal; each is pinned at its exact count
 * and the map only shrinks.
 *
 * The frozen ledger migrations under postgres/migrations/ledger are not
 * modules and stay outside the scan until owner action OA-4 retires them.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED = /^(?:src|cloud-run|scripts)\/.+\.(?:[cm]?js|ts)$/u;
const THIS_GATE = Object.freeze(["scripts/ledger-absence.check.mjs", "scripts/online-erasure-absence.check.mjs"]);

/**
 * The Cloudflare Worker's D1 modules and the D1 cutover tooling: live
 * Cloudflare production until decommission, never ported, so they keep the
 * D1 deletion ledger (the DELETION_LEDGER binding and its tables).
 */
export const D1_TOOLING = Object.freeze([
  /^scripts\/production-maintenance-cutover[^/]*\.mjs$/u,
  /^scripts\/d1-[^/]*\.mjs$/u,
  /^scripts\/typed-forward-migration[^/]*\.mjs$/u,
  /^scripts\/postgres-cutover-rehearsal[^/]*\.mjs$/u,
  /^scripts\/cutover-source-[^/]*\.mjs$/u,
  /^cloud-run\/d1-analytics-export-oracle[^/]*\.mjs$/u,
  /^scripts\/gcp-cost-profile[^/]*\.mjs$/u,
  /^scripts\/production-typed-[^/]*\.mjs$/u,
]);

/** Deleted modules: no surviving module may import or load one. */
export const DELETED_PATHS = Object.freeze([
  "postgres-ledger-authority",
  "ledger-preflight-reconcile",
  "ledger-reconciliation-diagnostic",
  "postgres-erasure-ledger-transfer",
  "0007_named_gcp_test_erasure_transfer",
]);

const DELETED_IMPORT = new RegExp(
  String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|ssrLoadModule\(\s*|\bload\(\s*)["'][^"']*(?:${
    DELETED_PATHS.join("|")})[^"']*["']`, "gu");

/** Retired tokens, each as a global regular expression. */
export const RETIRED_TOKENS = Object.freeze({
  ledgerPool: /\bledgerPool\b/gu,
  ledgerSchema: /\bledgerSchema\b/gu,
  hasPostgresDeletionTombstone: /\bhasPostgresDeletionTombstone\b/gu,
  recordPostgresDeletionTombstone: /\brecordPostgresDeletionTombstone\b/gu,
  hasDeletionTombstone: /\bhasDeletionTombstone\b/gu,
  reconcileLedgerRunMirror: /\breconcileLedgerRunMirror\b/gu,
  ledger_transfer_runs: /\bledger_transfer_runs\b/gu,
  LEDGER_EXPECTED_MIGRATIONS: /(?<![A-Z0-9_])LEDGER_EXPECTED_MIGRATIONS(?![A-Z0-9_])/gu,
  ledgerMigrationReceipt: /\bledgerMigrationReceipt\b/gu,
  "role:'ledger'": /\brole\s*:\s*["']ledger["']/gu,
  "roles.ledger": /\broles\??\.ledger\b/gu,
  "POSTGRES_RUNTIME_MIGRATIONS.ledger": /\bPOSTGRES_RUNTIME_MIGRATIONS\??\.ledger\b/gu,
  // Anchored, so D1 identifiers such as LEDGER_SCHEMA_SQL or
  // WRANGLER_MIGRATION_LEDGER_SCHEMA never match.
  "LEDGER_*": /(?<![A-Z0-9_])LEDGER_(?:INSTANCE_CONNECTION_NAME|DATABASE|SCHEMA)(?![A-Z0-9_])/gu,
  "CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger": /\bCLOUD_RUN_IAM_TEST_TARGET\.postgres\.ledger\b/gu,
  "deleted-path import": DELETED_IMPORT,
});

/** identity_reenrollment_cooldowns is retired for PostgreSQL modules only. */
const COOLDOWN_TABLE = /\bidentity_reenrollment_cooldowns\b/gu;
const COOLDOWN_SCOPE = /^(?:src\/postgres-[^/]+\.ts|cloud-run\/.+)$/u;

/**
 * Pinned refusal sites: refusal code and the negative tests that prove it.
 * {file: {token: exact count}}. Shrink-only: a new occurrence anywhere fails,
 * and a removed one fails until its count here is lowered.
 */
export const REFUSAL_SITES = Object.freeze({
  // Refusal code: a stale caller or setting naming the retired ledger fails.
  "src/backend-composition.ts": { ledgerPool: 1 },
  "src/postgres-client.ts": { ledgerSchema: 1 },
  "src/postgres-maintenance.ts": { ledgerPool: 1 },
  "cloud-run/postgres-community-graph-benchmark.mjs": { "LEDGER_*": 3 },
  "cloud-run/postgres-community-graph-readback-diagnostic.mjs": { "LEDGER_*": 3 },
  "cloud-run/postgres-production-configuration.mjs": { "LEDGER_*": 6 },
  "cloud-run/postgres-production-migrations.mjs": { "CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger": 2 },

  // Negative tests that prove those refusals.
  "cloud-run/host.check.mjs": { "LEDGER_*": 14, "CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger": 4 },
  "cloud-run/ops-backup-horizon.check.mjs": { "role:'ledger'": 2 },
  "cloud-run/origin-intake-composition.check.mjs": { ledgerSchema: 1 },
  "cloud-run/origin-route-modules.check.mjs": { LEDGER_EXPECTED_MIGRATIONS: 1, "LEDGER_*": 9 },
  "cloud-run/postgres-community-graph-benchmark.check.mjs": { "LEDGER_*": 1 },
  "cloud-run/postgres-community-graph-readback-diagnostic.check.mjs": { "LEDGER_*": 1 },
  "cloud-run/postgres-production-configuration.check.mjs": { "LEDGER_*": 6 },
  "cloud-run/postgres-production-migrations.check.mjs": {
    "LEDGER_*": 4, "CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger": 1,
  },
  "cloud-run/postgres-runtime-grants.check.mjs": { "role:'ledger'": 3 },
  "cloud-run/production-edge-infra.check.mjs": { "LEDGER_*": 6 },
  "cloud-run/synthetic-v12-cleanup.check.mjs": { "LEDGER_*": 5 },
  "cloud-run/synthetic-v12-discovery.check.mjs": { "LEDGER_*": 4 },
  "cloud-run/synthetic-v12-smoke.check.mjs": { ledgerMigrationReceipt: 2, "LEDGER_*": 3 },
  "cloud-run/test-migrations.check.mjs": { LEDGER_EXPECTED_MIGRATIONS: 2, "LEDGER_*": 7 },
  "scripts/cloud-run-production-configuration.check.mjs": { "LEDGER_*": 3 },
  "scripts/gcp-backup-horizon.check.mjs": { "role:'ledger'": 1 },
  "scripts/gcp-ops-infra-manifest.check.mjs": { "LEDGER_*": 6 },
  "scripts/gcp-test-database.check.mjs": { "role:'ledger'": 2, "LEDGER_*": 4 },
  "scripts/postgres-migrations.check.mjs": { "role:'ledger'": 2 },
  "scripts/postgres-transfer-target.check.mjs": { ledgerPool: 1 },

  // The Cloudflare Worker's D1 deletion ledger (live Cloudflare production
  // until decommission; never ported to PostgreSQL).
  "src/index.ts": { hasDeletionTombstone: 7 },
  "src/participant-erasure.ts": { hasDeletionTombstone: 2 },
  "src/retention.ts": { hasDeletionTombstone: 1 },

  // Owner decision OD-6 (open): the A2 private test deploy tooling stays
  // untouched until the owner decides its retirement.
  "scripts/gcp-private-test-deploy.mjs": { ledgerSchema: 2, ledgerMigrationReceipt: 1, "LEDGER_*": 4 },
  "scripts/gcp-private-test-deploy.check.mjs": { ledgerSchema: 2, ledgerMigrationReceipt: 1, "LEDGER_*": 10 },

  // Dense-workstream files this package may not edit (post-dense follow-ups;
  // each pin drops to zero when the fast path is rebased on this package).
  "scripts/gcp-fastpath-rehearsal.mjs": { ledgerSchema: 9, "role:'ledger'": 1, "LEDGER_*": 1 },
  "scripts/gcp-fastpath-test-deploy.mjs": { ledgerSchema: 4, LEDGER_EXPECTED_MIGRATIONS: 1, "LEDGER_*": 3 },
  "scripts/gcp-fastpath-test-deploy.check.mjs": {
    ledgerSchema: 3, LEDGER_EXPECTED_MIGRATIONS: 1, "LEDGER_*": 3,
  },
});

function matchCount(text, pattern) {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(text) !== null) count += 1;
  return count;
}

/** The retired-token counts of one module's text. */
export function scanText(path, text) {
  const counts = {};
  for (const [token, pattern] of Object.entries(RETIRED_TOKENS)) {
    const count = matchCount(text, pattern);
    if (count > 0) counts[token] = count;
  }
  if (COOLDOWN_SCOPE.test(path)) {
    const count = matchCount(text, COOLDOWN_TABLE);
    if (count > 0) counts.identity_reenrollment_cooldowns = count;
  }
  return counts;
}

export function inScope(path) {
  return SCANNED.test(path) && !THIS_GATE.includes(path) && !D1_TOOLING.some((pattern) => pattern.test(path));
}

/** Every violation of the pinned refusal sites, as content-free messages. */
export function violations(scanned, sites = REFUSAL_SITES) {
  const problems = [];
  const files = new Set([...Object.keys(scanned), ...Object.keys(sites)]);
  for (const file of [...files].sort()) {
    const actual = scanned[file] ?? {};
    const allowed = sites[file] ?? {};
    for (const token of new Set([...Object.keys(actual), ...Object.keys(allowed)])) {
      const found = actual[token] ?? 0;
      const pinned = allowed[token] ?? 0;
      if (found > pinned) problems.push(`${file}: ${found} ${token} (pinned ${pinned})`);
      else if (found < pinned) problems.push(`${file}: ${token} pinned at ${pinned} but found ${found}; shrink the pin`);
    }
  }
  return problems;
}

async function trackedModules(root) {
  // Tracked and untracked-but-not-ignored modules, so a new file is scanned
  // before it is committed.
  const output = execFileSync("git", [
    "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src", "cloud-run", "scripts",
  ], {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  return output.split("\0").filter((path) => path.length > 0 && inScope(path));
}

export async function scanTree(root = WORKER_ROOT, paths = undefined) {
  const scanned = {};
  for (const path of paths ?? await trackedModules(root)) {
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
  test("no retired ledger token survives outside a pinned refusal site", async () => {
    assert.deepEqual(violations(await scanTree()), []);
  });

  test("every pinned site is in scope and every pinned count is positive", () => {
    for (const [file, tokens] of Object.entries(REFUSAL_SITES)) {
      assert.equal(inScope(file), true, file);
      for (const [token, count] of Object.entries(tokens)) {
        assert.ok(Number.isInteger(count) && count > 0, `${file} ${token}`);
        assert.ok(token in RETIRED_TOKENS || token === "identity_reenrollment_cooldowns", token);
      }
    }
  });

  test("each retired token, added to an unpinned module, fails the gate", () => {
    const samples = {
      ledgerPool: "export const ledgerPool = null;",
      ledgerSchema: "const options = { ledgerSchema: 'synthetic' };",
      hasPostgresDeletionTombstone: "await hasPostgresDeletionTombstone(pool);",
      recordPostgresDeletionTombstone: "await recordPostgresDeletionTombstone(pool);",
      hasDeletionTombstone: "await hasDeletionTombstone(db);",
      reconcileLedgerRunMirror: "reconcileLedgerRunMirror();",
      ledger_transfer_runs: "SELECT 1 FROM tibotattle_transfer.ledger_transfer_runs",
      LEDGER_EXPECTED_MIGRATIONS: "env.LEDGER_EXPECTED_MIGRATIONS",
      ledgerMigrationReceipt: "checks.ledgerMigrationReceipt",
      "role:'ledger'": "readPostgresMigrations({ role: 'ledger' })",
      "roles.ledger": "manifest.roles.ledger",
      "POSTGRES_RUNTIME_MIGRATIONS.ledger": "POSTGRES_RUNTIME_MIGRATIONS.ledger.version",
      "LEDGER_*": "process.env.LEDGER_SCHEMA",
      "CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger": "CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger.schema",
      "deleted-path import": 'import { x } from "../src/postgres-ledger-authority.ts";',
    };
    assert.deepEqual(Object.keys(samples).sort(), Object.keys(RETIRED_TOKENS).sort());
    for (const [token, text] of Object.entries(samples)) {
      for (const path of ["src/postgres-synthetic.ts", "cloud-run/synthetic.mjs", "scripts/synthetic.check.mjs"]) {
        const scanned = { [path]: scanText(path, text) };
        assert.equal(scanned[path][token], 1, `${token} in ${path}`);
        assert.equal(violations(scanned, {}).length, 1, `${token} in ${path}`);
      }
    }
    // A pinned site that grows by one occurrence fails too.
    const [file, tokens] = Object.entries(REFUSAL_SITES)[0];
    const [token, count] = Object.entries(tokens)[0];
    assert.deepEqual(violations({ [file]: { [token]: count + 1 } }, { [file]: { [token]: count } }),
      [`${file}: ${count + 1} ${token} (pinned ${count})`]);
  });

  test("a removed occurrence fails until its pin shrinks (shrink-only map)", () => {
    assert.deepEqual(violations({}, { "cloud-run/synthetic.mjs": { ledgerPool: 2 } }),
      ["cloud-run/synthetic.mjs: ledgerPool pinned at 2 but found 0; shrink the pin"]);
    assert.deepEqual(violations({ "cloud-run/synthetic.mjs": { ledgerPool: 1 } },
      { "cloud-run/synthetic.mjs": { ledgerPool: 2 } }),
    ["cloud-run/synthetic.mjs: ledgerPool pinned at 2 but found 1; shrink the pin"]);
  });

  test("the re-enrollment cooldown table is retired for PostgreSQL modules only", () => {
    const text = "SELECT 1 FROM identity_reenrollment_cooldowns";
    assert.deepEqual(scanText("src/postgres-google-enrollment.ts", text), { identity_reenrollment_cooldowns: 1 });
    assert.deepEqual(scanText("cloud-run/server.mjs", text), { identity_reenrollment_cooldowns: 1 });
    // The D1 Worker keeps its own cooldown table.
    assert.deepEqual(scanText("src/participant-erasure.ts", text), {});
  });

  test("D1 identifiers and the D1 tooling are not PostgreSQL ledger tokens", () => {
    for (const text of [
      "const CUTOVER_EXPECTED_LEDGER_SCHEMA = 1;",
      "export const LEDGER_SCHEMA_SQL = '';",
      "throw new Error('LEDGER_SCHEMA_MISMATCH');",
      "WRANGLER_MIGRATION_LEDGER_SCHEMA",
      "REMOTE_DELETION_LEDGER_SCHEMA_VERSION",
      "accountless_enrollment_ledger",
      "env.DELETION_LEDGER",
      "const ledgerSchemaName = 'x';",
      "ledger_schema_name",
    ]) {
      assert.deepEqual(scanText("cloud-run/synthetic.mjs", text), {}, text);
    }
    for (const path of [
      "scripts/production-maintenance-cutover.mjs", "scripts/d1-export.mjs",
      "scripts/typed-forward-migration.mjs", "scripts/postgres-cutover-rehearsal.check.mjs",
      "scripts/cutover-source-proof.mjs", "cloud-run/d1-analytics-export-oracle.check.mjs",
      "scripts/gcp-cost-profile.mjs", "scripts/production-typed-preflight.check.mjs",
    ]) {
      assert.equal(inScope(path), false, path);
    }
    for (const path of ["src/postgres-client.ts", "cloud-run/server.mjs", "scripts/postgres-transfer-target.mjs"]) {
      assert.equal(inScope(path), true, path);
    }
    assert.equal(inScope("scripts/ledger-absence.check.mjs"), false);
    assert.equal(inScope("postgres-test/postgres-maintenance.spec.mjs"), false);
  });

  test("every deleted module is absent and no tracked module loads one", async () => {
    for (const path of [
      "src/postgres-ledger-authority.ts",
      "cloud-run/ledger-preflight-reconcile.mjs",
      "cloud-run/ledger-reconciliation-diagnostic.mjs",
      "scripts/postgres-erasure-ledger-transfer.mjs",
      "postgres/proposals/0007_named_gcp_test_erasure_transfer.sql",
    ]) {
      await assert.rejects(readFile(join(WORKER_ROOT, path)), { code: "ENOENT" }, path);
    }
    for (const text of [
      'await vite.ssrLoadModule("/src/postgres-ledger-authority.ts")',
      'const module = await import("./ledger-preflight-reconcile.mjs")',
      "import './ledger-reconciliation-diagnostic.mjs';",
    ]) {
      assert.equal(scanText("cloud-run/synthetic.mjs", text)["deleted-path import"], 1, text);
    }
  });

  test("the scan reads a modified temporary copy, not a cached tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "w3-simp-ledger-absence-"));
    try {
      await mkdir(join(root, "cloud-run"), { recursive: true });
      await writeFile(join(root, "cloud-run", "synthetic.mjs"), "export const ledgerPool = 1;\n");
      const scanned = await scanTree(root, ["cloud-run/synthetic.mjs", "cloud-run/absent.mjs"]);
      assert.deepEqual(scanned, { "cloud-run/synthetic.mjs": { ledgerPool: 1 } });
      assert.deepEqual(violations(scanned, {}), ["cloud-run/synthetic.mjs: 1 ledgerPool (pinned 0)"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
