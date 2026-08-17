import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createClaudeTranscriptExportCursor,
  createClaudeTranscriptExportSourcePlan,
  scanClaudeTranscriptExportSource,
  sliceClaudeTranscriptExportSourcePlans,
  verifyClaudeTranscriptExportSource,
} from "./claude-transcript-export-source.js";
import { createExportResourceGuard } from "./export-resource-policy.js";
import { inventoryClaudeDesktopSources } from "./claude-desktop-source-inventory.js";

export const CLAUDE_DESKTOP_DENSITY_CENSUS_VERSION =
  "claude-desktop-density-census-v0.1";

/*
 * This is deliberately a closed schema.  The census is a measurement aid,
 * not another transcript projection: it may return counts, byte totals and
 * fixed schema-component labels, but never source paths, keys, content, or
 * model declarations.
 */
export const CLAUDE_DESKTOP_REVIEWED_SQLITE_COMPONENTS = Object.freeze([
  "sqlite_schema",
  "ledger_meta",
  "source_state",
  "usage_candidate",
  "usage_candidate_logical",
  "usage_winner",
  "quota_revision",
  "coverage_gap",
  "ingest_checkpoint",
  "projection_manifest",
  "projection_row",
  "projection_state",
  "purge_tombstone",
]);

const REVIEWED_SQLITE_COMPONENT_SET = new Set(CLAUDE_DESKTOP_REVIEWED_SQLITE_COMPONENTS);
const SQLITE_SIDECARS = Object.freeze([
  { component: "wal", suffix: "-wal" },
  { component: "shm", suffix: "-shm" },
  { component: "journal", suffix: "-journal" },
]);
const PERCENTILES = Object.freeze([
  ["p50", 0.50],
  ["p90", 0.90],
  ["p95", 0.95],
  ["p99", 0.99],
]);
const MAXIMUM_SOURCE_ROWS = 250_000;
const MAXIMUM_SCAN_BATCH = 1_000;

export class ClaudeDesktopDensityCensusError extends Error {
  constructor(code) {
    super(`Claude Desktop density census failed (${code})`);
    this.name = "ClaudeDesktopDensityCensusError";
    this.code = `claude_desktop_density_census_${code}`;
  }
}

function fail(code) {
  throw new ClaudeDesktopDensityCensusError(code);
}

function safeCount(value, code = "count") {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function addSafeCounts(left, right, code = "count") {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) fail(code);
  return total;
}

function normalizeSecret(secret) {
  if (secret === undefined) return randomBytes(32);
  if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) fail("configuration");
  return Buffer.from(secret);
}

function validateDirectory(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("configuration");
  }
  return value;
}

function validateBounds(startAt, endAt) {
  if (typeof startAt !== "string" || typeof endAt !== "string") fail("configuration");
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    fail("configuration");
  }
}

function validateSourceRows(sourceRows) {
  if (!Array.isArray(sourceRows) || sourceRows.length > MAXIMUM_SOURCE_ROWS) {
    fail("source_rows");
  }
  return sourceRows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)
        || Object.keys(row).some((key) => !["sourceBytes", "candidateCount"].includes(key))) {
      fail("source_rows");
    }
    return {
      sourceBytes: safeCount(row.sourceBytes, "source_bytes"),
      candidateCount: safeCount(row.candidateCount, "candidate_count"),
    };
  });
}

function quantile(sorted, probability) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return {
      sampleCount: 0,
      min: null,
      p50: null,
      p90: null,
      p95: null,
      p99: null,
      max: null,
    };
  }
  const result = {
    sampleCount: sorted.length,
    min: sorted[0],
    p50: null,
    p90: null,
    p95: null,
    p99: null,
    max: sorted[sorted.length - 1],
  };
  for (const [label, probability] of PERCENTILES) {
    result[label] = quantile(sorted, probability);
  }
  return result;
}

function emptySqliteComposition(status = "not_requested") {
  return {
    status,
    snapshotBasis: "immutable_main_database",
    includesUncheckpointedWal: false,
    databaseFileBytes: null,
    pageSizeBytes: null,
    pageCount: null,
    freelistPages: null,
    dbstatBytes: null,
    reviewedComponentCount: 0,
    unreviewedComponentCount: null,
    unreviewedBytes: null,
    components: CLAUDE_DESKTOP_REVIEWED_SQLITE_COMPONENTS.map((component) => ({
      component,
      bytes: 0,
      pages: 0,
    })),
    sidecars: SQLITE_SIDECARS.map(({ component }) => ({
      component,
      bytes: 0,
      present: false,
    })),
  };
}

function safeReadOnlyDatabasePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("configuration");
  }
  const selected = resolve(value);
  let stats;
  try {
    stats = lstatSync(selected);
  } catch {
    fail("sqlite_missing");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || (uid !== null && stats.uid !== uid)
      || (process.platform !== "win32" && (stats.mode & 0o022) !== 0)) {
    fail("sqlite_unsafe");
  }
  return { path: selected, stats };
}

