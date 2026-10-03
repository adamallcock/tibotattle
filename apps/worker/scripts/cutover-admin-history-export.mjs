#!/usr/bin/env node
// N-ADMINHIST source coverage (D-PT4X): one read-only, content-free export of
// the analytics D1's admin metric snapshots for the sealed storage source,
// taken inside the EP-8 fence after the PT-2-lite seal.
//
// Why it exists. In typed storage mode, which production has run since the
// 2026-09-12 D1 migration (the live Worker binds ANALYTICS_DB, and the
// analytics D1 ledger carries 0016_admin_metrics_history.sql), d43c8f92
// captures the hourly gauge snapshots only into the analytics D1's
// analytics_admin_metric_snapshots (storage-analytics-runtime.ts calls
// captureStorageAdminMetricSnapshot), and its admin history reads its gauges
// only from that table. The ingestion admin_metric_snapshots that the seal
// carries stopped at the switch, and PT-2-lite never seals the analytics D1.
// Without this export the mapped history would miss everything since the
// switch; round 5 decided the admin charts continue without a gap.
//
// export   Read the seal manifest (pinned by --seal-id) and its inventory, the
//          EP-8 fence receipt that the seal pinned (with the fence's own
//          reader; its 'analytics' entry gives the fenced id digest and
//          bookmark), and the owner's 0600 analytics source file, which must
//          name exactly that fenced D1. Then, through the read-only transport:
//          bookmark B0 (must equal the fence pin); the
//          0016_admin_metrics_history.sql ledger row (must equal the Git blob
//          at the inventory's expectedSourceCommit); every snapshot row of the
//          sealed storage_source_state.source_id in captured_at order, 1,000
//          rows a page; the row count for that source (must equal the pages)
//          and for every other source id; bookmark B1 (must equal B0). It
//          writes admin-history-export.json (0400, never overwritten) into the
//          owner directory and prints its sha256 and counts. Without
//          --execute --remote --owner-read-only it is a dry run that reads
//          local files only and spawns nothing.
//
// The analytics cache row (analytics_admin_metrics_history_cache) is not read:
// at d43c8f92 it is built only from this table of the same D1, and nothing
// deletes from this table, so the cache holds no snapshot the table lacks.
//
// The export is deterministic: two runs inside one fence write the same bytes.
// It holds canonical capture instants and flat gauge objects of non-negative
// integers (the d43c8f92 grammar; anything else refuses), digests, the opaque
// bookmark the fence receipt already pins, and counts. No database id, source
// id, account id or other row is written, printed or placed in an error.
// runOperationalHistoryProduction (postgres-legacy-contribution-transfer.mjs)
// reads it back with readCutoverAdminHistoryExport and maps it.

import { execFileSync } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readCloudflareWriterFenceReceipt } from "./cloudflare-writer-fence.mjs";
import {
  CutoverSourceError,
  REPOSITORY_ROOT,
  assertOwnerDirectory,
  canonicalJson,
  containsSignedUrl,
  createWranglerCutoverTransport,
  cutoverFail,
  guardCutoverTransport,
  idDigest,
  openSealedSourceFromSeal,
  readCutoverInventory,
  readCutoverSeal,
  readPrivateFile,
  sha256Hex,
  writePrivateFileOnce,
} from "./cutover-source-seal.mjs";

export const CUTOVER_ADMIN_HISTORY_EXPORT_SCHEMA = "tibotattle-cutover-admin-history-v1";
export const CUTOVER_ANALYTICS_SOURCE_SCHEMA = "tibotattle-cutover-analytics-source-v1";
export const CUTOVER_ADMIN_HISTORY_EXPORT_FILE = "admin-history-export.json";
export const ADMIN_HISTORY_ANALYTICS_BINDING = "ANALYTICS_DB";
/** The EP-8 fence receipt label whose id digest and bookmark the analytics D1 must match. */
export const ADMIN_HISTORY_FENCE_LABEL = "analytics";
export const ADMIN_HISTORY_MIGRATION = Object.freeze({
  directory: "analytics-migrations",
  name: "0016_admin_metrics_history.sql",
});
export const ADMIN_HISTORY_PAGE_ROWS = 1_000;
/** A resource bound, not a window: more than eleven years of hourly captures. */
export const ADMIN_HISTORY_MAX_SNAPSHOTS = 100_000;
export const ADMIN_HISTORY_MAX_EXPORT_BYTES = 256 * 1024 * 1024;
// The d43c8f92 gauge grammar (admin-metrics-history.ts): a flat object of at
// most 128 structural names, each a non-negative safe integer, in at most
// 4,000 characters of JSON (the D1 and PostgreSQL CHECK).
export const ADMIN_GAUGE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
export const ADMIN_MAX_GAUGES = 128;
export const ADMIN_MAX_SNAPSHOT_JSON = 4_000;

