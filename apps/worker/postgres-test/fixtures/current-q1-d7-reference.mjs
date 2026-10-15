/** Current-source, two-case D7 producer. This is a versioned companion to
 * current-q1-d1-reference.mjs; it does not alter or reinterpret the D1 route. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { chmod, lstat, mkdir, mkdtemp, realpath, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import * as D1 from "./current-q1-d1-reference.mjs";
import * as D1Recompute from "./current-q1-d1-recompute.mjs";
import * as D7 from "./current-q1-d7-recompute.mjs";
import * as Contract from "./current-q1-d7-contract.mjs";
import { buildCurrentQ1D7CurrentPublicExpectation, buildCurrentQ1D7PerDateExpectation,
  buildCurrentQ1D7WindowProofs }
  from "./current-q1-d7-expectation.mjs";
import { runCurrentQ1D7NativeProbe } from "./current-q1-d7-native.mjs";
import { clearCurrentQ1D7PrivateValidatedOracle, produceCurrentQ1D7CaseOutput,
  createCurrentQ1D7PublicProjectionReceipt, validateCurrentQ1D7CurrentPublicResponse }
  from "./current-q1-d7-case-output.mjs";
import { buildCurrentCorpus } from "../../scripts/gcp-fastpath-current-corpus.mjs";
import { createS9Progress } from "../../scripts/s9-rehearsal-diagnostics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(HERE, "../..");
const REPOSITORY_ROOT = resolve(WORKER_ROOT, "../..");
const SOURCE_ID = "gcp-fastpath-oracle";
const SOURCE_NAMESPACE = SOURCE_ID;
const INPUT_SCHEMA = "current-q1-d7-input-binding-v1";
const BINDING_SCHEMA = "current-q1-d7-binding-v1";
const REFERENCE_SCHEMA = "current-q1-d7-reference-v4";
const ACCEPTANCE_SCHEMA = Contract.CURRENT_Q1_D7_SCHEMAS.acceptance;
const NEGATIVE_CORPUS_SHA256 = "be042b9a72c00a8bbeef592619d7d7ab00be5b02a557629340d27bbf36b5521e";
const INGESTION_MIGRATIONS = Object.freeze(["migrations", "typed-ingestion-migrations",
  "ingestion-bridge-migrations", "typed-v11-admission-migrations", "typed-v1-admission-migrations",
  "ingestion-isolation-migrations"]);
const CASE_KEYS = Object.freeze(["conflictPreserving", "conflictFreePositive"]);
const BOOTSTRAP_TABLES = Object.freeze(["community_public_source_bootstrap", "community_daily_aggregate_rebuilds",
  "community_current_analysis_queue"]);
const PHYSICAL_CASES = Object.freeze({ conflictPreserving: "conflict-preserving-negative-v2",
  conflictFreePositive: "conflict-free-positive-v2" });
const EXTRA_SOURCE_PATHS = Object.freeze([
  "package.json",
  "pnpm-lock.yaml",
  "apps/worker/postgres-test/fixtures/current-q1-d7-reference.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-reference.check.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-producer-component.check.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-native.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-native.check.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-expectation.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-expectation.check.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-case-output.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-case-output.check.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-diagnostic.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-diagnostic-guardian.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-diagnostic-child.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-diagnostic.check.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-recompute.mjs",
  "apps/worker/scripts/current-q1-d1-recompute.check.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-contract.mjs",
  "apps/worker/postgres-test/edge-origin-e2e.spec.mjs",
  "apps/worker/scripts/current-q1-d7-contract.check.mjs",
  "apps/worker/scripts/current-q1-conflict-proof.mjs",
  "apps/worker/scripts/current-q1-conflict-proof.check.mjs",
  "apps/worker/scripts/gcp-fastpath-current-corpus.mjs",
  "apps/worker/scripts/gcp-fastpath-current-corpus.check.mjs",
  "apps/worker/scripts/postgres-ingestion-journal-transfer.mjs",
  "apps/worker/scripts/postgres-ingestion-journal-transfer.check.mjs",
  "apps/worker/scripts/gcp-fastpath-rehearsal.mjs",
  "apps/worker/scripts/gcp-fastpath-rehearsal.check.mjs",
  "apps/worker/scripts/analytics-v2-current-d7-compare.mjs",
  "apps/worker/scripts/analytics-v2-current-d7-compare.check.mjs",
]);
const SHA = /^[a-f0-9]{64}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const jsonSha256 = (value) => Contract.currentQ1D7JsonSha256(value);
const fail = (code = "CURRENT_Q1_D7_PRODUCER_FAILED") => {
  throw Object.assign(new Error(code), { code });
};
const requireFact = (condition, code) => { if (!condition) fail(code); };
let producerHeld = false;

function checkDeadline(deadlineMonotonicMs) {
  requireFact(Number.isFinite(deadlineMonotonicMs) && performance.now() < deadlineMonotonicMs,
    "CURRENT_Q1_D7_DEADLINE");
}

function caseInputFromGenerated(caseKey, P) {
  const physicalId = PHYSICAL_CASES[caseKey];
  const generated = buildCurrentCorpus(physicalId);
  const indexText = generated.files[0]?.[1];
  requireFact(typeof indexText === "string" && generated.files[0][0] === "corpus.json",
    "CURRENT_Q1_D7_CORPUS_INVALID");
  const index = JSON.parse(indexText);
  const corpus = { ...index, owners: generated.owners };
  const topology = D7.validateCurrentQ1D7Topology(caseKey, corpus);
  corpus.expectedDailyDays = [...topology.dailyDays];
  corpus.conflictDays = [...topology.conflictDays];
  corpus.window = { fromDay: topology.allDays[0], throughDay: topology.allDays.at(-1) };
  const admissionIdentities = awaitableAdmissionIdentities(P, corpus);
  return { caseKey, physicalId, generated, index, corpus, topology,
    modelDays: Contract.currentQ1D7GraphDays(), admissionIdentities };
}

function awaitableAdmissionIdentities(P, corpus) {
  // Kept as a helper so capture and production use the same public D1 builder
  // over the exact generator bytes rather than a cached or historical oracle.
  return D1.buildCurrentQ1AdmissionIdentities(P, corpus);
}

async function collectCaseInputs(P) {
  const inputs = {};
  for (const caseKey of CASE_KEYS) {
    const input = caseInputFromGenerated(caseKey, P);
    input.admissionIdentities = await input.admissionIdentities;
    input.corpusSha256 = jsonSha256(input.generated.files.map(([, body]) => JSON.parse(body)));
    input.admissionSha256 = jsonSha256(input.admissionIdentities);
    input.topologySha256 = jsonSha256({ caseId: caseKey, corpusCaseId: input.physicalId,
      allDays: input.topology.allDays, dailyDays: input.topology.dailyDays, conflictDays: input.topology.conflictDays,
      counts: input.topology.counts, owners: input.corpus.owners.map((owner) => owner.key),
      sourceDays: input.topology.sourceDays, recordCount: input.topology.recordCount,
      primaryRecordCount: input.topology.primaryRecordCount, extraAdmissions: input.topology.extraAdmissions });
    inputs[caseKey] = input;
  }
  requireFact(inputs.conflictPreserving.corpusSha256 === NEGATIVE_CORPUS_SHA256
    && inputs.conflictFreePositive.corpusSha256 !== NEGATIVE_CORPUS_SHA256,
  "CURRENT_Q1_D7_CORPUS_INVALID");
  return inputs;
}

function contractCase(caseKey, input, { sourceInvariantSha256 } = {}) {
  return { caseId: caseKey, corpusCaseId: input.physicalId, corpusSha256: input.corpusSha256,
    topologySha256: input.topologySha256, admissionSha256: input.admissionSha256,
    ...(sourceInvariantSha256 ? { sourceInvariantSha256 } : {}), owners: [...D7.CURRENT_Q1_D7_OWNER_KEYS],
    sourceDays: input.topology.sourceDays, recordCount: input.topology.recordCount,
    primaryRecordCount: input.topology.primaryRecordCount, extraAdmissions: input.topology.extraAdmissions,
    conflictDays: [...input.topology.conflictDays], dailyDays: [...input.topology.dailyDays],
    modelDays: Contract.currentQ1D7GraphDays() };
}

function migrationDigest(source) {
  return jsonSha256(D1.orderedCurrentQ1MigrationInputs(source.files));
}

function captureSourceSnapshot() {
  return D1.captureCurrentQ1SourceSnapshot(EXTRA_SOURCE_PATHS, {
    validateSourcePath: Contract.validCurrentQ1D7SourcePath,
    strictPublicPackageRoots: true,
  });
}

export function currentQ1D7ViteOptions({ root = WORKER_ROOT, cacheDir } = {}) {
  return { root, ...(cacheDir ? { cacheDir } : {}), configFile: false, envDir: false,
    appType: "custom", logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null } };
}

async function openCurrentVite({ cacheDir } = {}) {
  const { createServer } = await import("vite");
  return createServer(currentQ1D7ViteOptions({ cacheDir }));
}

/** Capture immutable code/runtime/corpus pins before any D7 case admission. */
export async function captureCurrentQ1D7ReferenceBinding() {
  const runtime = await D1.measureCurrentQ1Runtime();
  const source = await captureSourceSnapshot();
  const migrations = migrationDigest(source);
  let vite, cacheRoot, cacheIdentity;
  let casesBefore;
  try {
    cacheRoot = await mkdtemp(join(tmpdir(), "tibotattle-current-q1-d7-binding-vite-"));
    await chmod(cacheRoot, 0o700); cacheIdentity = await lstat(cacheRoot);
    requireFact(cacheIdentity.isDirectory() && !cacheIdentity.isSymbolicLink()
      && cacheIdentity.uid === process.getuid() && (cacheIdentity.mode & 0o077) === 0,
    "CURRENT_Q1_D7_SCRATCH_INVALID");
    vite = await openCurrentVite({ cacheDir: cacheRoot });
    const P = await D1.loadCurrentQ1WorkerModules(vite);
    casesBefore = await collectCaseInputs(P);
  } finally {
    await D1.closeCurrentQ1BindingScratch({ vite, cacheRoot, cacheIdentity });
  }
  const [runtimeAfter, sourceAfter] = await Promise.all([
    D1.measureCurrentQ1Runtime(), captureSourceSnapshot(),
  ]);
  const input = {};
  for (const caseKey of CASE_KEYS) input[caseKey] = contractCase(caseKey, casesBefore[caseKey]);
  const binding = { schemaVersion: INPUT_SCHEMA, decisionId: "D7", sourceId: SOURCE_ID,
    sourceNamespace: SOURCE_NAMESPACE, source, runtime, migrationSha256: migrations,
    bounds: Contract.CURRENT_Q1_D7_BOUNDS, cases: input };
  requireFact(isDeepStrictEqual(runtime, runtimeAfter),
    "CURRENT_Q1_D7_SOURCE_CHANGED");
  requireSourceClosure(sourceAfter, source);
  Contract.validateCurrentQ1D7InputBinding(binding);
  return freezeTree(binding);
}

