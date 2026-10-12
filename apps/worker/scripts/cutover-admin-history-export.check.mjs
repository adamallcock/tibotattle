import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { copyFile, chmod, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ADMIN_HISTORY_MAX_SNAPSHOTS,
  ADMIN_HISTORY_MIGRATION,
  ADMIN_HISTORY_PAGE_ROWS,
  CUTOVER_ADMIN_HISTORY_EXPORT_FILE,
  CUTOVER_ADMIN_HISTORY_EXPORT_SCHEMA,
  CUTOVER_ADMIN_HISTORY_FINAL_SCHEMA,
  finalizeCutoverAdminHistory,
  CutoverAdminHistoryError,
  expectedAdminHistoryMigrationSha256,
  exportCutoverAdminHistory,
  isCanonicalAdminInstant,
  readCutoverAdminHistoryExport,
  readSealedStorageSourceId,
  validAdminGaugeMetricsJson,
} from "./cutover-admin-history-export.mjs";
import { CutoverSourceError, canonicalJson, readCutoverSeal, sha256Hex } from "./cutover-source-seal.mjs";
import {
  SYNTHETIC_ANALYTICS_DATABASE_NAME,
  SYNTHETIC_OTHER_SOURCE_ID,
  buildSyntheticAnalyticsD1,
  exportSyntheticAdminHistory,
  writeAnalyticsSourceFixture,
} from "../postgres-test/fixtures/w2-seal/admin-history-fixtures.mjs";
import { SYNTHETIC_ACCOUNT_ID, SYNTHETIC_BOOKMARKS, SYNTHETIC_D1 } from "../postgres-test/fixtures/w2-seal/fence-fixtures.mjs";
import {
  forgeVariantSeal,
  headCommit,
  outputPathsOf,
  prepareSealWorld,
  sealWorld,
  writeFakeWranglerCli,
} from "../postgres-test/fixtures/w2-seal/seal-harness.mjs";
import { createFakeCutoverTransport, privateDirectory } from "../postgres-test/fixtures/w2-seal/synthetic-sources.mjs";

// N-ADMINHIST source coverage: the analytics D1 admin-history export over a
// synthetic W2-SEAL seal, its EP-8 fence fixture and a synthetic analytics D1
// (the real 0016 tables from Git). The provider is never contacted: the
// injected fake transport, or the default Wrangler transport behind an
// injected spawn and a stand-in CLI, answers from the synthetic file.
// Run: node --test ./scripts/cutover-admin-history-export.check.mjs

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = headCommit(WORKER_ROOT);
// sha256 of analytics-migrations/0016_admin_metrics_history.sql: the d43c8f92
// blob, and the row the live analytics D1 ledger carries (its 12-hex prefix
// cec3083959a6 is in the parity repository's OWN-3b command-pack receipt).
const MIGRATION_0016_SHA256 = "cec3083959a6082edb32b1d1e8cc6b1c4c3d306025700eac89286233ce99dc48";
const HOUR = 60 * 60 * 1000;
const ROWS = 2 * ADMIN_HISTORY_PAGE_ROWS + 345;
const SNAPSHOT_SQL = "SELECT captured_at,metrics_json FROM analytics_admin_metric_snapshots";
let world;
let seal;
let sourceId;
let directory;
let analyticsPath;
let analyticsSourcePath;
let snapshots;

const iso = ms => new Date(ms).toISOString();
const isCode = code => error => (error instanceof CutoverSourceError || error instanceof CutoverAdminHistoryError)
  && error.code === code;

before(async () => {
  world = await prepareSealWorld({ commit: COMMIT });
  const run = await sealWorld(world);
  const result = await run.run();
  seal = { manifestPath: outputPathsOf(run.out).manifest, sealId: result.sealId };
  const sealed = await readCutoverSeal({ manifestPath: seal.manifestPath, expectedSealId: seal.sealId });
  const database = new DatabaseSync(sealed.sources.ingestion.path, { readOnly: true });
  try {
    sourceId = readSealedStorageSourceId(database).sourceId;
  } finally {
    database.close();
  }
  assert.equal(typeof sourceId, "string");
  directory = await privateDirectory("dpt4x-admin-history-check-");
  const start = Date.parse("2026-09-12T06:00:00.000Z");
  snapshots = Array.from({ length: ROWS }, (_, index) => [iso(start + index * HOUR),
    JSON.stringify({ participantsTotal: 40 + (index % 7), quarantinePendingObjects: index % 3, cohortParticipants_pro: 2 })]);
  analyticsPath = buildSyntheticAnalyticsD1({ directory, commit: COMMIT, sourceId, snapshots,
    otherSnapshots: [[iso(start), "{}"], [iso(start + HOUR), "{\"participantsTotal\":1}"], [iso(start - HOUR), "{}"]] });
  analyticsSourcePath = await writeAnalyticsSourceFixture({ directory });
});