export const CUTOVER_ADMIN_HISTORY_ERROR_CODES = Object.freeze([
  "CUTOVER_ADMIN_HISTORY_EXPORT_INVALID",
  "CUTOVER_ADMIN_HISTORY_SOURCE_ID_INVALID",
  "CUTOVER_ADMIN_HISTORY_TOO_LARGE",
  "CUTOVER_ADMIN_HISTORY_VALUE_INVALID",
  "CUTOVER_ANALYTICS_SOURCE_INVALID",
]);
const HISTORY_CODES = new Set(CUTOVER_ADMIN_HISTORY_ERROR_CODES);

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DATABASE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const OPAQUE = /^[A-Za-z0-9-]{8,128}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const MAX_ANALYTICS_SOURCE_BYTES = 4 * 1024;
const SNAPSHOTS_TABLE = "analytics_admin_metric_snapshots";

/** The export's own refusals; every other code is the seal family's CutoverSourceError. */
export class CutoverAdminHistoryError extends Error {
  constructor(code) {
    const known = HISTORY_CODES.has(code) ? code : "CUTOVER_ADMIN_HISTORY_EXPORT_INVALID";
    super(known);
    this.name = "CutoverAdminHistoryError";
    this.code = known;
  }
}

function historyFail(code) {
  throw new CutoverAdminHistoryError(code);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return record(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

// ---------------------------------------------------------------------------
// The snapshot grammar, shared with the PostgreSQL mapping.

/** A canonical millisecond ISO instant (sealed text order is time order). */
export function isCanonicalAdminInstant(value) {
  if (typeof value !== "string") return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

/** A flat object of at most 128 structural names, each a non-negative safe integer. */
export function validAdminGaugeMetrics(metrics) {
  if (!record(metrics)) return false;
  const entries = Object.entries(metrics);
  return entries.length <= ADMIN_MAX_GAUGES
    && entries.every(([key, value]) => ADMIN_GAUGE_KEY.test(key) && Number.isSafeInteger(value) && value >= 0);
}

/** metrics_json text as stored: at most 4,000 characters of a valid gauge object. */
export function validAdminGaugeMetricsJson(text) {
  if (typeof text !== "string" || text.length > ADMIN_MAX_SNAPSHOT_JSON) return false;
  try {
    return validAdminGaugeMetrics(JSON.parse(text));
  } catch {
    return false;
  }
}

/**
 * The sealed storage_source_state singleton: { state: 'absent' } without the
 * table, { state: 'invalid' } unless it holds exactly singleton 1 with a
 * structural source id, else { state: 'valid', sourceId }.
 */
export function readSealedStorageSourceId(database) {
  let rows;
  try {
    const present = database.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get("storage_source_state");
    if (Number(present?.n) !== 1) return Object.freeze({ state: "absent", sourceId: null });
    const statement = database.prepare("SELECT singleton, source_id FROM storage_source_state");
    statement.setReadBigInts(true);
    rows = statement.all();
  } catch {
    return Object.freeze({ state: "invalid", sourceId: null });
  }
  if (rows.length !== 1 || rows[0].singleton !== 1n || typeof rows[0].source_id !== "string"
      || !SOURCE_ID.test(rows[0].source_id)) {
    return Object.freeze({ state: "invalid", sourceId: null });
  }
  return Object.freeze({ state: "valid", sourceId: rows[0].source_id });
}

function snapshotsDigest(snapshots) {
  return sha256Hex(canonicalJson(snapshots));
}

// ---------------------------------------------------------------------------
// Inputs.

/**
 * The owner's 0600 analytics source file: exactly the live ANALYTICS_DB
 * binding's database name and id. Its id digest must equal the EP-8 fence
 * receipt's 'analytics' entry.
 */
export async function readCutoverAnalyticsSource(path) {
  const bytes = await readPrivateFile(path, MAX_ANALYTICS_SOURCE_BYTES, "CUTOVER_INVENTORY_UNSAFE");
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    historyFail("CUTOVER_ANALYTICS_SOURCE_INVALID");
  }
  if (!exactKeys(value, ["schema", "binding", "databaseName", "databaseId"])
      || value.schema !== CUTOVER_ANALYTICS_SOURCE_SCHEMA || value.binding !== ADMIN_HISTORY_ANALYTICS_BINDING
      || typeof value.databaseName !== "string" || !DATABASE_NAME.test(value.databaseName)
      || typeof value.databaseId !== "string" || !UUID.test(value.databaseId)) {
    historyFail("CUTOVER_ANALYTICS_SOURCE_INVALID");
  }
  return Object.freeze({
    role: ADMIN_HISTORY_FENCE_LABEL,
    binding: value.binding,
    databaseName: value.databaseName,
    databaseId: value.databaseId,
    databaseIdSha256: idDigest("d1", value.databaseId),
  });
}

function defaultGit(args, { repositoryRoot }) {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024,
  });
}