function freezeTree(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) freezeTree(item);
  return Object.freeze(value);
}

async function assertOwnerDirectory(path) {
  requireFact(isAbsolute(path) && normalize(path) === path && await realpath(path) === path,
    "CURRENT_Q1_D7_PG_INPUT_INVALID");
  const stat = await lstat(path);
  requireFact(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && (stat.mode & 0o777) === 0o700, "CURRENT_Q1_D7_PG_INPUT_INVALID");
  return stat;
}

function requireSourceClosure(actual, expected) {
  requireFact(isDeepStrictEqual(actual, expected), "CURRENT_Q1_D7_SOURCE_CHANGED");
  const files = new Set(actual.files.map((entry) => entry.path));
  for (const required of Contract.CURRENT_Q1_D7_REQUIRED_SOURCE_PATHS)
    requireFact(files.has(required), "CURRENT_Q1_D7_SOURCE_CLOSURE_INVALID");
  for (const required of EXTRA_SOURCE_PATHS)
    requireFact(files.has(required), "CURRENT_Q1_D7_SOURCE_CLOSURE_INVALID");
}

function assertDeadlineWithinOriginal(deadlineMonotonicMs) {
  const now = performance.now();
  requireFact(Number.isFinite(deadlineMonotonicMs) && deadlineMonotonicMs > now
    && deadlineMonotonicMs - now <= Contract.CURRENT_Q1_D7_BOUNDS.s9DeadlineMs,
  "CURRENT_Q1_D7_DEADLINE");
}

async function openCaseDatabases(ctx, scratchDirectory) {
  const { openSealedSqliteD1 } = await import("../../cloud-run/sealed-sqlite-d1-adapter.mjs");
  await mkdir(scratchDirectory, { mode: 0o700 }); await chmod(scratchDirectory, 0o700);
  const root = await realpath(scratchDirectory), stat = await lstat(root);
  requireFact(root === scratchDirectory && stat.isDirectory() && !stat.isSymbolicLink()
    && stat.uid === process.getuid() && (stat.mode & 0o077) === 0,
  "CURRENT_Q1_D7_SCRATCH_INVALID");
  const handles = [], paths = {};
  for (const role of ["ingestion", "analytics", "ledger"]) {
    paths[role] = join(root, `${role}.sqlite`);
    const handle = openSealedSqliteD1(paths[role], { create: true, pinnedNowMs: Contract.CURRENT_Q1_D7_NOW_MS });
    handles.push(handle); ctx[role] = handle.database; await chmod(paths[role], 0o600);
  }
  ctx.paths = paths; ctx.handles = handles; ctx.scratchDirectory = root; ctx.scratchIdentity = stat;
}