after(async () => {
  await world?.dispose();
});

function exportArgs(overrides = {}) {
  return { world, seal, analyticsPath, analyticsSourcePath, ...overrides };
}

/** The default Wrangler transport's provider, answered from the synthetic analytics file. */
function analyticsProviderSpawn({ bookmark = () => SYNTHETIC_BOOKMARKS.analytics, calls = [] } = {}) {
  let bookmarks = 0;
  return (command, args) => {
    const configPath = args[args.indexOf("--config") + 1];
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (config.d1_databases?.[0]?.database_id !== SYNTHETIC_D1.analytics) return { status: 1, stdout: "", stderr: "" };
    const configMode = statSync(configPath).mode & 0o777;
    if (args.includes("time-travel")) {
      bookmarks += 1;
      calls.push({ kind: "bookmark", configMode });
      return { status: 0, signal: null, stdout: JSON.stringify({ bookmark: bookmark(bookmarks) }), stderr: "" };
    }
    const flag = name => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
    const sql = readFileSync(flag("--tibo-query-path"), "utf8");
    if (!args.includes("execute") || sha256Hex(sql) !== flag("--tibo-query-sha256")) {
      return { status: 1, signal: null, stdout: "", stderr: "" };
    }
    calls.push({ kind: "query", configMode });
    const database = new DatabaseSync(analyticsPath, { readOnly: true });
    try {
      const results = database.prepare(sql).all().map(row => ({ ...row }));
      return { status: 0, signal: null, stdout: JSON.stringify([{ results, success: true, meta: {} }]), stderr: "" };
    } finally {
      database.close();
    }
  };
}

test("the snapshot grammar is d43c8f92's and the 0016 migration is pinned", () => {
  assert.equal(expectedAdminHistoryMigrationSha256({ commit: COMMIT }), MIGRATION_0016_SHA256);
  assert.equal(ADMIN_HISTORY_MIGRATION.name, "0016_admin_metrics_history.sql");
  assert.equal(isCanonicalAdminInstant("2026-09-12T06:00:00.000Z"), true);
  for (const instant of ["2026-09-12T06:00:00Z", "2026-09-12 06:00:00.000Z", "2026-09-12T06:00:00.000+00:00", 1, null]) {
    assert.equal(isCanonicalAdminInstant(instant), false, String(instant));
  }
  assert.equal(validAdminGaugeMetricsJson("{}"), true);
  assert.equal(validAdminGaugeMetricsJson("{\"participantsTotal\":12,\"cohortMedianUsd_pro\":0}"), true);
  const gauges = n => JSON.stringify(Object.fromEntries(Array.from({ length: n }, (_, index) => [`g${index}`, index])));
  assert.equal(validAdminGaugeMetricsJson(gauges(128)), true);
  for (const text of [gauges(129), "{\"participantsTotal\":-1}", "{\"participantsTotal\":1.5}", "{\"participantsTotal\":{\"n\":1}}",
    "{\"participantsTotal\":\"1\"}", "{\"bad-key\":1}", "{\"_lead\":1}", "[1]", "null", "{not json",
    `{"participantsTotal":${2 ** 53}}`, `{"${"a".repeat(4_000)}":1}`]) {
    assert.equal(validAdminGaugeMetricsJson(text), false, text.slice(0, 40));
  }
});