/** sha256 of the exact 0016 migration bytes at the commit (the d1_storage_migrations rule). */
export function expectedAdminHistoryMigrationSha256({ commit, repositoryRoot = REPOSITORY_ROOT, git = defaultGit } = {}) {
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/u.test(commit)) cutoverFail("CUTOVER_EXPECTED_LEDGER_INVALID");
  let bytes;
  try {
    bytes = git(["cat-file", "blob", `${commit}:apps/worker/${ADMIN_HISTORY_MIGRATION.directory}/${ADMIN_HISTORY_MIGRATION.name}`],
      { repositoryRoot });
  } catch {
    cutoverFail("CUTOVER_EXPECTED_LEDGER_INVALID");
  }
  return sha256Hex(bytes);
}

async function sealedSourceIdOf(seal) {
  // Opening hashes the sealed file; verify() re-hashes it after the read.
  const sealed = await openSealedSourceFromSeal(seal, "ingestion");
  try {
    const read = readSealedStorageSourceId(sealed.database());
    await sealed.verify();
    if (read.state !== "valid") historyFail("CUTOVER_ADMIN_HISTORY_SOURCE_ID_INVALID");
    return read.sourceId;
  } finally {
    sealed.close();
  }
}

/**
 * The EP-8 fence receipt's 'analytics' entry (its id digest and bookmark),
 * read with the fence's own reader at the sha256 the seal pinned. Also the
 * REV-SEED revision-floor capture's binding (cutover-revision-floor.mjs).
 */
export async function fencedAnalyticsEntry(fenceReceiptPath, fenceReceiptSha256) {
  let receipt;
  try {
    receipt = await readCloudflareWriterFenceReceipt(resolve(String(fenceReceiptPath)), fenceReceiptSha256);
  } catch {
    cutoverFail("CUTOVER_FENCE_RECEIPT_INVALID");
  }
  if (receipt?.productionWorker?.mode !== "fenced" || !Array.isArray(receipt.d1)) cutoverFail("CUTOVER_FENCE_RECEIPT_INVALID");
  const entries = receipt.d1.filter(item => item?.label === ADMIN_HISTORY_FENCE_LABEL);
  if (entries.length !== 1 || !SHA256.test(entries[0].idSha256 ?? "") || !OPAQUE.test(entries[0].bookmark ?? "")) {
    cutoverFail("CUTOVER_FENCE_RECEIPT_INVALID");
  }
  return Object.freeze({ idSha256: entries[0].idSha256, bookmark: entries[0].bookmark });
}

// ---------------------------------------------------------------------------
// Remote reads.

function count(rows) {
  if (!Array.isArray(rows) || rows.length !== 1 || !exactKeys(rows[0], ["n"])) cutoverFail("CUTOVER_REMOTE_RESPONSE_INVALID");
  const value = rows[0].n;
  if (!Number.isSafeInteger(value) || value < 0) cutoverFail("CUTOVER_REMOTE_RESPONSE_INVALID");
  return value;
}

function snapshotEntry(row, after) {
  if (!exactKeys(row, ["captured_at", "metrics_json"])) cutoverFail("CUTOVER_REMOTE_RESPONSE_INVALID");
  const { captured_at: capturedAt, metrics_json: metricsJson } = row;
  if (!isCanonicalAdminInstant(capturedAt) || (after !== null && capturedAt <= after)
      || !validAdminGaugeMetricsJson(metricsJson)) {
    historyFail("CUTOVER_ADMIN_HISTORY_VALUE_INVALID");
  }
  return Object.freeze([capturedAt, metricsJson]);
}