async function initializeCase(ctx) {
  const P = ctx.P, migrations = [];
  for (const directory of INGESTION_MIGRATIONS.slice(0, 4))
    await D1.applyCurrentQ1Migrations(ctx.ingestion, directory, migrations);
  await D1.applyCurrentQ1Migrations(ctx.analytics, "analytics-migrations", migrations);
  await D1.applyCurrentQ1Migrations(ctx.ledger, "deletion-ledger-migrations", migrations);
  await P.initializeStorageSource(ctx.ingestion, SOURCE_ID);
  await D1.applyCurrentQ1Migrations(ctx.ingestion, INGESTION_MIGRATIONS[4], migrations);
  await P.initializeTypedV11Admission(ctx.ingestion, SOURCE_NAMESPACE);
  await P.initializeTypedV1Admission(ctx.ingestion, SOURCE_NAMESPACE);
  await D1.applyCurrentQ1Migrations(ctx.ingestion, INGESTION_MIGRATIONS[5], migrations);
  await P.initializeStorageAnalyticsRuntime(D1.currentQ1DatabaseBindings(ctx));
  await ctx.ingestion.prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
  await ctx.ingestion.prepare("UPDATE telemetry_v12_runtime SET state='active',changed_at=? WHERE id=1")
    .bind(new Date().toISOString()).run();
  await ctx.ingestion.prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
  const runtimeContracts = await ctx.ingestion.prepare(`SELECT a.runtime_contract_version AS v1,b.runtime_contract_version AS v11
    FROM typed_v1_admission_state a JOIN typed_v11_admission_state b ON b.id=a.id WHERE a.id=1`).first();
  requireFact(runtimeContracts?.v1 === 1 && runtimeContracts?.v11 === 1, "CURRENT_Q1_D7_ADMISSION_FAILED");
  const actualMigrationSha256 = migrationDigest(ctx.binding.source);
  requireFact(actualMigrationSha256 === ctx.binding.migrationSha256
    && jsonSha256(migrations) === actualMigrationSha256,
  "CURRENT_Q1_D7_MIGRATION_MISMATCH");
  return migrations;
}

