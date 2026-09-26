#!/usr/bin/env node

/**
 * Operator-local D1 export oracle CLI (HX-4). Never part of the Cloud Run
 * image or its build context; the operator runs the bundled
 * `dist/d1-analytics-export-oracle.mjs` through the HX-3 `oracle` subcommand.
 *
 *   --ingestion <scratch copy> --analytics <scratch copy> --ledger <scratch copy>
 *   --pinned-now-ms <drain quiescentAtMs> --inventory <HX-6 inventory> --out <new file>
 *
 * The three database arguments must be the operator's 0600 SCRATCH COPIES of
 * the sealed exports (the oracle writes to them); a sealed 0400 export is
 * refused. The inventory supplies the cache-retention fromDay and the
 * informational FOLD history, and must name the same drain instant.
 *
 * The output is the closed `analytics-history-oracle-v2` document, written at
 * mode 0600 with a sibling `<out>.sha256`, both created atomically and never
 * over an existing file. A failure leaves neither behind. Logs are JSON lines
 * of closed codes and counts only: no paths, identifiers, SQL or messages.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmod, link, lstat, open, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/canonical-json.ts";
import {
  validateAnalyticsHistoryFoldHistory,
  validateAnalyticsHistoryOracle,
  validAnalyticsHistoryDay,
} from "../src/analytics-history-proof.ts";
import {
  ANALYTICS_EXPORT_NOT_QUIESCENT_REASONS,
  D1_ANALYTICS_EXPORT_ORACLE_ERRORS,
  runD1AnalyticsExportOracle,
} from "../src/d1-analytics-export-oracle.ts";
import { openSealedSqliteD1, SEALED_SQLITE_D1_ADAPTER_ERRORS } from "./sealed-sqlite-d1-adapter.mjs";

export const D1_ANALYTICS_EXPORT_ORACLE_EVENT = "d1_analytics_export_oracle";
export const D1_ANALYTICS_EXPORT_ORACLE_CLI_ERRORS = Object.freeze([
  "ORACLE_ARGUMENT_INVALID",
  "ORACLE_INPUT_NOT_SCRATCH",
  "ORACLE_INVENTORY_INVALID",
  "ORACLE_OUTPUT_EXISTS",
  "ORACLE_OUTPUT_UNSAFE",
  "ORACLE_SOURCE_IDENTITY_INVALID",
  "ORACLE_FAILED",
]);
const INVENTORY_SCHEMA = "analytics-cutover-inventory-v2";
const INVENTORY_MAX_BYTES = 1024 * 1024;
const FLAGS = Object.freeze({
  "--ingestion": "ingestion",
  "--analytics": "analytics",
  "--ledger": "ledger",
  "--pinned-now-ms": "pinnedNowMs",
  "--inventory": "inventory",
  "--out": "out",
});
const KNOWN_CODES = new Set([
  ...D1_ANALYTICS_EXPORT_ORACLE_CLI_ERRORS,
  ...D1_ANALYTICS_EXPORT_ORACLE_ERRORS,
  ...SEALED_SQLITE_D1_ADAPTER_ERRORS,
  "ANALYTICS_HISTORY_ORACLE_INVALID",
]);
const KNOWN_REASONS = new Set(ANALYTICS_EXPORT_NOT_QUIESCENT_REASONS);

function cliError(code) {
  return Object.assign(new Error(code), { code });
}

export function parseD1AnalyticsExportOracleArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== Object.keys(FLAGS).length * 2) throw cliError("ORACLE_ARGUMENT_INVALID");
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = FLAGS[argv[index]];
    const value = argv[index + 1];
    if (key === undefined || Object.hasOwn(parsed, key) || typeof value !== "string" || value.length === 0
        || value.startsWith("--") || value.includes("\0")) throw cliError("ORACLE_ARGUMENT_INVALID");
    parsed[key] = value;
  }
  if (!/^[1-9][0-9]{0,15}$/u.test(parsed.pinnedNowMs) || !Number.isSafeInteger(Number(parsed.pinnedNowMs))) {
    throw cliError("ORACLE_ARGUMENT_INVALID");
  }
  for (const key of ["ingestion", "analytics", "ledger", "inventory", "out"]) {
    if (!isAbsolute(parsed[key])) throw cliError("ORACLE_ARGUMENT_INVALID");
  }
  const databases = new Set([parsed.ingestion, parsed.analytics, parsed.ledger]);
  if (databases.size !== 3 || databases.has(parsed.out) || databases.has(parsed.inventory)
      || parsed.out === parsed.inventory) throw cliError("ORACLE_ARGUMENT_INVALID");
  return Object.freeze({ ...parsed, pinnedNowMs: Number(parsed.pinnedNowMs) });
}

/** A scratch copy: a private, writable, single-link regular file of this user. */
async function assertScratchInput(path) {
  const info = await lstat(path).catch(() => null);
  if (info === null || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1
      || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid()
      || await realpath(path).catch(() => null) !== path) throw cliError("ORACLE_INPUT_NOT_SCRATCH");
}