/** The source id as a hex blob cast to text: no quoting, whatever its characters. */
function sourceIdExpression(sourceId) {
  return `CAST(X'${Buffer.from(sourceId, "utf8").toString("hex")}' AS TEXT)`;
}

async function readRemoteSnapshots(guarded, source, sourceId) {
  const mine = sourceIdExpression(sourceId);
  const snapshots = [];
  let after = null;
  for (;;) {
    const cursor = after === null ? "" : ` AND captured_at>'${after}'`;
    const rows = await guarded.query(source, `SELECT captured_at,metrics_json FROM ${SNAPSHOTS_TABLE} WHERE source_id=${mine}${cursor} ORDER BY captured_at LIMIT ${ADMIN_HISTORY_PAGE_ROWS}`);
    if (rows.length > ADMIN_HISTORY_PAGE_ROWS) cutoverFail("CUTOVER_REMOTE_RESPONSE_INVALID");
    for (const row of rows) {
      const entry = snapshotEntry(row, after);
      snapshots.push(entry);
      after = entry[0];
      if (snapshots.length > ADMIN_HISTORY_MAX_SNAPSHOTS) historyFail("CUTOVER_ADMIN_HISTORY_TOO_LARGE");
    }
    if (rows.length < ADMIN_HISTORY_PAGE_ROWS) break;
  }
  const total = count(await guarded.query(source, `SELECT count(*) AS n FROM ${SNAPSHOTS_TABLE} WHERE source_id=${mine}`));
  if (total !== snapshots.length) cutoverFail("CUTOVER_AGGREGATE_MISMATCH");
  const otherSourceRows = count(await guarded.query(source, `SELECT count(*) AS n FROM ${SNAPSHOTS_TABLE} WHERE source_id<>${mine}`));
  return { snapshots, otherSourceRows };
}

// ---------------------------------------------------------------------------
// Export.

/**
 * Export the sealed source's analytics admin metric snapshots (see the file
 * header). An injected `transport` replaces the default Wrangler transport
 * (tests); the default one writes its pinned config into the owner directory
 * and removes it on success and on failure.
 */