function readSidecarBytes(databasePath, suffix) {
  try {
    const stats = lstatSync(`${databasePath}${suffix}`);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
        || (uid !== null && stats.uid !== uid)
        || (process.platform !== "win32" && (stats.mode & 0o022) !== 0)) {
      return { bytes: 0, present: false };
    }
    return { bytes: stats.size, present: true };
  } catch {
    return { bytes: 0, present: false };
  }
}

/**
 * Read only fixed-schema SQLite composition.  `dbstat.name` is never copied
 * into the receipt: known names are mapped to the reviewed allowlist and all
 * other objects are folded into one aggregate bucket.
 */
export function readClaudeDesktopSqliteComposition(sqlitePath) {
  const selected = safeReadOnlyDatabasePath(sqlitePath);
  let database;
  try {
    // SQLite read-only connections may still create a missing -shm file for a
    // WAL database. URI immutable mode is the stronger no-write contract. It
    // intentionally measures the stable main database only; WAL/SHM sizes are
    // reported separately and uncheckpointed WAL pages are never claimed as
    // part of the dbstat breakdown.
    const immutableUrl = pathToFileURL(selected.path);
    immutableUrl.searchParams.set("immutable", "1");
    database = new DatabaseSync(immutableUrl, { readOnly: true });
    const pageSize = Number(database.prepare("PRAGMA page_size").get().page_size);
    const pageCount = Number(database.prepare("PRAGMA page_count").get().page_count);
    const freelistPages = Number(database.prepare("PRAGMA freelist_count").get().freelist_count);
    if (![pageSize, pageCount, freelistPages].every(Number.isSafeInteger)) fail("sqlite_metadata");
    const rows = database.prepare(
      "SELECT name, SUM(pgsize) AS bytes, COUNT(*) AS pages FROM dbstat GROUP BY name",
    ).all();
    const byComponent = new Map(CLAUDE_DESKTOP_REVIEWED_SQLITE_COMPONENTS.map((component) => [
      component,
      { component, bytes: 0, pages: 0 },
    ]));
    let unreviewedComponentCount = 0;
    let unreviewedBytes = 0;
    let dbstatBytes = 0;
    for (const row of rows) {
      const bytes = safeCount(Number(row.bytes), "sqlite_bytes");
      const pages = safeCount(Number(row.pages), "sqlite_pages");
      dbstatBytes = addSafeCounts(dbstatBytes, bytes, "sqlite_bytes");
      const component = typeof row.name === "string" && REVIEWED_SQLITE_COMPONENT_SET.has(row.name)
        ? row.name : null;
      if (component) {
        const target = byComponent.get(component);
        target.bytes = addSafeCounts(target.bytes, bytes, "sqlite_bytes");
        target.pages = addSafeCounts(target.pages, pages, "sqlite_pages");
      } else {
        unreviewedComponentCount += 1;
        unreviewedBytes = addSafeCounts(unreviewedBytes, bytes, "sqlite_bytes");
      }
    }
    return {
      ...emptySqliteComposition("available"),
      databaseFileBytes: selected.stats.size,
      pageSizeBytes: pageSize,
      pageCount,
      freelistPages,
      dbstatBytes,
      reviewedComponentCount: rows.filter((row) => (
        typeof row.name === "string" && REVIEWED_SQLITE_COMPONENT_SET.has(row.name)
      )).length,
      unreviewedComponentCount,
      unreviewedBytes,
      components: CLAUDE_DESKTOP_REVIEWED_SQLITE_COMPONENTS.map((component) => byComponent.get(component)),
      sidecars: SQLITE_SIDECARS.map(({ component, suffix }) => ({
        component,
        ...readSidecarBytes(selected.path, suffix),
      })),
    };
  } catch (error) {
    if (error instanceof ClaudeDesktopDensityCensusError) throw error;
    return emptySqliteComposition("unavailable");
  } finally {
    database?.close();
  }
}

function inventoryReceipt(inventory) {
  return {
    status: inventory.status === "complete" ? "complete" : "partial",
    cleanupRaced: inventory.cleanupRaced === true,
    cleanupMarkerAccessible: inventory.cleanupMarkerAccessible === true,
    enumerationComplete: inventory.enumerationComplete === true,
    metadataFileCount: safeCount(inventory.metadataFileCount),
    transcriptFileCount: safeCount(inventory.transcriptFileCount),
    topLevelTranscriptCount: safeCount(inventory.topLevelTranscriptCount),
    nestedTranscriptCount: safeCount(inventory.nestedTranscriptCount),
    selectedChildTranscriptCount: safeCount(inventory.selectedChildTranscriptCount),
    unselectedChildTranscriptCount: safeCount(inventory.unselectedChildTranscriptCount),
    orphanTranscriptCount: safeCount(inventory.orphanTranscriptCount),
    inaccessibleEntryCount: safeCount(inventory.inaccessibleEntryCount),
  };
}

/**
 * Reduce source-level measurements to a stable, aggregate-only receipt.
 * `sourceRows` is intentionally limited to two numeric fields so this helper
 * can also be used by synthetic benchmarks without passing transcript-shaped
 * objects through a durable or report-facing boundary.
 */