export async function readD1AnalyticsExportInventory(path, pinnedNowMs) {
  const info = await lstat(path).catch(() => null);
  if (info === null || !info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > INVENTORY_MAX_BYTES) {
    throw cliError("ORACLE_INVENTORY_INVALID");
  }
  let inventory;
  try {
    inventory = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw cliError("ORACLE_INVENTORY_INVALID");
  }
  // HX-3 validates the whole inventory (HX-6) before it spawns this CLI. The
  // oracle reads only the fields it computes with and refuses them if absent.
  const fromDay = inventory?.cacheRetention?.fromDay;
  if (inventory === null || typeof inventory !== "object" || Array.isArray(inventory)
      || inventory.schema !== INVENTORY_SCHEMA || inventory.drain?.quiescentAtMs !== pinnedNowMs
      || !(fromDay === null || validAnalyticsHistoryDay(fromDay))) throw cliError("ORACLE_INVENTORY_INVALID");
  let foldHistory;
  try {
    foldHistory = validateAnalyticsHistoryFoldHistory(inventory.foldHistory);
  } catch {
    throw cliError("ORACLE_INVENTORY_INVALID");
  }
  return Object.freeze({ cacheRetentionFromDay: fromDay, foldHistory });
}

async function readSourceIdentity(analytics) {
  const rows = (await analytics.prepare(
    "SELECT source_id,source_namespace,contract_version FROM analytics_runtime_sources").all()).results;
  if (rows.length !== 1 || typeof rows[0].source_id !== "string" || typeof rows[0].source_namespace !== "string"
      || rows[0].contract_version !== 1) throw cliError("ORACLE_SOURCE_IDENTITY_INVALID");
  return { sourceId: rows[0].source_id, sourceNamespace: rows[0].source_namespace };
}

/** sha256 of the running module file: under the bundle, every src input. */
export async function computeD1AnalyticsExportOracleModuleDigest(moduleUrl = import.meta.url) {
  return createHash("sha256").update(await readFile(fileURLToPath(moduleUrl))).digest("hex");
}