async function admitCase(ctx, input, progress) {
  const actual = await D1.seedCurrentQ1Corpus({ ...ctx, P: ctx.admissionDiagnostic.api,
    admissionDiagnostic: ctx.admissionDiagnostic, progress, objects: D1.createCurrentQ1InertObjectStore(),
    sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE, nowMs: Contract.CURRENT_Q1_D7_NOW_MS }, input.corpus.owners);
  const orderedActual = [...actual].sort((left, right) => {
    const a = JSON.stringify([left.participantId, left.format, left.day]);
    const b = JSON.stringify([right.participantId, right.format, right.day]);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const actualSha256 = jsonSha256(orderedActual);
  requireFact(actualSha256 === input.admissionSha256
    && isDeepStrictEqual(orderedActual, input.admissionIdentities),
    "CURRENT_Q1_D7_ADMISSION_MISMATCH");
  const invariant = await D1.captureCurrentQ1IngestionInvariantDetails(ctx.ingestion);
  return { actual, sourceInvariant: invariant };
}

async function captureCanonicalSourceWitnesses(ctx, input, sourceInvariantSha256, deadlineMonotonicMs) {
  const P = ctx.P, owners = await P.readStorageCommunityOwnerPage(ctx.ingestion, { limit: 5 });
  requireFact(owners.length === 4, "CURRENT_Q1_D7_ADMISSION_FAILED");
  const corpusOwner = input.corpus.owners.find((owner) => owner.key === "a");
  const owner = owners.find((entry) => entry.ownerDigest === corpusOwner.pinnedOwnerDigest);
  requireFact(owner?.participantId === corpusOwner.participantId && Number.isSafeInteger(owner.ownerRevision)
    && Number.isSafeInteger(owner.authorityEpoch), "CURRENT_Q1_D7_ADMISSION_FAILED");
  const authorityBefore = await P.captureStorageCommunityAuthority(ctx.ingestion,
    { sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE });
  const witnesses = [], rawPages = new Map();
  for (const day of input.topology.conflictDays) for (const stream of ["quota", "session", "usage"]) {
    checkDeadline(deadlineMonotonicMs);
    let after = null, pageCount = 0, rows = 0, compatibleRows = 0, conflictRows = 0;
    let occurrenceMatched = false, compatibleRowsValid = true, conflictRecordJsonNull = false, conflictEventTimeNull = false;
    const evidence = createHash("sha256"); let complete = false;
    for (; pageCount < 256; pageCount++) {
      checkDeadline(deadlineMonotonicMs);
      const cursor = after;
      const page = await P.readEffectiveTelemetryOwnerDayPage(ctx.ingestion, { sourceNamespace: SOURCE_NAMESPACE,
        ownerDigest: owner.ownerDigest, ownerRevision: owner.ownerRevision, authorityEpoch: owner.authorityEpoch,
        day, stream, limit: 50, ...(cursor === null ? {} : { after: cursor }) });
      requireFact(page?.methodVersion === "effective-telemetry-owner-day-v1" && page.stream === stream
        && page.day === day && page.ownerDigest === owner.ownerDigest && page.participantId === owner.participantId
        && Array.isArray(page.rows) && page.rows.length <= 50, "CURRENT_Q1_D7_SOURCE_WITNESS_INVALID");
      evidence.update(jsonSha256({ after: cursor, page })).update("\n");
      rawPages.set(`${day}/${stream}/${pageCount}`, { page, after: cursor, owner });
      for (const row of page.rows) {
        rows++;
        if (row.status === "conflict") {
          conflictRows++;
          if (stream === "usage" && row.occurrenceId === input.corpus.conflict?.occurrenceId) occurrenceMatched = true;
          if (row.recordJson === null) conflictRecordJsonNull = true;
          if (row.eventTime === null && row.eventTimeConflict === true) conflictEventTimeNull = true;
          requireFact(row.recordJson === null && row.eventTime === null && row.eventTimeConflict === true,
            "CURRENT_Q1_D7_SOURCE_WITNESS_INVALID");
        } else {
          requireFact(row.status === "compatible" && row.eventTimeConflict === false
            && typeof row.recordJson === "string" && typeof row.eventTime === "string"
            && row.eventTime.slice(0, 10) === day, "CURRENT_Q1_D7_SOURCE_WITNESS_INVALID");
          try {
            const parsed = P.parseTelemetryV11Record(stream, JSON.parse(row.recordJson));
            compatibleRowsValid &&= P.canonicalJson(parsed) === row.recordJson;
          } catch { compatibleRowsValid = false; }
          compatibleRows++;
        }
      }
      if (page.next === null) { complete = true; pageCount++; break; }
      requireFact(!isDeepStrictEqual(cursor, page.next) && pageCount < 255, "CURRENT_Q1_D7_SOURCE_WITNESS_INVALID");
      after = page.next;
    }
    requireFact(complete && compatibleRowsValid, "CURRENT_Q1_D7_SOURCE_WITNESS_INVALID");
    if (stream === "usage") requireFact(conflictRows === 1 && occurrenceMatched && conflictRecordJsonNull && conflictEventTimeNull,
      "CURRENT_Q1_D7_SOURCE_WITNESS_INVALID");
    else requireFact(conflictRows === 0, "CURRENT_Q1_D7_SOURCE_WITNESS_INVALID");
    witnesses.push({ owner: "a", day, stream, method: "effective-telemetry-owner-day-v1", pageCount, rows,
      compatibleRows, conflictRows, complete, cursorOrderValid: true, occurrenceMatched,
      compatibleRowsValid, conflictRecordJsonNull, conflictEventTimeNull, sourceInvariantSha256,
      readerEvidenceSha256: evidence.digest("hex"), nativePages: [] });
  }
  const authorityAfter = await P.captureStorageCommunityAuthority(ctx.ingestion,
    { sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE });
  requireFact(isDeepStrictEqual(authorityBefore, authorityAfter), "CURRENT_Q1_D7_SOURCE_CHANGED");
  return { witnesses, rawPages, owner, authorityBefore, authorityAfter };
}

/** Capture every exact row needed to validate the current bounded scheduling
 * transition. The source invariant remains full-table; these rows only explain
 * the three reviewed scheduler tables that drainCommunityPublicSourceBootstrap
 * is allowed to mutate. */
async function captureBootstrapTransitionState(database) {
  const [bootstrap, mutation, dailyRebuilds, queueState, queue, domainDays, sequences] = await Promise.all([
    database.prepare(`SELECT singleton,policy_version,participant_cursor,source_day_cursor,completed
      FROM community_public_source_bootstrap WHERE singleton=1`).first(),
    database.prepare(`SELECT singleton_id,mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1`).first(),
    database.prepare(`SELECT day,requested_epoch,requested_at FROM community_daily_aggregate_rebuilds ORDER BY day`).all(),
    database.prepare(`SELECT * FROM community_current_analysis_queue_state WHERE singleton_id=1`).first(),
    database.prepare(`SELECT id,participant_id,dirty_generation,window_generation,pending,last_served_sequence,
        completed_day,completed_method FROM community_current_analysis_queue ORDER BY participant_id`).all(),
    database.prepare(`SELECT o.participant_id,h.generation_id,d.observed_day AS day
      FROM accountless_upload_owners o
      JOIN community_public_source_owners eligible ON eligible.participant_id=o.participant_id
      JOIN telemetry_v11_domain_heads h ON h.participant_id=o.participant_id
      JOIN telemetry_v11_domain_days d ON d.generation_id=h.generation_id
      WHERE eligible.owner_kind='accountless'
      ORDER BY o.participant_id,d.observed_day`).all(),
    database.prepare(`SELECT name,seq FROM sqlite_sequence ORDER BY name`).all(),
  ]);
  requireFact(bootstrap && mutation && queueState && Array.isArray(dailyRebuilds.results)
    && Array.isArray(queue.results) && Array.isArray(domainDays.results) && Array.isArray(sequences.results),
  "CURRENT_Q1_D7_BOOTSTRAP_INVALID");
  return { bootstrap, mutation, dailyRebuilds: dailyRebuilds.results, queueState, queue: queue.results,
    domainDays: domainDays.results, sequences: sequences.results };
}

async function drainCaseBootstrap(ctx, admissionInvariant, deadlineMonotonicMs) {
  const P = ctx.P;
  const bootstrapBefore = await captureBootstrapTransitionState(ctx.ingestion);
  let bootstrapped = false, bootstrapSteps = 0;
  ctx.progress.phase("settle_bootstrap");
  for (let iteration = 0; iteration < Contract.CURRENT_Q1_D7_BOUNDS.bootstrap; iteration++) {
    checkDeadline(deadlineMonotonicMs);
    const step = await P.drainCommunityPublicSourceBootstrap(ctx.ingestion);
    bootstrapSteps++;
    if (step?.completed === true) { bootstrapped = true; break; }
  }
  requireFact(bootstrapped, "CURRENT_Q1_D7_SETTLE_FAILED");
  const [postBootstrapInvariant, bootstrapAfter] = await Promise.all([
    D1.captureCurrentQ1IngestionInvariantDetails(ctx.ingestion), captureBootstrapTransitionState(ctx.ingestion),
  ]);
  const bootstrapProof = D7.assertCurrentQ1D7BootstrapTransition({ beforeInvariant: admissionInvariant,
    afterInvariant: postBootstrapInvariant, before: bootstrapBefore, after: bootstrapAfter, bootstrapSteps });
  const sourceInvariantSha256 = postBootstrapInvariant.sha256;
  ctx.sourceInvariant = postBootstrapInvariant;
  return { sourceInvariant: postBootstrapInvariant, sourceInvariantSha256, bootstrapProof,
    admissionInvariant, bootstrapBefore, bootstrapAfter, bootstrapSteps };
}

function sourceCaptureCommitment(details, proof) {
  requireFact(isObject(details) && Array.isArray(details.tableDigests)
    && Array.isArray(details.controls) && Array.isArray(details.audit) && Array.isArray(details.sequences),
  "CURRENT_Q1_D7_BOOTSTRAP_INVALID");
  const operational = new Set(BOOTSTRAP_TABLES);
  const nonOperationalTables = details.tableDigests.filter((entry) => !operational.has(entry.table));
  requireFact(nonOperationalTables.length > 0
    && isDeepStrictEqual(nonOperationalTables.map((entry) => entry.table),
      [...nonOperationalTables.map((entry) => entry.table)].sort()), "CURRENT_Q1_D7_BOOTSTRAP_INVALID");
  const capture = {
    fullSourceCaptureSha256: details.fullSourceCaptureSha256,
    sourceInvariantSha256: details.sha256,
    schemaSha256: details.schemaSha256,
    rawAdmissionsSha256: "0".repeat(64),
    nonOperationalTablesSha256: jsonSha256(nonOperationalTables),
    controlsSha256: jsonSha256(details.controls),
    auditSha256: jsonSha256(details.audit),
    otherSequencesSha256: jsonSha256(details.sequences.filter((entry) =>
      entry.name !== "community_current_analysis_queue")),
  };
  capture.rawAdmissionsSha256 = Contract.currentQ1D7BootstrapRawAdmissionsSha256(proof, capture);
  return capture;
}

function bootstrapPreservation(prepared, binding, caseKey) {
  const caseBinding = binding.cases[caseKey];
  const sourceModule = binding.source.files.find((entry) =>
    entry.path === "apps/worker/src/community-daily-aggregates.ts");
  requireFact(sourceModule && prepared?.admissionInvariant && prepared?.sourceInvariant
    && prepared.bootstrapBefore && prepared.bootstrapAfter
    && Number.isSafeInteger(prepared.bootstrapSteps), "CURRENT_Q1_D7_BOOTSTRAP_INVALID");
  const proof = { schemaVersion: "current-q1-d7-bootstrap-preservation-v1", actual: true,
    caseId: caseKey, bindingSha256: jsonSha256(binding), admissionSha256: caseBinding.admissionSha256,
    sourceModuleSha256: sourceModule.sha256, operation: "drainCommunityPublicSourceBootstrap",
    iterations: prepared.bootstrapSteps, pageSize: 32, completed: true,
    beforeCompleted: prepared.bootstrapBefore.bootstrap.completed === 1 };
  const before = sourceCaptureCommitment(prepared.admissionInvariant, proof);
  const after = sourceCaptureCommitment(prepared.sourceInvariant, proof);
  const beforeTables = new Map(prepared.admissionInvariant.tableDigests.map((entry) => [entry.table, entry]));
  const afterTables = new Map(prepared.sourceInvariant.tableDigests.map((entry) => [entry.table, entry]));
  const tableHash = (value) => jsonSha256(value);
  const operationalTables = BOOTSTRAP_TABLES.map((table) => {
    const beforeEntry = beforeTables.get(table), afterEntry = afterTables.get(table);
    requireFact(beforeEntry && afterEntry, "CURRENT_Q1_D7_BOOTSTRAP_INVALID");
    const entry = { table, beforeSha256: tableHash(beforeEntry), afterSha256: tableHash(afterEntry),
      transitionProofSha256: "0".repeat(64), transitionVerified: true };
    entry.transitionProofSha256 = Contract.currentQ1D7BootstrapTransitionSha256(proof, entry);
    return entry;
  });
  const sequenceValue = (details) => details.sequences.find((entry) =>
    entry.name === "community_current_analysis_queue")?.seq ?? null;
  const queueSequence = { table: "community_current_analysis_queue",
    before: sequenceValue(prepared.admissionInvariant), after: sequenceValue(prepared.sourceInvariant),
    transitionProofSha256: "0".repeat(64), transitionVerified: true };
  queueSequence.transitionProofSha256 = Contract.currentQ1D7BootstrapTransitionSha256(proof, {
    table: "sqlite_sequence:community_current_analysis_queue",
    beforeSha256: jsonSha256(queueSequence.before), afterSha256: jsonSha256(queueSequence.after),
  });
  const value = { ...proof, before, after, operationalTables, queueSequence };
  return Contract.validateCurrentQ1D7BootstrapPreservation(value, binding, caseKey);
}

async function settleCase(ctx, input, prepared, deadlineMonotonicMs) {
  const P = ctx.P, bindings = D1.currentQ1DatabaseBindings(ctx);
  const { sourceInvariant: postBootstrapInvariant, sourceInvariantSha256 } = prepared;
  const sourceWitnesses = await captureCanonicalSourceWitnesses(ctx, input, sourceInvariantSha256, deadlineMonotonicMs);
  let delivered = false;
  ctx.progress.phase("settle_delivery");
  const deliveryBound = Contract.CURRENT_Q1_D7_BOUNDS.delivery * Contract.CURRENT_Q1_D7_BOUNDS.settleRounds;
  for (let iteration = 1; iteration <= deliveryBound; iteration++) {
    checkDeadline(deadlineMonotonicMs); ctx.progress.counts({ iteration });
    const step = await P.advanceStorageAnalytics(bindings);
    if (step?.state === "idle") { delivered = true; break; }
    requireFact(["applied", "discarded", "building"].includes(step?.state), "CURRENT_Q1_D7_SETTLE_FAILED");
  }
  requireFact(delivered, "CURRENT_Q1_D7_SETTLE_FAILED");
  ctx.progress.phase("settle_daily");
  const dailyPasses = await D7.runCurrentQ1D7DailyConvergence(ctx, input.topology,
    Contract.CURRENT_Q1_D7_BOUNDS.dailyConvergence);
  ctx.progress.phase("settle_retirement");
  let retired = false;
  for (let iteration = 0; iteration < Contract.CURRENT_Q1_D7_BOUNDS.dailyRetirement; iteration++) {
    checkDeadline(deadlineMonotonicMs);
    if (await P.retireStorageCommunityDailyPage(bindings) === 0) { retired = true; break; }
  }
  requireFact(retired, "CURRENT_Q1_D7_SETTLE_FAILED");
  ctx.progress.phase("settle_cache");
  let cacheIdle = false;
  for (let iteration = 1; iteration <= Contract.CURRENT_Q1_D7_BOUNDS.cachePasses; iteration++) {
    checkDeadline(deadlineMonotonicMs); ctx.progress.counts({ iteration });
    const step = await D1Recompute.advanceCurrentQ1CachePass({ ...ctx, nowMs: Contract.CURRENT_Q1_D7_NOW_MS });
    if (step?.state === "idle") { cacheIdle = true; break; }
    requireFact(step?.state === "progress" || step?.state === "building", "CURRENT_Q1_D7_SETTLE_FAILED");
  }
  requireFact(cacheIdle, "CURRENT_Q1_D7_SETTLE_FAILED");
  const invariantAfterSettle = await D1.captureCurrentQ1IngestionInvariantDetails(ctx.ingestion);
  D1.assertCurrentQ1IngestionInvariantUnchanged(postBootstrapInvariant, invariantAfterSettle);
  requireFact(invariantAfterSettle.sha256 === sourceInvariantSha256, "CURRENT_Q1_D7_SOURCE_CHANGED");
  const afterWitnesses = await captureCanonicalSourceWitnesses(ctx, input, sourceInvariantSha256, deadlineMonotonicMs);
  requireFact(isDeepStrictEqual(sourceWitnesses.witnesses, afterWitnesses.witnesses), "CURRENT_Q1_D7_SOURCE_CHANGED");
  return { dailyPasses, sourceWitnesses: afterWitnesses, sourceInvariant: postBootstrapInvariant,
    sourceInvariantSha256 };
}

async function captureNativeOwnerRows(ctx, input) {
  const rows = await ctx.P.readStorageCommunityOwnerPage(ctx.ingestion, { limit: 5 });
  requireFact(Array.isArray(rows) && rows.length === 4, "CURRENT_Q1_D7_ADMISSION_FAILED");
  const ownerRows = input.corpus.owners.map((expected) => {
    const owner = rows.find((entry) => entry.participantId === expected.participantId
      && entry.ownerDigest === expected.pinnedOwnerDigest);
    requireFact(owner && Number.isSafeInteger(owner.ownerRevision) && owner.ownerRevision >= 1
      && Number.isSafeInteger(owner.authorityEpoch) && owner.authorityEpoch >= 1,
    "CURRENT_Q1_D7_ADMISSION_FAILED");
    return { key: expected.key, owner };
  });
  requireFact(isDeepStrictEqual(ownerRows.map((entry) => entry.key), [...D7.CURRENT_Q1_D7_OWNER_KEYS])
    && new Set(ownerRows.map((entry) => entry.owner.ownerDigest)).size === 4,
  "CURRENT_Q1_D7_ADMISSION_FAILED");
  return ownerRows;
}

async function publishCurrentModelDays(ctx, input, expectation, deadlineMonotonicMs) {
  const bindings = D1.currentQ1DatabaseBindings(ctx);
  const expectedMissing = [...new Set(expectation.ownerEvidence.filter((entry) => entry.conflictProofSha256 !== null)
    .map((entry) => entry.day))].sort();
  const outcomes = new Map();
  ctx.progress.phase("public_after");
  for (const [index, day] of input.modelDays.entries()) {
    checkDeadline(deadlineMonotonicMs);
    ctx.progress.counts({ iteration: index + 1 });
    const result = await ctx.P.publishStorageCommunityModelDay(bindings,
      { day, nowMs: Contract.CURRENT_Q1_D7_NOW_MS });
    requireFact(isObject(result) && ["published", "unchanged", "deferred"].includes(result.state),
      "CURRENT_Q1_D7_PUBLICATION_INVALID");
    if (result.state === "deferred") {
      requireFact(expectedMissing.includes(day) && result.reason === "cache_pending",
        "CURRENT_Q1_D7_PUBLICATION_INVALID");
    } else requireFact(!expectedMissing.includes(day), "CURRENT_Q1_D7_PUBLICATION_INVALID");
    outcomes.set(day, result);
  }
  const previewResult = await ctx.P.publishStorageCommunityGraphPreview(bindings,
    { nowMs: Contract.CURRENT_Q1_D7_NOW_MS });
  requireFact(isObject(previewResult) && ["published", "unchanged"].includes(previewResult.state),
    "CURRENT_Q1_D7_PUBLICATION_INVALID");
  return { outcomes, expectedMissing };
}

async function readCurrentPublicationInventory(ctx, input, expectation, publication, deadlineMonotonicMs) {
  const rows = (await ctx.analytics.prepare(`SELECT day,method,payload_json,payload_sha256,authority_json
    FROM analytics_community_model_publications WHERE source_id=? AND day BETWEEN ? AND ? AND method=? ORDER BY day`)
    .bind(SOURCE_ID, input.modelDays[0], input.modelDays.at(-1),
      ctx.P.STORAGE_GRAPH_PROJECTION_METHOD).all()).results;
  requireFact(Array.isArray(rows) && rows.length <= input.modelDays.length,
    "CURRENT_Q1_D7_PUBLICATION_INVALID");
  const byDay = new Map();
  for (const row of rows) {
    requireFact(isObject(row) && DAY.test(row.day) && typeof row.method === "string"
      && typeof row.payload_json === "string" && typeof row.payload_sha256 === "string"
      && typeof row.authority_json === "string" && !byDay.has(row.day), "CURRENT_Q1_D7_PUBLICATION_INVALID");
    byDay.set(row.day, row);
  }
  const inventory = [];
  for (const day of input.modelDays) {
    checkDeadline(deadlineMonotonicMs);
    const row = byDay.get(day);
    if (!row) {
      const outcome = publication.outcomes.get(day);
      requireFact(publication.expectedMissing.includes(day) && outcome?.state === "deferred"
        && outcome.reason === "cache_pending", "CURRENT_Q1_D7_PUBLICATION_INVALID");
      inventory.push({ day, state: "withheld", sha256: null });
      continue;
    }
    requireFact(!publication.expectedMissing.includes(day)
      && await ctx.P.sha256Hex(row.payload_json) === row.payload_sha256,
    "CURRENT_Q1_D7_PUBLICATION_INVALID");
    let projected;
    try { projected = ctx.P.projectAdminModelHistoryDay(JSON.parse(row.payload_json)); }
    catch { projected = null; }
    const expected = expectation.days.find((entry) => entry.day === day);
    requireFact(projected !== null && projected?.day === day && expected
      && isDeepStrictEqual(projected, expected), "CURRENT_Q1_D7_PUBLICATION_INVALID");
    inventory.push({ day, state: "published", sha256: jsonSha256(projected) });
  }
  requireFact(inventory.length === 70 && byDay.size === inventory.filter((entry) => entry.state === "published").length
    && isDeepStrictEqual(inventory.filter((entry) => entry.state === "withheld").map((entry) => entry.day),
      publication.expectedMissing), "CURRENT_Q1_D7_PUBLICATION_INVALID");
  if (input.caseKey === "conflictFreePositive")
    requireFact(inventory.every((entry) => entry.state === "published"), "CURRENT_Q1_D7_PUBLICATION_INVALID");
  return inventory;
}

async function validateFinalSnapshot(ctx, input, expectation, currentPublicExpectation,
  publication, publicationInventory, nativeEvidence, conflictProofs, deadlineMonotonicMs) {
  checkDeadline(deadlineMonotonicMs);
  const snapshot = await D1.readCurrentQ1ResponseSnapshot(ctx, input.corpus.window);
  requireFact(isObject(snapshot) && snapshot.publicResponse?.status === 200
    && isObject(snapshot.publicResponse.body) && isObject(snapshot.adminPreview),
  "CURRENT_Q1_D7_PUBLIC_READ_INVALID");
  try {
    const publicAllowanceAuthority = ctx.P.reducePublicAllowanceBreakdownsV15;
    const publicAllowanceEnvelope = snapshot.publicResponse.body.allowanceBreakdowns;
    const publicationReceipt = createCurrentQ1D7PublicProjectionReceipt({ binding: ctx.binding,
      perDateExpectation: expectation, currentPublicExpectation, nativeEvidence, conflictProofs,
      publication, publicationInventory, publicAllowanceAuthority, publicAllowanceEnvelope });
    validateCurrentQ1D7CurrentPublicResponse({ responseBody: snapshot.publicResponse.body,
      expectation: currentPublicExpectation, binding: ctx.binding, expectedDailyDays: input.corpus.expectedDailyDays,
      dailyWindow: input.corpus.window, metadata: ctx.P.buildCurrentPublicModelMetadata(), nowMs: ctx.nowMs,
      publicationReceipt, publicAllowanceAuthority });
  } catch { fail("CURRENT_Q1_D7_PUBLIC_READ_INVALID"); }
  const previewDays = snapshot.adminPreview.models?.days;
  const publishedDays = publicationInventory.filter((entry) => entry.state === "published").map((entry) => entry.day);
  requireFact(Array.isArray(previewDays)
    && isDeepStrictEqual(previewDays.map((entry) => entry?.day), publishedDays),
  "CURRENT_Q1_D7_PUBLIC_READ_INVALID");
  for (const actual of previewDays) {
    const expected = expectation.days.find((entry) => entry.day === actual.day);
    requireFact(expected && isDeepStrictEqual(actual, expected), "CURRENT_Q1_D7_PUBLIC_READ_INVALID");
  }
  if (input.caseKey === "conflictFreePositive")
    requireFact(isDeepStrictEqual(previewDays.map((entry) => entry.day), input.modelDays),
      "CURRENT_Q1_D7_PUBLIC_READ_INVALID");
  return snapshot;
}

function sourceInvariantSha(value) {
  requireFact(isObject(value) && SHA.test(value.sha256), "CURRENT_Q1_D7_SOURCE_CHANGED");
  return value.sha256;
}

async function removeOwnedCaseDirectory(path, identity) {
  if (!identity) return;
  const current = await lstat(path);
  requireFact(current.isDirectory() && !current.isSymbolicLink() && current.uid === identity.uid
    && current.dev === identity.dev && current.ino === identity.ino && (current.mode & 0o077) === 0
    && await realpath(path) === path, "CURRENT_Q1_D7_CLEANUP_FAILED");
  await rm(path, { recursive: true });
}

function finalBindingFromAdmission(inputBinding, preparedByCase) {
  const binding = structuredClone(inputBinding);
  binding.schemaVersion = BINDING_SCHEMA;
  for (const caseKey of CASE_KEYS)
    binding.cases[caseKey].sourceInvariantSha256 = sourceInvariantSha(preparedByCase[caseKey].sourceInvariant);
  return freezeTree(Contract.validateCurrentQ1D7Binding(binding, inputBinding));
}

/** Run both fresh current-source cases under one process-monotonic S9 deadline.
 * The parent supplies the original deadline and an owner-only, empty PG-input
 * directory; this function never resets the clock or consumes candidate SQL. */
export async function runCurrentQ1D7Reference({ inputBinding, deadlineMonotonicMs, pgInputDirectory } = {}) {
  requireFact(!producerHeld, "CURRENT_Q1_D7_BUSY");
  producerHeld = true;
  const progress = createS9Progress("producer");
  let scratchRoot, scratchIdentity, cacheRoot, cacheIdentity, vite, restore;
  let cleanupFailed = false, completed = false, result;
  const contexts = {}, pgDirectories = new Map();
  const deadlineProgress = {
    phase(value) { checkDeadline(deadlineMonotonicMs); progress.phase(value); },
    counts(value) { checkDeadline(deadlineMonotonicMs); progress.counts(value); },
  };
  try {
    assertDeadlineWithinOriginal(deadlineMonotonicMs);
    Contract.validateCurrentQ1D7InputBinding(inputBinding);
    inputBinding = freezeTree(structuredClone(inputBinding));
    requireFact(typeof pgInputDirectory === "string" && isAbsolute(pgInputDirectory)
      && normalize(pgInputDirectory) === pgInputDirectory, "CURRENT_Q1_D7_PG_INPUT_INVALID");
    requireFact(await assertOwnerDirectory(pgInputDirectory), "CURRENT_Q1_D7_PG_INPUT_INVALID");
    requireFact((await readdir(pgInputDirectory)).length === 0, "CURRENT_Q1_D7_PG_INPUT_INVALID");
    deadlineProgress.phase("source_provenance");
    const [runtimeBefore, sourceBefore] = await Promise.all([
      D1.measureCurrentQ1Runtime(), captureSourceSnapshot(),
    ]);
    requireFact(isDeepStrictEqual(runtimeBefore, inputBinding.runtime)
      && isDeepStrictEqual(sourceBefore, inputBinding.source)
      && migrationDigest(sourceBefore) === inputBinding.migrationSha256,
    "CURRENT_Q1_D7_SOURCE_CHANGED");
    requireSourceClosure(sourceBefore, inputBinding.source);

    deadlineProgress.phase("runtime");
    const { DatabaseSync } = await import("node:sqlite");
    restore = D1.pinCurrentQ1Runtime(DatabaseSync);
    scratchRoot = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-current-q1-d7-")));
    await chmod(scratchRoot, 0o700); scratchIdentity = await lstat(scratchRoot);
    requireFact(scratchIdentity.isDirectory() && !scratchIdentity.isSymbolicLink()
      && scratchIdentity.uid === process.getuid() && (scratchIdentity.mode & 0o077) === 0,
    "CURRENT_Q1_D7_SCRATCH_INVALID");
    cacheRoot = await mkdtemp(join(tmpdir(), "tibotattle-current-q1-d7-vite-"));
    await chmod(cacheRoot, 0o700); cacheIdentity = await lstat(cacheRoot);
    requireFact(cacheIdentity.isDirectory() && !cacheIdentity.isSymbolicLink()
      && cacheIdentity.uid === process.getuid() && (cacheIdentity.mode & 0o077) === 0,
    "CURRENT_Q1_D7_SCRATCH_INVALID");

    deadlineProgress.phase("module_load");
    vite = await openCurrentVite({ cacheDir: cacheRoot });
    const P = await D1.loadCurrentQ1WorkerModules(vite);
    const actualInputs = await collectCaseInputs(P);
    for (const caseKey of CASE_KEYS) {
      const actualCase = contractCase(caseKey, actualInputs[caseKey]);
      requireFact(isDeepStrictEqual(actualCase, inputBinding.cases[caseKey]),
        "CURRENT_Q1_D7_CORPUS_CHANGED");
    }
    const admissionDiagnostic = D1.createCurrentQ1AdmissionDiagnostic(P);
    const ctxBase = { P, server: vite, progress: deadlineProgress, admissionDiagnostic,
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE, nowMs: Contract.CURRENT_Q1_D7_NOW_MS,
      binding: inputBinding, pgInputDirectory };
    for (const caseKey of CASE_KEYS) {
      const scratchDirectory = join(scratchRoot, caseKey);
      contexts[caseKey] = { ...ctxBase, caseKey, scratchDirectory };
      await openCaseDatabases(contexts[caseKey], scratchDirectory);
    }

    deadlineProgress.phase("corpus_validation");
    for (const caseKey of CASE_KEYS) {
      checkDeadline(deadlineMonotonicMs);
      await initializeCase(contexts[caseKey]);
    }
    deadlineProgress.phase("admission");
    const admissions = {};
    for (const caseKey of CASE_KEYS) {
      checkDeadline(deadlineMonotonicMs);
      admissions[caseKey] = await admitCase(contexts[caseKey], actualInputs[caseKey], deadlineProgress);
    }
    deadlineProgress.phase("settle");
    const preparedByCase = {};
    for (const caseKey of CASE_KEYS) {
      checkDeadline(deadlineMonotonicMs);
      preparedByCase[caseKey] = await drainCaseBootstrap(contexts[caseKey],
        admissions[caseKey].sourceInvariant, deadlineMonotonicMs);
    }
    const binding = finalBindingFromAdmission(inputBinding, preparedByCase);
    const bindingSha256 = jsonSha256(binding);
    for (const caseKey of CASE_KEYS) {
      contexts[caseKey].binding = binding;
      contexts[caseKey].source = binding.source;
      contexts[caseKey].sourceInvariant = preparedByCase[caseKey].sourceInvariant;
    }
    const bootstrapByCase = Object.fromEntries(CASE_KEYS.map((caseKey) =>
      [caseKey, bootstrapPreservation(preparedByCase[caseKey], binding, caseKey)]));

    const settledByCase = {};
    const nativeByCase = {};
    const expectations = {};
    const currentPublicExpectations = {};
    const expectationSha256 = {};
    for (const caseKey of CASE_KEYS) {
      checkDeadline(deadlineMonotonicMs);
      const ctx = contexts[caseKey], input = actualInputs[caseKey];
      deadlineProgress.phase("settle");
      settledByCase[caseKey] = await settleCase(ctx, input, preparedByCase[caseKey], deadlineMonotonicMs);
      const initialWindowProofs = buildCurrentQ1D7WindowProofs({ binding, caseId: caseKey,
        sourceWitnesses: settledByCase[caseKey].sourceWitnesses.witnesses });
      deadlineProgress.phase("native_probes");
      nativeByCase[caseKey] = await runCurrentQ1D7NativeProbe({ ctx,
        ownerRows: await captureNativeOwnerRows(ctx, input), caseKey, binding,
        sourceWitnesses: settledByCase[caseKey].sourceWitnesses.witnesses,
        windowProofs: initialWindowProofs, deadlineMonotonicMs, progress: deadlineProgress });
      expectations[caseKey] = buildCurrentQ1D7PerDateExpectation({ binding, caseId: caseKey,
        current: P, contract: Contract, ownerResults: nativeByCase[caseKey].ownerResults,
        sourceWitnesses: nativeByCase[caseKey].sourceWitnesses,
        sourceConflictProofs: nativeByCase[caseKey].conflictProofs });
      expectationSha256[caseKey] = jsonSha256(expectations[caseKey]);
      Contract.validateCurrentQ1D7PerDateExpectation(expectations[caseKey], binding,
        { expectedSha256: expectationSha256[caseKey] });
      // Keep this exact in-memory per-date result: the expectation helper's
      // private seal proves the public projection was derived from the same
      // current factory output, not from a clone or candidate/PG evidence.
      currentPublicExpectations[caseKey] = buildCurrentQ1D7CurrentPublicExpectation({
        expectation: expectations[caseKey], binding, contract: Contract });
    }

    const cases = {}, pgInputs = {};
    for (const caseKey of CASE_KEYS) {
      checkDeadline(deadlineMonotonicMs);
      const ctx = contexts[caseKey], input = actualInputs[caseKey];
      const publication = await publishCurrentModelDays(ctx, input, expectations[caseKey], deadlineMonotonicMs);
      const pgCaseDirectory = join(pgInputDirectory, caseKey);
      await mkdir(pgCaseDirectory, { mode: 0o700 }); await chmod(pgCaseDirectory, 0o700);
      const pgIdentity = await assertOwnerDirectory(pgCaseDirectory);
      pgDirectories.set(pgCaseDirectory, pgIdentity);
      const caseOutput = await produceCurrentQ1D7CaseOutput({ ctx, input, bindingCase: binding.cases[caseKey],
        sourceInvariantSha256: binding.cases[caseKey].sourceInvariantSha256,
        pgCaseDirectory, deadlineMonotonicMs, progress: deadlineProgress });
      pgInputs[caseKey] = caseOutput.pgInput;
      const publicationInventory = await readCurrentPublicationInventory(ctx, input, expectations[caseKey],
        publication, deadlineMonotonicMs);
      const snapshot = await validateFinalSnapshot(ctx, input, expectations[caseKey],
        currentPublicExpectations[caseKey], publication, publicationInventory,
        nativeByCase[caseKey].nativeEvidence, nativeByCase[caseKey].conflictProofs,
        deadlineMonotonicMs);
      const finalSourceInvariant = await D1.captureCurrentQ1IngestionInvariant(ctx.ingestion);
      D1.assertCurrentQ1IngestionInvariantUnchanged(preparedByCase[caseKey].sourceInvariant, finalSourceInvariant);
      requireFact(sourceInvariantSha(finalSourceInvariant) === binding.cases[caseKey].sourceInvariantSha256,
        "CURRENT_Q1_D7_SOURCE_CHANGED");
      const caseReference = {
        schemaVersion: Contract.CURRENT_Q1_D7_SCHEMAS.reference,
        caseId: caseKey,
        bindingSha256,
        sourceInvariantSha256: { before: binding.cases[caseKey].sourceInvariantSha256,
          after: finalSourceInvariant.sha256 },
        admissionSha256: binding.cases[caseKey].admissionSha256,
        graphDays: [...binding.cases[caseKey].modelDays],
        publicationInventory,
        nativeEvidence: nativeByCase[caseKey].nativeEvidence,
        conflictProofs: nativeByCase[caseKey].conflictProofs,
        currentFits: nativeByCase[caseKey].currentFits,
        strictExport: caseOutput.strictExport,
        state: "complete",
        unresolved: [],
        snapshot,
        snapshotSha256: jsonSha256(snapshot),
        pgInputSha256: jsonSha256(caseOutput.pgInput),
        bootstrapPreservation: bootstrapByCase[caseKey],
      };
      cases[caseKey] = Contract.validateCurrentQ1D7CaseReference(caseReference, binding,
        { expectation: expectations[caseKey], expectedExpectationSha256: expectationSha256[caseKey] });
    }

    deadlineProgress.phase("source_recheck");
    const [runtimeAfter, sourceAfter, inputsAfter] = await Promise.all([
      D1.measureCurrentQ1Runtime(), captureSourceSnapshot(), collectCaseInputs(P),
    ]);
    requireFact(isDeepStrictEqual(runtimeAfter, inputBinding.runtime)
      && migrationDigest(sourceAfter) === inputBinding.migrationSha256,
    "CURRENT_Q1_D7_SOURCE_CHANGED");
    requireSourceClosure(sourceAfter, inputBinding.source);
    for (const caseKey of CASE_KEYS) requireFact(isDeepStrictEqual(contractCase(caseKey, inputsAfter[caseKey]),
      inputBinding.cases[caseKey]), "CURRENT_Q1_D7_CORPUS_CHANGED");

    const expectedController = binding.source.files.find((entry) =>
      entry.path === "apps/worker/scripts/gcp-fastpath-rehearsal.mjs");
    requireFact(expectedController && SHA.test(expectedController.sha256), "CURRENT_Q1_D7_SOURCE_CLOSURE_INVALID");
    const assessment = Contract.assessCurrentQ1D7Qualification({ binding, cases, expectations,
      expectationSha256, pgInputs });
    requireFact(assessment.state === "structurally_complete" && assessment.establishesNativeExecution === false,
      "CURRENT_Q1_D7_QUALIFICATION_UNRESOLVED");
    const reference = {
      schemaVersion: REFERENCE_SCHEMA,
      synthetic: true,
      qualification: assessment.state,
      decisionId: "D7",
      sourceId: binding.sourceId,
      sourceNamespace: binding.sourceNamespace,
      bounds: binding.bounds,
      provenance: { source: binding.source, runtime: binding.runtime, migrationSha256: binding.migrationSha256 },
      cases,
      expectationSha256,
    };
    const acceptance = {
      schemaVersion: ACCEPTANCE_SCHEMA,
      evidenceScope: "direct-source-pinned-producer-controller",
      cryptographicExecutionAttestation: false,
      actualHelperInvocation: true,
      resultReturnedAfterOwnedCleanup: true,
      accepted: true,
      bindingSha256,
      inputBindingSha256: jsonSha256(inputBinding),
      sourceHead: binding.source.head,
      sourceSha256: binding.source.sha256,
      controller: expectedController,
      caseReceipts: Object.fromEntries(CASE_KEYS.map((caseKey) => [caseKey, {
        referenceSha256: jsonSha256(cases[caseKey]),
        expectationSha256: expectationSha256[caseKey],
        corpusSha256: binding.cases[caseKey].corpusSha256,
        admissionSha256: binding.cases[caseKey].admissionSha256,
        sourceInvariantSha256: binding.cases[caseKey].sourceInvariantSha256,
        pgInputSha256: cases[caseKey].pgInputSha256,
        bootstrapPreservationSha256: jsonSha256(cases[caseKey].bootstrapPreservation),
        strictExportSha256: jsonSha256(cases[caseKey].strictExport),
      }])),
    };
    Contract.validateCurrentQ1D7ProducerAcceptance(acceptance, { inputBinding, binding, cases,
      expectations, expectationSha256, pgInputs, expectedController });
    result = { reference, binding, acceptance, cases, expectations,
      expectationSha256, pgInputs, expectedController };
    completed = true;
  } finally {
    try {
      for (const caseKey of [...CASE_KEYS].reverse()) {
        const ctx = contexts[caseKey];
        if (!ctx) continue;
        try { clearCurrentQ1D7PrivateValidatedOracle(ctx); } catch { cleanupFailed = true; }
        for (const handle of [...(ctx.handles ?? [])].reverse()) {
          try { handle.close(); } catch { cleanupFailed = true; }
        }
      }
      try { await D1.closeCurrentQ1BindingScratch({ vite, cacheRoot, cacheIdentity }); }
      catch { cleanupFailed = true; }
    } finally {
      if (scratchRoot && scratchIdentity) {
        try { await removeOwnedCaseDirectory(scratchRoot, scratchIdentity); }
        catch { cleanupFailed = true; }
      }
      try { restore?.(); } catch { cleanupFailed = true; }
      if (cleanupFailed || !completed) {
        for (const [path, identity] of pgDirectories) {
          try { await removeOwnedCaseDirectory(path, identity); }
          catch { cleanupFailed = true; /* preserve a conflicting owner change */ }
        }
      }
      progress.close();
      producerHeld = false;
    }
    requireFact(!cleanupFailed, "CURRENT_Q1_D7_CLEANUP_FAILED");
  }
  return result;
}
