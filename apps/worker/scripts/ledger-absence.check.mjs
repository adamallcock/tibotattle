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
 *
 * It also keeps the one storage receipt reader single (see
 * STORAGE_RECEIPT_READER): removing the ledger receipt left readSchemaReceipt
 * as the only fail-closed reader of the primary migration receipt, and no
 * second copy may grow beside it.
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
  // The refresh job mirrors CR-3's forbidden production variables (C-REFRESH).
  "cloud-run/analytics-refresh.mjs": { "LEDGER_*": 3 },

  // Negative tests that prove those refusals.
  "cloud-run/host.check.mjs": { "LEDGER_*": 14, "CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger": 4 },
  "cloud-run/ops-backup-horizon.check.mjs": { "role:'ledger'": 2 },
  "cloud-run/origin-intake-composition.check.mjs": { ledgerSchema: 1 },
  "cloud-run/origin-route-modules.check.mjs": { LEDGER_EXPECTED_MIGRATIONS: 1, "LEDGER_*": 9 },
  "cloud-run/postgres-community-graph-benchmark.check.mjs": { "LEDGER_*": 1 },
  "cloud-run/postgres-community-graph-readback-diagnostic.check.mjs": { "LEDGER_*": 1 },
  // The maintenance job's LEDGER_SCHEMA refusal (C-MAINT).
  "cloud-run/postgres-maintenance-job.check.mjs": { "LEDGER_*": 1 },
  "cloud-run/postgres-production-configuration.check.mjs": { "LEDGER_*": 6 },
  "cloud-run/postgres-production-migrations.check.mjs": {
    "LEDGER_*": 4, "CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger": 1,
  },
  "cloud-run/postgres-runtime-grants.check.mjs": { "role:'ledger'": 3 },
  "cloud-run/production-edge-infra.check.mjs": { "LEDGER_*": 6 },
  "cloud-run/test-migrations.check.mjs": { LEDGER_EXPECTED_MIGRATIONS: 2, "LEDGER_*": 6 },
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

  // C-SIMP (2026-10-02) brought the remaining pins to zero: the A2 private
  // test deploy and the synthetic v1.2 smoke, cleanup and discovery are
  // retired (owner decision OD-6), and the dense fast-path rehearsal and
  // test deploy are primary-only.
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