export function summarizeClaudeDesktopCandidateDensity({
  sourceRows = [],
  sqlitePath = null,
  status = "complete",
  inventory = null,
} = {}) {
  const rows = validateSourceRows(sourceRows);
  if (status !== "complete" && status !== "partial") fail("status");
  const totalSourceBytes = rows.reduce(
    (sum, row) => addSafeCounts(sum, row.sourceBytes, "source_bytes"),
    0,
  );
  const totalCandidateCount = rows.reduce(
    (sum, row) => addSafeCounts(sum, row.candidateCount, "candidate_count"),
    0,
  );
  const rowsWithCandidates = rows.filter((row) => row.candidateCount > 0);
  const bytesPerCandidateValues = rowsWithCandidates.map((row) => (
    row.sourceBytes / row.candidateCount
  ));
  const sqlite = sqlitePath === null
    ? emptySqliteComposition()
    : readClaudeDesktopSqliteComposition(sqlitePath);
  return {
    schemaVersion: CLAUDE_DESKTOP_DENSITY_CENSUS_VERSION,
    status,
    contentFree: true,
    readOnly: true,
    writesDurableArtifacts: false,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesModelStrings: false,
    inventory: inventory ? inventoryReceipt(inventory) : null,
    sourceCount: rows.length,
    sourcesWithCandidates: rowsWithCandidates.length,
    zeroCandidateSources: rows.length - rowsWithCandidates.length,
    totalSourceBytes,
    totalCandidateCount,
    candidateCounts: distribution(rows.map((row) => row.candidateCount)),
    bytesPerCandidate: {
      aggregate: totalCandidateCount > 0 ? totalSourceBytes / totalCandidateCount : null,
      perSource: distribution(bytesPerCandidateValues),
    },
    sqlite,
  };
}

/**
 * Read-only current-corpus mode.  Inventory and source planning are kept in
 * process memory; candidates are counted and immediately discarded.  No
 * canonicalizer, ledger, cache, checkpoint, or parsed-text artifact is
 * created by this function.
 */
export async function measureClaudeDesktopCandidateDensity({
  metadataDirectory,
  projectsDirectory,
  cleanupMarkerPath = null,
  startAt,
  endAt,
  secret,
  sqlitePath = null,
  resourceLimits = {},
} = {}) {
  validateDirectory(metadataDirectory);
  validateDirectory(projectsDirectory);
  if (cleanupMarkerPath !== null) validateDirectory(cleanupMarkerPath);
  validateBounds(startAt, endAt);
  if (sqlitePath !== null && typeof sqlitePath !== "string") fail("configuration");
  const key = normalizeSecret(secret);
  let inventory = null;
  let plan = null;
  try {
    const resourceGuard = createExportResourceGuard({
      scope: "export_set",
      limits: resourceLimits,
    });
    inventory = await inventoryClaudeDesktopSources({
      metadataDirectory,
      projectsDirectory,
      cleanupMarkerPath,
      secret: key,
      includePrivatePlan: true,
    });
    const selectedPaths = inventory.privatePlan?.sourcePaths;
    if (!Array.isArray(selectedPaths)) fail("inventory_plan");
    plan = await createClaudeTranscriptExportSourcePlan({
      projectsDirectory,
      selectedSourcePaths: selectedPaths,
      startAt,
      endAt,
      secret: key,
      resourceGuard,
    });
    // Validate the complete signed plan once, then use its reviewed one-source
    // slices. Passing the full 1,000+ source plan into every scan would repeat
    // whole-plan validation per source and turn a linear census quadratic.
    const sourcePlans = sliceClaudeTranscriptExportSourcePlans(plan, { secret: key });
    const sourceRows = [];
    for (const sourcePlan of sourcePlans) {
      const source = sourcePlan.sources[0];
      let cursor = createClaudeTranscriptExportCursor(
        sourcePlan,
        source.sourceKey,
        { secret: key },
      );
      let candidateCount = 0;
      for (;;) {
        const scanned = await scanClaudeTranscriptExportSource(sourcePlan, source.sourceKey, {
          secret: key,
          cursor,
          maximumCandidateRecords: MAXIMUM_SCAN_BATCH,
          resourceGuard,
          // Cursor and file boundaries are checked on every batch. Hashing
          // the entire prefix on every 1,000-candidate page is quadratic on a
          // dense long-running transcript, so do the full immutable-prefix
          // verification once after the terminal cursor instead.
          verifyWholePrefix: false,
        });
        candidateCount = addSafeCounts(
          candidateCount,
          scanned.candidates.length,
          "candidate_count",
        );
        // Do not retain candidate-shaped records between batches.
        scanned.candidates.length = 0;
        cursor = scanned.cursor;
        if (scanned.complete) break;
      }
      await verifyClaudeTranscriptExportSource(sourcePlan, source.sourceKey, {
        secret: key,
        cursor,
        resourceGuard,
      });
      sourceRows.push({ sourceBytes: source.prefixBytes, candidateCount });
    }
    return summarizeClaudeDesktopCandidateDensity({
      sourceRows,
      sqlitePath,
      status: inventory.status === "complete" ? "complete" : "partial",
      inventory,
    });
  } finally {
    inventory = null;
    plan = null;
    key.fill(0);
  }
}
