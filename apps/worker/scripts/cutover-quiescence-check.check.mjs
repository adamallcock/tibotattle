import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { appendFile, chmod, copyFile, lstat, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CORRECTION_RUNTIME_STAGED_STATE,
  CUTOVER_QUIESCENCE_QUERIES_SCHEMA,
  CUTOVER_QUIESCENCE_REPORT_SCHEMA,
  QUIESCENCE_ERROR_CODES,
  QUIESCENCE_GATES,
  QUIESCENCE_MAX_REFS,
  QUIESCENCE_PHASES,
  QUIESCENCE_SOURCE_ROLES,
  QUIESCENCE_STATEMENTS,
  QuiescenceCheckError,
  describeQuiescenceQueries,
  evaluateQuiescence,
  evaluateWranglerResults,
  normalizeQuiescenceFacts,
  openExportedSqlite,
  opaqueRef,
  parseQuiescenceArguments,
  parseWranglerQuiescenceResult,
  quiescenceExitCode,
  readQuiescenceFacts,
  runQuiescenceCheck,
} from "./cutover-quiescence-check.mjs";
import { CutoverSourceError, assertSelectOnly, readCutoverSeal, sha256File } from "./cutover-source-seal.mjs";
import { participantDeletionDigest } from "./cutover-source-projections.mjs";
import {
  PARTICIPANT_DELETION_FENCED_PREDICATE,
  PARTICIPANT_NOT_ACTIVE_PREDICATE,
  PARTICIPANT_NOT_QUIESCENT_PREDICATE,
  IdentityAuthorityTransferError,
  runIdentityAuthorityTransfer,
} from "./postgres-identity-authority-transfer.mjs";
import { PostgresTransferTargetError } from "./postgres-transfer-target.mjs";
import {
  forgeVariantSeal,
  headCommit,
  outputPathsOf,
  prepareSealWorld,
  sealWorld,
} from "../postgres-test/fixtures/w2-seal/seal-harness.mjs";
import {
  SYNTHETIC_IDENTITY_LINK_SECRET,
  SYNTHETIC_IDENTITY_LINK_VERSION,
  identityLinkFingerprint,
  privateDirectory,
} from "../postgres-test/fixtures/w2-seal/synthetic-sources.mjs";

// E-QUIESCE acceptance. Local only: every source is a synthetic D1 SQLite file
// built the way W2-SEAL builds its sealed fixtures (the Q-1 oracle corpus plus
// synthetic identity rows, through the D1 triggers; the deletion-ledger D1 from
// its migrations), then forged with SQL for each refusal. Nothing contacts a
// provider and nothing spawns Wrangler.
// Run: node --test ./scripts/cutover-quiescence-check.check.mjs

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(WORKER_ROOT, "scripts", "cutover-quiescence-check.mjs");
const NOW = () => new Date("2026-10-02T12:00:00.000Z");
const PIN = Object.freeze({ keyVersion: SYNTHETIC_IDENTITY_LINK_VERSION,
  secretFingerprint: identityLinkFingerprint(SYNTHETIC_IDENTITY_LINK_SECRET) });
// The oracle corpus ships with the correction runtime already activated; D1
// 0006 seeds it staged. Restore the seeded state (the immutable guard is the
// only thing that refuses it).
const STAGE_RUNTIME_SQL = `DROP TRIGGER telemetry_usage_correction_runtime_immutable;
  UPDATE telemetry_usage_correction_runtime SET state = 'staged'`;

let world;
let directory;
let counter = 0;
let clean;
let seal;
const emitted = [];

const isCode = (code) => (error) => error instanceof QuiescenceCheckError && error.code === code;
const isCutoverCode = (code) => (error) => error instanceof CutoverSourceError && error.code === code;
const statuses = (report) => Object.fromEntries(report.checks.map(item => [item.id, item.status]));
const checkOf = (report, id) => report.checks.find(item => item.id === id);
const idsOf = (report) => report.checks.map(item => item.id);

function record(report) {
  emitted.push(report);
  return report;
}

// Most cases are about what a check reports, which does not depend on the phase, and every check gates
// after the fence, so the helpers default to post-fence. The phase cases name theirs.
const POST = "post-fence";
const ANALYTICS_TABLES = Object.freeze(["analytics_source_cursors", "analytics_community_daily_queue",
  "analytics_community_terminal_watermarks"]);
const PRE = "pre-fence";
const runPre = async (options) => record(await runQuiescenceCheck({ now: NOW, phase: PRE, ...options }));
const checkPost = (options) => runQuiescenceCheck({ phase: POST, ...options });
const evaluatePost = (options) => evaluateWranglerResults({ phase: POST, ...options });

async function run(options) {
  return record(await checkPost({ now: NOW, ...options }));
}

/** A writable copy of a synthetic source, mutated with SQL. */
async function variant(path, sql) {
  counter += 1;
  const copy = join(directory, `variant-${counter}.sqlite`);
  await copyFile(path, copy);
  await chmod(copy, 0o600);
  if (sql !== undefined) {
    const database = new DatabaseSync(copy);
    try {
      database.exec("PRAGMA foreign_keys=ON");
      database.exec(sql);
    } finally {
      database.close();
    }
  }
  return copy;
}

function rowsOf(path, sql) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const statement = database.prepare(sql);
    statement.setReadBigInts(true);
    return statement.all().map(row => ({ ...row }));
  } finally {
    database.close();
  }
}

function scalar(path, sql) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(sql).get();
  } finally {
    database.close();
  }
}