test("a dry run reads local files only and spawns nothing", async () => {
  const out = await privateDirectory("dpt4x-admin-history-dry-");
  const calls = [];
  const result = await exportCutoverAdminHistory({ inventoryPath: world.inventory.path, manifestPath: seal.manifestPath,
    sealId: seal.sealId, analyticsSourcePath, fenceReceiptPath: world.fence.path, ownerDirectory: out,
    transport: createFakeCutoverTransport({ sources: { analytics: analyticsPath }, bookmarks: SYNTHETIC_BOOKMARKS, calls }) });
  assert.deepEqual(result, { mode: "dry-run", sealId: seal.sealId, fenceReceiptSha256: world.fence.sha256,
    analyticsDatabaseIdSha256: sha256Hex(`d1:${SYNTHETIC_D1.analytics}`), migrationSha256: MIGRATION_0016_SHA256 });
  assert.deepEqual(calls, []);
  assert.deepEqual(await readdir(out), []);
  // --execute without --remote --owner-read-only is refused before any read.
  await assert.rejects(exportCutoverAdminHistory({ inventoryPath: world.inventory.path, manifestPath: seal.manifestPath,
    sealId: seal.sealId, analyticsSourcePath, fenceReceiptPath: world.fence.path, ownerDirectory: out, execute: true,
    remote: true, transport: createFakeCutoverTransport({ sources: { analytics: analyticsPath }, bookmarks: SYNTHETIC_BOOKMARKS,
      calls }) }), isCode("CUTOVER_REMOTE_NOT_AUTHORIZED"));
  assert.deepEqual(calls, []);
});

test("exports every snapshot of the sealed source in pages, bracketed by the fenced bookmark, deterministic and content-free", async () => {
  const first = await exportSyntheticAdminHistory(exportArgs());
  assert.deepEqual({ ...first.result, path: undefined }, { mode: "exported", path: undefined, exportSha256: first.sha256,
    snapshots: ROWS, firstCapturedAt: snapshots[0][0], lastCapturedAt: snapshots.at(-1)[0], otherSourceRows: 3 });
  assert.deepEqual(first.calls.map(call => call.kind), ["bookmark", "query", "query", "query", "query", "query", "query", "bookmark"]);
  assert.deepEqual(await readdir(first.out), [CUTOVER_ADMIN_HISTORY_EXPORT_FILE]);
  assert.equal((await lstat(first.path)).mode & 0o777, 0o400);
  const text = await readFile(first.path, "utf8");
  assert.equal(sha256Hex(text), first.sha256);
  const value = JSON.parse(text);
  assert.equal(`${canonicalJson(value)}\n`, text);
  assert.equal(value.schema, CUTOVER_ADMIN_HISTORY_EXPORT_SCHEMA);
  assert.equal(value.sealId, seal.sealId);
  assert.equal(value.fenceReceiptSha256, world.fence.sha256);
  assert.deepEqual(value.analytics, { bookmark: SYNTHETIC_BOOKMARKS.analytics,
    databaseIdSha256: sha256Hex(`d1:${SYNTHETIC_D1.analytics}`), migration: ADMIN_HISTORY_MIGRATION.name,
    migrationSha256: MIGRATION_0016_SHA256 });
  assert.equal(value.sourceIdSha256, sha256Hex(sourceId));
  assert.deepEqual(value.snapshots, snapshots, "every row of the sealed source, verbatim, in captured_at order");
  for (const secret of [sourceId, SYNTHETIC_OTHER_SOURCE_ID, SYNTHETIC_D1.analytics, SYNTHETIC_D1.ingestion,
    SYNTHETIC_ACCOUNT_ID, SYNTHETIC_ANALYTICS_DATABASE_NAME]) {
    assert.equal(text.includes(secret), false, "no id in the export");
    assert.equal(JSON.stringify(first.result).includes(secret), false, "no id in the result");
  }
  const read = await readCutoverAdminHistoryExport({ path: first.path, expectedSha256: first.sha256 });
  assert.equal(read.exportSha256, first.sha256);
  assert.equal(read.snapshots.length, ROWS);
  assert.equal(Object.isFrozen(read.snapshots), true);
  // A second export inside the same fence writes the same bytes.
  const second = await exportSyntheticAdminHistory(exportArgs());
  assert.equal(second.sha256, first.sha256);
  // One that already exists is never overwritten.
  await assert.rejects(exportSyntheticAdminHistory(exportArgs({ ownerDirectory: first.out })), isCode("CUTOVER_OUTPUT_EXISTS"));
  assert.equal(sha256Hex(await readFile(first.path)), first.sha256);
  // An empty table exports an explicit empty history, never a refusal.
  const empty = buildSyntheticAnalyticsD1({ directory, commit: COMMIT, sourceId, name: "analytics-empty.sqlite" });
  const none = await exportSyntheticAdminHistory(exportArgs({ analyticsPath: empty }));
  assert.deepEqual([none.result.snapshots, none.result.firstCapturedAt, none.result.otherSourceRows], [0, null, 0]);
});

