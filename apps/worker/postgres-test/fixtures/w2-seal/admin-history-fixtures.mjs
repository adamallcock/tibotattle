// D-PT4X admin history fixtures: a synthetic analytics D1 (the 0016 tables
// and their d1_storage_migrations row, both read from Git at the commit), the
// owner's 0600 analytics source file, and an export of it through the injected
// fake transport, bound to a W2-SEAL seal and its EP-8 fence fixture.
// Test-only; every id is synthetic and nothing contacts a provider.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  ADMIN_HISTORY_MIGRATION,
  CUTOVER_ANALYTICS_SOURCE_SCHEMA,
  exportCutoverAdminHistory,
} from "../../../scripts/cutover-admin-history-export.mjs";
import { SYNTHETIC_BOOKMARKS, SYNTHETIC_D1 } from "./fence-fixtures.mjs";
import { createFakeCutoverTransport, privateDirectory } from "./synthetic-sources.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const SYNTHETIC_ANALYTICS_DATABASE_NAME = "synthetic-analytics";
export const SYNTHETIC_OTHER_SOURCE_ID = "synthetic-other-analytics-source";

/** The exact 0016 migration bytes at the commit. */
export function adminHistoryMigrationBytes(commit) {
  return execFileSync("git", ["-C", WORKER_ROOT, "cat-file", "blob",
    `${commit}:apps/worker/${ADMIN_HISTORY_MIGRATION.directory}/${ADMIN_HISTORY_MIGRATION.name}`]);
}

/**
 * A synthetic analytics D1 file: the storage ledger with the 0016 row (its
 * Git sha256 unless `ledgerSha256` overrides it, or no row when it is null),
 * the 0016 tables, `snapshots` ([capturedAt, metricsJson]) under `sourceId`
 * and `otherSnapshots` under another source id. The FOREIGN KEY to
 * analytics_runtime_sources is declared but not enforced here.
 */
export function buildSyntheticAnalyticsD1({
  directory, commit, sourceId, snapshots = [], otherSnapshots = [], ledgerSha256 = undefined, name = "analytics.sqlite",
} = {}) {
  const migration = adminHistoryMigrationBytes(commit);
  const path = join(directory, name);
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  try {
    database.exec("CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT");
    database.exec(migration.toString("utf8"));
    if (ledgerSha256 !== null) {
      database.prepare("INSERT INTO d1_storage_migrations (name, sha256) VALUES (?, ?)").run(ADMIN_HISTORY_MIGRATION.name,
        ledgerSha256 ?? createHash("sha256").update(migration).digest("hex"));
    }
    const insert = database.prepare("INSERT INTO analytics_admin_metric_snapshots (source_id, captured_at, metrics_json) VALUES (?, ?, ?)");
    database.exec("BEGIN");
    for (const [capturedAt, metricsJson] of snapshots) insert.run(sourceId, capturedAt, metricsJson);
    for (const [capturedAt, metricsJson] of otherSnapshots) insert.run(SYNTHETIC_OTHER_SOURCE_ID, capturedAt, metricsJson);
    database.exec("COMMIT");
  } finally {
    database.close();
  }
  return path;
}

/** The owner's analytics source file (0600): the fenced analytics D1 unless overridden. */
export async function writeAnalyticsSourceFixture({
  directory, databaseId = SYNTHETIC_D1.analytics, databaseName = SYNTHETIC_ANALYTICS_DATABASE_NAME, mutate = null,
  name = "analytics-source.json", mode = 0o600,
} = {}) {
  const value = { schema: CUTOVER_ANALYTICS_SOURCE_SCHEMA, binding: "ANALYTICS_DB", databaseName, databaseId };
  if (mutate !== null) mutate(value);
  const path = join(directory, name);
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(path, mode);
  return path;
}

/**
 * Export a synthetic analytics D1 for one seal into a fresh owner directory
 * through the injected fake transport. `world` is a prepareSealWorld result;
 * `seal` is { manifestPath, sealId } (a sealWorld result or a forged variant).
 */
export async function exportSyntheticAdminHistory({
  world, seal, analyticsPath, analyticsSourcePath, bookmarks = {}, tamper = null, calls = [], overrides = {},
  ownerDirectory = undefined,
} = {}) {
  const out = ownerDirectory ?? await privateDirectory("dpt4x-admin-history-");
  const transport = createFakeCutoverTransport({ sources: { analytics: analyticsPath },
    bookmarks: { analytics: SYNTHETIC_BOOKMARKS.analytics, ...bookmarks }, tamper, calls });
  const result = await exportCutoverAdminHistory({
    inventoryPath: world.inventory.path,
    manifestPath: seal.manifestPath,
    sealId: seal.sealId,
    analyticsSourcePath,
    fenceReceiptPath: world.fence.path,
    ownerDirectory: out,
    execute: true,
    remote: true,
    ownerReadOnly: true,
    transport,
    ...overrides,
  });
  return { out, calls, result, path: result.path, sha256: result.exportSha256 };
}
