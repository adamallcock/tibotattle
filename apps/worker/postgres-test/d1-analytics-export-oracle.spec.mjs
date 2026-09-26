import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { buildD1AnalyticsExportFixture } from "./fixtures/d1-analytics-export-fixture.mjs";
import { openSealedSqliteD1 } from "../cloud-run/sealed-sqlite-d1-adapter.mjs";
import { runD1AnalyticsExportOracleCli } from "../cloud-run/d1-analytics-export-oracle.mjs";
import { canonicalJson } from "../src/canonical-json.ts";
import { sha256Hex } from "../src/crypto.ts";
import {
  ANALYTICS_HISTORY_CANONICAL_TABLES,
  ANALYTICS_HISTORY_ORACLE_SCHEMA,
  CanonicalTableHasher,
  analyticsHistoryGraphWindow,
  canonicalColumnValue,
  canonicalRowLine,
  classifyDailyReproduction,
  classifyGraphReproduction,
  liveCohortMemberLine,
  normalizedDailyPayloadSha256,
  normalizedModelDaySha256,
  normalizedPreviewSha256,
  validateAnalyticsHistoryOracle,
} from "../src/analytics-history-proof.ts";
import {
  canonicalD1TableDigest,
  iterateOracleUntilDone,
  readD1AnalyticsImportSelection,
  readD1AnalyticsLiveCohort,
  runD1AnalyticsExportOracle,
} from "../src/d1-analytics-export-oracle.ts";
import { readCacheRetentionCommunitySeries } from "../src/cache-retention-day.ts";
import { readStorageCommunityOwnerPage } from "../src/storage-community-authority.ts";
import { advanceStorageCommunityGraphWork } from "../src/storage-community-graph-work.ts";
import { retireStorageCommunityGraphPublications } from "../src/storage-community-graph-publication.ts";

// The whole D1-side oracle is exercised offline: synthetic sealed D1 files
// built by the Worker's own migrations and functions, scratch copies, and the
// Worker's own analytics code. No PostgreSQL, network or live binding.
const RUN_TIMEOUT_MS = 300_000;
const DAY_MS = 86_400_000;
const FOLD_HISTORY = [{ value: "disabled", fromMs: 1_700_000_000_000, untilMs: null }];

let root;
let fixture;
let cliRun;
const scratchSets = [];

async function scratch(tag, doctor) {
  const paths = {};
  for (const [name, sealed] of Object.entries(fixture.paths)) {
    paths[name] = join(root, `scratch-${tag}-${name}.sqlite`);
    await copyFile(sealed, paths[name]);
    await chmod(paths[name], 0o600);
  }
  if (doctor) {
    const databases = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, new DatabaseSync(path)]));
    try {
      await doctor(databases);
    } finally {
      for (const database of Object.values(databases)) database.close();
    }
  }
  scratchSets.push(paths);
  return paths;
}

/** Adapter bindings over a scratch set. They read SQLite's 'now' at the
 * pinned instant unless `pinnedNowMs` is null (the wall clock). */
function open(paths, { pinnedNowMs = fixture.pinnedNowMs, readOnly = false } = {}) {
  const handles = Object.fromEntries(Object.entries(paths).map(([name, path]) =>
    [name, openSealedSqliteD1(path, { pinnedNowMs, readOnly })]));
  return {
    ...Object.fromEntries(Object.entries(handles).map(([name, handle]) => [name, handle.database])),
    close() { for (const handle of Object.values(handles)) handle.close(); },
  };
}

async function runOracle(paths, overrides = {}, openOptions = {}) {
  const db = open(paths, openOptions);
  try {
    return await runD1AnalyticsExportOracle({ ingestion: db.ingestion, analytics: db.analytics, ledger: db.ledger,
      pinnedNowMs: fixture.pinnedNowMs, sourceId: fixture.sourceId, sourceNamespace: fixture.sourceNamespace,
      cacheRetentionFromDay: null, foldHistory: FOLD_HISTORY, moduleDigest: cliRun.oracle.moduleDigest, ...overrides });
  } finally {
    db.close();
  }
}

async function refusal(paths, overrides = {}, openOptions = {}) {
  try {
    await runOracle(paths, overrides, openOptions);
  } catch (error) {
    return error;
  }
  assert.fail("the oracle accepted an export it must refuse");
}

async function fileSha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function cliArgv(paths, inventory, out) {
  return ["--ingestion", paths.ingestion, "--analytics", paths.analytics, "--ledger", paths.ledger,
    "--pinned-now-ms", String(fixture.pinnedNowMs), "--inventory", inventory, "--out", out];
}

/** Remove one cache-retention day completely (mark, values, bands, carry). */
function removeCacheRetentionDay(analytics, day) {
  const marks = analytics.prepare("SELECT mark_key FROM analytics_cache_retention_day_marks WHERE day=?").all(day)
    .map((row) => row.mark_key);
  assert.ok(marks.length > 0, `the fixture retains ${day}`);
  for (const markKey of marks) {
    const values = analytics.prepare("SELECT value_key FROM analytics_cache_retention_day_values WHERE mark_key=?")
      .all(markKey).map((row) => row.value_key);
    analytics.prepare("DELETE FROM analytics_cache_retention_day_marks WHERE mark_key=?").run(markKey);
    analytics.prepare("DELETE FROM analytics_cache_retention_day_values WHERE mark_key=?").run(markKey);
    for (const value of values) analytics.prepare("DELETE FROM analytics_cache_retention_day_bands WHERE value_key=?").run(value);
    analytics.prepare("DELETE FROM analytics_cache_retention_day_carry WHERE mark_key=?").run(markKey);
  }
}

function dropTriggers(database, table) {
  for (const { name } of database.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").all(table)) {
    database.exec(`DROP TRIGGER "${name}"`);
  }
}

/** Synthetic corruption of a scratch copy only: publications are immutable
 * in ordinary use, so the doctor removes the guard first. */
function dropPublicationGuard(analytics) {
  analytics.exec("DROP TRIGGER analytics_community_daily_revision_immutable");
}

function headRow(analytics, day) {
  return analytics.prepare(`SELECT p.revision,p.payload_json,p.authority_json FROM analytics_community_daily_heads h
    JOIN analytics_community_daily_publications p ON p.source_id=h.source_id AND p.day=h.day AND p.revision=h.revision
    WHERE h.day=?`).get(day);
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-d1-export-oracle-")));
  await chmod(root, 0o700);
  fixture = await buildD1AnalyticsExportFixture({ directory: root });
  // Run A goes through the operator CLI with the real oracle.
  const paths = await scratch("cli");
  const inventory = join(root, "inventory.json");
  const d1 = {};
  for (const [name, sealed] of Object.entries(fixture.paths)) {
    d1[name] = { timeTravelBookmark: `synthetic-bookmark-${name}`, sealedSha256: await fileSha256(sealed) };
  }
  await writeFile(inventory, JSON.stringify({ schema: "analytics-cutover-inventory-v2",
    drain: { fencedAtMs: fixture.pinnedNowMs - 60_000, quiescentAtMs: fixture.pinnedNowMs },
    cacheRetention: { fromDay: null }, foldHistory: FOLD_HISTORY, d1 }));
  const out = join(root, "oracle.json");
  const logs = [];
  const code = await runD1AnalyticsExportOracleCli({ argv: cliArgv(paths, inventory, out), log: (entry) => logs.push(entry) });
  const bytes = code === 0 ? await readFile(out) : null;
  cliRun = { code, logs, out, paths, inventory, bytes, oracle: bytes === null ? null : JSON.parse(bytes) };
}, RUN_TIMEOUT_MS);