test("the default Wrangler transport leaves only the export, or nothing", async () => {
  const cliPath = await writeFakeWranglerCli(await privateDirectory("dpt4x-admin-history-cli-"));
  const base = { inventoryPath: world.inventory.path, manifestPath: seal.manifestPath, sealId: seal.sealId,
    analyticsSourcePath, fenceReceiptPath: world.fence.path, execute: true, remote: true, ownerReadOnly: true, cliPath,
    environment: {} };
  const out = await privateDirectory("dpt4x-admin-history-default-");
  const calls = [];
  const result = await exportCutoverAdminHistory({ ...base, ownerDirectory: out, spawn: analyticsProviderSpawn({ calls }) });
  assert.equal(result.snapshots, ROWS);
  assert.deepEqual(await readdir(out), [CUTOVER_ADMIN_HISTORY_EXPORT_FILE]);
  assert.ok(calls.length === 8 && calls.every(call => call.configMode === 0o600));
  const failed = await privateDirectory("dpt4x-admin-history-default-drift-");
  await assert.rejects(exportCutoverAdminHistory({ ...base, ownerDirectory: failed,
    spawn: analyticsProviderSpawn({ bookmark: call => (call === 1 ? SYNTHETIC_BOOKMARKS.analytics : "00000001-22222222-00000008") }) }),
  isCode("CUTOVER_SOURCE_BOOKMARK_DRIFT"));
  assert.deepEqual(await readdir(failed), [], "no pinned config and no export is left");
});

test("refuses an analytics source that is malformed, unsafe, a sealed D1 or not the fenced analytics D1", async () => {
  const cases = [
    [{ mutate: value => { value.extra = 1; } }, "CUTOVER_ANALYTICS_SOURCE_INVALID"],
    [{ mutate: value => { value.binding = "USAGE_MONITOR_DB"; } }, "CUTOVER_ANALYTICS_SOURCE_INVALID"],
    [{ mutate: value => { value.schema = "tibotattle-cutover-analytics-source-v0"; } }, "CUTOVER_ANALYTICS_SOURCE_INVALID"],
    [{ databaseId: "not-a-uuid" }, "CUTOVER_ANALYTICS_SOURCE_INVALID"],
    [{ mode: 0o640 }, "CUTOVER_INVENTORY_UNSAFE"],
    [{ databaseId: SYNTHETIC_D1.ingestion }, "CUTOVER_SOURCE_NOT_ALLOWED"],
    [{ databaseId: SYNTHETIC_D1["deletion-ledger"] }, "CUTOVER_SOURCE_NOT_ALLOWED"],
    [{ databaseId: SYNTHETIC_D1["catchup-control"] }, "CUTOVER_FENCE_SOURCE_MISMATCH"],
    [{ databaseId: randomUUID() }, "CUTOVER_FENCE_SOURCE_MISMATCH"],
  ];
  for (const [options, code] of cases) {
    const path = await writeAnalyticsSourceFixture({ directory, name: `analytics-source-${randomUUID()}.json`, ...options });
    const calls = [];
    await assert.rejects(exportSyntheticAdminHistory(exportArgs({ analyticsSourcePath: path, calls })), isCode(code),
      JSON.stringify(options));
    assert.deepEqual(calls, [], "refused before any remote read");
  }
});

