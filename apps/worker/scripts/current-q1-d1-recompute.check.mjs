import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  assertCurrentQ1ControlTransition,
  assertCurrentQ1SourceUnchanged,
  advanceCurrentQ1CachePass,
  captureCurrentQ1SourceInvariant,
  proveCurrentQ1StrictExportRefusal,
  runCurrentQ1DailyConvergence,
  runCurrentQ1DailyPass,
  validateCurrentQ1Recomputation,
} from "../postgres-test/fixtures/current-q1-d1-recompute.mjs";
import {
  CURRENT_Q1_REFERENCE_NOW_MS,
  CURRENT_Q1_REFERENCE_SOURCE_ID,
  assertCurrentQ1BindingScratchIdentity,
  assessCurrentQ1ReferenceCompleteness,
  buildCurrentQ1AdmissionIdentities,
  closeCurrentQ1BindingScratch,
  finishCurrentQ1ReferenceBindingCapture,
  validateCurrentQ1Admissions,
  validateCurrentQ1NativeEvidence,
  validateCurrentQ1ReferenceBinding,
  probeCurrentQ1MissingScopes,
} from "../postgres-test/fixtures/current-q1-d1-reference.mjs";

const DAY_MS = 86_400_000;
const ALL_DAYS = Array.from({ length: 170 }, (_, index) =>
  new Date(Date.parse("2026-04-15") + index * DAY_MS).toISOString().slice(0, 10));
const CONFLICT_DAYS = [ALL_DAYS[1], ALL_DAYS[2]];
const EXPECTED_DAILY_DAYS = ALL_DAYS.filter((day) => !CONFLICT_DAYS.includes(day));
const CORPUS = { expectedDailyDays: EXPECTED_DAILY_DAYS, conflictDays: CONFLICT_DAYS };
const FAILURE = { code: "CURRENT_Q1_NOT_SETTLED" };

function sequencedAdvance(steps) {
  const remaining = structuredClone(steps);
  const calls = [];
  return {
    calls,
    advance: async (options) => {
      calls.push(structuredClone(options));
      assert.ok(remaining.length > 0, "the scheduler requested an unprovided step");
      return remaining.shift();
    },
  };
}

function dailyPass(advance, { bound = 16, preferStaleHead = false } = {}) {
  return runCurrentQ1DailyPass({ ...CORPUS, advance, bound, preferStaleHead });
}

function deferredConflict(day) {
  return { state: "deferred", reason: "projection_pending", ownersAdvanced: 0, day };
}

function refusedError(P, reasons = ["queue_rows"]) {
  return new P.D1AnalyticsExportOracleError("ANALYTICS_EXPORT_NOT_QUIESCENT", reasons);
}

function oracleContext(runD1AnalyticsExportOracle) {
  class D1AnalyticsExportOracleError extends Error {
    constructor(code, reasons) {
      super(code);
      this.code = code;
      this.reasons = reasons;
    }
  }
  return {
    P: { D1AnalyticsExportOracleError, runD1AnalyticsExportOracle },
    ingestion: {}, analytics: {}, ledger: {}, nowMs: Date.UTC(2026, 9, 13),
    sourceId: "synthetic-source", sourceNamespace: "synthetic-namespace",
  };
}

function createDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE collection_controls (
      id INTEGER PRIMARY KEY,
      revision INTEGER NOT NULL,
      reason_code TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      enrollment INTEGER NOT NULL,
      uploadRegistration INTEGER NOT NULL,
      processing INTEGER NOT NULL,
      publication INTEGER NOT NULL,
      state TEXT NOT NULL,
      schemaVersion INTEGER NOT NULL
    );
    INSERT INTO collection_controls VALUES
      (1, 3, 'initial', '2026-10-12T12:00:00.000Z', 1, 1, 1, 1, 'active', 1);
    CREATE TABLE admin_action_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL UNIQUE,
      action TEXT NOT NULL,
      actor_identity_digest TEXT NOT NULL,
      outcome TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE source_records (id INTEGER PRIMARY KEY, payload BLOB, note TEXT);
    INSERT INTO source_records VALUES (1, X'00ff10', NULL);
    CREATE TABLE future_auxiliary (kind TEXT, payload BLOB);
    INSERT INTO future_auxiliary VALUES ('opaque', X'ff0001');
    CREATE TABLE future_empty (key TEXT PRIMARY KEY, value TEXT);
    CREATE INDEX source_records_note_idx ON source_records(note);
  `);
  const database = {
    prepare(sql) {
      let parameters = [];
      return {
        bind(...values) { parameters = values; return this; },
        all() { return { results: db.prepare(sql).all(...parameters) }; },
      };
    },
  };
  return { db, database };
}

async function capture(database) {
  return captureCurrentQ1SourceInvariant(database);
}

function controls(revision) {
  return {
    revision, state: "active", enrollment: true, uploadRegistration: true,
    processing: true, publication: true, schemaVersion: 1,
  };
}

function recomputationFixture() {
  const importedSha = "c".repeat(64);
  const cacheTables = ["analytics_cache_retention_day_marks", "analytics_cache_retention_day_progress",
    "analytics_cache_retention_day_values", "analytics_cache_retention_day_bands",
    "analytics_cache_retention_day_carry"];
  return {
    schemaVersion: "current-q1-d1-recomputation-v1", actual: true,
    liveCohort: { members: 4, sha256: "a".repeat(64) },
    importSelection: {
      daily: EXPECTED_DAILY_DAYS.map((day) => ({ day, revision: 1, sha256: importedSha })),
      modelDays: [], preview: null,
    },
    dailyForced: EXPECTED_DAILY_DAYS.map((day) => ({ day, cohortDigest: "b".repeat(64),
      recomputedSha256: importedSha, importedSha256: importedSha, d1Drift: false })),
    graphForced: {
      modelDays: Array.from({ length: 70 }, (_, index) => ({
        day: new Date(Date.parse("2026-10-01") - (69 - index) * DAY_MS).toISOString().slice(0, 10),
        recomputedSha256: "d".repeat(64),
      })),
      previewSha256: null,
    },
    cacheRetention: { fromDay: null, resumeSeriesSha256: "e".repeat(64), rebuildSeriesSha256: "f".repeat(64),
      rebuildTableSha256: Object.fromEntries(cacheTables.map((table) => [table, "1".repeat(64)])) },
    collectionRevision: { before: 3, after: 4 },
    sourceInvariantSha256: { before: "2".repeat(64), after: "2".repeat(64) },
    invocations: { daily: 2, graph: 30, cacheResume: 1, cacheRebuild: 1 },
    controlTransition: { beforeSha256: "3".repeat(64), afterSha256: "4".repeat(64),
      auditRowsBefore: 0, auditRowsAfter: 1, auditSequenceBefore: 0, auditSequenceAfter: 1 },
    graphExecution: { state: "converged", reason: "quiet_rotation", iterations: 30, quiet: 30, rotation: 30 },
  };
}

const BOUNDS = { bootstrap: 64, settleRounds: 8, delivery: 512, daily: 256, dailyConvergence: 4096,
  forcedDailyPerHead: 64, dailyRetirement: 16, cachePasses: 4096, nativeInvocations: 128, nativeStall: 8 };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonSha256 = (value) => sha256(JSON.stringify(value));

function referenceCorpusFixture() {
  const owners = ["a", "b", "c", "d"].map((key, index) => ({
    key,
    participantId: `participant:00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    pinnedOwnerDigest: String(index + 1).repeat(64),
    models: [`synthetic-model-${key}`],
  }));
  const extras = [
    { ownerKey: "a", participantId: owners[0].participantId, day: "2026-04-17", format: "v1",
      stream: "usage", records: 1, corpusRowsSha256: sha256("synthetic-a-usage-2026-04-17") },
    { ownerKey: "d", participantId: owners[3].participantId, day: "2026-06-30", format: "v1",
      stream: "usage", records: 1, corpusRowsSha256: sha256("synthetic-d-usage-2026-06-30") },
  ];
  const conflictDays = CONFLICT_DAYS;
  const corpus = {
    owners,
    window: { fromDay: "2026-04-15", throughDay: "2026-10-01", days: 170 },
    expectedDailyDays: ALL_DAYS.filter((day) => !conflictDays.includes(day)),
    conflictDays,
    v1ExtraAdmissions: { count: extras.length, sha256: jsonSha256(extras), entries: extras },
  };
  corpus.admissionIdentities = admissionsFixture(corpus).sort((left, right) => {
    const a = JSON.stringify([left.participantId, left.format, left.day]);
    const b = JSON.stringify([right.participantId, right.format, right.day]);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return corpus;
}

function admissionsFixture(corpus) {
  const admissions = [];
  for (const owner of corpus.owners) {
    const format = owner.key === "c" ? "v12" : "v11";
    for (const day of ALL_DAYS) {
      admissions.push({ participantId: owner.participantId, format, day,
        manifestDigest: sha256(`manifest:${owner.key}:${day}`),
        chunks: [{ chunkId: `chunk-${owner.key}-${day}`, chunkDigest: sha256(`chunk:${owner.key}:${day}`), recordCount: 1 }],
      });
    }
  }
  for (const extra of corpus.v1ExtraAdmissions.entries) {
    admissions.push({ participantId: extra.participantId, format: "v1", day: extra.day,
      chunkDigest: sha256(`v1:${extra.ownerKey}:${extra.day}`), stream: extra.stream,
      records: extra.records, corpusRowsSha256: extra.corpusRowsSha256,
    });
  }
  return admissions;
}

function admissionBuilderInput() {
  const owners = ["a", "b", "c", "d"].map((key, index) => ({
    key,
    participantId: `participant:00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    pinnedOwnerDigest: String(index + 1).repeat(64),
    models: [`synthetic-model-${key}`],
    days: ALL_DAYS.map((day) => {
      const records = Object.fromEntries(["quota", "session", "usage"].map((stream) =>
        [stream, [{ owner: key, day, stream }]]));
      const v1Extra = (key === "a" && day === "2026-04-17") || (key === "d" && day === "2026-06-30")
        ? { usage: [{ owner: key, day, stream: "usage", legacy: true }] }
        : undefined;
      return { day, records, ...(v1Extra ? { v1Extra } : {}) };
    }),
  }));
  return {
    owners,
    window: { fromDay: "2026-04-15", throughDay: "2026-10-01", days: 170 },
    expectedDailyDays: ALL_DAYS.filter((day) => !CONFLICT_DAYS.includes(day)),
    conflictDays: [...CONFLICT_DAYS],
  };
}

function admissionBuilderFacade({ mutateV11Input = false, malformedV11Output = false } = {}) {
  const calls = {
    makeV11Day: 0,
    telemetryV12RequiredConsent: 0,
    canonicalTelemetryV12Json: 0,
    telemetryV12DayManifestDigestInput: 0,
    sha256Hex: 0,
    parseTelemetryV12Chunk: 0,
    telemetryV11LegacyProjection: 0,
    canonicalJson: 0,
    parseTelemetryV1Chunk: 0,
  };
  const digest = (value) => sha256(typeof value === "string" ? value : JSON.stringify(value));
  const P = {
    async makeV11Day(day, records, parserVersion) {
      calls.makeV11Day++;
      assert.equal(parserVersion, "synthetic-gcp-oracle-v11");
      if (mutateV11Input && calls.makeV11Day === 1) records.usage.push({ mutated: true });
      if (malformedV11Output && calls.makeV11Day === 1) return { manifest: { manifestDigest: "malformed",
        chunks: [{ chunkId: `v11:${day}`, chunkDigest: digest(`v11-chunk:${day}`), recordCount: 3 }] } };
      return { manifest: { manifestDigest: digest(`v11-manifest:${day}:${JSON.stringify(records)}`),
        chunks: [{ chunkId: `v11:${day}`, chunkDigest: digest(`v11-chunk:${day}`),
          recordCount: Object.values(records).reduce((sum, rows) => sum + rows.length, 0) }] } };
    },
    async sha256Hex(value) { calls.sha256Hex++; return digest(value); },
    canonicalTelemetryV12Json(rows) { calls.canonicalTelemetryV12Json++; return JSON.stringify(rows); },
    telemetryV12DayManifestDigestInput(manifest) {
      calls.telemetryV12DayManifestDigestInput++;
      return JSON.stringify(manifest);
    },
    telemetryV12RequiredConsent() { calls.telemetryV12RequiredConsent++; return { synthetic: true }; },
    parseTelemetryV12Chunk(chunk) {
      calls.parseTelemetryV12Chunk++;
      assert.equal(chunk.schemaVersion, "telemetry-contribution-v1.2");
      return chunk;
    },
    telemetryV11LegacyProjection(stream, record) {
      calls.telemetryV11LegacyProjection++;
      return { canonicalRecord: JSON.stringify({ stream, ...record }) };
    },
    canonicalJson(value) { calls.canonicalJson++; return JSON.stringify(value); },
    parseTelemetryV1Chunk(chunk) {
      calls.parseTelemetryV1Chunk++;
      return { chunkDigest: chunk.chunkDigest };
    },
  };
  return { P, calls };
}

function admissionBuilderCorpusStructure(corpus, admissionIdentities) {
  const entries = corpus.owners.flatMap((owner) => owner.days.flatMap((day) =>
    Object.entries(day.v1Extra ?? {}).filter(([, records]) => records.length > 0).map(([stream, records]) => ({
      ownerKey: owner.key, participantId: owner.participantId, day: day.day, format: "v1", stream,
      records: records.length, corpusRowsSha256: jsonSha256(records),
    })))).sort((left, right) => {
      const a = `${left.ownerKey}\0${left.day}\0${left.stream}`;
      const b = `${right.ownerKey}\0${right.day}\0${right.stream}`;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  return {
    owners: corpus.owners.map(({ key, participantId, pinnedOwnerDigest, models }) =>
      ({ key, participantId, pinnedOwnerDigest, models })),
    window: corpus.window,
    expectedDailyDays: corpus.expectedDailyDays,
    conflictDays: corpus.conflictDays,
    v1ExtraAdmissions: { count: entries.length, sha256: jsonSha256(entries), entries },
    admissionIdentities,
  };
}

function referenceBindingFixture() {
  const corpusStructure = referenceCorpusFixture();
  const admissions = admissionsFixture(corpusStructure);
  const sourceFiles = [
    { path: "apps/worker/migrations/0001_synthetic.sql", sha256: "1".repeat(64) },
    { path: "apps/worker/src/synthetic-entry.mjs", sha256: "2".repeat(64) },
  ];
  const source = { head: "a".repeat(40), files: sourceFiles, sha256: jsonSha256(sourceFiles) };
  const migrations = [sourceFiles[0]];
  const runtime = { version: "v26.2.0", platform: "darwin", arch: "arm64",
    binarySha256: "b276251704734604aad4ab2dc4a07892565baea39400f6422abeb1fe39637440",
    pinnedNowMs: CURRENT_Q1_REFERENCE_NOW_MS, randomSeed: "current-q1-reference", sqliteVersion: "3.50.4" };
  const corpus = { synthetic: true, sourceCommit: "d43c8f92a059d9c577776f7eca8a331eb305b8a6",
    canonicalSha256: "be042b9a72c00a8bbeef592619d7d7ab00be5b02a557629340d27bbf36b5521e",
    recordCount: 14832, primaryRecordCount: 14830, owners: 4, daysPerOwner: 170,
    files: Array.from({ length: 5 }, (_, index) => ({
      path: `apps/worker/analytics-v2-test/golden/corpus/synthetic-${index}.json`,
      sha256: String(index + 3).repeat(64),
    })) };
  const runtimeContracts = { v1: 1, v11: 1 };
  const cohort = corpusStructure.owners.map((owner) => ({
    participantId: owner.participantId, ownerDigest: owner.pinnedOwnerDigest,
  })).sort((left, right) => left.participantId.localeCompare(right.participantId));
  const expected = {
    schemaVersion: "current-q1-d1-reference-binding-v3",
    sourceId: CURRENT_Q1_REFERENCE_SOURCE_ID, sourceNamespace: CURRENT_Q1_REFERENCE_SOURCE_ID,
    source, migrations, migrationSha256: jsonSha256(migrations), runtime, bounds: structuredClone(BOUNDS),
    runtimeContracts, corpus, corpusStructure,
  };
  const reference = {
    schemaVersion: "current-q1-d1-reference-v2", synthetic: true,
    sourceId: CURRENT_Q1_REFERENCE_SOURCE_ID, sourceNamespace: CURRENT_Q1_REFERENCE_SOURCE_ID,
    bounds: structuredClone(BOUNDS),
    provenance: { source: structuredClone(source), runtime: structuredClone(runtime), corpus: structuredClone(corpus),
      migrations: structuredClone(migrations), migrationSha256: expected.migrationSha256,
      runtimeContracts: structuredClone(runtimeContracts), admissions,
      admissionSha256: jsonSha256(admissions), cohort },
  };
  return { expected, reference, corpusStructure, admissions };
}

function graphDays() {
  const today = new Date(CURRENT_Q1_REFERENCE_NOW_MS).toISOString().slice(0, 10);
  return Array.from({ length: 70 }, (_, index) => new Date(Date.parse(today) - (69 - index) * DAY_MS)
    .toISOString().slice(0, 10));
}

async function applyValidControlTransition(db) {
  const before = await capture(createDatabaseAdapter(db));
  const nowMs = Date.UTC(2026, 9, 13, 15, 30, 0);
  const nowIso = new Date(nowMs).toISOString();
  const actorDigest = "b".repeat(64);
  db.prepare(`UPDATE collection_controls SET revision=4,reason_code='drill_restore',updated_at=? WHERE id=1`)
    .run(nowIso);
  db.prepare(`INSERT INTO admin_action_audit
    (operation_id,action,actor_identity_digest,outcome,details_json,created_at)
    VALUES (?,?,?,?,?,?)`).run(
    "00000000-0000-4000-8000-000000000001", "set_collection_controls", actorDigest, "success",
    JSON.stringify({ expectedRevision: 3, revision: 4, state: "active",
      flags: { enrollment: true, uploadRegistration: true, processing: true, publication: true },
      reasonCode: "drill_restore" }), nowIso,
  );
  const after = await capture(createDatabaseAdapter(db));
  const result = assertCurrentQ1ControlTransition({ before, after, controlsBefore: controls(3),
    controlsAfter: controls(4), nowMs, actorDigest });
  return { before, after, controlsBefore: controls(3), controlsAfter: controls(4), result, nowMs, actorDigest };
}

function createDatabaseAdapter(db) {
  return {
    prepare(sql) {
      let parameters = [];
      return {
        bind(...values) { parameters = values; return this; },
        all() { return { results: db.prepare(sql).all(...parameters) }; },
      };
    },
  };
}

test("daily convergence earns fresh skips for the oldest two conflicts, publishes later eligible work, and replays", async () => {
  const makeSteps = () => [
    deferredConflict(CONFLICT_DAYS[0]),
    deferredConflict(CONFLICT_DAYS[1]),
    { state: "published", ownersAdvanced: 4, day: EXPECTED_DAILY_DAYS[0] },
    { state: "idle", ownersAdvanced: 0 },
  ];
  const run = async () => {
    const scheduler = sequencedAdvance(makeSteps());
    const result = await dailyPass(scheduler.advance, { preferStaleHead: true });
    return { result, calls: scheduler.calls };
  };

  const first = await run();
  const replay = await run();
  assert.deepEqual(first, replay);
  assert.deepEqual(first.result, {
    iterations: 4,
    outcomes: { published: 1, unchanged: 0, progress: 0, conflicts: 2 },
    filteredIdle: true,
  });
  assert.deepEqual(first.calls.map(({ skipDays }) => skipDays), [
    [], [CONFLICT_DAYS[0]], CONFLICT_DAYS, CONFLICT_DAYS,
  ]);
  assert.ok(!makeSteps().some((step) => step.state === "published" && CONFLICT_DAYS.includes(step.day)));
});

test("daily convergence continues partial-owner progress and never publishes conflict days", async () => {
  const steps = [
    { state: "progress", ownersAdvanced: 1, day: EXPECTED_DAILY_DAYS[0] },
    { state: "progress", reason: "projection_pending", ownersAdvanced: 2, day: EXPECTED_DAILY_DAYS[0] },
    { state: "published", ownersAdvanced: 1, day: EXPECTED_DAILY_DAYS[0] },
    deferredConflict(CONFLICT_DAYS[0]),
    deferredConflict(CONFLICT_DAYS[1]),
    { state: "unchanged", ownersAdvanced: 0, day: EXPECTED_DAILY_DAYS[1] },
    { state: "idle", ownersAdvanced: 0 },
  ];
  const scheduler = sequencedAdvance(steps);
  const result = await dailyPass(scheduler.advance);
  assert.deepEqual(result, {
    iterations: 7,
    outcomes: { published: 1, unchanged: 1, progress: 2, conflicts: 2 },
    filteredIdle: true,
  });
  assert.deepEqual(scheduler.calls.map(({ skipDays }) => skipDays), [
    [], [], [], [], [CONFLICT_DAYS[0]], CONFLICT_DAYS, CONFLICT_DAYS,
  ]);
  assert.ok(!steps.some((step) => step.state === "published" && CONFLICT_DAYS.includes(step.day)));
});

test("daily convergence refuses unexpected, deferred eligible, malformed, skipped, and unbounded outcomes", async (t) => {
  const scenarios = [
    ["unexpected day", [{ state: "published", ownersAdvanced: 1, day: "2026-04-14" }]],
    ["eligible deferral", [{ state: "deferred", reason: "projection_pending", ownersAdvanced: 0,
      day: EXPECTED_DAILY_DAYS[0] }]],
    ["wrong conflict reason", [{ state: "deferred", reason: "other", ownersAdvanced: 0,
      day: CONFLICT_DAYS[0] }]],
    ["capacity overrun", [{ state: "published", ownersAdvanced: 5, day: EXPECTED_DAILY_DAYS[0] }]],
    ["zero-progress progress", [{ state: "progress", ownersAdvanced: 0, day: EXPECTED_DAILY_DAYS[0] }]],
    ["false idle", [{ state: "idle", ownersAdvanced: 0 }]],
    ["skipped candidate returned again", [deferredConflict(CONFLICT_DAYS[0]), deferredConflict(CONFLICT_DAYS[0])]],
    ["conflict published", [{ state: "published", ownersAdvanced: 1, day: CONFLICT_DAYS[0] }]],
    ["iteration exhaustion", [{ state: "progress", ownersAdvanced: 1, day: EXPECTED_DAILY_DAYS[0] }], 1],
  ];
  for (const [name, steps, bound = 16] of scenarios) {
    await t.test(name, async () => {
      const scheduler = sequencedAdvance(steps);
      await assert.rejects(dailyPass(scheduler.advance, { bound }), FAILURE);
    });
  }
});

test("source invariants include unknown tables, empty schemas, BLOBs, and source rows", async (t) => {
  const fixture = createDatabase();
  try {
    const before = await capture(fixture.database);
    assert.equal(fixture.db.prepare("SELECT count(*) AS rows FROM future_empty").get().rows, 0);
    assert.equal(fixture.db.prepare("SELECT count(*) AS n FROM future_auxiliary").get().n, 1);

    fixture.db.prepare("UPDATE future_auxiliary SET payload=X'010203' WHERE kind='opaque'").run();
    const afterUnknownTableMutation = await capture(fixture.database);
    assert.notEqual(afterUnknownTableMutation.sha256, before.sha256);
    assert.equal(afterUnknownTableMutation.schemaSha256, before.schemaSha256);
    assert.throws(() => assertCurrentQ1SourceUnchanged(before, afterUnknownTableMutation), FAILURE);

    fixture.db.exec("ALTER TABLE future_empty ADD COLUMN introduced TEXT");
    const afterSchemaMutation = await capture(fixture.database);
    assert.notEqual(afterSchemaMutation.schemaSha256, afterUnknownTableMutation.schemaSha256);
    assert.throws(() => assertCurrentQ1SourceUnchanged(before, afterSchemaMutation), FAILURE);

    fixture.db.prepare("UPDATE source_records SET payload=X'ff' WHERE id=1").run();
    const afterSourceMutation = await capture(fixture.database);
    assert.notEqual(afterSourceMutation.sha256, before.sha256);
    assert.throws(() => assertCurrentQ1SourceUnchanged(before, afterSourceMutation), FAILURE);
  } finally {
    fixture.db.close();
  }
});

test("control, audit, and sequence mutations are detected while the exact audited transition passes", async (t) => {
  const fixture = createDatabase();
  try {
    const before = await capture(fixture.database);
    fixture.db.prepare("UPDATE collection_controls SET enrollment=0 WHERE id=1").run();
    const afterControlMutation = await capture(fixture.database);
    assert.equal(afterControlMutation.sha256, before.sha256);
    assert.notDeepEqual(afterControlMutation.controls, before.controls);
    assert.throws(() => assertCurrentQ1SourceUnchanged(before, afterControlMutation), FAILURE);
  } finally {
    fixture.db.close();
  }

  const auditFixture = createDatabase();
  try {
    const before = await capture(auditFixture.database);
    auditFixture.db.prepare(`INSERT INTO admin_action_audit
      (operation_id,action,actor_identity_digest,outcome,details_json,created_at)
      VALUES (?,?,?,?,?,?)`).run("00000000-0000-4000-8000-000000000002", "unexpected", "c".repeat(64),
      "success", "{}", "2026-10-13T00:00:00.000Z");
    const after = await capture(auditFixture.database);
    assert.equal(after.sha256, before.sha256);
    assert.notDeepEqual(after.audit, before.audit);
    assert.throws(() => assertCurrentQ1SourceUnchanged(before, after), FAILURE);
  } finally {
    auditFixture.db.close();
  }

  const validFixture = createDatabase();
  try {
    const valid = await applyValidControlTransition(validFixture.db);
    assert.equal(valid.result.auditRowsAfter, 1);
    assert.equal(valid.result.auditSequenceAfter, 1);
    assert.throws(() => assertCurrentQ1ControlTransition({ ...valid, after: {
      ...valid.after, controls: [{ ...valid.after.controls[0], enrollment: 0 }],
    } }), FAILURE);

    for (const [name, operationId] of [
      ["malformed UUID", "malformed-operation-id"],
      ["non-v4 UUID", "00000000-0000-1000-7000-000000000001"],
    ]) {
      await t.test(name, async () => {
        validFixture.db.prepare("UPDATE admin_action_audit SET operation_id=? WHERE id=1").run(operationId);
        try {
          const afterUuidMutation = await capture(createDatabaseAdapter(validFixture.db));
          assert.throws(() => assertCurrentQ1ControlTransition({ ...valid, after: afterUuidMutation }), FAILURE);
        } finally {
          validFixture.db.prepare("UPDATE admin_action_audit SET operation_id=? WHERE id=1")
            .run("00000000-0000-4000-8000-000000000001");
        }
      });
    }

    validFixture.db.prepare("UPDATE sqlite_sequence SET seq=9 WHERE name='admin_action_audit'").run();
    const afterSequenceMutation = await capture(createDatabaseAdapter(validFixture.db));
    assert.equal(afterSequenceMutation.sha256, valid.after.sha256);
    assert.notDeepEqual(afterSequenceMutation.sequences, valid.after.sequences);
    assert.throws(() => assertCurrentQ1SourceUnchanged(valid.after, afterSequenceMutation), FAILURE);
    assert.throws(() => assertCurrentQ1ControlTransition({ ...valid, after: afterSequenceMutation }), FAILURE);

    validFixture.db.prepare("UPDATE sqlite_sequence SET seq=1 WHERE name='admin_action_audit'").run();
    validFixture.db.prepare("UPDATE admin_action_audit SET details_json='{}' WHERE id=1").run();
    const afterAuditMutation = await capture(createDatabaseAdapter(validFixture.db));
    assert.throws(() => assertCurrentQ1SourceUnchanged(valid.after, afterAuditMutation), FAILURE);
    assert.throws(() => assertCurrentQ1ControlTransition({ ...valid, after: afterAuditMutation }), FAILURE);
  } finally {
    validFixture.db.close();
  }
});

test("cache pass preserves the bounded synthetic fixture arguments and pinned bindings", async () => {
  const ingestion = { name: "synthetic-ingestion" }, analytics = { name: "synthetic-analytics" };
  const sourceId = "synthetic-source", sourceNamespace = "synthetic-namespace";
  const nowMs = Date.UTC(2026, 9, 13, 15, 30, 0), build = { name: "synthetic-build" };
  const laneResult = { state: "idle" };
  let buildArgs, laneArgs;
  const ctx = {
    ingestion, analytics, sourceId, sourceNamespace, nowMs,
    P: {
      createCacheRetentionDaySourceBuild(args) { buildArgs = args; return build; },
      async advanceCacheRetentionDayLane(args) { laneArgs = args; return laneResult; },
    },
  };

  assert.equal(await advanceCurrentQ1CachePass(ctx), laneResult);
  assert.deepEqual(Object.keys(buildArgs).sort(), ["now", "source", "sourceId", "sourceNamespace", "target"]);
  assert.strictEqual(buildArgs.source, ingestion);
  assert.strictEqual(buildArgs.target, analytics);
  assert.equal(buildArgs.sourceId, sourceId);
  assert.equal(buildArgs.sourceNamespace, sourceNamespace);
  assert.equal(buildArgs.now(), nowMs);
  assert.deepEqual(Object.keys(laneArgs).sort(), ["build", "deadlineMs", "maxDays", "maxWrites", "now",
    "remainingQueries", "shardCount", "shardIndex", "sourceId", "sourceQueries", "target"].sort());
  assert.strictEqual(laneArgs.target, analytics);
  assert.strictEqual(laneArgs.build, build);
  assert.equal(laneArgs.sourceId, sourceId);
  assert.equal(laneArgs.deadlineMs, nowMs + 1);
  assert.equal(laneArgs.remainingQueries, 5_000);
  assert.equal(laneArgs.sourceQueries, 5_000);
  assert.equal(laneArgs.maxDays, 64);
  assert.equal(laneArgs.maxWrites, 64);
  assert.equal(laneArgs.now(), nowMs);
  assert.equal(laneArgs.shardIndex, 0);
  assert.equal(laneArgs.shardCount, 1);
});

test("recomputation accepts quiet graph convergence and rejects a false complete claim", async (t) => {
  const valid = recomputationFixture();
  assert.strictEqual(validateCurrentQ1Recomputation(valid, CORPUS), valid);

  for (const [name, mutate] of [
    ["converged without all quiet-rotation passes", (value) => { value.graphExecution.quiet = 29; }],
    ["execution count differs from graph invocations", (value) => { value.graphExecution.iterations = 29; }],
    ["wrong convergence reason", (value) => { value.graphExecution.reason = "invocations"; }],
  ]) {
    await t.test(name, async () => {
      const invalid = structuredClone(valid);
      mutate(invalid);
      assert.throws(() => validateCurrentQ1Recomputation(invalid, CORPUS), FAILURE);
    });
  }
});

test("the strict export oracle executes and records only the typed queue-row fence refusal", async () => {
  const callbacks = [];
  let invocations = 0;
  const ctx = oracleContext(async ({ onStep }) => {
    invocations++;
    onStep("fence");
    callbacks.push("fence");
    throw refusedError(ctx.P);
  });
  const result = await proveCurrentQ1StrictExportRefusal(ctx, "a".repeat(64));
  assert.deepEqual(result, {
    schemaVersion: "current-q1-d1-strict-export-refusal-v1", actual: true,
    code: "ANALYTICS_EXPORT_NOT_QUIESCENT", reasons: ["queue_rows"], queueRows: 2,
  });
  assert.equal(invocations, 1);
  assert.deepEqual(callbacks, ["fence"]);
});

test("the strict export oracle rejects success, other reasons, untyped errors, and callbacks outside the fence", async (t) => {
  const scenarios = [
    ["oracle success", async () => {}],
    ["other refusal reason", async ({ onStep }, P) => { onStep("fence"); throw refusedError(P, ["queue_rows", "cache_busy"]); }],
    ["untyped matching error", async ({ onStep }) => {
      onStep("fence");
      throw Object.assign(new Error("ANALYTICS_EXPORT_NOT_QUIESCENT"), {
        code: "ANALYTICS_EXPORT_NOT_QUIESCENT", reasons: ["queue_rows"],
      });
    }],
    ["refusal before fence", async (_args, P) => { throw refusedError(P); }],
    ["callback after fence", async ({ onStep }, P) => {
      onStep("fence"); onStep("export"); throw refusedError(P);
    }],
  ];
  for (const [name, run] of scenarios) {
    await t.test(name, async () => {
      const ctx = oracleContext((args) => run(args, ctx.P));
      await assert.rejects(proveCurrentQ1StrictExportRefusal(ctx, "a".repeat(64)), FAILURE);
    });
  }
});

test("reference admissions cover the exact 682 immutable coordinates and reject reminted, missing, duplicate, or foreign rows", async (t) => {
  const corpus = referenceCorpusFixture();
  const admissions = admissionsFixture(corpus);
  assert.equal(admissions.length, 682);
  assert.deepEqual(validateCurrentQ1Admissions(admissions, corpus), {
    count: 682, sha256: jsonSha256(admissions),
  });

  const scenarios = [
    ["empty reminted set", () => []],
    ["missing primary coordinate", () => admissions.slice(1)],
    ["duplicate coordinate at the expected cardinality", () => {
      const value = structuredClone(admissions);
      value[1] = structuredClone(value[0]);
      return value;
    }],
    ["foreign participant", () => {
      const value = structuredClone(admissions);
      value[0].participantId = "participant:99999999-9999-4999-8999-999999999999";
      return value;
    }],
    ["closed admission record", () => {
      const value = structuredClone(admissions);
      value[0].privatePayload = "synthetic-private-field";
      return value;
    }],
    ["missing corpus-derived v1 extra", () => admissions.filter((entry) => entry.format !== "v1"
      || entry.day !== "2026-04-17" || entry.participantId !== corpus.owners[0].participantId)],
  ];
  for (const [name, create] of scenarios) {
    await t.test(name, () => assert.throws(
      () => validateCurrentQ1Admissions(create(), corpus), { code: "CURRENT_Q1_REFERENCE_BINDING_INVALID" },
    ));
  }
});

test("admission identities reject reminted digests, nested chunks, and altered corpus-derived v1 extras", async (t) => {
  const corpus = referenceCorpusFixture();
  const original = admissionsFixture(corpus);
  const newDigest = (value) => value === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
  const reminted = (mutate) => {
    const value = structuredClone(original);
    mutate(value);
    return value;
  };
  const digestScenarios = [
    ["v11 manifest digest", (entries) => {
      const entry = entries.find((candidate) => candidate.format === "v11");
      entry.manifestDigest = newDigest(entry.manifestDigest);
    }],
    ["v12 manifest digest", (entries) => {
      const entry = entries.find((candidate) => candidate.format === "v12");
      entry.manifestDigest = newDigest(entry.manifestDigest);
    }],
    ["v11 nested chunk digest", (entries) => {
      const entry = entries.find((candidate) => candidate.format === "v11");
      entry.chunks[0].chunkDigest = newDigest(entry.chunks[0].chunkDigest);
    }],
    ["v12 nested chunk digest", (entries) => {
      const entry = entries.find((candidate) => candidate.format === "v12");
      entry.chunks[0].chunkDigest = newDigest(entry.chunks[0].chunkDigest);
    }],
    ["v1 chunk digest", (entries) => {
      const entry = entries.find((candidate) => candidate.format === "v1");
      entry.chunkDigest = newDigest(entry.chunkDigest);
    }],
    ["same-coordinate v1 corpus row digest", (entries) => {
      const entry = entries.find((candidate) => candidate.format === "v1");
      entry.corpusRowsSha256 = sha256("synthetic-reminted-corpus-row");
      entry.chunkDigest = sha256("synthetic-reminted-v1-chunk");
    }],
    ["same-coordinate v1 stream and record count", (entries) => {
      const entry = entries.find((candidate) => candidate.format === "v1");
      entry.stream = "session";
      entry.records = 2;
      entry.corpusRowsSha256 = sha256("synthetic-reminted-session-rows");
      entry.chunkDigest = sha256("synthetic-reminted-session-chunk");
    }],
    ["v1 extra moved from its exact corpus coordinate", (entries) => {
      const entry = entries.find((candidate) => candidate.format === "v1");
      entry.day = "2026-07-01";
      entry.chunkDigest = sha256("synthetic-moved-v1-chunk");
    }],
    ["duplicate actual v1 participant/day across streams", (entries) => {
      const target = entries.findIndex((candidate) => candidate.format === "v1" && candidate.day === "2026-06-30");
      const source = structuredClone(entries.find((candidate) => candidate.format === "v1" && candidate.day === "2026-04-17"));
      source.stream = "session";
      source.corpusRowsSha256 = sha256("synthetic-duplicate-v1-session-rows");
      source.chunkDigest = sha256("synthetic-duplicate-v1-session-chunk");
      entries[target] = source;
    }],
  ];
  for (const [name, mutate] of digestScenarios) {
    await t.test(name, () => {
      const entries = reminted(mutate);
      assert.equal(entries.length, 682);
      assert.throws(() => validateCurrentQ1Admissions(entries, corpus), {
        code: "CURRENT_Q1_REFERENCE_BINDING_INVALID",
      });
    });
  }
});

test("reference binding pins exact bounds, runtime contracts, source, admissions, and closed cohort projections", async (t) => {
  const valid = referenceBindingFixture();
  const rehashAdmissions = (fixture) => {
    fixture.reference.provenance.admissionSha256 = jsonSha256(fixture.reference.provenance.admissions);
  };
  assert.deepEqual(validateCurrentQ1ReferenceBinding(valid), {
    state: "bound", sourceHead: valid.expected.source.head, sourceSha256: valid.expected.source.sha256,
    migrationSha256: valid.expected.migrationSha256, corpusSha256: valid.expected.corpus.canonicalSha256,
  });

  const scenarios = [
    ["expanded expected bound", (fixture) => { fixture.expected.bounds.daily = 257; }],
    ["extra actual bound", (fixture) => { fixture.reference.bounds.unbounded = 1; }],
    ["expanded runtime contracts", (fixture) => { fixture.expected.runtimeContracts.v12 = 1; }],
    ["changed actual runtime contract", (fixture) => { fixture.reference.provenance.runtimeContracts.v1 = 2; }],
    ["cohort private field", (fixture) => { fixture.reference.provenance.cohort[0].participantSecret = "synthetic-private"; }],
    ["reminted cohort digest", (fixture) => { fixture.reference.provenance.cohort[0].ownerDigest = "f".repeat(64); }],
    ["duplicate admission with recomputed admission hash", (fixture) => {
      fixture.reference.provenance.admissions[1] = structuredClone(fixture.reference.provenance.admissions[0]);
      fixture.reference.provenance.admissionSha256 = jsonSha256(fixture.reference.provenance.admissions);
    }],
    ["foreign admission with recomputed admission hash", (fixture) => {
      fixture.reference.provenance.admissions[0].participantId = "participant:99999999-9999-4999-8999-999999999999";
      rehashAdmissions(fixture);
    }],
    ["reminted v11 manifest with recomputed admission hash", (fixture) => {
      const entry = fixture.reference.provenance.admissions.find((candidate) => candidate.format === "v11");
      entry.manifestDigest = entry.manifestDigest === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
      rehashAdmissions(fixture);
    }],
    ["reminted v12 nested chunk with recomputed admission hash", (fixture) => {
      const entry = fixture.reference.provenance.admissions.find((candidate) => candidate.format === "v12");
      entry.chunks[0].chunkDigest = entry.chunks[0].chunkDigest === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
      rehashAdmissions(fixture);
    }],
    ["reminted v1 chunk with recomputed admission hash", (fixture) => {
      const entry = fixture.reference.provenance.admissions.find((candidate) => candidate.format === "v1");
      entry.chunkDigest = entry.chunkDigest === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
      rehashAdmissions(fixture);
    }],
    ["same-coordinate v1 corpus row digest and stream reminted", (fixture) => {
      const entry = fixture.reference.provenance.admissions.find((candidate) =>
        candidate.format === "v1" && candidate.day === "2026-04-17");
      entry.stream = "session";
      entry.records = 2;
      entry.corpusRowsSha256 = sha256("synthetic-reminted-session-rows");
      entry.chunkDigest = sha256("synthetic-reminted-session-chunk");
      rehashAdmissions(fixture);
    }],
    ["v1 extra moved from corpus coordinate with recomputed admission hash", (fixture) => {
      const entry = fixture.reference.provenance.admissions.find((candidate) => candidate.format === "v1");
      entry.day = "2026-07-01";
      entry.chunkDigest = sha256("synthetic-moved-v1-chunk");
      rehashAdmissions(fixture);
    }],
    ["duplicate v1 participant/day across streams with recomputed admission hash", (fixture) => {
      const admissions = fixture.reference.provenance.admissions;
      const target = admissions.findIndex((candidate) => candidate.format === "v1" && candidate.day === "2026-06-30");
      const source = structuredClone(admissions.find((candidate) => candidate.format === "v1" && candidate.day === "2026-04-17"));
      source.stream = "session";
      source.corpusRowsSha256 = sha256("synthetic-duplicate-v1-session-rows");
      source.chunkDigest = sha256("synthetic-duplicate-v1-session-chunk");
      admissions[target] = source;
      rehashAdmissions(fixture);
    }],
  ];
  for (const [name, mutate] of scenarios) {
    await t.test(name, () => {
      const invalid = structuredClone(valid);
      mutate(invalid);
      assert.throws(() => validateCurrentQ1ReferenceBinding(invalid), {
        code: "CURRENT_Q1_REFERENCE_BINDING_INVALID",
      });
    });
  }
});

function nativeProbeFixture({ mutateTarget, seedTarget, sourceForScope = () => "v1" } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE analytics_history_checkpoint_heads (
      key_digest TEXT PRIMARY KEY, generation TEXT, retired INTEGER NOT NULL);
    CREATE TABLE analytics_history_checkpoint_stages (
      key_digest TEXT NOT NULL, generation TEXT NOT NULL, expected_head TEXT, owner_revision INTEGER NOT NULL,
      authority_epoch INTEGER NOT NULL, part_count INTEGER NOT NULL, control_json TEXT NOT NULL, manifest_json TEXT NOT NULL,
      PRIMARY KEY(key_digest,generation));
    CREATE TABLE analytics_history_checkpoint_parts (
      key_digest TEXT NOT NULL, generation TEXT NOT NULL, part_index INTEGER NOT NULL,
      sha256 TEXT NOT NULL, payload_bytes INTEGER NOT NULL, PRIMARY KEY(key_digest,generation,part_index));`);
  const queries = [], keys = [], captureCalls = [], computeCalls = [], results = new Map();
  const analytics = {
    prepare(sql) {
      return { bind(...values) {
        return { all() {
          queries.push({ sql, values });
          return { results: db.prepare(sql).all(...values) };
        } };
      } };
    },
    async batch(statements) { return statements.map((statement) => statement.all()); },
  };
  const owners = ["a", "b", "c", "d"].map((key) => ({ key, ownerDigest: key.repeat(64) }));
  const day = graphDays()[0];
  const targetKeyDigest = `scope:${owners[0].ownerDigest}:${day}:synthetic-history-method`;
  seedTarget?.({ db, keyDigest: targetKeyDigest });
  let targetInvocations = 0;
  const historyMethod = "synthetic-history-method";
  const P = {
    STORAGE_GRAPH_HISTORY_CHECKPOINT_METHOD: historyMethod,
    STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD: "synthetic-current-fit-method",
    STORAGE_GRAPH_EFFECTIVE_FITS_CHECKPOINT_METHOD: "synthetic-effective-fits-method",
    STORAGE_GRAPH_EFFECTIVE_MODEL_CHECKPOINT_METHOD: "synthetic-effective-model-method",
    STORAGE_GRAPH_LIVE_CHECKPOINT_METHODS: [historyMethod, "synthetic-current-fit-method",
      "synthetic-effective-fits-method", "synthetic-effective-model-method", "synthetic-v11-fits", "synthetic-v11-model"],
    STORAGE_GRAPH_FAILURE_REASONS: ["d1_timeout"],
    STORAGE_GRAPH_OPERATION_STAGES: ["graph_scope"],
    COMMUNITY_MODEL_REFUSAL_REASONS: new Set(),
    StorageGraphOperationError: class StorageGraphOperationError extends Error {},
    storageGraphV11CheckpointMethod: (metric, preparedFold) => {
      assert.equal(preparedFold, false);
      return `synthetic-v11-${metric}`;
    },
    async storageHistoryKeyDigest(key) {
      keys.push(key);
      return `scope:${key.ownerDigest}:${key.day}:${key.method}`;
    },
    async readStorageCommunityOwnerPage() { return owners; },
    async captureStorageGraphScope(_source, input) {
      captureCalls.push({ preparedFold: input.preparedFold, metric: input.metric });
      return { source: sourceForScope(input), owner: input.owner, metric: input.metric, day: input.day,
        dependencyDigest: "d".repeat(64), checkpointDependencyDigest: "c".repeat(64) };
    },
    async computeStorageGraphResult(_bindings, scope, options) {
      computeCalls.push({ optionKeys: Object.keys(options).sort(), preparedFold: options.preparedFold,
        nowMs: options.now() });
      if (scope.owner.ownerDigest === owners[0].ownerDigest) {
        targetInvocations++;
        mutateTarget?.({ db, keyDigest: targetKeyDigest, invocation: targetInvocations });
        return { state: "deferred" };
      }
      const result = { scope, fits: null, composition: { status: "ready" } };
      results.set(scope.owner.ownerDigest, result);
      return { state: "complete", result, reused: false };
    },
    async readStorageGraphResult(_bindings, scope) { return results.get(scope.owner.ownerDigest) ?? null; },
  };
  const ctx = { P, ingestion: {}, analytics, progress: { counts() {} } };
  const corpus = { owners: owners.map(({ key, ownerDigest }) => ({ key, pinnedOwnerDigest: ownerDigest })) };
  const recomputation = { graphForced: { previewSha256: "p".repeat(64), modelDays: [{ day, recomputedSha256: null }] } };
  return { ctx, corpus, recomputation, db, queries, keys, captureCalls, computeCalls, day, owners,
    get targetInvocations() { return targetInvocations; } };
}

function assertNativeProbeForwarding(fixture) {
  assert.ok(fixture.captureCalls.length > 0);
  assert.ok(fixture.captureCalls.every(({ preparedFold }) => preparedFold === false));
  assert.ok(fixture.computeCalls.length > 0);
  for (const { optionKeys, preparedFold, nowMs } of fixture.computeCalls) {
    assert.deepEqual(optionKeys, ["now", "preparedFold"]);
    assert.equal(preparedFold, false);
    assert.equal(nowMs, CURRENT_Q1_REFERENCE_NOW_MS);
  }
}

function addCheckpointStage(db, keyDigest, { generation = "g1", expectedHead = null, partCount = 1 } = {}) {
  db.prepare(`INSERT INTO analytics_history_checkpoint_stages
    (key_digest,generation,expected_head,owner_revision,authority_epoch,part_count,control_json,manifest_json)
    VALUES(?,?,?,?,1,?,?,?)`).run(keyDigest, generation, expectedHead, 1, partCount,
      JSON.stringify({ phase: "acquisition", generation }), JSON.stringify([{ sha256: sha256(`manifest:${generation}`) }]));
}

function addCheckpointPart(db, keyDigest, generation, index) {
  db.prepare(`INSERT INTO analytics_history_checkpoint_parts
    (key_digest,generation,part_index,sha256,payload_bytes) VALUES(?,?,?,?,?)`)
    .run(keyDigest, generation, index, sha256(`part:${index}`), 16 + index);
}

function promoteCheckpointHead(db, keyDigest, generation) {
  db.prepare(`INSERT INTO analytics_history_checkpoint_heads(key_digest,generation,retired) VALUES(?,?,0)
    ON CONFLICT(key_digest) DO UPDATE SET generation=excluded.generation,retired=0`).run(keyDigest, generation);
}

test("native probe stall progress observes scoped partial stages, parts, and promotion only", async (t) => {
  const cases = [
    ["new unpromoted stage resets the unchanged counter", ({ db, keyDigest, invocation }) => {
      if (invocation === 1) addCheckpointStage(db, keyDigest);
    }, 9],
    ["new partial part resets the unchanged counter", ({ db, keyDigest, invocation }) => {
      if (invocation === 1) addCheckpointPart(db, keyDigest, "g1", 0);
    }, 9, ({ db, keyDigest }) => addCheckpointStage(db, keyDigest)],
    ["promoted head resets the unchanged counter", ({ db, keyDigest, invocation }) => {
      if (invocation === 1) promoteCheckpointHead(db, keyDigest, "g1");
    }, 9, ({ db, keyDigest }) => { addCheckpointStage(db, keyDigest); addCheckpointPart(db, keyDigest, "g1", 0); }],
    ["partial part in an unpromoted successor resets after promoted head", ({ db, keyDigest, invocation }) => {
      if (invocation === 1) {
        addCheckpointStage(db, keyDigest, { generation: "g2", expectedHead: "g1", partCount: 2 });
        addCheckpointPart(db, keyDigest, "g2", 0);
      }
    }, 9, ({ db, keyDigest }) => {
      addCheckpointStage(db, keyDigest, { generation: "g1" });
      addCheckpointPart(db, keyDigest, "g1", 0);
      promoteCheckpointHead(db, keyDigest, "g1");
    }],
    ["an unrelated key does not reset the unchanged counter", ({ db, keyDigest, invocation }) => {
      if (invocation === 1) addCheckpointStage(db, `${keyDigest}:unrelated`);
    }, 8],
  ];
  for (const [name, mutateTarget, expectedInvocations, seedTarget] of cases) await t.test(name, async () => {
    const fixture = nativeProbeFixture({ mutateTarget, seedTarget });
    try {
      const evidence = await probeCurrentQ1MissingScopes(fixture.ctx, fixture.corpus, fixture.recomputation);
      assert.equal(fixture.targetInvocations, expectedInvocations);
      assert.equal(evidence[0].state, "unresolved");
      assert.equal(evidence[0].reason, "deferred");
      assert.equal(evidence[0].bound, "stall");
      assert.equal(evidence[0].invocations, expectedInvocations);
      assert.ok(fixture.keys.every((key) => key.sourceId === CURRENT_Q1_REFERENCE_SOURCE_ID
        && key.sourceNamespace === CURRENT_Q1_REFERENCE_SOURCE_ID && key.day === fixture.day
        && key.ownerDigest.length === 64 && key.dependencyDigest === "d".repeat(64)
        && key.method === "synthetic-history-method"));
      assert.ok(fixture.queries.length > 0);
      assertNativeProbeForwarding(fixture);
      assert.ok(fixture.queries.some(({ sql }) => /SUM\(part_count\).*controlBytes.*manifestBytes/su.test(sql)));
      assert.ok(fixture.queries.some(({ sql }) => /SUM\(payload_bytes\).*FROM analytics_history_checkpoint_parts/su.test(sql)));
      const scopedDigests = new Set(fixture.keys.map((key) =>
        `scope:${key.ownerDigest}:${key.day}:${key.method}`));
      assert.ok(fixture.queries.every(({ sql, values }) => /WHERE key_digest=\?/u.test(sql)
        && values.length === 1 && scopedDigests.has(values[0])));
      for (const { sql, values } of fixture.queries) {
        const plan = fixture.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values);
        assert.ok(plan.some((row) => /SEARCH .*USING (?:PRIMARY KEY|INDEX)/u.test(row.detail)), sql);
      }
    } finally {
      fixture.db.close();
    }
  });
});

test("native probe derives checkpoint keys from public source and method contracts", async () => {
  const sourceByScope = new Map([
    ["a:fits", "v1.1"], ["a:model", "effective"], ["b:fits", "effective"], ["b:model", "v1.1"],
    ["c:fits", "v1"], ["c:model", "v1"], ["d:fits", "mixed"], ["d:model", "mixed"],
  ]);
  const fixture = nativeProbeFixture({ sourceForScope: ({ owner, metric }) => sourceByScope.get(`${owner.key}:${metric}`) });
  try {
    fixture.recomputation.graphForced.previewSha256 = null;
    await probeCurrentQ1MissingScopes(fixture.ctx, fixture.corpus, fixture.recomputation);
    assertNativeProbeForwarding(fixture);
    const byScope = new Map(fixture.keys.map((key) => [`${key.ownerDigest[0]}:${key.method}`, key]));
    const expected = [
      ["a", "synthetic-v11-fits", "c"], ["a", "synthetic-effective-model-method", "c"],
      ["b", "synthetic-effective-fits-method", "c"], ["b", "synthetic-v11-model", "c"],
      ["c", "synthetic-current-fit-method", "d"], ["c", "synthetic-history-method", "d"],
      ["d", "synthetic-history-method", "d"],
    ];
    assert.equal(byScope.size, expected.length, "mixed fits uses no resumable checkpoint");
    for (const [owner, method, dependencyPrefix] of expected) {
      const key = byScope.get(`${owner}:${method}`);
      assert.ok(key, `${owner} should use ${method}`);
      assert.equal(key.dependencyDigest, dependencyPrefix.repeat(64));
      assert.equal(key.sourceId, CURRENT_Q1_REFERENCE_SOURCE_ID);
      assert.equal(key.sourceNamespace, CURRENT_Q1_REFERENCE_SOURCE_ID);
    }
    assert.ok(fixture.queries.every(({ sql, values }) => /WHERE key_digest=\?/u.test(sql)
      && values.length === 1 && fixture.keys.some((key) =>
        values[0] === `scope:${key.ownerDigest}:${key.day}:${key.method}`)));
  } finally {
    fixture.db.close();
  }
});

test("native probe preserves the 128-invocation cap and unresolved deferred evidence", async () => {
  const fixture = nativeProbeFixture({
    seedTarget: ({ db, keyDigest }) => addCheckpointStage(db, keyDigest, { partCount: 128 }),
    mutateTarget: ({ db, keyDigest, invocation }) => addCheckpointPart(db, keyDigest, "g1", invocation - 1),
  });
  try {
    const evidence = await probeCurrentQ1MissingScopes(fixture.ctx, fixture.corpus, fixture.recomputation);
    assertNativeProbeForwarding(fixture);
    assert.equal(fixture.targetInvocations, 128);
    assert.equal(evidence[0].state, "unresolved");
    assert.equal(evidence[0].reason, "deferred");
    assert.equal(evidence[0].bound, "invocations");
    assert.equal(evidence[0].invocations, 128);
  } finally {
    fixture.db.close();
  }
});

test("native evidence accepts only the exact closed result union", async (t) => {
  const scope = { owner: "a", metric: "fits", day: graphDays()[0] };
  const base = { ...scope, invocations: 1 };
  const accepted = [
    { ...base, state: "complete", computeOutcomeMatchesVerified: true, payloadSha256: "a".repeat(64), reused: false },
    { ...base, metric: "model", state: "not_testable", reason: "supported_quota_track_unavailable",
      computeOutcomeMatchesVerified: true, payloadSha256: "b".repeat(64), reused: true },
    { ...base, metric: "model", state: "unresolved", reason: "deferred" },
    { ...base, state: "refused", invocations: 0, nativeCapacityRefusal: false,
      reason: "d1_timeout", phase: "graph_scope" },
  ];
  const scopeFor = (entry) => ({ owner: entry.owner, metric: entry.metric, day: entry.day });
  for (const entry of accepted) {
    assert.deepEqual(validateCurrentQ1NativeEvidence([entry], [scopeFor(entry)]), [entry]);
  }

  const scenarios = [
    ["complete private key", { ...accepted[0], rawCache: "private" }],
    ["not-testable private key", { ...accepted[1], diagnostic: "private" }],
    ["unresolved private key", { ...accepted[2], debug: "private" }],
    ["refused private key", { ...accepted[3], accountId: "private" }],
    ["unknown state", { ...base, state: "qualified" }],
    ["unresolved false verification", { ...accepted[2], computeOutcomeMatchesVerified: true }],
    ["unresolved wrong invocation bound", { ...accepted[2], bound: "invocations", invocations: 127 }],
    ["capacity refusal mislabeled", { ...accepted[3], nativeCapacityRefusal: true }],
    ["refusal unknown phase", { ...accepted[3], phase: "unknown_operation" }],
  ];
  for (const [name, entry] of scenarios) {
    await t.test(name, () => assert.throws(
      () => validateCurrentQ1NativeEvidence([entry], [scopeFor(entry)]),
      { code: "CURRENT_Q1_REFERENCE_BINDING_INVALID" },
    ));
  }
});

test("native evidence rejects missing, extra, and wrong-day scopes", async (t) => {
  const days = graphDays();
  const scopes = [
    { owner: "a", metric: "fits", day: days[0] },
    { owner: "b", metric: "model", day: days[1] },
  ];
  const complete = (scope) => ({ ...scope, state: "complete", invocations: 1,
    computeOutcomeMatchesVerified: true, payloadSha256: sha256(JSON.stringify(scope)), reused: false });
  const entries = scopes.map(complete);
  const invalid = { code: "CURRENT_Q1_REFERENCE_BINDING_INVALID" };
  await t.test("missing expected scope", () => assert.throws(
    () => validateCurrentQ1NativeEvidence(entries.slice(0, 1), scopes), invalid,
  ));
  await t.test("extra scope", () => assert.throws(
    () => validateCurrentQ1NativeEvidence([...entries, complete({ owner: "c", metric: "fits", day: days[2] })], scopes), invalid,
  ));
  await t.test("wrong day for expected scope", () => {
    const wrongDay = [entries[0], complete({ ...scopes[1], day: days[2] })];
    assert.throws(() => validateCurrentQ1NativeEvidence(wrongDay, scopes), invalid);
  });
});

test("unresolved and refused native results remain non-qualifying in completeness", async (t) => {
  const { reference: provenanceReference, corpusStructure } = referenceBindingFixture();
  const days = graphDays();
  const missingDay = days[0];
  const scopes = corpusStructure.owners.map((owner) => ({ owner: owner.key, metric: "model", day: missingDay }));
  const scenarios = [
    ["unresolved", (scope) => ({ ...scope, state: "unresolved", invocations: 1, reason: "deferred" })],
    ["refused", (scope) => ({ ...scope, state: "refused", invocations: 0,
      nativeCapacityRefusal: false, reason: "d1_timeout", phase: "graph_scope" })],
  ];
  for (const [name, makeEvidence] of scenarios) {
    await t.test(name, () => {
      const reference = {
        ...provenanceReference,
        qualification: "unresolved",
        beforeForcedRecompute: {}, afterForcedRecompute: {}, afterNativeProbes: {},
        recomputation: { graphExecution: { state: "converged" }, liveCohort: { members: 4 },
          graphForced: { modelDays: days.map((day, index) => ({ day,
            recomputedSha256: index === 0 ? null : sha256(`graph:${day}`) })), previewSha256: "e".repeat(64) } },
        corpusConvergence: {}, strictExportRefusal: {}, graphPublications: [],
        nativeEvidence: scopes.map(makeEvidence),
      };
      const assessed = assessCurrentQ1ReferenceCompleteness({ reference, corpus: corpusStructure,
        snapshotReadiness: { afterForcedRecompute: {}, afterNativeProbes: {} } });
      assert.equal(assessed.state, "unresolved");
      assert.ok(assessed.reasons.includes("native_result_unverified"));
    });
  }
});

test("daily convergence enforces the 4096 initial and 168-by-64 forced bounds", async () => {
  const makeContext = () => {
    const calls = [];
    const ctx = {
      P: { advanceNextStorageCommunityDaily: async (options) => {
        calls.push(structuredClone(options));
        const nextConflict = CONFLICT_DAYS.find((day) => !options.skipDays.includes(day));
        return nextConflict
          ? deferredConflict(nextConflict)
          : { state: "idle", ownersAdvanced: 0 };
      } },
      ingestion: {}, analytics: {}, sourceId: "synthetic-source", sourceNamespace: "synthetic-namespace",
      nowMs: CURRENT_Q1_REFERENCE_NOW_MS, progress: { counts() {} },
    };
    return { ctx, calls };
  };

  for (const bound of [4096, 168 * 64]) {
    const { ctx, calls } = makeContext();
    const passes = await runCurrentQ1DailyConvergence(ctx, CORPUS, bound);
    assert.equal(passes.length, 2);
    assert.equal(passes.reduce((sum, pass) => sum + pass.iterations, 0), 6);
    assert.equal(calls.length, 6);
  }
  for (const expandedBound of [4097, 168 * 64 + 1]) {
    const { ctx, calls } = makeContext();
    await assert.rejects(runCurrentQ1DailyConvergence(ctx, CORPUS, expandedBound), FAILURE);
    assert.equal(calls.length, 0);
  }

  const forcedMaximum = recomputationFixture();
  forcedMaximum.invocations.daily = 168 * 64;
  assert.strictEqual(validateCurrentQ1Recomputation(forcedMaximum, CORPUS), forcedMaximum);
  const expandedForcedWork = structuredClone(forcedMaximum);
  expandedForcedWork.invocations.daily++;
  assert.throws(() => validateCurrentQ1Recomputation(expandedForcedWork, CORPUS), FAILURE);
});

test("graph execution requires exact quiet-rotation proof or the exact bounded unresolved state", () => {
  const valid = recomputationFixture();
  const unresolved = structuredClone(valid);
  unresolved.invocations.graph = 17_920;
  unresolved.graphExecution = { state: "unresolved", reason: "invocations", iterations: 17_920,
    quiet: 29, rotation: 30 };
  assert.strictEqual(validateCurrentQ1Recomputation(unresolved, CORPUS), unresolved);

  for (const mutate of [
    (value) => { value.graphExecution.quiet = 30; },
    (value) => { value.graphExecution.state = "complete"; },
    (value) => { value.graphExecution.iterations = 17_919; value.invocations.graph = 17_919; },
    (value) => { value.graphExecution.rotation = 29; },
  ]) {
    const invalid = structuredClone(unresolved);
    mutate(invalid);
    assert.throws(() => validateCurrentQ1Recomputation(invalid, CORPUS), FAILURE);
  }
});

test("admission identities execute the public builders for all 682 exact coordinates", async () => {
  const corpus = admissionBuilderInput();
  const originalCorpus = structuredClone(corpus);
  const { P, calls } = admissionBuilderFacade();
  const entries = await buildCurrentQ1AdmissionIdentities(P, corpus);
  assert.equal(entries.length, 682);
  assert.deepEqual(Object.fromEntries(["v11", "v12", "v1"].map((format) =>
    [format, entries.filter((entry) => entry.format === format).length])), { v11: 510, v12: 170, v1: 2 });
  assert.deepEqual(entries.filter((entry) => entry.format === "v1").map((entry) =>
    ({ participantId: entry.participantId, day: entry.day, stream: entry.stream, records: entry.records }))
    .sort((left, right) => left.day < right.day ? -1 : 1), [
      { participantId: corpus.owners[0].participantId, day: "2026-04-17", stream: "usage", records: 1 },
      { participantId: corpus.owners[3].participantId, day: "2026-06-30", stream: "usage", records: 1 },
    ]);
  const structure = admissionBuilderCorpusStructure(corpus, entries);
  assert.deepEqual(validateCurrentQ1Admissions(entries, structure), { count: 682, sha256: jsonSha256(entries) });
  assert.deepEqual(calls, {
    makeV11Day: 510,
    telemetryV12RequiredConsent: 170,
    canonicalTelemetryV12Json: 510,
    telemetryV12DayManifestDigestInput: 170,
    sha256Hex: 682,
    parseTelemetryV12Chunk: 510,
    telemetryV11LegacyProjection: 2,
    canonicalJson: 2,
    parseTelemetryV1Chunk: 2,
  });
  assert.deepEqual(corpus, originalCorpus, "public builders must receive an isolated copy and leave source rows seedable");
});

test("admission builder rejects malformed output and isolates mutations from the original corpus", async (t) => {
  await t.test("malformed public V11 builder output is refused by the binding validator", async () => {
    const corpus = admissionBuilderInput();
    const { P } = admissionBuilderFacade({ malformedV11Output: true });
    const entries = await buildCurrentQ1AdmissionIdentities(P, corpus);
    const structure = admissionBuilderCorpusStructure(corpus, entries);
    assert.throws(() => validateCurrentQ1Admissions(entries, structure), {
      code: "CURRENT_Q1_REFERENCE_BINDING_INVALID",
    });
  });
  await t.test("mutating public builder fails closed while original corpus stays unchanged", async () => {
    const corpus = admissionBuilderInput();
    const originalCorpus = structuredClone(corpus);
    const { P } = admissionBuilderFacade({ mutateV11Input: true });
    await assert.rejects(buildCurrentQ1AdmissionIdentities(P, corpus), {
      code: "CURRENT_Q1_REFERENCE_BINDING_INVALID",
    });
    assert.deepEqual(corpus, originalCorpus, "the builder mutation must remain confined to its clone");
  });
});

function captureBoundaryFixture() {
  return {
    runtime: { version: "v26.2.0", binarySha256: "a".repeat(64) },
    source: { head: "b".repeat(40), sha256: "c".repeat(64) },
    corpus: { canonicalSha256: "d".repeat(64) },
    migrations: [{ path: "apps/worker/migrations/0001_synthetic.sql", sha256: "e".repeat(64) }],
    bounds: structuredClone(BOUNDS),
  };
}

test("binding capture finish rejects boundary changes and deeply freezes accepted output", async (t) => {
  const before = captureBoundaryFixture();
  const binding = { provenance: { source: { sha256: before.source.sha256 }, entries: [{ day: ALL_DAYS[0] }] } };
  const result = finishCurrentQ1ReferenceBindingCapture({ before, after: structuredClone(before), binding });
  assert.strictEqual(result, binding);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.provenance));
  assert.ok(Object.isFrozen(result.provenance.source));
  assert.ok(Object.isFrozen(result.provenance.entries));
  assert.ok(Object.isFrozen(result.provenance.entries[0]));

  const changes = [
    ["source", (after) => { after.source.sha256 = "f".repeat(64); }],
    ["runtime", (after) => { after.runtime.binarySha256 = "f".repeat(64); }],
    ["corpus", (after) => { after.corpus.canonicalSha256 = "f".repeat(64); }],
    ["migrations", (after) => { after.migrations[0].sha256 = "f".repeat(64); }],
    ["bounds", (after) => { after.bounds.dailyConvergence++; }],
  ];
  for (const [name, mutate] of changes) {
    await t.test(`${name} changed before capture finish`, () => {
      const after = structuredClone(before);
      mutate(after);
      assert.throws(() => finishCurrentQ1ReferenceBindingCapture({ before, after, binding: {} }), {
        code: "CURRENT_Q1_SOURCE_CHANGED",
      });
    });
  }
});

test("binding scratch close failure and inode replacement fail closed", async () => {
  const closeError = new Error("synthetic close failure");
  let closeCalls = 0;
  await assert.rejects(closeCurrentQ1BindingScratch({
    vite: { async close() { closeCalls++; throw closeError; } },
    cacheRoot: null,
    cacheIdentity: null,
  }), (error) => error === closeError);
  assert.equal(closeCalls, 1);

  const stat = (ino) => ({ isDirectory: () => true, isSymbolicLink: () => false,
    uid: process.getuid(), dev: 7, ino, mode: 0o40700 });
  assert.doesNotThrow(() => assertCurrentQ1BindingScratchIdentity(stat(11), stat(11)));
  assert.throws(() => assertCurrentQ1BindingScratchIdentity(stat(11), stat(12)), {
    code: "CURRENT_Q1_CLEANUP_FAILED",
  });
});