async function trackedModules(root, filter = inScope) {
  // Tracked and untracked-but-not-ignored modules, so a new file is scanned
  // before it is committed.
  const output = execFileSync("git", [
    "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src", "cloud-run", "scripts",
  ], {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  return output.split("\0").filter((path) => path.length > 0 && filter(path));
}

async function scanModules(root, paths, scan) {
  const scanned = {};
  for (const path of paths) {
    let text;
    try {
      text = await readFile(join(root, path), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const counts = scan(path, text);
    if (Object.keys(counts).length > 0) scanned[path] = counts;
  }
  return scanned;
}

export async function scanTree(root = WORKER_ROOT, paths = undefined) {
  return scanModules(root, paths ?? await trackedModules(root), scanText);
}

/**
 * One storage receipt reader (wave-3 critic, conflict on
 * cloud-run/postgres-test-dispatch.mjs). readSchemaReceipt is the only
 * fail-closed reader of the primary migration receipt that gates the
 * PostgreSQL routes. The critic assigned its extraction into a src module to
 * LEAD-SIMP, so that RD-2 (src/postgres-readiness.ts, which cannot import
 * cloud-run) and CR B2's storage gate share it. W3-SIMP leaves it in place:
 * src is TypeScript only, and modules that import the dispatch load
 * unbundled on the image's Node 22.16, which strips no types by default: the
 * dense analytics-refresh.mjs source entry, whose spec requires it (it
 * imports CLOUD_RUN_IAM_TEST_TARGET from the dispatch), and, as W3-SIMP runs
 * them, host.check and the OPS-10 migration spec. An extraction tried here
 * failed that source-entry test with ERR_UNKNOWN_FILE_EXTENSION and was
 * reverted. No src module reads the receipt yet. Moving the extraction to CR
 * phase B needs the lead's or owner's acceptance (see the W3-SIMP receipt).
 * Until the extraction lands, this guard refuses a second copy:
 * - no src module names the migration-history table: RD-2 must import the
 *   one reader once it is moved into src, not re-implement it;
 * - readSchemaReceipt is declared once, in the dispatch, and the dispatch
 *   names the history table only in its constant and in that reader's one
 *   query: CR B2's gate must call the reader;
 * - outside the dispatch, only the reviewed migrators and Jobs below name the
 *   history table, each for its own run receipt; a new module that names it
 *   fails until it is reviewed here;
 * - the one exception is RECEIPT_READER_EXCEPTIONS (owner decision OWN-19).
 * The extraction updates this guard in the same change.
 */
export const STORAGE_RECEIPT_READER = Object.freeze({
  file: "cloud-run/postgres-test-dispatch.mjs",
  // MIGRATION_HISTORY_TABLE's declaration (its name and the table literal)
  // and the one history query in readSchemaReceipt.
  historyReferences: 3,
});

/** The cloud-run migrators and Jobs that read or grant the history table for their own receipts. */
export const MIGRATION_HISTORY_MODULES = Object.freeze([
  "cloud-run/postgres-community-daily-activation.mjs",
  "cloud-run/postgres-community-graph-benchmark.mjs",
  "cloud-run/postgres-community-graph-readback-diagnostic.mjs",
  "cloud-run/postgres-migrations.mjs",
  "cloud-run/postgres-production-migrations.mjs",
  "cloud-run/postgres-runtime-grants.mjs",
  "cloud-run/test-activation.mjs",
]);

/**
 * OWN-19 (owner, round 8, 2026-10-02): "pinned exception until CR phase B".
 * C-MAINT's lifecycle pass checks the migration receipt itself, inside its
 * own transaction (assertReceipt), so the check and the pass's work share
 * one snapshot. It is the ONE named exception to the single-reader rule,
 * counted at its exact history references and declaring no readSchemaReceipt.
 * D-CRB (CR phase B) consolidates it and readSchemaReceipt into one shared
 * reader and removes this entry; until then a third reader still fails, and
 * the map may only shrink (an entry that stops naming the table fails until
 * it is removed).
 */
export const RECEIPT_READER_EXCEPTIONS = Object.freeze({
  "src/postgres-lifecycle-pass.ts": Object.freeze({
    decision: "OWN-19",
    until: "CR phase B (D-CRB)",
    // MIGRATION_HISTORY_TABLE's declaration (its name and the table
    // literal), the to_regclass probe and the one history query.
    historyReferences: 4,
  }),
});

const RECEIPT_SCOPE = /^(?:src\/.+\.ts|cloud-run\/.+\.(?:[cm]?js|ts))$/u;
const HISTORY_TABLE = /_tibotattle_migration_history|\bMIGRATION_HISTORY_TABLE\b|\bmigrationHistoryTable\b/gu;
const RECEIPT_READER_DECLARATION = /\bfunction\s*\*?\s*readSchemaReceipt\b|\breadSchemaReceipt\s*=(?!=)/gu;

/** Product modules under src and cloud-run; their checks are tests, outside the guard. */
export function inReceiptScope(path) {
  return RECEIPT_SCOPE.test(path) && !/\.check\.[cm]?js$/u.test(path) && !path.startsWith("cloud-run/dist/");
}

/** History-table references and receipt-reader declarations of one module. */
export function scanReceiptText(_path, text) {
  const counts = {};
  const history = matchCount(text, HISTORY_TABLE);
  if (history > 0) counts.history = history;
  const declarations = matchCount(text, RECEIPT_READER_DECLARATION);
  if (declarations > 0) counts.declarations = declarations;
  return counts;
}

/** Every second copy of the storage receipt policy, as content-free messages. */
export function receiptReaderViolations(scanned, reader = STORAGE_RECEIPT_READER,
  modules = MIGRATION_HISTORY_MODULES, exceptions = RECEIPT_READER_EXCEPTIONS) {
  const problems = [];
  for (const [file, counts] of Object.entries(scanned).sort(([left], [right]) => left.localeCompare(right))) {
    if (file === reader.file) continue;
    if ((counts.declarations ?? 0) > 0) {
      problems.push(`${file}: declares readSchemaReceipt; import the one reader`);
    }
    const exception = Object.hasOwn(exceptions, file) ? exceptions[file] : undefined;
    if (exception !== undefined) {
      const found = counts.history ?? 0;
      if (found > exception.historyReferences) {
        problems.push(`${file}: ${found} history references (${exception.decision} exception pinned ${
          exception.historyReferences})`);
      }
      continue;
    }
    if ((counts.history ?? 0) > 0 && file.startsWith("src/")) {
      problems.push(`${file}: reads the migration history; extract the one reader into src instead`);
    } else if ((counts.history ?? 0) > 0 && !modules.includes(file)) {
      problems.push(`${file}: names the migration history outside the reviewed readers`);
    }
  }
  const own = scanned[reader.file] ?? {};
  if ((own.declarations ?? 0) !== 1) {
    problems.push(`${reader.file}: ${own.declarations ?? 0} readSchemaReceipt declarations (pinned 1)`);
  }
  if ((own.history ?? 0) !== reader.historyReferences) {
    problems.push(`${reader.file}: ${own.history ?? 0} history references (pinned ${reader.historyReferences})`);
  }
  for (const file of modules) {
    if ((scanned[file]?.history ?? 0) === 0) {
      problems.push(`${file}: listed as a history reader but names no history table; remove it`);
    }
  }
  for (const [file, exception] of Object.entries(exceptions)) {
    const found = scanned[file]?.history ?? 0;
    if (found < exception.historyReferences) {
      problems.push(`${file}: ${exception.decision} exception pinned at ${exception.historyReferences} history ${
        ""}references but found ${found}; shrink or remove it`);
    }
  }
  return problems;
}

export async function scanReceiptTree(root = WORKER_ROOT, paths = undefined) {
  return scanModules(root, paths ?? await trackedModules(root, inReceiptScope), scanReceiptText);
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
      "scripts/production-typed-preflight.check.mjs",
    ]) {
      assert.equal(inScope(path), false, path);
    }
    // The retired cost profile (OD-6) is no longer excepted: a module of
    // that name would be scanned like any other.
    assert.equal(inScope("scripts/gcp-cost-profile.mjs"), true);
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
      // The A2 deployed-test tooling retired by owner decision OD-6.
      "cloud-run/synthetic-v12-smoke.mjs",
      "cloud-run/synthetic-v12-cleanup.mjs",
      "cloud-run/synthetic-v12-discovery.mjs",
      "scripts/gcp-private-test-deploy.mjs",
      "scripts/gcp-cost-profile.mjs",
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

  test("the storage receipt policy has one reader until its extraction lands", async () => {
    assert.deepEqual(receiptReaderViolations(await scanReceiptTree()), []);
  });

  test("a second storage receipt reader fails the guard", () => {
    const reader = STORAGE_RECEIPT_READER.file;
    const current = Object.fromEntries([
      [reader, { history: STORAGE_RECEIPT_READER.historyReferences, declarations: 1 }],
      ...MIGRATION_HISTORY_MODULES.map((file) => [file, { history: 1 }]),
      ...Object.entries(RECEIPT_READER_EXCEPTIONS).map(([file, { historyReferences }]) =>
        [file, { history: historyReferences }]),
    ]);
    assert.deepEqual(receiptReaderViolations(current), []);
    // RD-2 re-implementing the reader in src.
    const src = "src/postgres-readiness.ts";
    assert.deepEqual(scanReceiptText(src,
      'const rows = await client.query(`SELECT version FROM ${schema}."_tibotattle_migration_history"`);'),
    { history: 1 });
    assert.deepEqual(receiptReaderViolations({ ...current, [src]: { history: 1 } }),
      [`${src}: reads the migration history; extract the one reader into src instead`]);
    // A new cloud-run module (CR's production host) with its own history read.
    const host = "cloud-run/postgres-production-host.mjs";
    assert.deepEqual(scanReceiptText(host, "import { MIGRATION_HISTORY_TABLE } from './postgres-runtime-grants.mjs';"),
      { history: 1 });
    assert.deepEqual(receiptReaderViolations({ ...current, [host]: { history: 1 } }),
      [`${host}: names the migration history outside the reviewed readers`]);
    // A second declaration anywhere, or a copy inside the dispatch.
    for (const text of ["async function readSchemaReceipt(pool) {}", "const readSchemaReceipt = async () => {};"]) {
      assert.deepEqual(scanReceiptText(host, text), { declarations: 1 }, text);
    }
    assert.deepEqual(scanReceiptText(host, "if (readSchemaReceipt === undefined) await readSchemaReceipt(pool);"), {});
    assert.deepEqual(receiptReaderViolations({ ...current, [host]: { declarations: 1 } }),
      [`${host}: declares readSchemaReceipt; import the one reader`]);
    assert.deepEqual(receiptReaderViolations({ ...current, [reader]: { history: 4, declarations: 1 } }),
      [`${reader}: 4 history references (pinned ${STORAGE_RECEIPT_READER.historyReferences})`]);
    assert.deepEqual(receiptReaderViolations({ ...current, [reader]: { history: 3, declarations: 2 } }),
      [`${reader}: 2 readSchemaReceipt declarations (pinned 1)`]);
    // A listed reader that stops naming the table must be removed (shrink-only).
    const [listed] = MIGRATION_HISTORY_MODULES;
    const { [listed]: _dropped, ...shrunk } = current;
    assert.deepEqual(receiptReaderViolations(shrunk),
      [`${listed}: listed as a history reader but names no history table; remove it`]);
  });

  test("OWN-19: the lifecycle pass is the one named, counted exception and a third reader still fails", async () => {
    // Exactly one exception, named for the owner decision, until CR phase B.
    assert.deepEqual(Object.keys(RECEIPT_READER_EXCEPTIONS), ["src/postgres-lifecycle-pass.ts"]);
    const [[file, exception]] = Object.entries(RECEIPT_READER_EXCEPTIONS);
    assert.equal(exception.decision, "OWN-19");
    assert.equal(inReceiptScope(file), true);
    // The pinned count is the module's real count.
    const own = scanReceiptText(file, await readFile(join(WORKER_ROOT, file), "utf8"));
    assert.deepEqual(own, { history: exception.historyReferences });
    const reader = STORAGE_RECEIPT_READER.file;
    const current = Object.fromEntries([
      [reader, { history: STORAGE_RECEIPT_READER.historyReferences, declarations: 1 }],
      ...MIGRATION_HISTORY_MODULES.map((path) => [path, { history: 1 }]),
      [file, { history: exception.historyReferences }],
    ]);
    assert.deepEqual(receiptReaderViolations(current), []);
    // Without the exception the pass is a second reader, as it was before OWN-19.
    assert.deepEqual(receiptReaderViolations(current, STORAGE_RECEIPT_READER, MIGRATION_HISTORY_MODULES, {}),
      [`${file}: reads the migration history; extract the one reader into src instead`]);
    // A third reader still fails, in src or in cloud-run, with the exception in place.
    const third = "src/postgres-readiness.ts";
    assert.deepEqual(receiptReaderViolations({ ...current, [third]: { history: 1 } }),
      [`${third}: reads the migration history; extract the one reader into src instead`]);
    const host = "cloud-run/postgres-production-host.mjs";
    assert.deepEqual(receiptReaderViolations({ ...current, [host]: { history: 1 } }),
      [`${host}: names the migration history outside the reviewed readers`]);
    // The exception is counted: it may not grow, may not declare
    // readSchemaReceipt, and must shrink or go when its references do.
    assert.deepEqual(receiptReaderViolations({ ...current, [file]: { history: exception.historyReferences + 1 } }),
      [`${file}: ${exception.historyReferences + 1} history references (OWN-19 exception pinned ${
        exception.historyReferences})`]);
    assert.deepEqual(receiptReaderViolations({ ...current,
      [file]: { history: exception.historyReferences, declarations: 1 } }),
    [`${file}: declares readSchemaReceipt; import the one reader`]);
    const { [file]: _gone, ...consolidated } = current;
    assert.deepEqual(receiptReaderViolations(consolidated),
      [`${file}: OWN-19 exception pinned at ${exception.historyReferences} history references but found 0; ${
        ""}shrink or remove it`]);
  });

  test("the receipt guard covers product modules under src and cloud-run only", async () => {
    for (const path of ["src/postgres-readiness.ts", "src/index.ts", "cloud-run/server.mjs",
      "cloud-run/routes/v11-composition.mjs"]) {
      assert.equal(inReceiptScope(path), true, path);
    }
    for (const path of ["cloud-run/host.check.mjs", "cloud-run/dist/server.mjs", "scripts/gcp-test-database.mjs",
      "postgres-test/append-only-residue.spec.mjs", "test/postgres-composition.spec.ts"]) {
      assert.equal(inReceiptScope(path), false, path);
    }
    const root = await mkdtemp(join(tmpdir(), "w3-simp-receipt-reader-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "postgres-readiness.ts"),
        "export const table = \"_tibotattle_migration_history\";\n");
      assert.deepEqual(await scanReceiptTree(root, ["src/postgres-readiness.ts"]),
        { "src/postgres-readiness.ts": { history: 1 } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