test("refuses a moved bookmark, a missing or different 0016 ledger row and a response that breaks the count or the shape", async () => {
  const refuse = async (overrides, code, label) => {
    const out = await privateDirectory("dpt4x-admin-history-refuse-");
    await assert.rejects(exportSyntheticAdminHistory(exportArgs({ ownerDirectory: out, ...overrides })), isCode(code), label);
    assert.deepEqual(await readdir(out), [], `${label}: nothing is left`);
  };
  await refuse({ bookmarks: { analytics: "00000001-22222222-00000008" } }, "CUTOVER_SOURCE_BOOKMARK_DRIFT", "B0 is not the fence pin");
  await refuse({ bookmarks: { analytics: call => (call === 1 ? SYNTHETIC_BOOKMARKS.analytics : "00000001-22222222-00000008") } },
    "CUTOVER_SOURCE_BOOKMARK_DRIFT", "B1 differs from B0");
  for (const ledgerSha256 of [null, "0".repeat(64)]) {
    const path = buildSyntheticAnalyticsD1({ directory, commit: COMMIT, sourceId, snapshots: snapshots.slice(0, 3), ledgerSha256,
      name: `analytics-ledger-${randomUUID()}.sqlite` });
    await refuse({ analyticsPath: path }, "CUTOVER_LEDGER_MISMATCH", `ledger ${ledgerSha256}`);
  }
  const tampers = {
    "a page without its last row": [(sql, rows) => (sql.startsWith(SNAPSHOT_SQL) ? rows.slice(0, -1) : rows),
      "CUTOVER_AGGREGATE_MISMATCH"],
    "another count": [(sql, rows) => (sql.startsWith("SELECT count(*) AS n FROM analytics_admin_metric_snapshots WHERE source_id=")
      ? [{ n: rows[0].n + 1 }] : rows), "CUTOVER_AGGREGATE_MISMATCH"],
    "an extra column": [(sql, rows) => (sql.startsWith(SNAPSHOT_SQL) ? rows.map(row => ({ ...row, source_id: "x" })) : rows),
      "CUTOVER_REMOTE_RESPONSE_INVALID"],
    "a non-integer count": [(sql, rows) => (sql.includes("source_id<>") ? [{ n: "3" }] : rows), "CUTOVER_REMOTE_RESPONSE_INVALID"],
    "an oversized page": [(sql, rows) => (sql.startsWith(SNAPSHOT_SQL) ? [...rows, ...rows.slice(0, 1)] : rows),
      "CUTOVER_REMOTE_RESPONSE_INVALID"],
  };
  for (const [label, [tamper, code]] of Object.entries(tampers)) {
    await refuse({ tamper: (role, sql, rows) => tamper(sql, rows) }, code, label);
  }
});

test("refuses any snapshot outside the d43c8f92 grammar or out of order", async () => {
  const rewrite = (index, row) => (role, sql, rows) => (sql.startsWith(SNAPSHOT_SQL) && !sql.includes("captured_at>")
    ? rows.map((item, position) => (position === index ? row(item) : item)) : rows);
  const cases = {
    "a non-canonical instant": rewrite(5, row => ({ ...row, captured_at: row.captured_at.replace(".000Z", "Z") })),
    "a negative gauge": rewrite(5, row => ({ ...row, metrics_json: "{\"participantsTotal\":-1}" })),
    "a nested gauge": rewrite(5, row => ({ ...row, metrics_json: "{\"participantsTotal\":{\"n\":1}}" })),
    "a non-integer gauge": rewrite(5, row => ({ ...row, metrics_json: "{\"participantsTotal\":1.5}" })),
    "a structural key it does not allow": rewrite(5, row => ({ ...row, metrics_json: "{\"bad-key\":1}" })),
    "more than 4,000 characters": rewrite(5, row => ({ ...row,
      metrics_json: JSON.stringify(Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`g${index}${"x".repeat(30)}`, 1]))) })),
    "a repeated instant": rewrite(5, row => ({ ...row, captured_at: snapshots[4][0] })),
    "an earlier instant": rewrite(5, row => ({ ...row, captured_at: snapshots[0][0] })),
  };
  for (const [label, tamper] of Object.entries(cases)) {
    const out = await privateDirectory("dpt4x-admin-history-grammar-");
    await assert.rejects(exportSyntheticAdminHistory(exportArgs({ ownerDirectory: out, tamper })),
      isCode("CUTOVER_ADMIN_HISTORY_VALUE_INVALID"), label);
    assert.deepEqual(await readdir(out), [], label);
  }
});

test("refuses more snapshots than the resource bound", async () => {
  const start = Date.parse("2014-01-01T00:00:00.000Z");
  const many = Array.from({ length: ADMIN_HISTORY_MAX_SNAPSHOTS + 1 }, (_, index) => [iso(start + index * HOUR), "{}"]);
  const path = buildSyntheticAnalyticsD1({ directory, commit: COMMIT, sourceId, snapshots: many, name: "analytics-many.sqlite" });
  const out = await privateDirectory("dpt4x-admin-history-many-");
  await assert.rejects(exportSyntheticAdminHistory(exportArgs({ analyticsPath: path, ownerDirectory: out })),
    isCode("CUTOVER_ADMIN_HISTORY_TOO_LARGE"));
  assert.deepEqual(await readdir(out), []);
});