export async function exportCutoverAdminHistory({
  inventoryPath,
  manifestPath,
  sealId,
  analyticsSourcePath,
  fenceReceiptPath,
  ownerDirectory,
  execute = false,
  remote = false,
  ownerReadOnly = false,
  transport = undefined,
  spawn = undefined,
  cliPath = undefined,
  environment = undefined,
  repositoryRoot = REPOSITORY_ROOT,
  git = defaultGit,
  forbiddenRoots = undefined,
} = {}) {
  const inventory = await readCutoverInventory(inventoryPath);
  const directory = await assertOwnerDirectory(ownerDirectory, forbiddenRoots === undefined ? {} : { forbiddenRoots });
  const seal = await readCutoverSeal({ manifestPath, expectedSealId: sealId });
  if (seal.manifest.inventorySha256 !== inventory.inventorySha256) cutoverFail("CUTOVER_SEAL_MANIFEST_INVALID");
  const fenceReceiptSha256 = seal.manifest.fence?.fenceReceiptSha256;
  if (typeof fenceReceiptSha256 !== "string" || !SHA256.test(fenceReceiptSha256)) cutoverFail("CUTOVER_SEAL_MANIFEST_INVALID");
  const source = await readCutoverAnalyticsSource(analyticsSourcePath);
  if (Object.values(inventory.sources).some(sealed => sealed.databaseIdSha256 === source.databaseIdSha256)) {
    cutoverFail("CUTOVER_SOURCE_NOT_ALLOWED");
  }
  const fenced = await fencedAnalyticsEntry(fenceReceiptPath, fenceReceiptSha256);
  if (fenced.idSha256 !== source.databaseIdSha256) cutoverFail("CUTOVER_FENCE_SOURCE_MISMATCH");
  const sourceId = await sealedSourceIdOf(seal);
  const migrationSha256 = expectedAdminHistoryMigrationSha256({ commit: inventory.expectedSourceCommit, repositoryRoot, git });
  if (execute !== true) {
    return Object.freeze({ mode: "dry-run", sealId, fenceReceiptSha256, analyticsDatabaseIdSha256: source.databaseIdSha256,
      migrationSha256 });
  }
  if (remote !== true || ownerReadOnly !== true) cutoverFail("CUTOVER_REMOTE_NOT_AUTHORIZED");
  const path = join(directory, CUTOVER_ADMIN_HISTORY_EXPORT_FILE);
  try {
    await lstat(path);
    cutoverFail("CUTOVER_OUTPUT_EXISTS");
  } catch (error) {
    if (error instanceof CutoverSourceError) throw error;
    if (error?.code !== "ENOENT") cutoverFail("CUTOVER_OWNER_DIRECTORY_UNSAFE");
  }
  // The transport sees only this one D1; any other id or role is refused.
  const scope = Object.freeze({ accountId: inventory.accountId, sources: Object.freeze({ [source.role]: source }) });
  const previousUmask = process.umask(0o077);
  let ownedTransport = null;
  try {
    ownedTransport = transport === undefined ? createWranglerCutoverTransport({
      inventory: scope, transportDirectory: directory, spawn, cliPath, environment, remote, ownerReadOnly,
    }) : null;
    const guarded = guardCutoverTransport(transport ?? ownedTransport, scope);
    const b0 = await guarded.bookmark(source);
    if (b0 !== fenced.bookmark) cutoverFail("CUTOVER_SOURCE_BOOKMARK_DRIFT");
    const ledger = await guarded.query(source, `SELECT name,sha256 FROM d1_storage_migrations WHERE name='${ADMIN_HISTORY_MIGRATION.name}'`);
    if (ledger.length !== 1 || !exactKeys(ledger[0], ["name", "sha256"]) || ledger[0].name !== ADMIN_HISTORY_MIGRATION.name
        || ledger[0].sha256 !== migrationSha256) {
      cutoverFail("CUTOVER_LEDGER_MISMATCH");
    }
    const { snapshots, otherSourceRows } = await readRemoteSnapshots(guarded, source, sourceId);
    const b1 = await guarded.bookmark(source);
    if (b1 !== b0) cutoverFail("CUTOVER_SOURCE_BOOKMARK_DRIFT");
    await ownedTransport?.dispose();
    const body = {
      schema: CUTOVER_ADMIN_HISTORY_EXPORT_SCHEMA,
      sealId,
      inventorySha256: inventory.inventorySha256,
      fenceReceiptSha256,
      analytics: { databaseIdSha256: source.databaseIdSha256, bookmark: b0, migration: ADMIN_HISTORY_MIGRATION.name,
        migrationSha256 },
      sourceIdSha256: sha256Hex(sourceId),
      snapshots,
      snapshotsSha256: snapshotsDigest(snapshots),
      otherSourceRows,
    };
    const text = `${canonicalJson(body)}\n`;
    if (Buffer.byteLength(text) > ADMIN_HISTORY_MAX_EXPORT_BYTES) historyFail("CUTOVER_ADMIN_HISTORY_TOO_LARGE");
    if (containsSignedUrl(text)) cutoverFail("CUTOVER_SECRET_IN_OUTPUT");
    const exportSha256 = await writePrivateFileOnce(path, text, 0o400);
    return Object.freeze({
      mode: "exported",
      path,
      exportSha256,
      snapshots: snapshots.length,
      firstCapturedAt: snapshots[0]?.[0] ?? null,
      lastCapturedAt: snapshots.at(-1)?.[0] ?? null,
      otherSourceRows,
    });
  } catch (error) {
    await ownedTransport?.dispose().catch(() => {});
    throw error;
  } finally {
    process.umask(previousUmask);
  }
}

// ---------------------------------------------------------------------------
// Reading an export back (the PostgreSQL mapping).

/**
 * Read an export pinned by its sha256: a private canonical file whose every
 * field and snapshot is re-validated. It does not prove the binding; the
 * caller compares sealId, inventorySha256, fenceReceiptSha256 and
 * sourceIdSha256 with its own seal. Any defect is
 * CUTOVER_ADMIN_HISTORY_EXPORT_INVALID.
 */