async function writeNewFileAtomically(path, bytes) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(12).toString("hex")}.partial`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.datasync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600);
    // link() never replaces an existing file, so the output cannot clobber one
    // that appeared after the pre-check.
    await link(temporary, path);
  } catch (error) {
    throw error?.code === "EEXIST" ? cliError("ORACLE_OUTPUT_EXISTS") : cliError("ORACLE_OUTPUT_UNSAFE");
  } finally {
    await rm(temporary, { force: true });
  }
}

async function assertOutputAvailable(out) {
  const parent = await lstat(dirname(out)).catch(() => null);
  if (parent === null || !parent.isDirectory() || parent.isSymbolicLink()
      || await realpath(dirname(out)).catch(() => null) !== dirname(out)) throw cliError("ORACLE_OUTPUT_UNSAFE");
  for (const path of [out, `${out}.sha256`]) {
    if (await lstat(path).catch(() => null) !== null) throw cliError("ORACLE_OUTPUT_EXISTS");
  }
}

function closedFailure(error) {
  const code = typeof error?.code === "string" && KNOWN_CODES.has(error.code) ? error.code : "ORACLE_FAILED";
  const reasons = Array.isArray(error?.reasons) ? error.reasons.filter((reason) => KNOWN_REASONS.has(reason)) : [];
  return { code, reasons };
}

function countsOnly(counts) {
  const safe = {};
  for (const [key, value] of Object.entries(counts ?? {})) {
    if (/^[a-zA-Z][a-zA-Z0-9]{0,31}$/u.test(key) && Number.isSafeInteger(value) && value >= 0) safe[key] = value;
  }
  return safe;
}

const defaultLog = (entry) => console.log(JSON.stringify(entry));

/**
 * The whole CLI. Returns the process exit code: 0 on a written oracle,
 * 1 on any refusal or failure (which leaves no output behind).
 */
export async function runD1AnalyticsExportOracleCli({ argv, log = defaultLog, runOracle = runD1AnalyticsExportOracle,
  moduleUrl = import.meta.url, openDatabase = openSealedSqliteD1 } = {}) {
  const handles = [];
  /** Only files this run created are ever removed. */
  const created = [];
  try {
    const args = parseD1AnalyticsExportOracleArguments(argv);
    for (const path of [args.ingestion, args.analytics, args.ledger]) await assertScratchInput(path);
    const inventory = await readD1AnalyticsExportInventory(args.inventory, args.pinnedNowMs);
    await assertOutputAvailable(args.out);
    const moduleDigest = await computeD1AnalyticsExportOracleModuleDigest(moduleUrl);
    for (const path of [args.ingestion, args.analytics, args.ledger]) handles.push(openDatabase(path));
    const [ingestion, analytics, ledger] = handles.map((handle) => handle.database);
    const identity = await readSourceIdentity(analytics);
    log({ event: D1_ANALYTICS_EXPORT_ORACLE_EVENT, status: "started" });
    const oracle = validateAnalyticsHistoryOracle(await runOracle({ ingestion, analytics, ledger,
      pinnedNowMs: args.pinnedNowMs, sourceId: identity.sourceId, sourceNamespace: identity.sourceNamespace,
      cacheRetentionFromDay: inventory.cacheRetentionFromDay, foldHistory: inventory.foldHistory, moduleDigest,
      onStep: (step, counts) => log({ event: D1_ANALYTICS_EXPORT_ORACLE_EVENT, step, ...countsOnly(counts) }) }));
    const bytes = Buffer.from(`${canonicalJson(oracle)}\n`, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeNewFileAtomically(args.out, bytes);
    created.push(args.out);
    await writeNewFileAtomically(`${args.out}.sha256`, Buffer.from(`${sha256}\n`, "utf8"));
    created.length = 0;
    log({ event: D1_ANALYTICS_EXPORT_ORACLE_EVENT, status: "ok", dailyHeads: oracle.dailyForced.length,
      dailyD1Drift: oracle.dailyForced.filter((entry) => entry.d1Drift).length,
      importedDaily: oracle.importSelection.daily.length, importedModelDays: oracle.importSelection.modelDays.length,
      recomputedModelDays: oracle.graphForced.modelDays.filter((entry) => entry.recomputedSha256 !== null).length,
      cohortMembers: oracle.liveCohort.members });
    return 0;
  } catch (error) {
    // A failure between the two writes removes the first: nothing partial remains.
    for (const path of created) await rm(path, { force: true }).catch(() => {});
    const failure = closedFailure(error);
    log({ event: D1_ANALYTICS_EXPORT_ORACLE_EVENT,
      status: failure.code === "ANALYTICS_EXPORT_NOT_QUIESCENT" ? "refused" : "failed",
      code: failure.code, ...(failure.reasons.length ? { reasons: failure.reasons } : {}) });
    return 1;
  } finally {
    for (const handle of handles) {
      try { handle.close(); } catch { /* Closing never masks the outcome. */ }
    }
  }
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runD1AnalyticsExportOracleCli({ argv: process.argv.slice(2) });
}