test("refuses a foreign seal id, an invalid sealed source id and a fence receipt that is not the seal's", async () => {
  const calls = [];
  await assert.rejects(exportSyntheticAdminHistory(exportArgs({ seal: { ...seal, sealId: "e".repeat(64) }, calls })),
    isCode("CUTOVER_SEAL_MANIFEST_INVALID"));
  const sealed = await readCutoverSeal({ manifestPath: seal.manifestPath, expectedSealId: seal.sealId });
  for (const sql of ["DELETE FROM storage_source_state", `DROP TRIGGER storage_source_identity_immutable;
    UPDATE storage_source_state SET source_id = 'bad id'`]) {
    const forged = await forgeVariantSeal(sealed, sql);
    await assert.rejects(exportSyntheticAdminHistory(exportArgs({ seal: forged, calls })),
      isCode("CUTOVER_ADMIN_HISTORY_SOURCE_ID_INVALID"), sql);
  }
  await assert.rejects(exportSyntheticAdminHistory(exportArgs({ overrides: { fenceReceiptPath: world.proof.path }, calls })),
    isCode("CUTOVER_FENCE_RECEIPT_INVALID"));
  assert.deepEqual(calls, [], "refused before any remote read");
});

test("the reader refuses a changed, re-encoded, reordered or out-of-grammar export", async () => {
  const valid = await exportSyntheticAdminHistory(exportArgs());
  const value = JSON.parse(await readFile(valid.path, "utf8"));
  const write = async (text, mode = 0o600) => {
    const path = join(directory, `export-${randomUUID()}.json`);
    await writeFile(path, text, { mode: 0o600, flag: "wx" });
    await chmod(path, mode);
    return { path, expectedSha256: sha256Hex(text) };
  };
  const canonical = item => `${canonicalJson(item)}\n`;
  const resealed = mutate => {
    const copy = structuredClone(value);
    mutate(copy);
    copy.snapshotsSha256 = sha256Hex(canonicalJson(copy.snapshots));
    return canonical(copy);
  };
  const invalid = [
    await write(JSON.stringify(value, null, 2)),
    await write(canonical({ ...value, extra: 1 })),
    await write(canonical({ ...value, schema: "tibotattle-cutover-admin-history-v0" })),
    await write(canonical({ ...value, snapshotsSha256: "0".repeat(64) })),
    await write(canonical({ ...value, otherSourceRows: -1 })),
    await write(canonical({ ...value, analytics: { ...value.analytics, migration: "0017_graph_work_selection.sql" } })),
    await write(resealed(copy => { copy.snapshots.reverse(); })),
    await write(resealed(copy => { copy.snapshots[3][0] = copy.snapshots[3][0].replace(".000Z", "Z"); })),
    await write(resealed(copy => { copy.snapshots[3][1] = "{\"participantsTotal\":-1}"; })),
    await write(resealed(copy => { copy.snapshots[3] = [copy.snapshots[3][0]]; })),
    await write(canonical(value), 0o644),
    { path: valid.path, expectedSha256: "0".repeat(64) },
    { path: join(directory, "absent.json"), expectedSha256: valid.sha256 },
    { path: valid.path, expectedSha256: "not-a-digest" },
  ];
  for (const [index, args] of invalid.entries()) {
    await assert.rejects(readCutoverAdminHistoryExport(args), isCode("CUTOVER_ADMIN_HISTORY_EXPORT_INVALID"), `case ${index}`);
  }
  // The same bytes at another private path are accepted.
  const copy = await write(await readFile(valid.path, "utf8"));
  assert.equal((await readCutoverAdminHistoryExport(copy)).snapshots.length, ROWS);
});

test("the CLI runs a dry run that prints content-free JSON and refuses missing flags", () => {
  const script = join(WORKER_ROOT, "scripts", "cutover-admin-history-export.mjs");
  const args = ["export", "--inventory", world.inventory.path, "--seal", seal.manifestPath, "--seal-id", seal.sealId,
    "--analytics-source", analyticsSourcePath, "--fence-receipt", world.fence.path, "--out", directory];
  const stdout = execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.deepEqual(JSON.parse(stdout), { command: "export", mode: "dry-run", sealId: seal.sealId,
    fenceReceiptSha256: world.fence.sha256, analyticsDatabaseIdSha256: sha256Hex(`d1:${SYNTHETIC_D1.analytics}`),
    migrationSha256: MIGRATION_0016_SHA256 });
  for (const missing of ["--analytics-source", "--fence-receipt", "--seal-id"]) {
    const index = args.indexOf(missing);
    const partial = [...args.slice(0, index), ...args.slice(index + 2)];
    assert.throws(() => execFileSync(process.execPath, [script, ...partial], { stdio: ["ignore", "pipe", "pipe"] }),
      error => error.status === 1 && error.stderr.toString().trim() === "CUTOVER_ARGUMENT_INVALID" && error.stdout.length === 0,
      missing);
  }
});