export async function readCutoverAdminHistoryExport({ path, expectedSha256 } = {}) {
  if (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256)) historyFail("CUTOVER_ADMIN_HISTORY_EXPORT_INVALID");
  let bytes;
  try {
    bytes = await readPrivateFile(path, ADMIN_HISTORY_MAX_EXPORT_BYTES, "CUTOVER_ARGUMENT_INVALID");
  } catch {
    historyFail("CUTOVER_ADMIN_HISTORY_EXPORT_INVALID");
  }
  if (sha256Hex(bytes) !== expectedSha256) historyFail("CUTOVER_ADMIN_HISTORY_EXPORT_INVALID");
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    historyFail("CUTOVER_ADMIN_HISTORY_EXPORT_INVALID");
  }
  const invalid = () => historyFail("CUTOVER_ADMIN_HISTORY_EXPORT_INVALID");
  if (!exactKeys(value, ["schema", "sealId", "inventorySha256", "fenceReceiptSha256", "analytics", "sourceIdSha256",
    "snapshots", "snapshotsSha256", "otherSourceRows"])
      || value.schema !== CUTOVER_ADMIN_HISTORY_EXPORT_SCHEMA
      || ![value.sealId, value.inventorySha256, value.fenceReceiptSha256, value.sourceIdSha256, value.snapshotsSha256]
        .every(item => typeof item === "string" && SHA256.test(item))
      || !exactKeys(value.analytics, ["databaseIdSha256", "bookmark", "migration", "migrationSha256"])
      || !SHA256.test(value.analytics.databaseIdSha256 ?? "") || !OPAQUE.test(value.analytics.bookmark ?? "")
      || value.analytics.migration !== ADMIN_HISTORY_MIGRATION.name || !SHA256.test(value.analytics.migrationSha256 ?? "")
      || !Number.isSafeInteger(value.otherSourceRows) || value.otherSourceRows < 0
      || !Array.isArray(value.snapshots) || value.snapshots.length > ADMIN_HISTORY_MAX_SNAPSHOTS
      || `${canonicalJson(value)}\n` !== bytes.toString("utf8")) {
    invalid();
  }
  let after = null;
  for (const entry of value.snapshots) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isCanonicalAdminInstant(entry[0])
        || (after !== null && entry[0] <= after) || !validAdminGaugeMetricsJson(entry[1])) {
      invalid();
    }
    after = entry[0];
  }
  if (snapshotsDigest(value.snapshots) !== value.snapshotsSha256) invalid();
  return Object.freeze({
    ...value,
    analytics: Object.freeze({ ...value.analytics }),
    snapshots: Object.freeze(value.snapshots.map(entry => Object.freeze([...entry]))),
    exportSha256: expectedSha256,
  });
}

// ---------------------------------------------------------------------------
// CLI.

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (command !== "export") cutoverFail("CUTOVER_ARGUMENT_INVALID");
  const values = { "--inventory": "inventoryPath", "--seal": "manifestPath", "--seal-id": "sealId",
    "--analytics-source": "analyticsSourcePath", "--fence-receipt": "fenceReceiptPath", "--out": "ownerDirectory" };
  const switches = { "--remote": "remote", "--owner-read-only": "ownerReadOnly", "--execute": "execute" };
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (Object.hasOwn(switches, flag)) {
      if (options[switches[flag]] !== undefined) cutoverFail("CUTOVER_ARGUMENT_INVALID");
      options[switches[flag]] = true;
      continue;
    }
    const key = values[flag];
    const value = rest[index + 1];
    if (key === undefined || options[key] !== undefined || typeof value !== "string" || value.startsWith("--")) {
      cutoverFail("CUTOVER_ARGUMENT_INVALID");
    }
    options[key] = value;
    index += 1;
  }
  for (const key of Object.values(values)) {
    if (options[key] === undefined) cutoverFail("CUTOVER_ARGUMENT_INVALID");
  }
  return options;
}

async function main(argv) {
  const options = parseArguments(argv);
  const result = await exportCutoverAdminHistory({
    inventoryPath: resolve(options.inventoryPath),
    manifestPath: resolve(options.manifestPath),
    sealId: options.sealId,
    analyticsSourcePath: resolve(options.analyticsSourcePath),
    fenceReceiptPath: resolve(options.fenceReceiptPath),
    ownerDirectory: resolve(options.ownerDirectory),
    execute: options.execute === true,
    remote: options.remote === true,
    ownerReadOnly: options.ownerReadOnly === true,
  });
  const { path: _path, ...printable } = result;
  process.stdout.write(`${JSON.stringify({ command: "export", ...printable })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof CutoverSourceError || error instanceof CutoverAdminHistoryError
      ? error.message : "CUTOVER_FAILED"}\n`);
    process.exitCode = 1;
  });
}