/** The analytics D1: every analytics migration, in order, plus the journal delivered through its own triggers. */
async function buildAnalytics(ingestionPath, { through = Number.MAX_SAFE_INTEGER, sql } = {}) {
  counter += 1;
  const path = join(directory, `analytics-${counter}.sqlite`);
  const analytics = new DatabaseSync(path);
  const source = new DatabaseSync(ingestionPath, { readOnly: true });
  try {
    for (const name of readdirSync(join(WORKER_ROOT, "analytics-migrations")).filter(file => file.endsWith(".sql")).sort()) {
      analytics.exec(readFileSync(join(WORKER_ROOT, "analytics-migrations", name), "utf8"));
    }
    const sourceId = source.prepare("SELECT source_id FROM storage_source_state").get().source_id;
    const insert = analytics.prepare(`INSERT INTO analytics_applied_events(source_id, sequence, event_digest, owner_digest,
      revision, kind, object_digest, content_digest, authority_epoch, public_authority_epoch, recorded_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of source.prepare("SELECT * FROM storage_ingestion_changes WHERE sequence <= ? ORDER BY sequence").all(through)) {
      insert.run(sourceId, row.sequence, row.event_digest, row.owner_digest, row.revision, row.kind, row.object_digest,
        row.content_digest, row.authority_epoch, row.public_authority_epoch, row.recorded_ms);
    }
    if (sql !== undefined) analytics.exec(sql);
  } finally {
    source.close();
    analytics.close();
  }
  await chmod(path, 0o600);
  return path;
}

function cli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: WORKER_ROOT, encoding: "utf8", timeout: 120_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function envelope(rows) {
  return JSON.stringify([{ results: rows, success: true, meta: {} }]);
}

/** What `wrangler d1 execute --json` would answer for the printed statement of a role. */
function wranglerOutput(role, path) {
  return envelope(rowsOf(path, QUIESCENCE_STATEMENTS[role]).map(row => ({ ...row, v: typeof row.v === "bigint" ? Number(row.v) : row.v })));
}

async function resultFile(text) {
  counter += 1;
  const path = join(directory, `result-${counter}.json`);
  await writeFile(path, text, { mode: 0o644 });
  return path;
}

before(async () => {
  world = await prepareSealWorld({ commit: headCommit(WORKER_ROOT) });
  directory = await privateDirectory("e-quiesce-check-");
  clean = {
    ingestion: await variant(world.ingestionPath, STAGE_RUNTIME_SQL),
    ledger: await variant(world.ledgerPath),
  };
  clean.analytics = await buildAnalytics(clean.ingestion);
  const sealing = await sealWorld(world);
  const result = await sealing.run();
  seal = await readCutoverSeal({ manifestPath: outputPathsOf(sealing.out).manifest, expectedSealId: result.sealId });
});

after(async () => {
  await world?.dispose();
});

test("the statements are one read-only SELECT per role, built from the importer's own predicates", () => {
  assert.deepEqual(Object.keys(QUIESCENCE_STATEMENTS), [...QUIESCENCE_SOURCE_ROLES]);
  for (const role of QUIESCENCE_SOURCE_ROLES) {
    assert.equal(assertSelectOnly(QUIESCENCE_STATEMENTS[role]), QUIESCENCE_STATEMENTS[role], role);
    assert.ok(Buffer.byteLength(QUIESCENCE_STATEMENTS[role]) < 4096, `${role}: a statement an owner can paste`);
  }
  // PT-3's refusal predicate and its two disjuncts are the exported ones, verbatim.
  assert.equal(PARTICIPANT_NOT_QUIESCENT_PREDICATE,
    `${PARTICIPANT_NOT_ACTIVE_PREDICATE} OR ${PARTICIPANT_DELETION_FENCED_PREDICATE}`);
  assert.equal(PARTICIPANT_NOT_ACTIVE_PREDICATE, "state IS NOT 'active'");
  assert.equal(PARTICIPANT_DELETION_FENCED_PREDICATE, "deletion_session_id IS NOT NULL");
  const ingestion = QUIESCENCE_STATEMENTS.ingestion;
  assert.ok(ingestion.includes(`FROM participants WHERE ${PARTICIPANT_NOT_QUIESCENT_PREDICATE}\n`));
  assert.ok(ingestion.includes(`FROM participants WHERE ${PARTICIPANT_NOT_ACTIVE_PREDICATE}\n`));
  assert.ok(ingestion.includes(`FROM participants WHERE ${PARTICIPANT_DELETION_FENCED_PREDICATE}\n`));
  // The documented read-only mode runs exactly these statements.
  const printed = JSON.parse(describeQuiescenceQueries());
  assert.equal(printed.schema, CUTOVER_QUIESCENCE_QUERIES_SCHEMA);
  assert.deepEqual(printed.queries.map(item => item.role), [...QUIESCENCE_SOURCE_ROLES]);
  for (const item of printed.queries) assert.equal(item.sql, QUIESCENCE_STATEMENTS[item.role]);
  assert.equal(describeQuiescenceQueries({ role: "deletion-ledger", sql: true }), QUIESCENCE_STATEMENTS["deletion-ledger"]);
});

test("the predicates are imported, never copied: PT-3 builds its refusal from the exported constant", () => {
  const importer = readFileSync(join(WORKER_ROOT, "scripts", "postgres-identity-authority-transfer.mjs"), "utf8");
  assert.ok(importer.includes("WHERE ${PARTICIPANT_NOT_QUIESCENT_PREDICATE}`"), "PT-3's assertion interpolates the constant");
  assert.equal(importer.split("deletion_session_id IS NOT NULL").length - 1, 1, "the literal exists once, in its definition");
  assert.equal(importer.split("state IS NOT 'active'").length - 1, 1);
  const checker = readFileSync(SCRIPT, "utf8");
  for (const copied of ["deletion_session_id IS NOT NULL", "state IS NOT 'active'", "deletion-tombstone/v1", "createHash(\"sha256\").update(`${PARTICIPANT"]) {
    assert.equal(checker.includes(copied), false, `the checker does not copy: ${copied}`);
  }
  assert.ok(/from "\.\/postgres-identity-authority-transfer\.mjs"/u.test(checker));
  assert.ok(/countParticipantDeletionMatches,\s*\n\s*readDeletionDigestsFromDatabase,/u.test(checker));
  // The checker never writes: no mutation statement and no database write verb in its source.
  for (const verb of [/\bINSERT\s+INTO\b/iu, /\bUPDATE\s+\w+\s+SET\b/iu, /\bDELETE\s+FROM\b/iu, /\bspawn(?:Sync)?\(/u,
    /\bexecFile(?:Sync)?\(/u, /\bfetch\(/u, /\bwriteFile\(/u]) {
    assert.equal(verb.test(checker.replace(/^\/\/.*$/gmu, "")), false, String(verb));
  }
});

test("a clean source, with all three inputs, is quiescent and every check is clear", async () => {
  const report = await run({ ingestion: clean.ingestion, ledger: clean.ledger, analytics: clean.analytics });
  assert.equal(report.schema, CUTOVER_QUIESCENCE_REPORT_SCHEMA);
  assert.equal(report.mode, "sqlite");
  assert.equal(report.checkedAt, "2026-10-02T12:00:00.000Z");
  assert.equal(report.verdict, "quiescent");
  assert.deepEqual(report.blocked, []);
  assert.deepEqual(report.notEvaluated, []);
  assert.equal(quiescenceExitCode(report), 0);
  assert.deepEqual(idsOf(report), ["participants-quiescent", "deletion-digest-intersection", "owner-links-erased",
    "pending-quarantine-registrations", "correction-runtime", "pending-erasure-jobs", "analytics-delivery"]);
  for (const item of report.checks) assert.equal(item.status, "clear", item.id);
  assert.deepEqual(checkOf(report, "participants-quiescent").counts,
    { participants: 6, notQuiescent: 0, deleting: 0, deletionFenced: 0, stateUnrecognized: 0 });
  assert.deepEqual(checkOf(report, "deletion-digest-intersection").counts,
    { participants: 6, deletionDigests: world.digests.length, matches: 0 });
  assert.deepEqual(checkOf(report, "owner-links-erased").counts, { ownerLinks: 4, erased: 0, withdrawn: 0 });
  assert.deepEqual(checkOf(report, "pending-quarantine-registrations").counts,
    { registrations: 0, registered: 0, deleting: 0, oldestRegisteredAt: null });
  assert.deepEqual(checkOf(report, "correction-runtime").counts,
    { runtimeRows: 1, runtimeState: CORRECTION_RUNTIME_STAGED_STATE, facts: 0, history: 0 });
  assert.deepEqual(checkOf(report, "pending-erasure-jobs").counts,
    { jobs: 1, pending: 0, complete: 1, pendingParticipants: 0, tombstones: world.digests.length });
  const delivery = checkOf(report, "analytics-delivery").counts;
  assert.equal(delivery.sources.length, 1);
  assert.deepEqual({ ...delivery.sources[0], sourceRef: undefined },
    { sourceRef: undefined, journalMax: 6, deliveredCursor: 6, undelivered: 0, cursorAheadBy: 0, queueRows: 0,
      sourceTerminalEpoch: 0, deliveredTerminalEpoch: 0, terminalUndelivered: false });
  assert.match(delivery.sources[0].sourceRef, /^[0-9a-f]{16}$/u);
  assert.equal(delivery.analyticsCursorsWithoutIngestionSource, 0);
  assert.equal(delivery.analyticsQueueRowsWithoutIngestionSource, 0);
  for (const entry of report.sources) assert.equal(entry.supplied, true);
  assert.deepEqual(report.sources.map(entry => entry.kind), ["exported", "exported", "exported"]);
  for (const entry of report.sources) assert.match(entry.sha256, /^[0-9a-f]{64}$/u);
  for (const item of report.checks) {
    assert.ok(item.refusals.length >= 1 && item.requires.length >= 1, item.id);
    assert.equal(Object.hasOwn(item, "note"), false, "a clear check carries no cure note");
  }
});

test("an input that is not supplied leaves its checks not-evaluated, never clear", async () => {
  const cases = [
    [{ ingestion: clean.ingestion }, ["deletion-digest-intersection", "pending-erasure-jobs", "analytics-delivery"],
      { "deletion-digest-intersection": "ledger-not-supplied", "pending-erasure-jobs": "ledger-not-supplied",
        "analytics-delivery": "analytics-not-supplied" }],
    [{ ingestion: clean.ingestion, ledger: clean.ledger },
      ["analytics-delivery"], { "analytics-delivery": "analytics-not-supplied" }],
    [{ ledger: clean.ledger }, ["participants-quiescent", "deletion-digest-intersection", "owner-links-erased",
      "pending-quarantine-registrations", "correction-runtime", "analytics-delivery"],
    { "participants-quiescent": "ingestion-not-supplied", "deletion-digest-intersection": "ingestion-not-supplied",
      "analytics-delivery": "ingestion-not-supplied" }],
    [{ analytics: clean.analytics }, ["participants-quiescent", "deletion-digest-intersection", "owner-links-erased",
      "pending-quarantine-registrations", "correction-runtime", "pending-erasure-jobs", "analytics-delivery"],
    { "pending-erasure-jobs": "ledger-not-supplied", "analytics-delivery": "ingestion-not-supplied" }],
  ];
  for (const [options, expected, reasons] of cases) {
    const report = await run(options);
    assert.equal(report.verdict, "incomplete", JSON.stringify(Object.keys(options)));
    assert.deepEqual(report.blocked, []);
    assert.deepEqual(report.notEvaluated, expected, JSON.stringify(Object.keys(options)));
    assert.equal(quiescenceExitCode(report), 3);
    for (const [id, reason] of Object.entries(reasons)) assert.equal(checkOf(report, id).reason, reason, id);
    for (const id of expected) assert.equal(Object.hasOwn(checkOf(report, id), "counts"), false, `${id} reports no count`);
    const supplied = { ingestion: "ingestion", "deletion-ledger": "ledger", analytics: "analytics" };
    for (const role of QUIESCENCE_SOURCE_ROLES) {
      assert.equal(report.sources.find(entry => entry.role === role).supplied, options[supplied[role]] !== undefined, role);
    }
  }
  // Blocked outranks incomplete: a blocker in the supplied input wins over the missing ones.
  const blocked = await run({ ingestion: await variant(clean.ingestion, `UPDATE participants SET state = 'deleting'
    WHERE id = '${world.fixture.ids.participant}'`) });
  assert.equal(blocked.verdict, "blocked");
  assert.equal(quiescenceExitCode(blocked), 2);
  assert.ok(blocked.notEvaluated.length > 0);
});

// ---------------------------------------------------------------------------
// Participants: PT-3's quiescence refusal.

const participantId = () => world.fixture.ids.participant;
// A participant with a v1.1 owner link: changing its state also moves the journal.
const linkedParticipantId = () => scalar(clean.ingestion, "SELECT participant_id FROM storage_v11_owner_links ORDER BY participant_id LIMIT 1")
  .participant_id;
const PARTICIPANT_CASES = Object.freeze([
  ["deleting with its deletion fence", () => `UPDATE participants SET state = 'deleting', deletion_session_id = '${randomUUID()}'
    WHERE id = '${participantId()}'`, { notQuiescent: 1, deleting: 1, deletionFenced: 1, stateUnrecognized: 0 }],
  ["deleting with a NULL fence (a restore replay owns it)", () => `UPDATE participants SET state = 'deleting'
    WHERE id = '${participantId()}'`, { notQuiescent: 1, deleting: 1, deletionFenced: 0, stateUnrecognized: 0 }],
  ["active with a fence left on it", () => `UPDATE participants SET deletion_session_id = '${randomUUID()}'
    WHERE id = '${participantId()}'`, { notQuiescent: 1, deleting: 0, deletionFenced: 1, stateUnrecognized: 0 }],
  ["a state the D1 schema does not admit", () => `PRAGMA ignore_check_constraints = ON;
    UPDATE participants SET state = 'zombie' WHERE id = '${participantId()}'`,
  { notQuiescent: 1, deleting: 0, deletionFenced: 0, stateUnrecognized: 1 }],
]);

test("participants that are not quiescent block, with counts and an opaque reference, for each PT-3 refusal shape", async () => {
  for (const [name, sql, expected] of PARTICIPANT_CASES) {
    const report = await run({ ingestion: await variant(clean.ingestion, sql()), ledger: clean.ledger, analytics: undefined });
    assert.equal(report.verdict, "blocked", name);
    assert.ok(report.blocked.includes("participants-quiescent"), name);
    const item = checkOf(report, "participants-quiescent");
    assert.equal(item.status, "blocked", name);
    assert.deepEqual(item.counts, { participants: 6, ...expected }, name);
    assert.deepEqual(item.refs, [opaqueRef("participant", participantId())], name);
    assert.equal(item.refsTruncated, false);
    assert.equal(item.refusals[0].code, "CUTOVER_PARTICIPANT_ERASURE_PENDING");
    assert.ok(item.note.length > 0, "a blocked check names its cure");
    assert.equal(quiescenceExitCode(report), 2);
  }
  // A participant outside the schema's states is also what PT-2-lite's intersection refuses.
  const zombie = checkOf(await run({ ingestion: await variant(clean.ingestion, PARTICIPANT_CASES[3][1]()), ledger: clean.ledger }),
    "deletion-digest-intersection");
  assert.equal(zombie.status, "blocked");
  assert.equal(zombie.refused, "CUTOVER_PROJECTION_INVALID");
  assert.equal(zombie.counts, null);
});

test("the refusals are PT-3's: the same forged sources are refused by PT-3 after the seal and reported before it", async () => {
  // A clean seal (staged runtime) passes every PT-3 source check; the
  // unregistered handle is then refused by PT-1, so no database was reached.
  const cleanSeal = await forgeVariantSeal(seal, STAGE_RUNTIME_SQL);
  await assert.rejects(runIdentityAuthorityTransfer({ handle: { sealManifestSha256: cleanSeal.sealId },
    sealManifestPath: cleanSeal.manifestPath, identityLinkPin: PIN }),
  error => error instanceof PostgresTransferTargetError && error.code === "CUTOVER_TARGET_HANDLE_INVALID");
  const sealed = await run({ seal: cleanSeal.manifestPath, sealId: cleanSeal.sealId });
  assert.deepEqual(statuses(sealed), { "participants-quiescent": "clear", "deletion-digest-intersection": "clear",
    "owner-links-erased": "clear", "pending-quarantine-registrations": "clear", "correction-runtime": "clear",
    "pending-erasure-jobs": "clear", "analytics-delivery": "not-evaluated" });

  const refused = async (forged, code) => assert.rejects(runIdentityAuthorityTransfer({
    handle: { sealManifestSha256: forged.sealId }, sealManifestPath: forged.manifestPath, identityLinkPin: PIN }),
  error => (error instanceof IdentityAuthorityTransferError || error instanceof PostgresTransferTargetError
    || error instanceof CutoverSourceError) && error.code === code);

  for (const [name, sql] of PARTICIPANT_CASES) {
    const forged = await forgeVariantSeal(seal, `${STAGE_RUNTIME_SQL}; ${sql()}`);
    await refused(forged, "CUTOVER_PARTICIPANT_ERASURE_PENDING");
    const report = await run({ seal: forged.manifestPath, sealId: forged.sealId });
    assert.equal(statuses(report)["participants-quiescent"], "blocked", name);
    assert.equal(checkOf(report, "participants-quiescent").counts.notQuiescent, 1, name);
    assert.deepEqual(report.sources.filter(entry => entry.supplied).map(entry => entry.kind), ["sealed", "sealed"]);
    assert.equal(report.sources[0].sealId, forged.sealId);
  }

  // The do-not-restore rule: an active participant whose digest the ledger records.
  const tombstone = digest => `INSERT INTO deletion_tombstones(participant_digest, schema_version, deleted_at, retain_until)
    VALUES ('${digest}', 'participant-deletion-tombstone-v0.1', '2026-09-01T00:00:00.000Z', '2027-09-01T00:00:00.000Z')`;
  const restored = await forgeVariantSeal(seal, tombstone(participantDeletionDigest(participantId())), "deletion-ledger");
  await refused(restored, "CUTOVER_ERASED_PARTICIPANT_PRESENT");
  const reported = await run({ seal: restored.manifestPath, sealId: restored.sealId });
  assert.equal(statuses(reported)["deletion-digest-intersection"], "blocked");
  assert.deepEqual(checkOf(reported, "deletion-digest-intersection").counts,
    { participants: 6, deletionDigests: world.digests.length + 1, matches: 1 });
  assert.equal(statuses(reported)["participants-quiescent"], "clear", "an active participant is quiescent; only the digest refuses it");

  // The seal's own projection refuses a malformed ledger digest; the check reports it.
  const malformed = await forgeVariantSeal(seal, `PRAGMA ignore_check_constraints = ON; ${tombstone("NOT-A-DIGEST")}`, "deletion-ledger");
  await refused(malformed, "CUTOVER_PROJECTION_INVALID");
  const malformedReport = await run({ seal: malformed.manifestPath, sealId: malformed.sealId });
  assert.equal(checkOf(malformedReport, "deletion-digest-intersection").status, "blocked");
  assert.equal(checkOf(malformedReport, "deletion-digest-intersection").refused, "CUTOVER_PROJECTION_INVALID");
});

test("a sealed source that changed after the seal is refused with the seal's own code", async () => {
  const forged = await forgeVariantSeal(seal, STAGE_RUNTIME_SQL);
  const path = join(forged.directory, "ingestion.sealed.sqlite");
  await chmod(path, 0o600);
  await appendFile(path, Buffer.from([0]));
  await chmod(path, 0o400);
  await assert.rejects(checkPost({ seal: forged.manifestPath, sealId: forged.sealId, now: NOW }),
    isCutoverCode("CUTOVER_SEALED_SOURCE_CHANGED"));
  await assert.rejects(checkPost({ seal: forged.manifestPath, sealId: "0".repeat(64), now: NOW }),
    isCutoverCode("CUTOVER_SEAL_MANIFEST_INVALID"));
  await assert.rejects(checkPost({ seal: forged.manifestPath, now: NOW }), isCutoverCode("CUTOVER_ARGUMENT_INVALID"));
});

test("the do-not-restore intersection blocks a participant that is both mid-erasure and tombstoned", async () => {
  const tombstoneSql = `INSERT INTO deletion_tombstones(participant_digest, schema_version, deleted_at, retain_until)
    VALUES ('${participantDeletionDigest(participantId())}', 'participant-deletion-tombstone-v0.1',
      '2026-09-01T00:00:00.000Z', '2027-09-01T00:00:00.000Z')`;
  const report = await run({
    ingestion: await variant(clean.ingestion, `UPDATE participants SET state = 'deleting',
      deletion_session_id = '${randomUUID()}' WHERE id = '${participantId()}'`),
    ledger: await variant(clean.ledger, tombstoneSql),
  });
  assert.deepEqual(report.blocked, ["participants-quiescent", "deletion-digest-intersection"]);
  const reference = opaqueRef("participant", participantId());
  assert.deepEqual(checkOf(report, "participants-quiescent").refs, [reference]);
  assert.deepEqual(checkOf(report, "deletion-digest-intersection").refs, [reference], "one reference joins the two findings");
  assert.equal(checkOf(report, "deletion-digest-intersection").counts.matches, 1);
});

// ---------------------------------------------------------------------------
// Objects: links, quarantine registrations, the correction runtime, erasure jobs.

test("an owner link already marked erased blocks, with a reference", async () => {
  const report = await run({ ingestion: await variant(clean.ingestion,
    `UPDATE storage_v11_owner_links SET state = 'erased' WHERE participant_id = '${linkedParticipantId()}'`) });
  const item = checkOf(report, "owner-links-erased");
  assert.equal(item.status, "blocked");
  assert.deepEqual(item.counts, { ownerLinks: 4, erased: 1, withdrawn: 0 });
  assert.deepEqual(item.refs, [opaqueRef("participant", linkedParticipantId())]);
  assert.deepEqual(item.refusals[0], { stage: "PT-8 preflight P5", code: "CUTOVER_OWNER_LINK_ERASED", implemented: true });
});

test("pending quarantine registrations block, split by state, with the oldest timestamp and references", async () => {
  const report = await run({ ingestion: await variant(clean.ingestion, `
    INSERT INTO pending_quarantine_objects(r2_key, contribution_id, object_kind, registered_at)
      VALUES ('telemetry/synthetic-object-a', 'synthetic-contribution-a', 'telemetry', '2026-10-02T10:00:00.000Z');
    INSERT INTO pending_quarantine_objects(r2_key, contribution_id, object_kind, registered_at,
        reconciliation_state, reconciliation_lease_id)
      VALUES ('synthetic/synthetic-object-b', 'synthetic-contribution-b', 'synthetic', '2026-10-02T11:00:00.000Z',
        'deleting', 'synthetic-lease')`) });
  const item = checkOf(report, "pending-quarantine-registrations");
  assert.equal(item.status, "blocked");
  assert.deepEqual(item.counts, { registrations: 2, registered: 1, deleting: 1, oldestRegisteredAt: "2026-10-02T10:00:00.000Z" });
  // PT-4 maps the sealed registrations and E-PT8's post-import refuses a mapping mismatch.
  assert.deepEqual(item.refusals, [{ stage: "PT-4 pending-registrations, E-PT8 post-import",
    code: "CUTOVER_PENDING_OBJECT_CONFLICT", implemented: true }]);
  assert.deepEqual(item.refs, [opaqueRef("quarantine-registration", "synthetic-contribution-a"),
    opaqueRef("quarantine-registration", "synthetic-contribution-b")]);
  assert.equal(report.verdict, "blocked");
});

test("the correction runtime blocks unless it is the one staged row with no correction facts", async () => {
  // The oracle corpus's activated runtime.
  const active = await run({ ingestion: world.ingestionPath });
  assert.deepEqual(checkOf(active, "correction-runtime").counts, { runtimeRows: 1, runtimeState: "active", facts: 0, history: 0 });
  assert.equal(checkOf(active, "correction-runtime").status, "blocked");
  assert.equal(checkOf(active, "correction-runtime").refusals[0].code, "CUTOVER_CORRECTION_RUNTIME_ACTIVE");
  assert.equal(checkOf(active, "correction-runtime").refusals[0].implemented, true, "E-PT8 preflight P4 refuses it");

  // Staged, with one archived correction (the history trigger adds its fact).
  const history = `INSERT INTO telemetry_usage_correction_history(id, participant_id, owner_digest, owner_revision,
      authority_epoch, source_format, namespace_id, owner_id, device_id, chunk_id, manifest_id, source_storage_row_id,
      source_row_id, occurrence_id, event_time_ms, provider_id, session_id, model_id, speed_mode_id, api_service_tier_id,
      surface_id, billing_surface_id, reasoning_effort_id, agent_scope_id, outcome_id, attribution_id,
      total_input_context_tokens, input_uncached_tokens, input_cache_read_tokens, input_cache_write_tokens,
      output_text_tokens, output_reasoning_tokens, output_combined_tokens, source_chunk_digest, source_event_digest,
      record_digest, base_digest, captured_at_ms)
    VALUES (1, '${participantId()}', zeroblob(32), 1, 1, 10, 1, 1, 1, 1, NULL, 1, 1, zeroblob(8), 1, 1, 1, 1, 1, 1, 1, 1,
      1, 1, 1, NULL, 1, 1, 1, 1, 1, 1, 1, zeroblob(32), zeroblob(32), zeroblob(32), zeroblob(32), 5)`;
  const archived = await run({ ingestion: await variant(clean.ingestion, `
    DROP TRIGGER telemetry_usage_correction_history_provenance;
    DROP TRIGGER telemetry_usage_correction_fact_provenance;
    ${history}`) });
  assert.deepEqual(checkOf(archived, "correction-runtime").counts,
    { runtimeRows: 1, runtimeState: "staged", facts: 1, history: 1 });
  assert.equal(checkOf(archived, "correction-runtime").status, "blocked");

  // No runtime row at all (D1 always seeds it): neither staged nor clear.
  const missing = await run({ ingestion: await variant(clean.ingestion, `
    DROP TRIGGER telemetry_usage_correction_runtime_retained; DELETE FROM telemetry_usage_correction_runtime`) });
  assert.deepEqual(checkOf(missing, "correction-runtime").counts,
    { runtimeRows: 0, runtimeState: null, facts: 0, history: 0 });
  assert.equal(checkOf(missing, "correction-runtime").status, "blocked");
});

test("unfinished erasure jobs in the deletion ledger block, by job and by participant", async () => {
  const [first, second] = world.digests;
  const job = (digest, source) => `INSERT INTO storage_erasure_jobs(participant_digest, source_id, owner_digest,
    source_namespace, state, attempted_ms) VALUES ('${digest}', '${source}', '${"a".repeat(64)}', 'synthetic-namespace', 'pending', 0)`;
  const one = await run({ ledger: await variant(clean.ledger, job(first, "synthetic-source-a")) });
  const single = checkOf(one, "pending-erasure-jobs");
  assert.equal(single.status, "blocked");
  assert.deepEqual(single.counts, { jobs: 2, pending: 1, complete: 1, pendingParticipants: 1, tombstones: world.digests.length });
  assert.equal(single.refs.length, 1);
  const two = await run({ ledger: await variant(clean.ledger, `${job(first, "synthetic-source-a")};
    ${job(first, "synthetic-source-b")}; ${job(second, "synthetic-source-a")}`) });
  assert.deepEqual(checkOf(two, "pending-erasure-jobs").counts,
    { jobs: 4, pending: 3, complete: 1, pendingParticipants: 2, tombstones: world.digests.length });
  assert.equal(new Set(checkOf(two, "pending-erasure-jobs").refs).size, 3, "three distinct jobs, three distinct references");
  assert.equal(two.verdict, "blocked");
});

// ---------------------------------------------------------------------------
// Analytics delivery.

test("analytics delivery: behind, ahead, absent and foreign cursors are measured against the journal", async () => {
  const journalMax = Number(scalar(clean.ingestion, "SELECT max(sequence) AS m FROM storage_ingestion_changes").m);
  assert.equal(journalMax, 6);
  const deliveryOf = async (analytics) => checkOf(await run({ ingestion: clean.ingestion, analytics }), "analytics-delivery");
  const sources = (item) => item.counts.sources.map(row => ({ ...row, sourceRef: undefined }));
  const drained = { queueRows: 0, sourceTerminalEpoch: 0, deliveredTerminalEpoch: 0, terminalUndelivered: false };

  const behind = await deliveryOf(await buildAnalytics(clean.ingestion, { through: 4 }));
  assert.equal(behind.status, "blocked");
  assert.deepEqual(sources(behind), [{ sourceRef: undefined, journalMax: 6, deliveredCursor: 4, undelivered: 2, cursorAheadBy: 0,
    ...drained }]);

  const ahead = await deliveryOf(await buildAnalytics(clean.ingestion, { sql: "UPDATE analytics_source_cursors SET sequence = 9" }));
  assert.equal(ahead.status, "blocked");
  assert.deepEqual(sources(ahead), [{ sourceRef: undefined, journalMax: 6, deliveredCursor: 9, undelivered: 0, cursorAheadBy: 3,
    ...drained }]);

  const absent = await deliveryOf(await buildAnalytics(clean.ingestion, { through: 0 }));
  assert.equal(absent.status, "blocked", "a source with no cursor row has delivered nothing");
  assert.deepEqual(sources(absent), [{ sourceRef: undefined, journalMax: 6, deliveredCursor: 0, undelivered: 6, cursorAheadBy: 0,
    ...drained }]);

  const foreign = await deliveryOf(await buildAnalytics(clean.ingestion, { sql: `INSERT INTO analytics_source_cursors(source_id, sequence,
    authority_epoch) VALUES ('synthetic-other-source', 3, 1)` }));
  assert.equal(foreign.status, "clear");
  assert.equal(foreign.counts.analyticsCursorsWithoutIngestionSource, 1);

  const complete = await deliveryOf(clean.analytics);
  assert.equal(complete.status, "clear");
  assert.deepEqual(complete.refusals.map(({ stage, code, implemented }) => ({ stage, code, implemented })), [
    { stage: "D1 analytics export oracle", code: "ANALYTICS_EXPORT_NOT_QUIESCENT", implemented: true },
    { stage: "HX-6 drain, EP-8 attestation", code: null, implemented: false },
  ]);
});

const ingestionSourceId = () => scalar(clean.ingestion, "SELECT source_id FROM storage_source_state").source_id;
const TERMINAL_KINDS = "kind IN ('owner-withdrawn', 'owner-erased')";

test("analytics delivery: the daily queue and the terminal epoch are measured the way the drain proof measures them", async () => {
  const deliveryOf = async (ingestion, analytics) => checkOf(await run({ ingestion, analytics }), "analytics-delivery");
  const row = (item) => ({ ...item.counts.sources[0], sourceRef: undefined });

  // Pending daily-publication work (the oracle's queue_rows) blocks, with the cursor at the journal maximum.
  const queued = await deliveryOf(clean.ingestion, await buildAnalytics(clean.ingestion, { sql: `
    INSERT INTO analytics_community_daily_queue(source_id, day, revision) VALUES ('${ingestionSourceId()}', '2026-10-01', 1);
    INSERT INTO analytics_community_daily_queue(source_id, day, revision) VALUES ('${ingestionSourceId()}', '2026-10-02', 1)` }));
  assert.equal(queued.status, "blocked");
  assert.equal(row(queued).queueRows, 2);
  assert.equal(row(queued).undelivered, 0, "the cursor itself is at the journal maximum");
  assert.equal(row(queued).cursorAheadBy, 0);
  assert.equal(queued.counts.analyticsQueueRowsWithoutIngestionSource, 0);

  // Queue rows of a source the ingestion does not name are counted, not blocking (the oracle proves one source).
  const foreign = await deliveryOf(clean.ingestion, await buildAnalytics(clean.ingestion, { sql: `
    INSERT INTO analytics_community_daily_queue(source_id, day, revision) VALUES ('synthetic-other-source', '2026-10-01', 1)` }));
  assert.equal(foreign.status, "clear");
  assert.equal(row(foreign).queueRows, 0);
  assert.equal(foreign.counts.analyticsQueueRowsWithoutIngestionSource, 1);

  // A terminal (owner-erased) the source has journaled: delivered through the analytics triggers it is clear...
  const erased = await variant(clean.ingestion, "UPDATE storage_v11_owner_links SET state = 'erased'");
  const sourceTerminal = Number(scalar(erased, `SELECT COALESCE(MAX(public_authority_epoch), 0) AS n
    FROM storage_ingestion_changes WHERE ${TERMINAL_KINDS}`).n);
  assert.ok(sourceTerminal > 0, "the fixture journals a terminal with a public authority epoch");
  const delivered = await deliveryOf(erased, await buildAnalytics(erased));
  assert.equal(delivered.status, "clear");
  assert.equal(row(delivered).sourceTerminalEpoch, sourceTerminal);
  assert.equal(row(delivered).deliveredTerminalEpoch, sourceTerminal);
  assert.equal(row(delivered).terminalUndelivered, false);

  // ...and when the watermark is behind while the cursor is at the journal maximum, it blocks on the epoch alone.
  const lagging = await deliveryOf(erased, await buildAnalytics(erased, { sql: `
    DROP TRIGGER analytics_terminal_watermark_monotonic;
    UPDATE analytics_community_terminal_watermarks SET terminal_public_authority_epoch = 0` }));
  assert.equal(lagging.status, "blocked");
  assert.deepEqual(row(lagging), { sourceRef: undefined, journalMax: row(lagging).journalMax, deliveredCursor: row(lagging).journalMax,
    undelivered: 0, cursorAheadBy: 0, queueRows: 0, sourceTerminalEpoch: sourceTerminal, deliveredTerminalEpoch: 0,
    terminalUndelivered: true });
  // No watermark row at all has delivered no terminal either (the Worker's helper reads 0).
  const none = await deliveryOf(erased, await buildAnalytics(erased, { sql: `
    DROP TRIGGER analytics_terminal_watermark_retained;
    DELETE FROM analytics_community_terminal_watermarks` }));
  assert.equal(none.status, "blocked");
  assert.equal(row(none).deliveredTerminalEpoch, 0);
  assert.equal(row(none).terminalUndelivered, true);
  // A delivered terminal ahead of the source's is not a refusal: the target's own erasure fences raise it too.
  const ahead = await deliveryOf(erased, await buildAnalytics(erased, { sql: `
    UPDATE analytics_community_terminal_watermarks SET terminal_public_authority_epoch = ${sourceTerminal + 5}` }));
  assert.equal(ahead.status, "clear");
  assert.equal(row(ahead).terminalUndelivered, false);
});

test("analytics delivery states what it covers: the drain proof's other reasons are named, and pinned to the proof's source", () => {
  const oracle = readFileSync(join(WORKER_ROOT, "src", "d1-analytics-export-oracle.ts"), "utf8");
  const proof = oracle.slice(oracle.indexOf("async function proveQuiescence"), oracle.indexOf("// (c) live cohort"));
  assert.ok(proof.length > 200);
  const reasons = new Set([...proof.matchAll(/reasons\.push\('([a-z_]+)'\)|\['([a-z_]+)'\]\)/gu)].map(match => match[1] ?? match[2]));
  const report = evaluateQuiescence({ mode: "sqlite", phase: POST, now: NOW, facts: {
    ingestion: readQuiescenceFacts("ingestion", new DatabaseSync(clean.ingestion, { readOnly: true })),
    analytics: readQuiescenceFacts("analytics", new DatabaseSync(clean.analytics, { readOnly: true })),
  } });
  const item = checkOf(report, "analytics-delivery");
  const covered = item.refusals.find(entry => entry.code === "ANALYTICS_EXPORT_NOT_QUIESCENT").reasons;
  assert.deepEqual([...covered], ["cursor_not_at_journal_max", "queue_rows", "terminal_undelivered"]);
  assert.deepEqual([...item.notCovered], ["cursor_receipt", "cache_retention_incomplete", "stale_head"]);
  // Every reason the proof can give is covered here, reported as not covered, or the pending-erasure-jobs check's.
  assert.deepEqual([...reasons].sort(), [...covered, ...item.notCovered, "erasure_jobs_pending"].sort());
  assert.ok(proof.includes("FROM storage_erasure_jobs WHERE state='pending'"), "pending-erasure-jobs reads the proof's predicate");
  // The statements read what the Worker's own helpers and the proof read.
  const authority = readFileSync(join(WORKER_ROOT, "src", "storage-community-authority.ts"), "utf8").replace(/\s+/gu, " ");
  const flat = (text) => text.replace(/\s+/gu, " ");
  const ingestionSql = flat(QUIESCENCE_STATEMENTS.ingestion);
  const analyticsSql = flat(QUIESCENCE_STATEMENTS.analytics);
  const sourceTerminal = "SELECT COALESCE(MAX(public_authority_epoch),0) AS epoch FROM storage_ingestion_changes "
    + "WHERE kind IN('owner-withdrawn','owner-erased')";
  assert.ok(authority.includes(sourceTerminal), "readStorageCommunitySourceTerminalEpoch still reads this");
  assert.ok(ingestionSql.includes(sourceTerminal));
  assert.ok(authority.includes("SELECT terminal_public_authority_epoch AS epoch FROM analytics_community_terminal_watermarks WHERE source_id=?"));
  assert.ok(analyticsSql.includes("SELECT source_id, terminal_public_authority_epoch FROM analytics_community_terminal_watermarks"));
  assert.ok(flat(proof).includes("FROM analytics_community_daily_queue WHERE source_id=?"));
  assert.ok(analyticsSql.includes("FROM analytics_community_daily_queue GROUP BY source_id"));
});

test("an ingestion source with no source-state row has no journal to measure and is not-evaluated", async () => {
  const facts = rowsOf(clean.ingestion, QUIESCENCE_STATEMENTS.ingestion)
    .filter(row => row.c !== "journal" && row.c !== "journal_terminal");
  const report = evaluateQuiescence({ mode: "wrangler-results", phase: POST, now: NOW, facts: {
    ingestion: normalizeQuiescenceFacts("ingestion", facts),
    analytics: readQuiescenceFacts("analytics", new DatabaseSync(clean.analytics, { readOnly: true })),
  } });
  assert.equal(checkOf(report, "analytics-delivery").status, "not-evaluated");
  assert.equal(checkOf(report, "analytics-delivery").reason, "source-state-absent");
});

// ---------------------------------------------------------------------------
// Phases: what gates the verdict and the exit status.

/** A healthy live source: in-flight quarantine, a lagging delivery cursor, an erased link and the active runtime. */
async function liveSourceNoise(extraSql = "") {
  const ingestion = await variant(world.ingestionPath, `UPDATE storage_v11_owner_links SET state = 'erased';
    INSERT INTO pending_quarantine_objects(r2_key, contribution_id, object_kind, registered_at)
    VALUES ('telemetry/synthetic-object-live', 'synthetic-contribution-live', 'telemetry', '2026-10-02T11:59:00.000Z');
    ${extraSql}`);
  return { ingestion, ledger: clean.ledger, analytics: await buildAnalytics(ingestion, { through: 4 }) };
}
const INFORMATIONAL_BEFORE_THE_FENCE = Object.freeze(["owner-links-erased", "pending-quarantine-registrations",
  "correction-runtime", "analytics-delivery"]);
const GATING_BEFORE_THE_FENCE = Object.freeze(["participants-quiescent", "deletion-digest-intersection", "pending-erasure-jobs"]);

test("the gates are closed: before the fence only the unfinished erasure state gates, after it every check does", () => {
  assert.deepEqual([...QUIESCENCE_PHASES], ["pre-fence", "post-fence"]);
  assert.deepEqual(Object.keys(QUIESCENCE_GATES), ["participants-quiescent", "deletion-digest-intersection", "owner-links-erased",
    "pending-quarantine-registrations", "correction-runtime", "pending-erasure-jobs", "analytics-delivery"]);
  assert.equal(Object.isFrozen(QUIESCENCE_GATES), true);
  const gating = (phase) => Object.entries(QUIESCENCE_GATES).filter(([, gates]) => gates[phase] === "gating").map(([id]) => id);
  assert.deepEqual(gating("pre-fence"), ["participants-quiescent", "deletion-digest-intersection", "pending-erasure-jobs"]);
  assert.deepEqual(gating("post-fence"), Object.keys(QUIESCENCE_GATES), "after the fence nothing is advisory");
  for (const [id, gates] of Object.entries(QUIESCENCE_GATES)) {
    assert.deepEqual(Object.keys(gates), ["pre-fence", "post-fence"], id);
    assert.equal(Object.isFrozen(gates), true, id);
    for (const value of Object.values(gates)) assert.ok(["gating", "informational"].includes(value), id);
  }
});

test("before the fence a healthy live source is quiescent: the in-flight state is advisory and does not move the exit status", async () => {
  const live = await liveSourceNoise();
  const report = await runPre(live);
  assert.equal(report.phase, "pre-fence");
  assert.equal(report.verdict, "quiescent");
  assert.equal(quiescenceExitCode(report), 0);
  assert.deepEqual(report.gating, GATING_BEFORE_THE_FENCE);
  assert.deepEqual(report.blocked, []);
  assert.deepEqual(report.notEvaluated, []);
  assert.deepEqual(report.advisory, { blocked: INFORMATIONAL_BEFORE_THE_FENCE, notEvaluated: [] });
  // Every finding is still evaluated and reported in full, and marked with the gate it carries.
  for (const id of INFORMATIONAL_BEFORE_THE_FENCE) {
    const item = checkOf(report, id);
    assert.equal(item.status, "blocked", id);
    assert.equal(item.gate, "informational", id);
    assert.ok(item.counts !== undefined, id);
  }
  for (const id of GATING_BEFORE_THE_FENCE) {
    assert.equal(checkOf(report, id).status, "clear", id);
    assert.equal(checkOf(report, id).gate, "gating", id);
  }
  assert.equal(checkOf(report, "pending-quarantine-registrations").counts.registered, 1);
  assert.equal(checkOf(report, "analytics-delivery").counts.sources[0].undelivered > 0, true);
});

test("after the fence the same source is blocked on every finding the pre-fence run called advisory", async () => {
  const live = await liveSourceNoise();
  const report = await run(live);
  assert.equal(report.phase, "post-fence");
  assert.equal(report.verdict, "blocked");
  assert.equal(quiescenceExitCode(report), 2);
  assert.deepEqual(report.gating, Object.keys(QUIESCENCE_GATES));
  assert.deepEqual(report.blocked, INFORMATIONAL_BEFORE_THE_FENCE.slice().sort((a, b) =>
    Object.keys(QUIESCENCE_GATES).indexOf(a) - Object.keys(QUIESCENCE_GATES).indexOf(b)));
  assert.deepEqual(report.advisory, { blocked: [], notEvaluated: [] });
  for (const item of report.checks) assert.equal(item.gate, "gating", item.id);
});

test("before the fence each unfinished-erasure finding gates by itself, and the advisory state does not hide or mimic it", async () => {
  const job = (digest) => `INSERT INTO storage_erasure_jobs(participant_digest, source_id, owner_digest, source_namespace, state,
    attempted_ms) VALUES ('${digest}', 'synthetic-source-a', '${"b".repeat(64)}', 'synthetic-namespace', 'pending', 0)`;
  // A mid-erasure participant among the in-flight noise.
  const midErasure = await runPre(await liveSourceNoise(`UPDATE participants SET state = 'deleting',
    deletion_session_id = '${randomUUID()}' WHERE id = '${participantId()}'`));
  assert.equal(midErasure.verdict, "blocked");
  assert.equal(quiescenceExitCode(midErasure), 2);
  assert.deepEqual(midErasure.blocked, ["participants-quiescent"]);
  assert.deepEqual(midErasure.advisory.blocked, INFORMATIONAL_BEFORE_THE_FENCE);
  assert.equal(checkOf(midErasure, "participants-quiescent").gate, "gating");

  // An unfinished erasure job, with a clean ingestion.
  const jobs = await runPre({ ingestion: clean.ingestion, ledger: await variant(clean.ledger, job(world.digests[0])) });
  assert.deepEqual(jobs.blocked, ["pending-erasure-jobs"]);
  assert.equal(jobs.verdict, "blocked");

  // A participant whose digest is a recorded tombstone (and who is active, so only the intersection gates).
  const tombstoned = await runPre({ ingestion: clean.ingestion,
    ledger: await variant(clean.ledger, `INSERT INTO deletion_tombstones(participant_digest, schema_version, deleted_at,
      retain_until) VALUES ('${participantDeletionDigest(participantId())}', 'participant-deletion-tombstone-v0.1',
      '2026-09-01T00:00:00.000Z', '2027-09-01T00:00:00.000Z')`) });
  assert.deepEqual(tombstoned.blocked, ["deletion-digest-intersection"]);
  assert.equal(quiescenceExitCode(tombstoned), 2);
});

test("an input that is missing leaves the run incomplete only if a gating check needs it", async () => {
  // No analytics: its check is advisory before the fence and gating after it.
  const pre = await runPre({ ingestion: clean.ingestion, ledger: clean.ledger });
  assert.equal(pre.verdict, "quiescent");
  assert.equal(quiescenceExitCode(pre), 0);
  assert.deepEqual(pre.notEvaluated, []);
  assert.deepEqual(pre.advisory, { blocked: [], notEvaluated: ["analytics-delivery"] });
  const post = await run({ ingestion: clean.ingestion, ledger: clean.ledger });
  assert.equal(post.verdict, "incomplete");
  assert.deepEqual(post.notEvaluated, ["analytics-delivery"]);
  // No ledger: two gating checks need it before the fence, so the run is incomplete and says which.
  const noLedger = await runPre({ ingestion: clean.ingestion });
  assert.equal(noLedger.verdict, "incomplete");
  assert.equal(quiescenceExitCode(noLedger), 3);
  assert.deepEqual(noLedger.notEvaluated, ["deletion-digest-intersection", "pending-erasure-jobs"]);
  assert.deepEqual(noLedger.advisory.notEvaluated, ["analytics-delivery"]);
  // A blocker still outranks a missing input.
  const blocked = await runPre({ ingestion: await variant(clean.ingestion, PARTICIPANT_CASES[1][1]()) });
  assert.equal(blocked.verdict, "blocked");
  assert.deepEqual(blocked.blocked, ["participants-quiescent"]);
});

test("the saved Wrangler output answers the pre-fence gate except the intersection, and says so", async () => {
  const live = await liveSourceNoise();
  const files = {};
  for (const [role, path] of [["ingestion", live.ingestion], ["deletion-ledger", live.ledger], ["analytics", live.analytics]]) {
    files[role] = await resultFile(wranglerOutput(role, path));
  }
  const options = { ingestion: files.ingestion, ledger: files["deletion-ledger"], analytics: files.analytics, now: NOW };
  const pre = record(await evaluateWranglerResults({ phase: PRE, ...options }));
  assert.equal(pre.phase, "pre-fence");
  assert.equal(pre.verdict, "incomplete", "the intersection needs local hashing, so this is the best saved output can give");
  assert.equal(quiescenceExitCode(pre), 3);
  assert.deepEqual(pre.blocked, [], "every gating check D1 can answer is clear");
  assert.deepEqual(pre.notEvaluated, ["deletion-digest-intersection"]);
  assert.deepEqual(pre.advisory, { blocked: INFORMATIONAL_BEFORE_THE_FENCE, notEvaluated: [] });
  // A mid-erasure participant in saved output is a blocker that outranks the missing intersection.
  const erasing = await resultFile(wranglerOutput("ingestion", await variant(live.ingestion, PARTICIPANT_CASES[0][1]())));
  const blocked = record(await evaluateWranglerResults({ phase: PRE, ...options, ingestion: erasing }));
  assert.equal(blocked.verdict, "blocked");
  assert.deepEqual(blocked.blocked, ["participants-quiescent"]);
  const post = record(await evaluateWranglerResults({ phase: POST, ...options }));
  assert.equal(post.verdict, "blocked");
});

test("the command line carries the phase into the exit status", async () => {
  const live = await liveSourceNoise();
  const args = (phase) => ["check", "--phase", phase, "--ingestion", live.ingestion, "--ledger", live.ledger, "--analytics", live.analytics];
  const pre = cli(args(PRE));
  assert.equal(pre.status, 0, pre.stderr);
  const preReport = JSON.parse(pre.stdout);
  emitted.push(preReport);
  assert.equal(preReport.phase, "pre-fence");
  assert.deepEqual(preReport.advisory.blocked, INFORMATIONAL_BEFORE_THE_FENCE);
  const post = cli(args(POST));
  assert.equal(post.status, 2, post.stderr);
  const postReport = JSON.parse(post.stdout);
  emitted.push(postReport);
  assert.equal(postReport.phase, "post-fence");
  assert.equal(JSON.parse(cli(["evaluate", "--phase", PRE, "--ingestion-result", await resultFile(wranglerOutput("ingestion", live.ingestion))])
    .stdout).phase, "pre-fence");
  // No phase is an error, not a default; and a sealed source cannot be called pre-fence.
  const missing = cli(args(PRE).filter((value, index, all) => value !== "--phase" && all[index - 1] !== "--phase"));
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.equal(missing.stderr, "QUIESCENCE_ARGUMENT_INVALID\n");
  const sealedPre = cli(["check", "--phase", PRE, "--seal", join(directory, "missing.json"), "--seal-id", "0".repeat(64)]);
  assert.equal(sealedPre.status, 1);
  assert.equal(sealedPre.stderr, "QUIESCENCE_ARGUMENT_INVALID\n");
});

// ---------------------------------------------------------------------------
// The report is bounded, content free and read-only.

test("references are bounded at 25 per check; the counts stay exact", async () => {
  const insertions = Array.from({ length: 30 }, (_, index) => `INSERT INTO pending_quarantine_objects(r2_key, contribution_id,
    object_kind, registered_at) VALUES ('telemetry/synthetic-bulk-${index}', 'synthetic-bulk-${index}', 'telemetry',
    '2026-10-02T09:${String(index).padStart(2, "0")}:00.000Z')`).join(";\n");
  const participants = Array.from({ length: 30 }, (_, index) => `INSERT INTO participants(id, owner_kind, state, created_at)
    VALUES ('participant:00000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}', 'accountless', 'active',
    '2026-10-02T00:00:00.000Z');
    UPDATE participants SET state = 'deleting' WHERE id = 'participant:00000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}'`)
    .join(";\n");
  const report = await run({ ingestion: await variant(clean.ingestion, `${insertions};\n${participants}`) });
  const quarantine = checkOf(report, "pending-quarantine-registrations");
  assert.equal(quarantine.counts.registrations, 30);
  assert.equal(quarantine.refs.length, QUIESCENCE_MAX_REFS);
  assert.equal(quarantine.refsTruncated, true);
  assert.equal(new Set(quarantine.refs).size, QUIESCENCE_MAX_REFS);
  const people = checkOf(report, "participants-quiescent");
  assert.equal(people.counts.notQuiescent, 30);
  assert.equal(people.refs.length, QUIESCENCE_MAX_REFS);
  assert.equal(people.refsTruncated, true);
});

test("opaque references are one-way, purpose-separated and stable", () => {
  const id = "participant:00000000-0000-4000-8000-000000000001";
  assert.match(opaqueRef("participant", id), /^[0-9a-f]{16}$/u);
  assert.equal(opaqueRef("participant", id), opaqueRef("participant", id));
  assert.notEqual(opaqueRef("participant", id), opaqueRef("quarantine-registration", id));
  assert.notEqual(opaqueRef("participant", id), participantDeletionDigest(id).slice(0, 16), "not a prefix of the deletion digest");
  assert.throws(() => opaqueRef("Bad Kind", id), isCode("QUIESCENCE_ARGUMENT_INVALID"));
  assert.throws(() => opaqueRef("participant", ""), isCode("QUIESCENCE_ARGUMENT_INVALID"));
});

test("a source is opened read-only and refused when unsafe or when it changes under the check", async () => {
  const fingerprint = async () => Promise.all(Object.values(clean).map(async path => [await sha256File(path),
    (await lstat(path)).mtimeMs]));
  const before = await fingerprint();
  const names = await readdir(directory);
  await run({ ingestion: clean.ingestion, ledger: clean.ledger, analytics: clean.analytics });
  assert.deepEqual(await fingerprint(), before, "no input was written");
  const readOnly = await openExportedSqlite(clean.ingestion, "ingestion");
  try {
    assert.throws(() => readOnly.database().exec("CREATE TABLE written_by_the_check(a)"), /readonly|read-only|query_only/iu);
    assert.throws(() => readOnly.database().exec("DELETE FROM participants"), /readonly|read-only|query_only/iu);
  } finally {
    readOnly.close();
  }
  assert.deepEqual(await fingerprint(), before, "a refused write changed nothing");
  assert.deepEqual((await readdir(directory)).filter(name => /-(?:wal|shm|journal)$/u.test(name)), [],
    "no journal was left beside an input");
  assert.equal((await readdir(directory)).length, names.length, "no file was created");

  const refusal = async (path) => assert.rejects(openExportedSqlite(path, "ingestion"), isCode("QUIESCENCE_SOURCE_UNSAFE"));
  await refusal(join(directory, "missing.sqlite"));
  await refusal(directory);
  await refusal("");
  await refusal(`${clean.ingestion}\0`);
  const empty = join(directory, "empty.sqlite");
  await writeFile(empty, "", { mode: 0o600 });
  await refusal(empty);
  const garbage = join(directory, "garbage.sqlite");
  await writeFile(garbage, "this is not a database file".repeat(80), { mode: 0o600 });
  await refusal(garbage);
  const link = join(directory, "link.sqlite");
  await symlink(clean.ingestion, link);
  await refusal(link);
  const hot = await variant(clean.ingestion);
  await writeFile(`${hot}-journal`, "x", { mode: 0o600 });
  await refusal(hot);

  const source = await openExportedSqlite(await variant(clean.ledger), "deletion-ledger");
  try {
    await source.verify();
    await appendFile(join(directory, `variant-${counter}.sqlite`), Buffer.from([0]));
    await assert.rejects(source.verify(), isCode("QUIESCENCE_SOURCE_CHANGED"));
  } finally {
    source.close();
  }
  // The wrong file for a role is a query failure naming the missing table, not a verdict.
  await assert.rejects(checkPost({ ingestion: clean.ledger }), error => isCode("QUIESCENCE_SOURCE_QUERY_FAILED")(error)
    && error.role === "ingestion" && /^[a-z_0-9]+$/u.test(error.table));
  await assert.rejects(checkPost({ ledger: clean.ingestion }), error => isCode("QUIESCENCE_SOURCE_QUERY_FAILED")(error)
    && error.role === "deletion-ledger");
  // SQLite names the first table it fails to resolve, whichever arm that is: any table the statement reads.
  await assert.rejects(checkPost({ analytics: clean.ingestion }), error => isCode("QUIESCENCE_SOURCE_QUERY_FAILED")(error)
    && ANALYTICS_TABLES.includes(error.table));
  // A source whose table is absent fails loudly even when the rest of it is fine.
  await assert.rejects(checkPost({ ingestion: await variant(clean.ingestion, "DROP TABLE pending_quarantine_objects") }),
    error => isCode("QUIESCENCE_SOURCE_QUERY_FAILED")(error) && error.table === "pending_quarantine_objects");
});

test("arguments are closed", async () => {
  for (const options of [{}, { seal: "m.json" , ingestion: clean.ingestion }, { sealId: "0".repeat(64), ingestion: clean.ingestion },
    { seal: "m.json", ledger: clean.ledger }]) {
    await assert.rejects(checkPost(options), isCode("QUIESCENCE_ARGUMENT_INVALID"), JSON.stringify(Object.keys(options)));
  }
  await assert.rejects(evaluatePost({}), isCode("QUIESCENCE_ARGUMENT_INVALID"));
  assert.throws(() => evaluateQuiescence({ mode: "neither", phase: POST }), isCode("QUIESCENCE_ARGUMENT_INVALID"));
  // The phase is required, closed, and a sealed source cannot be pre-fence: no default and no fall-back.
  for (const phase of [undefined, "", "fence", "Pre-Fence", "sealed", null]) {
    await assert.rejects(runQuiescenceCheck({ ingestion: clean.ingestion, phase }), isCode("QUIESCENCE_ARGUMENT_INVALID"),
      `check phase ${String(phase)}`);
    await assert.rejects(evaluateWranglerResults({ ingestion: "x.json", phase }), isCode("QUIESCENCE_ARGUMENT_INVALID"),
      `evaluate phase ${String(phase)}`);
    assert.throws(() => evaluateQuiescence({ mode: "sqlite", phase }), isCode("QUIESCENCE_ARGUMENT_INVALID"), String(phase));
  }
  const sealed = await forgeVariantSeal(seal, STAGE_RUNTIME_SQL);
  const sealedReport = await checkPost({ seal: sealed.manifestPath, sealId: sealed.sealId, now: NOW });
  assert.equal(sealedReport.phase, "post-fence", "the same seal is accepted as post-fence (no analytics supplied: incomplete)");
  await assert.rejects(runQuiescenceCheck({ phase: PRE, seal: sealed.manifestPath, sealId: sealed.sealId, now: NOW }),
    isCode("QUIESCENCE_ARGUMENT_INVALID"), "a sealed source is post-fence by construction");
  for (const argv of [[], ["bogus"], ["check", "--ingestion"], ["check", "--ingestion", "--ledger", "x"],
    ["check", "--ingestion", "a", "--ingestion", "b"], ["check", "--nope", "a"], ["check", "--ingestion-result", "a"],
    ["evaluate", "--ingestion", "a"], ["queries", "--role", "catchup"], ["queries", "--sql"], ["queries", "--role", "ingestion", "--sql", "--sql"],
    ["check", "--sql"],
    // The phase has no default, is closed, repeats nowhere, and belongs to check and evaluate only.
    ["check", "--ingestion", "a"], ["evaluate", "--ingestion-result", "a"], ["check", "--phase", "soon", "--ingestion", "a"],
    ["check", "--phase", "pre-fence", "--phase", "post-fence", "--ingestion", "a"], ["check", "--phase"],
    ["check", "--phase", "pre-fence", "--seal", "m.json", "--seal-id", "0".repeat(64)], ["queries", "--phase", "pre-fence"]]) {
    assert.throws(() => parseQuiescenceArguments(argv), isCode("QUIESCENCE_ARGUMENT_INVALID"), JSON.stringify(argv));
  }
  assert.deepEqual(parseQuiescenceArguments(["check", "--phase", "pre-fence", "--ingestion", "a", "--ledger", "b", "--analytics", "c"]),
    { command: "check", phase: "pre-fence", ingestion: "a", ledger: "b", analytics: "c" });
  assert.deepEqual(parseQuiescenceArguments(["evaluate", "--ingestion-result", "a", "--phase", "post-fence"]),
    { command: "evaluate", phase: "post-fence", ingestion: "a" });
  assert.deepEqual(parseQuiescenceArguments(["check", "--phase", "post-fence", "--seal", "m.json", "--seal-id", "0".repeat(64)]),
    { command: "check", phase: "post-fence", seal: "m.json", sealId: "0".repeat(64) });
  assert.deepEqual(parseQuiescenceArguments(["queries", "--role", "analytics", "--sql"]),
    { command: "queries", role: "analytics", sql: true });
});

// ---------------------------------------------------------------------------
// The documented owner-run Wrangler mode: the printed statements, their saved output.

test("the printed statements, run read-only, give the same report as the SQLite mode, minus the local-hashing check", async () => {
  const printed = JSON.parse(cli(["queries"]).stdout);
  for (const item of printed.queries) assert.equal(item.sql, QUIESCENCE_STATEMENTS[item.role]);
  for (const role of QUIESCENCE_SOURCE_ROLES) {
    const bare = cli(["queries", "--role", role, "--sql"]);
    assert.equal(bare.status, 0);
    assert.equal(bare.stdout, `${QUIESCENCE_STATEMENTS[role]}\n`);
    assert.equal(assertSelectOnly(bare.stdout.trimEnd()), QUIESCENCE_STATEMENTS[role]);
  }

  const sources = { ingestion: clean.ingestion, "deletion-ledger": clean.ledger, analytics: clean.analytics };
  const files = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([role, path]) =>
    [role, await resultFile(wranglerOutput(role, path))])));
  const results = record(await evaluatePost({ ingestion: files.ingestion, ledger: files["deletion-ledger"],
    analytics: files.analytics, now: NOW }));
  const local = await checkPost({ ingestion: clean.ingestion, ledger: clean.ledger, analytics: clean.analytics, now: NOW });
  assert.equal(results.mode, "wrangler-results");
  assert.equal(results.verdict, "incomplete", "the intersection needs local hashing");
  assert.deepEqual(results.notEvaluated, ["deletion-digest-intersection"]);
  assert.equal(checkOf(results, "deletion-digest-intersection").reason, "requires-local-hashing");
  const stripped = (report) => report.checks.filter(item => item.id !== "deletion-digest-intersection")
    .map(({ refs: _refs, refsTruncated: _truncated, ...item }) => item);
  assert.deepEqual(stripped(results), stripped(local));
  assert.deepEqual(results.sources.map(entry => entry.kind), ["wrangler-result", "wrangler-result", "wrangler-result"]);

  // Every blocked shape is seen the same way through the saved output.
  const shapes = [
    ["ingestion", await variant(clean.ingestion, PARTICIPANT_CASES[0][1]()), "participants-quiescent"],
    ["ingestion", await variant(clean.ingestion, `UPDATE storage_v11_owner_links SET state = 'erased'`), "owner-links-erased",
      true],
    ["ingestion", await variant(clean.ingestion, `INSERT INTO pending_quarantine_objects(r2_key, contribution_id, object_kind,
      registered_at) VALUES ('telemetry/synthetic-object-c', 'synthetic-contribution-c', 'telemetry', '2026-10-02T10:00:00.000Z')`),
    "pending-quarantine-registrations"],
    ["ingestion", world.ingestionPath, "correction-runtime"],
    ["deletion-ledger", await variant(clean.ledger, `INSERT INTO storage_erasure_jobs(participant_digest, source_id, owner_digest,
      source_namespace, state, attempted_ms) VALUES ('${world.digests[0]}', 'synthetic-source-a', '${"b".repeat(64)}',
      'synthetic-namespace', 'pending', 0)`), "pending-erasure-jobs"],
    ["analytics", await buildAnalytics(clean.ingestion, { through: 2 }), "analytics-delivery"],
  ];
  for (const [role, path, id, movesJournal] of shapes) {
    const file = await resultFile(wranglerOutput(role, path));
    const options = { ingestion: files.ingestion, ledger: files["deletion-ledger"], analytics: files.analytics, now: NOW };
    options[{ ingestion: "ingestion", "deletion-ledger": "ledger", analytics: "analytics" }[role]] = file;
    // Erasing a link appends to the journal; delivery is then drained to match, so only the link blocks.
    if (movesJournal === true) options.analytics = await resultFile(wranglerOutput("analytics", await buildAnalytics(path)));
    const report = record(await evaluatePost(options));
    assert.equal(report.verdict, "blocked", id);
    assert.deepEqual(report.blocked, [id]);
    assert.equal(Object.hasOwn(checkOf(report, id), "refs"), false, "saved output carries no references");
  }
});

test("a statement cut at its UNION ALL boundaries gives the same facts when its parts' outputs are merged", async () => {
  const sources = { ingestion: clean.ingestion, "deletion-ledger": clean.ledger, analytics: clean.analytics };
  for (const [role, path] of Object.entries(sources)) {
    const arms = QUIESCENCE_STATEMENTS[role].split("\nUNION ALL ");
    assert.ok(arms.length >= 2, role);
    const whole = parseWranglerQuiescenceResult(role, wranglerOutput(role, path));
    for (const cut of [1, Math.ceil(arms.length / 2), arms.length - 1]) {
      const parts = [arms.slice(0, cut), arms.slice(cut)].map(group => group.join("\nUNION ALL "));
      for (const part of parts) assert.equal(assertSelectOnly(part), part, "each part is a read-only SELECT of its own");
      const merged = JSON.stringify(parts.flatMap(part => JSON.parse(envelope(rowsOf(path, part).map(row => ({ ...row,
        v: typeof row.v === "bigint" ? Number(row.v) : row.v }))))));
      const split = parseWranglerQuiescenceResult(role, merged);
      for (const family of ["journal", "delivery_cursor"]) assert.deepEqual([...(split.family(family) ?? [])], [...(whole.family(family) ?? [])]);
      for (const [c, k] of [["participants", "total"], ["quarantine", "oldest_registered_at"], ["correction", "runtime_state"],
        ["erasure_jobs", "total"], ["tombstones", "total"], ["delivery", "cursor_rows"]]) {
        assert.equal(split.get(c, k), whole.get(c, k), `${role} ${c}/${k}`);
      }
    }
  }
});

test("saved output that is not the closed answer of the printed statement is refused", async () => {
  const good = JSON.parse(wranglerOutput("ingestion", clean.ingestion));
  const rows = good[0].results;
  const refusals = [
    ["not JSON", "{", "QUIESCENCE_RESULT_INVALID"],
    ["not an array", JSON.stringify({ results: rows, success: true }), "QUIESCENCE_RESULT_INVALID"],
    ["the same part twice", JSON.stringify([good[0], good[0]]), "QUIESCENCE_FACT_DUPLICATE"],
    ["no result", "[]", "QUIESCENCE_RESULT_INVALID"],
    ["nine results", JSON.stringify(Array.from({ length: 9 }, () => ({ success: true, results: [] }))), "QUIESCENCE_RESULT_INVALID"],
    ["one failed part", JSON.stringify([good[0], { success: false, results: [] }]), "QUIESCENCE_RESULT_INVALID"],
    ["success false", JSON.stringify([{ ...good[0], success: false }]), "QUIESCENCE_RESULT_INVALID"],
    ["results not an array", JSON.stringify([{ success: true, results: "x" }]), "QUIESCENCE_RESULT_INVALID"],
    ["a missing fact", envelope(rows.filter(row => !(row.c === "correction" && row.k === "facts"))), "QUIESCENCE_FACT_MISSING"],
    ["an unknown family", envelope([...rows, { c: "extra", k: "x", v: 1 }]), "QUIESCENCE_FACT_UNKNOWN"],
    ["an unknown static fact", envelope([...rows, { c: "participants", k: "extra", v: 1 }]), "QUIESCENCE_FACT_UNKNOWN"],
    ["a duplicate fact", envelope([...rows, rows[0]]), "QUIESCENCE_FACT_DUPLICATE"],
    ["a duplicate journal source", envelope([...rows, rows.find(row => row.c === "journal")]), "QUIESCENCE_FACT_DUPLICATE"],
    ["a negative count", envelope(rows.map(row => (row.k === "total" && row.c === "participants" ? { ...row, v: -1 } : row))),
      "QUIESCENCE_FACT_INVALID"],
    ["a fractional count", envelope(rows.map(row => (row.k === "total" && row.c === "participants" ? { ...row, v: 1.5 } : row))),
      "QUIESCENCE_FACT_INVALID"],
    ["a text count", envelope(rows.map(row => (row.k === "total" && row.c === "participants" ? { ...row, v: "6" } : row))),
      "QUIESCENCE_FACT_INVALID"],
    ["an unsafe state name", envelope(rows.map(row => (row.k === "runtime_state" ? { ...row, v: "/private/path" } : row))),
      "QUIESCENCE_FACT_INVALID"],
    ["an unsafe source id", envelope(rows.map(row => (row.c === "journal" ? { ...row, k: "a b/c" } : row))), "QUIESCENCE_FACT_INVALID"],
    ["an extra column", envelope(rows.map(row => ({ ...row, extra: 1 }))), "QUIESCENCE_FACT_INVALID"],
    ["a row that is not an object", envelope([...rows, 5]), "QUIESCENCE_FACT_INVALID"],
    ["too many rows", envelope(Array.from({ length: 600 }, () => rows[0])), "QUIESCENCE_FACT_INVALID"],
    ["participants that do not add up", envelope(rows.map(row => (row.k === "not_quiescent" ? { ...row, v: 0 }
      : row.k === "deleting" ? { ...row, v: 1 } : row))), "QUIESCENCE_FACT_INCONSISTENT"],
    ["a quarantine total that is not its parts", envelope(rows.map(row => (row.c === "quarantine" && row.k === "total" ? { ...row, v: 3 } : row))),
      "QUIESCENCE_FACT_INCONSISTENT"],
    ["a runtime state with no runtime row", envelope(rows.map(row => (row.k === "runtime_rows" ? { ...row, v: 0 } : row))),
      "QUIESCENCE_FACT_INCONSISTENT"],
  ];
  for (const [name, text, code] of refusals) {
    await assert.rejects(evaluatePost({ ingestion: await resultFile(text) }), isCode(code), name);
  }
  assert.throws(() => parseWranglerQuiescenceResult("analytics", wranglerOutput("ingestion", clean.ingestion)),
    isCode("QUIESCENCE_FACT_UNKNOWN"), "a role's output is not another role's");
  const analyticsRows = JSON.parse(wranglerOutput("analytics", clean.analytics))[0].results;
  assert.throws(() => parseWranglerQuiescenceResult("analytics", envelope(analyticsRows.map(row => (row.c === "delivery" ? { ...row, v: 4 } : row)))),
    isCode("QUIESCENCE_FACT_INCONSISTENT"), "the cursor row count must equal the rows listed");
  assert.throws(() => normalizeQuiescenceFacts("catchup", []), isCode("QUIESCENCE_ARGUMENT_INVALID"));
  assert.throws(() => normalizeQuiescenceFacts("analytics", "not rows"), isCode("QUIESCENCE_FACT_INVALID"));

  const file = async (bytes, mode = 0o644) => {
    counter += 1;
    const path = join(directory, `result-${counter}.json`);
    await writeFile(path, bytes, { mode });
    return path;
  };
  await assert.rejects(evaluatePost({ ingestion: join(directory, "absent.json") }), isCode("QUIESCENCE_RESULT_FILE_UNSAFE"));
  await assert.rejects(evaluatePost({ ingestion: directory }), isCode("QUIESCENCE_RESULT_FILE_UNSAFE"));
  await assert.rejects(evaluatePost({ ingestion: await file("") }), isCode("QUIESCENCE_RESULT_FILE_UNSAFE"));
  await assert.rejects(evaluatePost({ ingestion: await file(" ".repeat(300 * 1024)) }), isCode("QUIESCENCE_RESULT_FILE_UNSAFE"));
  const target = await file(wranglerOutput("ingestion", clean.ingestion));
  const link = join(directory, "result-link.json");
  await symlink(target, link);
  await assert.rejects(evaluatePost({ ingestion: link }), isCode("QUIESCENCE_RESULT_FILE_UNSAFE"));
});

// ---------------------------------------------------------------------------
// The command line: exit status, stdout, stderr.

test("the command line reports the verdict in its exit status and one JSON line, and an error as a code on stderr", async () => {
  const run3 = (extra = []) => cli(["check", "--phase", POST, "--ingestion", clean.ingestion, "--ledger", clean.ledger, "--analytics", clean.analytics, ...extra]);
  const quiescent = run3();
  assert.equal(quiescent.status, 0, quiescent.stderr);
  assert.equal(quiescent.stderr, "");
  assert.equal(quiescent.stdout.endsWith("\n"), true);
  const parsed = JSON.parse(quiescent.stdout);
  emitted.push(parsed);
  assert.equal(parsed.verdict, "quiescent");
  assert.equal(parsed.schema, CUTOVER_QUIESCENCE_REPORT_SCHEMA);

  const incomplete = cli(["check", "--phase", POST, "--ingestion", clean.ingestion]);
  assert.equal(incomplete.status, 3);
  assert.equal(JSON.parse(incomplete.stdout).verdict, "incomplete");
  emitted.push(JSON.parse(incomplete.stdout));

  const blocked = cli(["check", "--phase", POST, "--ingestion", await variant(clean.ingestion, PARTICIPANT_CASES[1][1]()), "--ledger", clean.ledger]);
  assert.equal(blocked.status, 2);
  assert.equal(JSON.parse(blocked.stdout).verdict, "blocked");
  assert.deepEqual(JSON.parse(blocked.stdout).blocked, ["participants-quiescent"]);
  emitted.push(JSON.parse(blocked.stdout));

  const evaluated = cli(["evaluate", "--phase", POST, "--ingestion-result", await resultFile(wranglerOutput("ingestion", clean.ingestion)),
    "--ledger-result", await resultFile(wranglerOutput("deletion-ledger", clean.ledger)),
    "--analytics-result", await resultFile(wranglerOutput("analytics", clean.analytics))]);
  assert.equal(evaluated.status, 3, "the intersection is not evaluated from saved output");
  assert.equal(JSON.parse(evaluated.stdout).mode, "wrangler-results");
  emitted.push(JSON.parse(evaluated.stdout));

  for (const [args, code] of [
    [["check", "--phase", POST], "QUIESCENCE_ARGUMENT_INVALID"],
    [["check", "--ingestion", clean.ingestion], "QUIESCENCE_ARGUMENT_INVALID"],
    [["check", "--phase", POST, "--ingestion", join(directory, "missing.sqlite")], "QUIESCENCE_SOURCE_UNSAFE [role=ingestion]"],
    [["check", "--phase", POST, "--analytics", clean.ledger],
      new RegExp(`^QUIESCENCE_SOURCE_QUERY_FAILED \\[role=analytics table=(?:${ANALYTICS_TABLES.join("|")})\\]$`, "u")],
    [["evaluate", "--phase", POST, "--ingestion-result", join(directory, "missing.json")], "QUIESCENCE_RESULT_FILE_UNSAFE [role=ingestion]"],
    [["bogus"], "QUIESCENCE_ARGUMENT_INVALID"],
    [["check", "--phase", POST, "--seal", join(directory, "missing.json"), "--seal-id", "0".repeat(64)], "CUTOVER_SEAL_MANIFEST_INVALID"],
  ]) {
    const failed = cli(args);
    assert.equal(failed.status, 1, args.join(" "));
    assert.equal(failed.stdout, "");
    const message = failed.stderr.slice(0, -1);
    assert.equal(failed.stderr.endsWith("\n"), true);
    if (code instanceof RegExp) assert.match(message, code);
    else assert.equal(message, code);
    assert.equal(QUIESCENCE_ERROR_CODES.includes(message.split(" ")[0]) || message.startsWith("CUTOVER_"), true);
  }
  assert.equal(quiescenceExitCode({ verdict: "other" }), 1);
});

test("the sealed source of a real seal is checked through the command line the way PT-3 opens it", async () => {
  const forged = await forgeVariantSeal(seal, STAGE_RUNTIME_SQL);
  const analytics = await buildAnalytics(join(forged.directory, "ingestion.sealed.sqlite"));
  const result = cli(["check", "--phase", POST, "--seal", forged.manifestPath, "--seal-id", forged.sealId, "--analytics", analytics]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  emitted.push(report);
  assert.equal(report.verdict, "quiescent");
  assert.deepEqual(report.sources.map(entry => entry.kind), ["sealed", "sealed", "exported"]);
  const manifest = JSON.parse(readFileSync(forged.manifestPath, "utf8"));
  assert.deepEqual(report.sources.slice(0, 2).map(entry => entry.sha256), manifest.sources.map(entry => entry.sealedSha256));
  const mixed = cli(["check", "--phase", POST, "--seal", forged.manifestPath, "--seal-id", forged.sealId, "--ingestion", clean.ingestion]);
  assert.equal(mixed.status, 1);
  assert.equal(mixed.stderr, "QUIESCENCE_ARGUMENT_INVALID\n");
});

test("nothing the check prints holds an id, a digest, a key, a path or a secret", async () => {
  assert.ok(emitted.length > 30, "the cases above produced the reports to scan");
  const text = JSON.stringify(emitted);
  const values = new Set();
  for (const path of [world.ingestionPath, clean.ingestion]) {
    for (const row of rowsOf(path, "SELECT id FROM participants")) values.add(row.id);
    for (const row of rowsOf(path, "SELECT owner_digest FROM storage_owner_revisions")) values.add(row.owner_digest);
    for (const row of rowsOf(path, "SELECT source_id FROM storage_source_state")) values.add(row.source_id);
    for (const row of rowsOf(path, "SELECT id FROM device_credentials")) values.add(row.id);
    for (const row of rowsOf(path, "SELECT id FROM enrollment_grants")) values.add(row.id);
  }
  for (const digest of world.digests) values.add(digest);
  for (const row of rowsOf(world.ledgerPath, "SELECT owner_digest, source_id FROM storage_erasure_jobs")) {
    values.add(row.owner_digest);
    values.add(row.source_id);
  }
  for (const secret of Object.values(world.fixture.secrets)) values.add(secret);
  for (const value of ["synthetic-contribution-a", "synthetic-contribution-b", "synthetic-contribution-c", "synthetic-object-a",
    "synthetic-lease", "synthetic-bulk-0", "synthetic-contribution-live", "synthetic-object-live", "synthetic-source-a", "synthetic-other-source", directory, world.work, "participant:"]) {
    values.add(value);
  }
  for (const value of values) {
    assert.equal(typeof value === "string" && value.length >= 8, true, "every scanned value is a real, long string");
    assert.equal(text.includes(value), false, `the output holds a ${value.slice(0, 4)}... value`);
  }
  const references = text.match(/"(?:refs|sourceRef)":(?:\[[^\]]*\]|"[^"]*")/gu) ?? [];
  assert.ok(references.length > 0);
  for (const match of references) {
    for (const reference of match.match(/"([^"]*)"/gu).slice(1).map(item => item.slice(1, -1))) {
      assert.match(reference, /^[0-9a-f]{16}$/u, "a reference is 16 hex characters");
    }
  }
  assert.equal(/\/(?:private|var|tmp|Users)\//u.test(text), false, "no path");
  assert.equal(/\b[0-9a-f]{32,}\b/u.test(text.replace(/"sha256":"[0-9a-f]{64}"/gu, "").replace(/"sealId":"[0-9a-f]{64}"/gu, "")),
    false, "no long hex value other than a source file's sha256 and a seal id");
});