test("fixed analytics drafts are refused until successor proof covers the complete capture", async () => {
  const { writeCaptureProofFixture, captureProofInstant } = await import("../postgres-test/fixtures/w2-seal/capture-proof-fixtures.mjs");
  const { readCaptureAnchor, createCaptureDraft } = await import("./cutover-capture-proof.mjs");
  const fixture = await writeCaptureProofFixture();
  try {
    const pin = fixture.original.receipt.d1.find(item => item.label === "analytics");
    const anchor = await readCaptureAnchor({ fenceReceiptPath: fixture.original.path, fenceReceiptSha256: fixture.original.sha256 });
    const body = { schema: CUTOVER_ADMIN_HISTORY_FINAL_SCHEMA, sealId: "a".repeat(64), inventorySha256: "b".repeat(64),
      fenceReceiptSha256: fixture.original.sha256, analytics: { databaseIdSha256: pin.idSha256, bookmark: pin.bookmark,
        migration: ADMIN_HISTORY_MIGRATION.name, migrationSha256: MIGRATION_0016_SHA256 }, sourceIdSha256: "c".repeat(64),
      snapshots: [], snapshotsSha256: sha256Hex(canonicalJson([])), otherSourceRows: 0 };
    const capture = { startedAt: captureProofInstant(40), endpointTimestamp: captureProofInstant(41), completedAt: captureProofInstant(42),
      roles: [{ role: "analytics", label: "analytics", databaseIdSha256: pin.idSha256, bookmarkSha256: sha256Hex(pin.bookmark) }] };
    const draft = createCaptureDraft({ kind: "admin-history", body, anchor, capture });
    const out = await privateDirectory("history-proof-check-");
    const draftPath = join(out, "draft.json");
    const text = `${canonicalJson(draft)}\n`;
    await writeFile(draftPath, text, { mode: 0o400 });
    const draftSha256 = sha256Hex(text);
    await assert.rejects(readCutoverAdminHistoryExport({ path: draftPath, expectedSha256: draftSha256 }), isCode("CUTOVER_ADMIN_HISTORY_EXPORT_INVALID"));
    const args = { draftPath, draftSha256, fenceReceiptPath: fixture.original.path, ownerDirectory: out };
    await assert.rejects(finalizeCutoverAdminHistory({ ...args, successorFenceReceiptPath: fixture.original.path,
      successorFenceReceiptSha256: fixture.original.sha256 }), isCode("CUTOVER_CAPTURE_PROOF_INVALID"));
    const result = await finalizeCutoverAdminHistory({ ...args, successorFenceReceiptPath: fixture.successor.path,
      successorFenceReceiptSha256: fixture.successor.sha256 });
    await assert.rejects(finalizeCutoverAdminHistory({ ...args, successorFenceReceiptPath: fixture.successor.path,
      successorFenceReceiptSha256: fixture.successor.sha256 }), isCode("CUTOVER_OUTPUT_EXISTS"));
    const final = await readCutoverAdminHistoryExport({ path: result.path, expectedSha256: result.exportSha256,
      originalFenceReceiptPath: fixture.original.path });
    assert.equal(final.schema, CUTOVER_ADMIN_HISTORY_FINAL_SCHEMA);
    assert.equal(final.captureProof.capture.completedAt, capture.completedAt);
    const legacyPath = join(out, "downgraded.json");
    const legacyText = `${canonicalJson({ ...body, schema: CUTOVER_ADMIN_HISTORY_EXPORT_SCHEMA })}\n`;
    await writeFile(legacyPath, legacyText, { mode: 0o400 });
    const legacyArgs = { path: legacyPath, expectedSha256: sha256Hex(legacyText) };
    await readCutoverAdminHistoryExport(legacyArgs);
    await assert.rejects(readCutoverAdminHistoryExport({ ...legacyArgs, originalFenceReceiptPath: fixture.original.path }),
      isCode("CUTOVER_ADMIN_HISTORY_EXPORT_INVALID"));
    await fixture.release();
    await assert.rejects(readCutoverAdminHistoryExport({ path: result.path, expectedSha256: result.exportSha256,
      originalFenceReceiptPath: fixture.original.path }));
  } finally { await fixture.dispose(); }
});