afterAll(async () => {
  vi.useRealTimers();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("normalization and the closed oracle contract", () => {
  it("normalization strips exactly revision, releasedAt and aggregateId", async () => {
    const payload = { schemaVersion: "community-daily-aggregate-v1.0", aggregateId: "community-daily:2026-09-24:r1",
      day: "2026-09-24", revision: 1, releasedAt: "2026-09-25T00:00:00.000Z", immutableRevision: true,
      totals: { usageEvents: 3 }, cells: [{ modelId: "gpt-5.6-sol", revision: 7 }] };
    const base = await normalizedDailyPayloadSha256(JSON.stringify(payload));
    assert.equal(base, await sha256Hex(canonicalJson({ schemaVersion: payload.schemaVersion, day: payload.day,
      immutableRevision: true, totals: payload.totals, cells: payload.cells })));
    assert.equal(await normalizedDailyPayloadSha256({ ...payload, aggregateId: "community-daily:2026-09-24:r9",
      revision: 9, releasedAt: "2026-09-30T00:00:00.000Z" }), base);
    const reordered = Object.fromEntries(Object.entries(payload).reverse());
    assert.equal(await normalizedDailyPayloadSha256(reordered), base);
    for (const changed of [{ ...payload, day: "2026-09-23" }, { ...payload, schemaVersion: "other" },
      { ...payload, immutableRevision: false }, { ...payload, totals: { usageEvents: 4 } },
      { ...payload, cells: [{ modelId: "gpt-5.6-sol", revision: 8 }] }, { ...payload, released: "x" }]) {
      assert.notEqual(await normalizedDailyPayloadSha256(changed), base, "only the three revision keys are stripped");
    }
    const model = { day: "2026-09-24", values: [["gpt-5.6-sol", 1.5, 2]], refusedParticipantCount: 1 };
    assert.equal(await normalizedModelDaySha256(model), await sha256Hex(canonicalJson(model)));
    assert.notEqual(await normalizedModelDaySha256({ ...model, refusedParticipantCount: 2 }),
      await normalizedModelDaySha256(model));
    const preview = { generatedAt: "2026-09-26T00:00:00.000Z", participants: 3, days: [] };
    assert.equal(await normalizedPreviewSha256({ ...preview, generatedAt: "2026-09-27T00:00:00.000Z" }),
      await normalizedPreviewSha256(preview));
    assert.notEqual(await normalizedPreviewSha256({ ...preview, participants: 4 }), await normalizedPreviewSha256(preview));
    await assert.rejects(normalizedDailyPayloadSha256("[]"), { code: "ANALYTICS_HISTORY_ORACLE_INVALID" });
  });

  it("the validator refuses unknown keys, missing keys and malformed values", () => {
    const valid = cliRun.oracle;
    assert.ok(valid, "the CLI run produced an oracle");
    validateAnalyticsHistoryOracle(structuredClone(valid));
    const mutations = [
      (value) => { value.participantId = "synthetic"; },
      (value) => { value.fenceCounters.ownerDigest = "0".repeat(64); },
      (value) => { value.importSelection.daily[0].ownerDigest = "0".repeat(64); },
      (value) => { value.graphForced.modelDays[0].note = "x"; },
      (value) => { value.cacheRetention.rebuildTableSha256.analytics_other = "0".repeat(64); },
      (value) => { value.foldHistory = [{ value: "enabled", fromMs: 1, untilMs: null, host: "x" }]; },
      (value) => { delete value.moduleDigest; },
      (value) => { value.schema = "analytics-history-oracle-v1"; },
      (value) => { value.quiescence.queueRows = 1; },
      (value) => { value.dailyForced[0].d1Drift = !value.dailyForced[0].d1Drift; },
      (value) => { value.graphForced.modelDays.pop(); },
      (value) => { value.importSelection.daily.reverse(); value.importSelection.daily.push(value.importSelection.daily[0]); },
      (value) => { value.liveCohort.sha256 = "Z".repeat(64); },
    ];
    for (const mutate of mutations) {
      const copy = structuredClone(valid);
      mutate(copy);
      assert.throws(() => validateAnalyticsHistoryOracle(copy), { code: "ANALYTICS_HISTORY_ORACLE_INVALID" });
    }
  });

  // Known answers for the canonical hash contract HX-2 and HX-5 reproduce
  // without importing this module. The expected hex values were computed
  // independently (node:crypto over the documented framing).
  it("canonical row lines, table digests and cohort lines match their known answers", async () => {
    const journal = ANALYTICS_HISTORY_CANONICAL_TABLES.storage_ingestion_changes;
    const row = { sequence: 7, event_digest: "a".repeat(64), owner_digest: "b".repeat(64), revision: 2,
      kind: "owner-upload", object_digest: "c".repeat(64), content_digest: null, authority_epoch: 3,
      public_authority_epoch: 4, recorded_ms: 1_700_000_000_000 };
    const line = `["7","${"a".repeat(64)}","${"b".repeat(64)}","2","owner-upload","${"c".repeat(64)}",null,"3","4","1700000000000"]`;
    assert.equal(canonicalRowLine(journal, row), line, "i64 renders a decimal string, NULL stays null, columns in projection order");
    assert.equal(canonicalRowLine(journal, { ...row, sequence: 7n, recorded_ms: 1_700_000_000_000n }), line, "bigint i64");
    assert.equal(canonicalRowLine(journal, Object.fromEntries(Object.entries(row).reverse())), line, "row key order is irrelevant");
    assert.throws(() => canonicalRowLine(journal, { ...row, extra: 1, sequence: undefined }), { code: "ANALYTICS_HISTORY_ORACLE_INVALID" });
    const { recorded_ms: _omitted, ...missing } = row;
    assert.throws(() => canonicalRowLine(journal, missing), { code: "ANALYTICS_HISTORY_ORACLE_INVALID" });
    const one = new CanonicalTableHasher();
    await one.add([line]);
    assert.equal(one.rows, 1);
    assert.equal(await one.digest(), "d98ee984c329454c739464f5fe67b407f8186e3b241df86f44fbdbc1a0bfd79d");
    // Framing: sha256 over sha256(line) + "\n" per row; paging-independent.
    const paged = new CanonicalTableHasher();
    await paged.add(["x"]);
    await paged.add([]);
    await paged.add(["y"]);
    assert.equal(await paged.digest(), "7f395d7422a497f623b6a5a8a18c49049e24eefa8542ba9a39ed36cff8a5d485");
    assert.equal(await new CanonicalTableHasher().digest(), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    // Column types, including json_bytes (byte for byte) and NULL for each.
    for (const type of ["text", "i64", "f64", "json_bytes", "json_canonical"]) assert.equal(canonicalColumnValue(type, null), null);
    assert.equal(canonicalColumnValue("json_bytes", '{"b":1, "a":[2,3]}'), '{"b":1, "a":[2,3]}');
    assert.equal(canonicalColumnValue("json_canonical", '{"b":1, "a":[2,3]}'), '{"a":[2,3],"b":1}');
    assert.equal(canonicalColumnValue("f64", 0.1 + 0.2), "0.30000000000000004");
    assert.equal(canonicalColumnValue("i64", -9_007_199_254_740_991), "-9007199254740991");
    assert.equal(canonicalColumnValue("i64", 2n ** 63n - 1n), "9223372036854775807");
    for (const [type, value] of [["i64", 2 ** 53], ["i64", 1.5], ["i64", "7"], ["text", 7], ["json_bytes", 7],
      ["f64", Number.NaN], ["json_canonical", "{"]]) {
      assert.throws(() => canonicalColumnValue(type, value), { code: "ANALYTICS_HISTORY_ORACLE_INVALID" }, `${type} ${value}`);
    }
    const progress = ANALYTICS_HISTORY_CANONICAL_TABLES.analytics_cache_retention_day_progress;
    assert.equal(progress.columns.find(([name]) => name === "state_json")[1], "json_bytes");
    // One live-cohort member: the complete owner-page row, keys sorted.
    const owner = { participantId: "participant-synthetic-1", ownerDigest: "d".repeat(64), inputRevision: 2,
      ownerRevision: 1, authorityEpoch: 3, hasV1: true, hasV11: false, hasV12: true, hasLegacy: false, hasEffective: true };
    const memberLine = `{"authorityEpoch":3,"hasEffective":true,"hasLegacy":false,"hasV1":true,"hasV11":false,"hasV12":true,`
      + `"inputRevision":2,"ownerDigest":"${"d".repeat(64)}","ownerRevision":1,"participantId":"participant-synthetic-1"}`;
    assert.equal(liveCohortMemberLine(owner), memberLine);
    const { hasEffective: _absent, ...legacyShape } = owner;
    assert.equal(liveCohortMemberLine(legacyShape), memberLine.replace('"hasEffective":true', '"hasEffective":false'));
    assert.equal(liveCohortMemberLine({ ...owner, ownerDigest: null }), memberLine.replace(`"${"d".repeat(64)}"`, "null"));
    const cohort = new CanonicalTableHasher();
    await cohort.add([liveCohortMemberLine(owner)]);
    assert.equal(await cohort.digest(), "e2d50808fabe42659249a61ab707811da2ca864e0a2c804e2f6a080e67272558");
  });

  it("the keyset-paged table digest equals one unpaged read across page boundaries", async () => {
    const path = join(root, "paging.sqlite");
    const seed = new DatabaseSync(path);
    seed.exec(`CREATE TABLE storage_ingestion_changes(sequence INTEGER PRIMARY KEY,event_digest TEXT,owner_digest TEXT,
        revision INTEGER,kind TEXT,object_digest TEXT,content_digest TEXT,authority_epoch INTEGER,
        public_authority_epoch INTEGER,recorded_ms INTEGER);
      CREATE TABLE analytics_cache_retention_day_carry(mark_key TEXT NOT NULL,day TEXT NOT NULL,source_id TEXT,
        owner_digest TEXT,device_id TEXT,manifest_digest TEXT,PRIMARY KEY(mark_key,day)) WITHOUT ROWID;
      CREATE TABLE analytics_cache_retention_day_progress(progress_key TEXT PRIMARY KEY,source_id TEXT,source_layout TEXT,
        source_namespace TEXT,owner_digest TEXT,device_id TEXT,manifest_id TEXT,manifest_digest TEXT,day TEXT,
        method_version TEXT,carry_digest TEXT,progress_revision INTEGER,state_json TEXT,state_digest TEXT);`);
    const hex = (n, width = 64) => n.toString(16).padStart(width, "0");
    seed.exec("BEGIN");
    const journal = seed.prepare("INSERT INTO storage_ingestion_changes VALUES(?,?,?,?,?,?,?,?,?,?)");
    // Exactly two full pages (the last page read is empty), inserted out of order.
    for (let n = 1_000; n >= 1; n -= 1) {
      journal.run(n, hex(n), hex(n % 7), n % 5, n % 2 ? "owner-upload" : "owner-erased", hex(n + 1), n % 3 ? null : hex(n + 2),
        1, n % 11, 1_700_000_000_000 + n);
    }
    // A composite key whose page boundaries fall inside one mark's days.
    const carry = seed.prepare("INSERT INTO analytics_cache_retention_day_carry VALUES(?,?,?,?,?,?)");
    for (let n = 0; n < 1_201; n += 1) {
      const mark = Math.floor(n / 12), day = n % 12;
      carry.run(hex(mark), `2026-09-${String(day + 10).padStart(2, "0")}`, "synthetic-source", hex(mark % 3), `device-${mark % 4}`,
        day % 5 ? hex(day) : "");
    }
    const progress = seed.prepare("INSERT INTO analytics_cache_retention_day_progress VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (let n = 0; n < 501; n += 1) {
      progress.run(hex(n * 7919 % 100_003), "synthetic-source", "typed-v11", "synthetic-namespace", hex(n % 5), `device-${n}`,
        `manifest-${n}`, hex(n), "2026-09-25", "cache-retention-v3", hex(n + 9), n + 1, `{"z":${n}, "a":"\u00e9"}`, hex(n + 3));
    }
    seed.exec("COMMIT");
    const expected = (table) => {
      const projection = ANALYTICS_HISTORY_CANONICAL_TABLES[table];
      const rows = seed.prepare(`SELECT ${projection.columns.map(([name]) => name).join(",")} FROM ${table}
        ORDER BY ${projection.orderBy.join(",")}`).all();
      const digests = rows.map((value) => createHash("sha256").update(JSON.stringify(projection.columns.map(([name, type]) =>
        value[name] === null ? null : type === "i64" ? String(value[name]) : value[name]))).digest("hex") + "\n");
      return { rows: rows.length, sha256: createHash("sha256").update(digests.join("")).digest("hex") };
    };
    const want = Object.fromEntries(["storage_ingestion_changes", "analytics_cache_retention_day_carry",
      "analytics_cache_retention_day_progress"].map((table) => [table, expected(table)]));
    seed.close();
    await chmod(path, 0o600);
    const handle = openSealedSqliteD1(path, { readOnly: true });
    try {
      for (const [table, digest] of Object.entries(want)) {
        assert.deepEqual(await canonicalD1TableDigest(handle.database, table), digest, table);
      }
      assert.deepEqual(Object.values(want).map((digest) => digest.rows), [1_000, 1_201, 501]);
      await assert.rejects(canonicalD1TableDigest(handle.database, "participants"), { code: "ANALYTICS_EXPORT_INPUT_INVALID" });
      await assert.rejects(canonicalD1TableDigest(handle.database, "storage_owner_revisions"),
        { code: "ANALYTICS_EXPORT_SCHEMA_INVALID" });
    } finally {
      handle.close();
    }
  }, RUN_TIMEOUT_MS);

  it("the daily and graph reproduction classifiers count every kind of mismatch", async () => {
    const sha = (seed) => createHash("sha256").update(seed).digest("hex");
    const days = ["2026-09-23", "2026-09-24", "2026-09-25"];
    const oracle = { dailyForced: days.map((day, index) => ({ day, cohortDigest: sha(`cohort-${day}`),
      recomputedSha256: sha(`daily-${day}`), importedSha256: index === 2 ? sha(`d1-served-${day}`) : sha(`daily-${day}`),
      d1Drift: index === 2 })) };
    const faithful = () => oracle.dailyForced.map(({ d1Drift: _drift, ...head }) => ({ ...head }));
    const daily = (heads, folds = {}) => classifyDailyReproduction(oracle, { heads, foldRowsMismatch: folds.mismatch ?? 0,
      foldRowsNotComparable: folds.notComparable ?? 0 });
    const clean = { heads: 3, oracleMismatch: 0, cohortDigestMismatch: 0, unexplained: 0, d1RecomputeDrift: 1,
      foldRowsMismatch: 0, foldRowsNotComparable: 0 };
    assert.deepEqual(daily(faithful()), clean);
    const cases = [
      ["recompute differs", (heads) => { heads[0].recomputedSha256 = sha("other"); heads[0].importedSha256 = null; },
        { oracleMismatch: 1 }],
      ["cohort digest differs", (heads) => { heads[1].cohortDigest = sha("other"); }, { cohortDigestMismatch: 1 }],
      ["head missing on GCP", (heads) => { heads.splice(1, 1); }, { oracleMismatch: 1, cohortDigestMismatch: 1 }],
      ["extra head on GCP", (heads) => { heads.push({ day: "2026-09-26", cohortDigest: sha("c"), recomputedSha256: sha("r"),
        importedSha256: null }); }, { oracleMismatch: 1, cohortDigestMismatch: 1 }],
      ["GCP import differs from its recompute without D1 drift",
        (heads) => { heads[0].importedSha256 = sha("imported-other"); }, { unexplained: 1 }],
      ["GCP import differs where D1 recorded the same drift", (heads) => { heads[2].importedSha256 = sha("imported-other"); }, {}],
      ["extra head that also drifts", (heads) => { heads.push({ day: "2026-09-26", cohortDigest: sha("c"), recomputedSha256: sha("r"),
        importedSha256: sha("i") }); }, { oracleMismatch: 1, cohortDigestMismatch: 1, unexplained: 1 }],
    ];
    for (const [label, mutate, delta] of cases) {
      const heads = faithful();
      mutate(heads);
      assert.deepEqual(daily(heads), { ...clean, ...delta }, label);
    }
    assert.deepEqual(daily(faithful(), { mismatch: 2, notComparable: 3 }), { ...clean, foldRowsMismatch: 2, foldRowsNotComparable: 3 });
    assert.throws(() => daily([...faithful(), faithful()[0]]), { code: "ANALYTICS_HISTORY_ORACLE_INVALID" }, "duplicate day");
    assert.throws(() => daily(faithful(), { mismatch: -1 }), { code: "ANALYTICS_HISTORY_ORACLE_INVALID" });

    const window = analyticsHistoryGraphWindow(Date.parse("2026-09-26T06:00:00.000Z"));
    const graphOracle = { graphForced: { modelDays: window.map((day, index) => ({ day,
      recomputedSha256: index < 60 ? null : sha(`model-${day}`) })), previewSha256: sha("preview") },
    importSelection: { daily: [], preview: { sha256: sha("preview") }, modelDays: [
      { day: window[65], sha256: sha(`model-${window[65]}`) }, { day: window[66], sha256: sha("d1-served") }] } };
    const graphFaithful = () => ({ modelDays: graphOracle.graphForced.modelDays.map((entry) => ({ ...entry })),
      previewSha256: graphOracle.graphForced.previewSha256 });
    const graphClean = { modelDays: 70, oracleMismatch: 0, modelDayPresenceMismatch: 0, previewMismatch: 0, d1RecomputeDrift: 1 };
    assert.deepEqual(classifyGraphReproduction(graphOracle, graphFaithful()), graphClean);
    const graphCases = [
      ["model day differs", (gcp) => { gcp.modelDays[65].recomputedSha256 = sha("other"); }, { oracleMismatch: 1 }],
      ["model day absent on GCP", (gcp) => { gcp.modelDays[61].recomputedSha256 = null; }, { modelDayPresenceMismatch: 1 }],
      ["model day only on GCP", (gcp) => { gcp.modelDays[10].recomputedSha256 = sha("extra"); }, { modelDayPresenceMismatch: 1 }],
      ["window day missing from GCP", (gcp) => { gcp.modelDays.splice(69, 1); }, { modelDayPresenceMismatch: 1 }],
      ["day outside the window on GCP", (gcp) => { gcp.modelDays.push({ day: "2026-09-27", recomputedSha256: sha("x") }); },
        { modelDayPresenceMismatch: 1 }],
      ["preview differs", (gcp) => { gcp.previewSha256 = sha("other-preview"); }, { previewMismatch: 1 }],
      ["preview absent on GCP", (gcp) => { gcp.previewSha256 = null; }, { previewMismatch: 1 }],
    ];
    for (const [label, mutate, delta] of graphCases) {
      const gcp = graphFaithful();
      mutate(gcp);
      assert.deepEqual(classifyGraphReproduction(graphOracle, gcp), { ...graphClean, ...delta }, label);
    }
    const noPreview = { ...graphOracle, graphForced: { ...graphOracle.graphForced, previewSha256: null } };
    assert.equal(classifyGraphReproduction(noPreview, { ...graphFaithful(), previewSha256: sha("preview") }).previewMismatch, 1);
    assert.equal(classifyGraphReproduction(noPreview, { ...graphFaithful(), previewSha256: null }).previewMismatch, 0);
    assert.throws(() => classifyGraphReproduction(graphOracle, { ...graphFaithful(),
      modelDays: [...graphFaithful().modelDays, graphFaithful().modelDays[0]] }), { code: "ANALYTICS_HISTORY_ORACLE_INVALID" });
  });

  it("every oracle loop is bounded: a lane that never becomes idle is ORACLE_NOT_CONVERGED", async () => {
    let calls = 0;
    await assert.rejects(iterateOracleUntilDone(5, async () => { calls += 1; return false; }), { code: "ORACLE_NOT_CONVERGED" });
    assert.equal(calls, 5, "exactly the bound, never more");
    calls = 0;
    assert.equal(await iterateOracleUntilDone(5, async () => { calls += 1; return calls === 5; }), 5, "done on the last step");
    assert.equal(await iterateOracleUntilDone(64, async () => true), 1);
    for (const bound of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await assert.rejects(iterateOracleUntilDone(bound, async () => true), { code: "ANALYTICS_EXPORT_INPUT_INVALID" });
    }
  });
});

describe("D1 export oracle over synthetic sealed exports", () => {
  it("a quiescent fixture yields a schema-valid v2 oracle that the CLI writes atomically at 0600", async () => {
    assert.equal(cliRun.code, 0, JSON.stringify(cliRun.logs.at(-1)));
    const oracle = validateAnalyticsHistoryOracle(cliRun.oracle);
    assert.equal(oracle.schema, ANALYTICS_HISTORY_ORACLE_SCHEMA);
    assert.equal(oracle.pinnedNowMs, fixture.pinnedNowMs);
    assert.equal((await lstat(cliRun.out)).mode & 0o777, 0o600);
    assert.equal((await lstat(`${cliRun.out}.sha256`)).mode & 0o777, 0o600);
    assert.equal(await readFile(`${cliRun.out}.sha256`, "utf8"),
      `${createHash("sha256").update(cliRun.bytes).digest("hex")}\n`);
    assert.deepEqual((await readdir(root)).filter((name) => name.includes("partial")), []);
    assert.equal(oracle.moduleDigest, createHash("sha256")
      .update(await readFile(fileURLToPath(new URL("../cloud-run/d1-analytics-export-oracle.mjs", import.meta.url)))).digest("hex"));
    assert.deepEqual(oracle.foldHistory, FOLD_HISTORY);
    assert.deepEqual(oracle.quiescence, { queueRows: 0, staleHeadIdle: true, cursorSequence: fixture.journalLength,
      journalMax: fixture.journalLength, deliveredTerminal: oracle.fenceCounters.deliveredTerminalEpoch,
      sourceTerminal: oracle.fenceCounters.sourceTerminalEpoch, pendingErasureJobs: 0, cacheRetentionIncompleteDays: 0 });
    assert.ok(oracle.fenceCounters.sourceTerminalEpoch > 0, "the fixture's erasure terminal is part of the fence");
    assert.equal(oracle.fenceAuthority.sequence, fixture.journalLength);
    assert.equal(oracle.liveCohort.members, 4);
    // Every head is recomputed, and every visible MAX revision is selected.
    assert.deepEqual(oracle.dailyForced.map((entry) => entry.day),
      [fixture.days.threeDaysAgo, fixture.days.twoDaysAgo, fixture.days.yesterday, fixture.days.today]);
    assert.deepEqual(oracle.importSelection.daily.map((entry) => [entry.day, entry.revision]),
      [[fixture.days.threeDaysAgo, 2], [fixture.days.twoDaysAgo, 1], [fixture.days.yesterday, 2], [fixture.days.today, 1]]);
    assert.equal(oracle.dailyForced.filter((entry) => entry.d1Drift).length, 0);
    assert.equal(oracle.graphForced.modelDays.length, 70);
    assert.ok(oracle.graphForced.modelDays.every((entry) => entry.recomputedSha256 !== null));
    assert.notEqual(oracle.graphForced.previewSha256, null);
    assert.notEqual(oracle.importSelection.preview, null);
    assert.equal(cliRun.logs.at(-1).status, "ok");
    assert.deepEqual(cliRun.logs.filter((entry) => entry.step).map((entry) => entry.step), ["fence", "quiescence",
      "cohort", "selection", "cache_retention_resume", "daily_forced", "graph_forced", "cache_retention_rebuild"]);
    // The reproduction classifiers pass a faithful replay of the oracle itself.
    assert.deepEqual(classifyDailyReproduction(oracle, { heads: oracle.dailyForced.map((entry) => ({ day: entry.day,
      cohortDigest: entry.cohortDigest, recomputedSha256: entry.recomputedSha256, importedSha256: entry.importedSha256 })),
    foldRowsMismatch: 0, foldRowsNotComparable: 0 }), { heads: 4, oracleMismatch: 0, cohortDigestMismatch: 0,
      unexplained: 0, d1RecomputeDrift: 0, foldRowsMismatch: 0, foldRowsNotComparable: 0 });
  }, RUN_TIMEOUT_MS);

  it("the oracle output and logs contain no fixture owner digest, participant or device id", () => {
    assert.ok(fixture.privateIdentifiers.length >= 12);
    const outputs = [cliRun.bytes.toString("utf8"), JSON.stringify(cliRun.logs)];
    for (const text of outputs) {
      for (const identifier of fixture.privateIdentifiers) assert.ok(!text.includes(identifier));
      assert.ok(!text.includes(root), "no scratch path");
    }
  });

  it("the forced recomputes are deterministic across two fresh scratch runs", async () => {
    const second = await runOracle(await scratch("determinism"));
    assert.deepEqual(second, cliRun.oracle);
  }, RUN_TIMEOUT_MS);

  it("a model day whose inputs changed after publication records D1 drift instead of refusing", async () => {
    const oracle = cliRun.oracle;
    const recomputed = new Map(oracle.graphForced.modelDays.map((entry) => [entry.day, entry.recomputedSha256]));
    const imported = new Map(oracle.importSelection.modelDays.map((entry) => [entry.day, entry.sha256]));
    // Yesterday's model day was published before a new owner joined and an
    // existing owner restated it; D1 keeps serving it, the recompute differs.
    assert.ok(imported.has(fixture.days.yesterday));
    assert.notEqual(imported.get(fixture.days.yesterday), recomputed.get(fixture.days.yesterday));
    const counts = classifyGraphReproduction(oracle, { modelDays: oracle.graphForced.modelDays,
      previewSha256: oracle.graphForced.previewSha256 });
    assert.equal(counts.oracleMismatch, 0);
    assert.equal(counts.modelDayPresenceMismatch, 0);
    assert.equal(counts.previewMismatch, 0);
    assert.ok(counts.d1RecomputeDrift >= 1);
    assert.equal(counts.modelDays, 70);
  });

  it("a daily day edited on disk to differ from its recompute is recorded as d1Drift", async () => {
    const day = fixture.days.twoDaysAgo;
    const edited = await runOracle(await scratch("daily-drift", async ({ analytics }) => {
      dropPublicationGuard(analytics);
      const head = headRow(analytics, day);
      const payload = JSON.parse(head.payload_json);
      payload.totals.usageEvents += 1000;
      const payloadJson = canonicalJson(payload);
      analytics.prepare("UPDATE analytics_community_daily_publications SET payload_json=?,payload_sha256=? WHERE day=? AND revision=?")
        .run(payloadJson, await sha256Hex(payloadJson), day, head.revision);
    }));
    const byDay = new Map(edited.dailyForced.map((entry) => [entry.day, entry]));
    const baseline = new Map(cliRun.oracle.dailyForced.map((entry) => [entry.day, entry]));
    assert.equal(byDay.get(day).d1Drift, true);
    assert.notEqual(byDay.get(day).importedSha256, byDay.get(day).recomputedSha256);
    assert.equal(byDay.get(day).recomputedSha256, baseline.get(day).recomputedSha256, "the recompute ignores the edit");
    assert.deepEqual(edited.dailyForced.filter((entry) => entry.d1Drift).map((entry) => entry.day), [day]);
    // Recorded, never refused; and a GCP port reproducing D1 is not unexplained.
    assert.deepEqual(classifyDailyReproduction(edited, { heads: edited.dailyForced.map((entry) => ({ day: entry.day,
      cohortDigest: entry.cohortDigest, recomputedSha256: entry.recomputedSha256, importedSha256: entry.importedSha256 })),
    foldRowsMismatch: 0, foldRowsNotComparable: 0 }).unexplained, 0);
  }, RUN_TIMEOUT_MS);

  it("import selection excludes a day whose MAX revision is contained, never falls back, and keeps its head", async () => {
    const day = fixture.days.yesterday;
    let terminal;
    const paths = await scratch("contained", ({ analytics }) => {
      dropPublicationGuard(analytics);
      const latest = headRow(analytics, day);
      assert.equal(latest.revision, 2);
      const pin = JSON.parse(latest.authority_json);
      terminal = pin.publicAuthorityEpoch + 1;
      // Containment newer than the MAX revision's pin, and an OLDER revision
      // doctored to look visible: selection must not fall back to it.
      analytics.prepare("INSERT INTO analytics_community_daily_containment VALUES(?,?,?,?)")
        .run(fixture.sourceId, day, "c".repeat(64), terminal);
      // Retirement already removed the superseded revision 1; restore one
      // whose pin clears the containment, bypassing the revision-order and
      // head triggers so the head stays at revision 2.
      analytics.exec("DROP TRIGGER analytics_community_daily_revision_order");
      analytics.exec("DROP TRIGGER analytics_community_daily_head_advance");
      const current = analytics.prepare("SELECT * FROM analytics_community_daily_publications WHERE day=? AND revision=2").get(day);
      analytics.prepare(`INSERT INTO analytics_community_daily_publications
        (source_id,day,revision,cohort_digest,authority_json,payload_json,payload_sha256,released_at) VALUES(?,?,1,?,?,?,?,?)`)
        .run(current.source_id, day, current.cohort_digest, canonicalJson({ ...pin, publicAuthorityEpoch: terminal }),
          current.payload_json, current.payload_sha256, current.released_at);
    });
    const db = open(paths);
    try {
      const selection = await readD1AnalyticsImportSelection({ source: db.ingestion, target: db.analytics,
        sourceId: fixture.sourceId, sourceNamespace: fixture.sourceNamespace, pinnedNowMs: fixture.pinnedNowMs });
      assert.deepEqual(selection.daily.map((entry) => entry.day),
        [fixture.days.threeDaysAgo, fixture.days.twoDaysAgo, fixture.days.today]);
      assert.ok(selection.daily.every((entry) => entry.revision
        === cliRun.oracle.importSelection.daily.find((other) => other.day === entry.day).revision));
      assert.deepEqual(selection.heads.find((head) => head.day === day), { day, revision: 2 });
      assert.equal(selection.heads.length, 4);
    } finally {
      db.close();
    }
    // The full oracle refuses the doctored copy: a contained head is stale.
    const error = await refusal(paths);
    assert.equal(error.code, "ANALYTICS_EXPORT_NOT_QUIESCENT");
    assert.deepEqual(error.reasons, ["stale_head"]);
  }, RUN_TIMEOUT_MS);

  it("each non-quiescent condition refuses with ANALYTICS_EXPORT_NOT_QUIESCENT", async () => {
    const cases = [
      ["queue row", ["queue_rows"], ({ analytics }) => {
        analytics.prepare("INSERT INTO analytics_community_daily_queue VALUES(?,?,1)").run(fixture.sourceId, fixture.days.today);
      }],
      ["cursor below the journal MAX", ["cursor_not_at_journal_max"], ({ analytics }) => {
        analytics.prepare("UPDATE analytics_source_cursors SET sequence=sequence-1 WHERE source_id=?").run(fixture.sourceId);
      }],
      ["cursor receipt differing from its journal row", ["cursor_receipt"], ({ analytics }) => {
        analytics.exec("DROP TRIGGER analytics_delivery_immutable");
        analytics.prepare(`UPDATE analytics_applied_events SET content_digest=? WHERE source_id=?
          AND sequence=(SELECT sequence FROM analytics_source_cursors WHERE source_id=?)`)
          .run("0".repeat(64), fixture.sourceId, fixture.sourceId);
      }],
      ["delivered terminal below the source terminal", ["terminal_undelivered"], ({ analytics }) => {
        analytics.exec("DROP TRIGGER analytics_terminal_watermark_monotonic");
        analytics.prepare(`UPDATE analytics_community_terminal_watermarks
          SET terminal_public_authority_epoch=terminal_public_authority_epoch-1 WHERE source_id=?`).run(fixture.sourceId);
      }],
      ["pending erasure job", ["erasure_jobs_pending"], ({ ledger }) => {
        // The Worker's own reopen transition for a completed job.
        assert.equal(ledger.prepare("UPDATE storage_erasure_jobs SET state='pending',completed_at=NULL").run().changes, 1);
      }],
      ["stale head (a publication lacking dailyDeviceMethod)", ["stale_head"], ({ analytics }) => {
        dropPublicationGuard(analytics);
        const head = headRow(analytics, fixture.days.today);
        const pin = JSON.parse(head.authority_json);
        delete pin.dailyDeviceMethod;
        analytics.prepare("UPDATE analytics_community_daily_publications SET authority_json=? WHERE day=? AND revision=?")
          .run(canonicalJson(pin), fixture.days.today, head.revision);
      }],
      ["incomplete cache-retention day", ["cache_retention_incomplete"], ({ analytics }) => {
        const mark = analytics.prepare("SELECT mark_key FROM analytics_cache_retention_day_marks ORDER BY day DESC,mark_key LIMIT 1").get();
        const values = analytics.prepare("SELECT value_key FROM analytics_cache_retention_day_values WHERE mark_key=?")
          .all(mark.mark_key).map((row) => row.value_key);
        analytics.prepare("DELETE FROM analytics_cache_retention_day_marks WHERE mark_key=?").run(mark.mark_key);
        analytics.prepare("DELETE FROM analytics_cache_retention_day_values WHERE mark_key=?").run(mark.mark_key);
        for (const value of values) analytics.prepare("DELETE FROM analytics_cache_retention_day_bands WHERE value_key=?").run(value);
        analytics.prepare("DELETE FROM analytics_cache_retention_day_carry WHERE mark_key=?").run(mark.mark_key);
      }],
    ];
    for (const [label, reasons, doctor] of cases) {
      const error = await refusal(await scratch(`refuse-${reasons[0]}`, doctor));
      assert.equal(error.code, "ANALYTICS_EXPORT_NOT_QUIESCENT", label);
      assert.deepEqual(error.reasons, reasons, label);
    }
  }, RUN_TIMEOUT_MS);

  it("the CLI refuses a non-quiescent export and leaves no output or partial file", async () => {
    const paths = await scratch("cli-refused", ({ analytics }) => {
      analytics.prepare("INSERT INTO analytics_community_daily_queue VALUES(?,?,1)").run(fixture.sourceId, fixture.days.today);
    });
    const inventory = join(root, "inventory-refused.json");
    // The inventory seals the doctored copies, so the refusal is the oracle's own.
    const d1 = {};
    for (const [name, path] of Object.entries(paths)) d1[name] = { sealedSha256: await fileSha256(path) };
    await writeFile(inventory, JSON.stringify({ schema: "analytics-cutover-inventory-v2",
      drain: { quiescentAtMs: fixture.pinnedNowMs }, cacheRetention: { fromDay: null }, foldHistory: [], d1 }));
    const out = join(root, "oracle-refused.json");
    const logs = [];
    assert.equal(await runD1AnalyticsExportOracleCli({ argv: cliArgv(paths, inventory, out),
      log: (entry) => logs.push(entry) }), 1);
    assert.deepEqual(logs.at(-1), { event: "d1_analytics_export_oracle", status: "refused",
      code: "ANALYTICS_EXPORT_NOT_QUIESCENT", reasons: ["queue_rows"] });
    assert.equal(await lstat(out).catch(() => null), null);
    assert.equal(await lstat(`${out}.sha256`).catch(() => null), null);
    assert.deepEqual((await readdir(root)).filter((name) => name.includes("partial")), []);
  }, RUN_TIMEOUT_MS);

  it("the graph recompute runs with the fold off: no ':fits-1' or ':model-1' checkpoint namespace", async () => {
    const methods = (paths) => {
      const analytics = new DatabaseSync(paths.analytics, { readOnly: true });
      try {
        return analytics.prepare("SELECT DISTINCT method FROM analytics_history_checkpoint_stages").all().map((row) => row.method);
      } finally {
        analytics.close();
      }
    };
    const written = methods(cliRun.paths);
    assert.ok(written.length > 0, "the v1.1 owner's graph work wrote checkpoints");
    assert.ok(written.every((method) => !method.endsWith(":fits-1") && !method.endsWith(":model-1")));
    // Control: the same lane with the fold on writes the prepared-fold
    // namespaces, so the assertion above would catch preparedFold:true.
    const control = await scratch("fold-control", ({ analytics }) => {
      for (const table of ["analytics_history_checkpoint_heads", "analytics_history_checkpoint_parts",
        "analytics_history_checkpoint_stages", "analytics_community_graph_results", "analytics_community_graph_execution",
        "analytics_community_graph_scan", "analytics_community_graph_work_selection"]) analytics.exec(`DELETE FROM ${table}`);
    });
    const db = open(control);
    try {
      for (let step = 0; step < 24; step += 1) {
        await advanceStorageCommunityGraphWork({ source: db.ingestion, target: db.analytics, sourceId: fixture.sourceId,
          sourceNamespace: fixture.sourceNamespace, nowMs: fixture.pinnedNowMs, preparedFold: true });
      }
    } finally {
      db.close();
    }
    assert.ok(methods(control).some((method) => method.endsWith(":fits-1") || method.endsWith(":model-1")));
  }, RUN_TIMEOUT_MS);

  it("retirement uses the pinned nowMs: a wall clock 30 days later retires nothing extra", async () => {
    const paths = await scratch("wall-clock");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fixture.pinnedNowMs + 30 * DAY_MS);
    try {
      const later = await runOracle(paths);
      assert.deepEqual(later.graphForced, cliRun.oracle.graphForced);
      assert.deepEqual(later.importSelection, cliRun.oracle.importSelection);
      assert.deepEqual(later, cliRun.oracle);
      // Control: the Worker's retirement at that wall clock would retire the
      // oldest window days, so the equality above is not vacuous.
      const db = open(paths);
      try {
        const retired = await retireStorageCommunityGraphPublications({ source: db.ingestion, target: db.analytics,
          sourceId: fixture.sourceId, sourceNamespace: fixture.sourceNamespace });
        assert.ok(retired > 0);
      } finally {
        db.close();
      }
    } finally {
      vi.useRealTimers();
    }
  }, RUN_TIMEOUT_MS);

  it("the cache-retention resume and rebuild use the supplied fromDay", async () => {
    const analytics = new DatabaseSync(fixture.paths.analytics, { readOnly: true });
    const markedDays = analytics.prepare("SELECT DISTINCT day FROM analytics_cache_retention_day_marks ORDER BY day").all()
      .map((row) => row.day);
    analytics.close();
    assert.ok(markedDays.some((day) => day < fixture.days.today), "the fixture retains days before the chosen fromDay");
    const fromToday = await runOracle(await scratch("from-day"), { cacheRetentionFromDay: fixture.days.today });
    assert.equal(fromToday.cacheRetention.fromDay, fixture.days.today);
    assert.equal(cliRun.oracle.cacheRetention.fromDay, null);
    // Resume starts from the exported rows, which are complete for any fromDay.
    assert.equal(fromToday.cacheRetention.resumeSeriesSha256, cliRun.oracle.cacheRetention.resumeSeriesSha256);
    assert.notEqual(fromToday.cacheRetention.rebuildSeriesSha256, cliRun.oracle.cacheRetention.rebuildSeriesSha256);
    assert.notEqual(fromToday.cacheRetention.rebuildTableSha256.analytics_cache_retention_day_marks,
      cliRun.oracle.cacheRetention.rebuildTableSha256.analytics_cache_retention_day_marks);
    assert.deepEqual(fromToday.dailyForced, cliRun.oracle.dailyForced);
  }, RUN_TIMEOUT_MS);

  it("the resume pass and the quiescence probe honour fromDay: days before it are never built", async () => {
    const fromDay = fixture.days.yesterday;
    const removed = fixture.days.twoDaysAgo;
    assert.ok(removed < fromDay);
    const paths = await scratch("from-day-gap", ({ analytics }) => removeCacheRetentionDay(analytics, removed));
    // The doctored copy's own series at the pinned instant, before any lane runs.
    const db = open(paths, { readOnly: true });
    let ownSeries;
    try {
      ownSeries = await sha256Hex(canonicalJson(await readCacheRetentionCommunitySeries({ target: db.analytics,
        sourceId: fixture.sourceId, nowMs: fixture.pinnedNowMs })));
    } finally {
      db.close();
    }
    assert.notEqual(ownSeries, cliRun.oracle.cacheRetention.resumeSeriesSha256, "the removed day is part of the series");
    const oracle = await runOracle(paths, { cacheRetentionFromDay: fromDay });
    assert.equal(oracle.quiescence.cacheRetentionIncompleteDays, 0, "the probe ignores days before fromDay");
    assert.equal(oracle.cacheRetention.resumeSeriesSha256, ownSeries, "the resume pass built nothing before fromDay");
    assert.equal(oracle.cacheRetention.fromDay, fromDay);
    // Without fromDay the same gap is an incomplete day.
    const error = await refusal(await scratch("from-day-gap-null", ({ analytics }) => removeCacheRetentionDay(analytics, removed)));
    assert.equal(error.code, "ANALYTICS_EXPORT_NOT_QUIESCENT");
    assert.deepEqual(error.reasons, ["cache_retention_incomplete"]);
  }, RUN_TIMEOUT_MS);

  it("import selection omits a model day D1 withholds, and the forced graph recompute replaces it", async () => {
    const day = fixture.days.threeDaysAgo;
    const baseline = cliRun.oracle;
    assert.ok(baseline.importSelection.modelDays.some((entry) => entry.day === day));
    const terminal = Math.max(baseline.fenceCounters.sourceTerminalEpoch, baseline.fenceCounters.deliveredTerminalEpoch);
    const paths = await scratch("model-withheld", ({ analytics }) => {
      // Containment newer than the model day's pin: D1 no longer serves it,
      // and retirement (at most four rows a call) has not removed it yet.
      analytics.exec("DROP TRIGGER analytics_model_authority_update");
      const row = analytics.prepare("SELECT authority_json FROM analytics_community_model_publications WHERE source_id=? AND day=?")
        .get(fixture.sourceId, day);
      const pin = JSON.parse(row.authority_json);
      assert.ok(pin.publicAuthorityEpoch >= terminal && terminal >= 1);
      assert.equal(analytics.prepare("UPDATE analytics_community_model_publications SET authority_json=? WHERE source_id=? AND day=?")
        .run(canonicalJson({ ...pin, publicAuthorityEpoch: terminal - 1 }), fixture.sourceId, day).changes, 1);
    });
    const expectedModelDays = baseline.importSelection.modelDays.filter((entry) => entry.day !== day);
    const db = open(paths, { readOnly: true });
    try {
      const selection = await readD1AnalyticsImportSelection({ source: db.ingestion, target: db.analytics,
        sourceId: fixture.sourceId, sourceNamespace: fixture.sourceNamespace, pinnedNowMs: fixture.pinnedNowMs });
      assert.deepEqual(selection.modelDays, expectedModelDays);
    } finally {
      db.close();
    }
    const oracle = await runOracle(paths);
    assert.deepEqual(oracle.importSelection.modelDays, expectedModelDays);
    assert.deepEqual(oracle.graphForced, baseline.graphForced, "the withheld row never reaches graphForced");
    assert.deepEqual(oracle.dailyForced, baseline.dailyForced);
  }, RUN_TIMEOUT_MS);

  it("the forced daily recompute deletes the exported folds instead of reusing them", async () => {
    const day = fixture.days.yesterday;
    const paths = await scratch("fold-edited", ({ analytics }) => {
      const fold = analytics.prepare(`SELECT owner_digest,values_json FROM analytics_community_daily_owners
        WHERE source_id=? AND day=? AND complete=1 AND json_array_length(values_json,'$.cells')>0
        ORDER BY owner_digest LIMIT 1`).get(fixture.sourceId, day);
      const values = JSON.parse(fold.values_json);
      const tokens = values.cells[0].tokens.inputCacheReadTokens;
      tokens.knownSum = String(BigInt(tokens.knownSum) + 1_000_000n);
      // Revisions, method and completeness stay current: only a recompute
      // from the ingestion source can tell the fold is wrong.
      assert.equal(analytics.prepare("UPDATE analytics_community_daily_owners SET values_json=? WHERE source_id=? AND day=? AND owner_digest=?")
        .run(JSON.stringify(values), fixture.sourceId, day, fold.owner_digest).changes, 1);
    });
    const edited = await runOracle(paths);
    assert.deepEqual(edited.dailyForced, cliRun.oracle.dailyForced);
  }, RUN_TIMEOUT_MS);

  it("the live cohort digest does not depend on the owner page size", async () => {
    const db = open(await scratch("cohort-pages"), { readOnly: true });
    try {
      for (const pageSize of [1, 2, 3, 4, 5, 64]) {
        assert.deepEqual(await readD1AnalyticsLiveCohort(db.ingestion, pageSize), cliRun.oracle.liveCohort, `page ${pageSize}`);
      }
      for (const pageSize of [0, 65, 1.5]) {
        await assert.rejects(readD1AnalyticsLiveCohort(db.ingestion, pageSize), { code: "ANALYTICS_EXPORT_INPUT_INVALID" });
      }
    } finally {
      db.close();
    }
  }, RUN_TIMEOUT_MS);

  it("SQLite's own clock is pinned: v1.2 authority is judged at pinnedNowMs, never when the oracle runs", async () => {
    // The Worker's owner page scopes v1.2 authority with SQLite's 'now': a
    // live lease counts only through the active-authorization view (which a
    // staged runtime empties), an expired one through the retained branch.
    // Synthetic scratch state: a staged v1.2 runtime and an eligible v1.2
    // owner whose whole lease (ledger, owner, credential and grants) expires
    // one millisecond after the drain instant. At the pinned instant the
    // lease is live, so the owner holds no v1.2 authority; by the wall clock
    // it has expired and would be retained, flipping hasV12 and the cohort.
    const expiresAt = new Date(fixture.pinnedNowMs + 1).toISOString();
    const paths = await scratch("clock-lease", ({ ingestion }) => {
      ingestion.exec("PRAGMA ignore_check_constraints=ON");
      const lease = ingestion.prepare(`SELECT enrollment_device_id AS enrollment,device_credential_id AS credential
        FROM accountless_v12_device_authorizations`).all();
      assert.equal(lease.length, 1);
      const [{ enrollment, credential }] = lease;
      for (const table of ["accountless_v12_device_authorizations", "accountless_v11_device_authorizations",
        "accountless_enrollment_ledger", "accountless_upload_owners", "device_credentials"]) dropTriggers(ingestion, table);
      assert.equal(ingestion.prepare("UPDATE telemetry_v12_runtime SET state='staged' WHERE id=1").run().changes, 1);
      assert.equal(ingestion.prepare(`UPDATE accountless_v12_device_authorizations SET authorized_at=?,expires_at=?
        WHERE enrollment_device_id=?`).run(new Date(fixture.pinnedNowMs - DAY_MS).toISOString(), expiresAt, enrollment).changes, 1);
      ingestion.prepare("UPDATE accountless_v11_device_authorizations SET expires_at=? WHERE enrollment_device_id=?")
        .run(expiresAt, enrollment);
      assert.equal(ingestion.prepare("UPDATE accountless_enrollment_ledger SET expires_at=? WHERE device_id=?")
        .run(expiresAt, enrollment).changes, 1);
      assert.equal(ingestion.prepare("UPDATE accountless_upload_owners SET expires_at=? WHERE enrollment_device_id=?")
        .run(expiresAt, enrollment).changes, 1);
      assert.equal(ingestion.prepare("UPDATE device_credentials SET expires_at=? WHERE id=?").run(expiresAt, credential).changes, 1);
    });
    assert.ok(Date.now() > fixture.pinnedNowMs + 1);
    const v12Owners = async (pinnedNowMs) => {
      const db = open(paths, { pinnedNowMs, readOnly: true });
      try {
        const page = await readStorageCommunityOwnerPage(db.ingestion);
        return { members: page.length, hasV12: page.filter((owner) => owner.hasV12).length,
          cohort: await readD1AnalyticsLiveCohort(db.ingestion) };
      } finally {
        db.close();
      }
    };
    const pinned = await v12Owners(fixture.pinnedNowMs);
    const wallClock = await v12Owners(null);
    assert.equal(pinned.members, 4, "the owner stays eligible: eligibility reads no clock");
    assert.equal(wallClock.members, 4);
    assert.equal(pinned.hasV12, 0, "a live lease under a staged runtime grants nothing");
    assert.equal(wallClock.hasV12, 1, "the wall clock would retain the expired lease");
    assert.notDeepEqual(pinned.cohort, wallClock.cohort);
    // The pristine export at the pinned instant: the active runtime authorizes the owner.
    const pristine = open(await scratch("clock-pristine"), { readOnly: true });
    try {
      assert.equal((await readStorageCommunityOwnerPage(pristine.ingestion)).filter((owner) => owner.hasV12).length, 1);
    } finally {
      pristine.close();
    }
    // The oracle itself refuses bindings whose SQLite clock is not pinned to it.
    const unpinnedPaths = await scratch("clock-unpinned");
    for (const openOptions of [{ pinnedNowMs: null }, { pinnedNowMs: fixture.pinnedNowMs + 1 }]) {
      const error = await refusal(unpinnedPaths, {}, openOptions);
      assert.equal(error.code, "ANALYTICS_EXPORT_CLOCK_UNPINNED");
    }
  }, RUN_TIMEOUT_MS);

  it("the CLI refuses scratch copies an earlier run already consumed", async () => {
    // Run A's copies now hold the oracle's own bump, recomputes and rebuilds.
    const out = join(root, "oracle-rerun.json");
    const logs = [];
    assert.equal(await runD1AnalyticsExportOracleCli({ argv: cliArgv(cliRun.paths, cliRun.inventory, out),
      log: (entry) => logs.push(entry) }), 1);
    assert.deepEqual(logs.at(-1), { event: "d1_analytics_export_oracle", status: "failed", code: "ORACLE_INPUT_SEAL_MISMATCH" });
    assert.equal(await lstat(out).catch(() => null), null);
    assert.notEqual(await fileSha256(cliRun.paths.ingestion), await fileSha256(fixture.paths.ingestion));
    assert.equal(await fileSha256(cliRun.paths.ledger), await fileSha256(fixture.paths.ledger), "the ledger is only read");
  }, RUN_TIMEOUT_MS);

  it("refuses a second source, a foreign namespace, an inconsistent head and a concurrent run", async () => {
    const twoSources = await scratch("two-sources", ({ analytics }) => {
      analytics.prepare("INSERT INTO analytics_runtime_sources(source_id,source_namespace,contract_version) VALUES(?,?,1)")
        .run("synthetic-second-source", fixture.sourceNamespace);
    });
    assert.equal((await refusal(twoSources)).code, "ANALYTICS_EXPORT_SCHEMA_INVALID");
    const pristine = await scratch("foreign-namespace");
    assert.equal((await refusal(pristine, { sourceNamespace: "synthetic-other-namespace" })).code,
      "ANALYTICS_EXPORT_IDENTITY_MISMATCH");
    assert.equal(await fileSha256(pristine.analytics), await fileSha256(fixture.paths.analytics), "refused before any write");
    // A head behind its day's MAX publication revision is an integrity failure.
    const behind = await scratch("head-behind", ({ analytics }) => {
      dropTriggers(analytics, "analytics_community_daily_publications");
      const head = headRow(analytics, fixture.days.today);
      const current = analytics.prepare("SELECT * FROM analytics_community_daily_publications WHERE day=? AND revision=?")
        .get(fixture.days.today, head.revision);
      analytics.prepare(`INSERT INTO analytics_community_daily_publications
        (source_id,day,revision,cohort_digest,authority_json,payload_json,payload_sha256,released_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(current.source_id, current.day, head.revision + 1, current.cohort_digest, current.authority_json,
          current.payload_json, current.payload_sha256, current.released_at);
    });
    const db = open(behind, { readOnly: true });
    try {
      await assert.rejects(readD1AnalyticsImportSelection({ source: db.ingestion, target: db.analytics,
        sourceId: fixture.sourceId, sourceNamespace: fixture.sourceNamespace, pinnedNowMs: fixture.pinnedNowMs }),
      { code: "ANALYTICS_EXPORT_INTEGRITY_FAILED" });
    } finally {
      db.close();
    }
    // One oracle per process: the pinned JavaScript clock is process-wide.
    const first = await scratch("busy-first", ({ analytics }) => {
      analytics.prepare("INSERT INTO analytics_community_daily_queue VALUES(?,?,1)").run(fixture.sourceId, fixture.days.today);
    });
    const second = await scratch("busy-second");
    const running = runOracle(first);
    await assert.rejects(runOracle(second), { code: "ORACLE_BUSY" });
    await assert.rejects(running, { code: "ANALYTICS_EXPORT_NOT_QUIESCENT" });
    assert.ok(Math.abs(Date.now() - fixture.pinnedNowMs) > 0 && Date.now() > fixture.pinnedNowMs, "the clock is restored");
    assert.equal((await runOracle(second)).pinnedNowMs, fixture.pinnedNowMs, "the next run proceeds");
  }, RUN_TIMEOUT_MS);
});
