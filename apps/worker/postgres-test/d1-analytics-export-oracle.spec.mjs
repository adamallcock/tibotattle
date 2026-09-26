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
  ANALYTICS_HISTORY_ORACLE_SCHEMA,
  classifyDailyReproduction,
  classifyGraphReproduction,
  normalizedDailyPayloadSha256,
  normalizedModelDaySha256,
  normalizedPreviewSha256,
  validateAnalyticsHistoryOracle,
} from "../src/analytics-history-proof.ts";
import { readD1AnalyticsImportSelection, runD1AnalyticsExportOracle } from "../src/d1-analytics-export-oracle.ts";
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

function open(paths) {
  const handles = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, openSealedSqliteD1(path)]));
  return {
    ...Object.fromEntries(Object.entries(handles).map(([name, handle]) => [name, handle.database])),
    close() { for (const handle of Object.values(handles)) handle.close(); },
  };
}

async function runOracle(paths, overrides = {}) {
  const db = open(paths);
  try {
    return await runD1AnalyticsExportOracle({ ingestion: db.ingestion, analytics: db.analytics, ledger: db.ledger,
      pinnedNowMs: fixture.pinnedNowMs, sourceId: fixture.sourceId, sourceNamespace: fixture.sourceNamespace,
      cacheRetentionFromDay: null, foldHistory: FOLD_HISTORY, moduleDigest: cliRun.oracle.moduleDigest, ...overrides });
  } finally {
    db.close();
  }
}

async function refusal(paths) {
  try {
    await runOracle(paths);
  } catch (error) {
    return error;
  }
  assert.fail("the oracle accepted a non-quiescent export");
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
  await writeFile(inventory, JSON.stringify({ schema: "analytics-cutover-inventory-v2",
    drain: { fencedAtMs: fixture.pinnedNowMs - 60_000, quiescentAtMs: fixture.pinnedNowMs },
    cacheRetention: { fromDay: null }, foldHistory: FOLD_HISTORY }));
  const out = join(root, "oracle.json");
  const logs = [];
  const code = await runD1AnalyticsExportOracleCli({ argv: ["--ingestion", paths.ingestion, "--analytics", paths.analytics,
    "--ledger", paths.ledger, "--pinned-now-ms", String(fixture.pinnedNowMs), "--inventory", inventory, "--out", out],
  log: (entry) => logs.push(entry) });
  const bytes = code === 0 ? await readFile(out) : null;
  cliRun = { code, logs, out, paths, bytes, oracle: bytes === null ? null : JSON.parse(bytes) };
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
    await writeFile(inventory, JSON.stringify({ schema: "analytics-cutover-inventory-v2",
      drain: { quiescentAtMs: fixture.pinnedNowMs }, cacheRetention: { fromDay: null }, foldHistory: [] }));
    const out = join(root, "oracle-refused.json");
    const logs = [];
    assert.equal(await runD1AnalyticsExportOracleCli({ argv: ["--ingestion", paths.ingestion, "--analytics", paths.analytics,
      "--ledger", paths.ledger, "--pinned-now-ms", String(fixture.pinnedNowMs), "--inventory", inventory, "--out", out],
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
});