test("fixed capture uses only explicit timestamps and account mismatch refuses before transport", async () => {
  const { writeCaptureProofFixture, captureProofInstant } = await import("../postgres-test/fixtures/w2-seal/capture-proof-fixtures.mjs");
  const fixture = await writeCaptureProofFixture({ d1: world.fence.receipt.d1,
    accountSha256: sha256Hex(`account:${SYNTHETIC_ACCOUNT_ID}`) });
  try {
    const legacy = await readCutoverSeal({ manifestPath: seal.manifestPath, expectedSealId: seal.sealId });
    const out = await privateDirectory("analytics-fixed-capture-");
    const { readCaptureAnchor, createCaptureDraft, finalizeCaptureDraft } = await import("./cutover-capture-proof.mjs");
    const { sealId: _old, ...base } = legacy.manifest;
    async function writeFixedSeal(receipts, name) {
      const manifestBody = { ...base, schema: "tibotattle-cutover-seal-v2",
        fence: { ...base.fence, fenceReceiptSha256: receipts.original.sha256 } };
      const nextSealId = sha256Hex(canonicalJson(manifestBody));
      const body = { ...manifestBody, sealId: nextSealId };
      const anchor = await readCaptureAnchor({ fenceReceiptPath: receipts.original.path, fenceReceiptSha256: receipts.original.sha256 });
      const draft = createCaptureDraft({ kind: "seal", body, anchor, capture: { startedAt: captureProofInstant(31),
        endpointTimestamp: captureProofInstant(32), completedAt: captureProofInstant(33), roles: body.sources.map(source => ({
          role: source.role, label: source.role, databaseIdSha256: source.databaseIdSha256,
          bookmarkSha256: sha256Hex(receipts.original.receipt.d1.find(pin => pin.label === source.role).bookmark) })) } });
      const { proof } = await finalizeCaptureDraft({ draft, originalFenceReceiptPath: receipts.original.path,
        successorFenceReceiptPath: receipts.successor.path, successorFenceReceiptSha256: receipts.successor.sha256 });
      const manifestPath = join(out, name);
      await writeFile(manifestPath, `${canonicalJson({ ...body, captureProof: proof })}\n`, { mode: 0o400 });
      return { manifestPath, nextSealId };
    }
    const { manifestPath, nextSealId } = await writeFixedSeal(fixture, "seal-manifest.json");
    for (const source of Object.values(legacy.sources)) {
      await copyFile(source.path, join(out, source.sealedFile));
      await chmod(join(out, source.sealedFile), 0o400);
    }
    const timestamps = [];
    const fake = createFakeCutoverTransport({ sources: { analytics: analyticsPath }, bookmarks: { analytics: SYNTHETIC_BOOKMARKS.analytics } });
    const transport = { ...fake, bookmark: async (source, options) => {
      assert.equal(typeof options?.timestamp, "string"); timestamps.push(options.timestamp); return fake.bookmark(source);
    } };
    const args = { inventoryPath: world.inventory.path, manifestPath, sealId: nextSealId, analyticsSourcePath,
      fenceReceiptPath: fixture.original.path, execute: true, remote: true, ownerReadOnly: true, transport,
      now: () => new Date(captureProofInstant(40)) };
    const draftOut = await privateDirectory("history-fixed-out-");
    const result = await exportCutoverAdminHistory({ ...args, ownerDirectory: draftOut });
    assert.equal(result.mode, "draft");
    assert.deepEqual(timestamps, [captureProofInstant(30), captureProofInstant(40), captureProofInstant(40)]);
    await assert.rejects(readCutoverAdminHistoryExport({ path: result.path, expectedSha256: result.exportSha256 }), isCode("CUTOVER_ADMIN_HISTORY_EXPORT_INVALID"));
    const wrong = await writeCaptureProofFixture({ d1: world.fence.receipt.d1 });
    try {
      const { manifestPath: wrongPath, nextSealId: wrongId } = await writeFixedSeal(wrong, "wrong-seal.json");
      const callsBefore = timestamps.length;
      await assert.rejects(exportCutoverAdminHistory({ ...args, manifestPath: wrongPath, sealId: wrongId,
        fenceReceiptPath: wrong.original.path, ownerDirectory: await privateDirectory("wrong-account-out-") }), isCode("CUTOVER_FENCE_SOURCE_MISMATCH"));
      assert.equal(timestamps.length, callsBefore);
    } finally { await wrong.dispose(); }
  } finally { await fixture.dispose(); }
});
