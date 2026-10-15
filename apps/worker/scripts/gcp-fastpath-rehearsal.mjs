#!/usr/bin/env node
// GCP fast-path local end-to-end rehearsal (Q-2).
//
// One command, against a local PostgreSQL 17 only:
//
//   PG_TEST_SOCKET=/private/tmp/tibotattle-pg-.../socket PG_TEST_PORT=55433 \
//     node apps/worker/scripts/gcp-fastpath-rehearsal.mjs --golden apps/worker/analytics-v2-test/golden \
//     --per-date-expected apps/worker/analytics-v2-test/golden-q1-node/per-date-expected.json
//
// (npm run gcp:fastpath:rehearsal in apps/worker runs exactly this.)
//
//  1. creates a fresh typed_legacy_transfer_rehearsal_target_fastpath_<8 hex>
//     schema (plus an importer control schema) and applies every promoted
//     primary migration with the production runner (there is no ledger role);
//  2. rebuilds the Q-1 oracle's USAGE_MONITOR_DB dump into a sealed SQLite;
//  3. runs the importers in order: T-1 identity/authority copy, the
//     typed-legacy transfer, T-2 v1.2, usage-correction and ingestion-journal,
//     then the read-only T-1 verifications (roster, public owners, revisions);
//  4. runs cloud-run/dist/analytics-refresh.mjs --mode=full under Node 22
//     with the golden's nowMs;
//  5. composes cloud-run/dist/server.mjs in fastpath-test mode with
//     ANALYTICS_V2_ENABLED=1, the injected clock and local pools, and serves
//     it on 127.0.0.1 from a child process under the same Node 22 (the
//     image runtime);
//  6. GETs /api/v1/community/daily?from=<golden from>&to=<golden to>;
//  7. In the default historical mode, compares the response and stored preview with the golden
//     (scripts/analytics-v2-parity-compare.mjs, publication fields only
//     normalized) and reports every difference per family. The model dates
//     the golden manifest lists as withheld (modelPublications.missing) may
//     be published by the fast path, and only those, with exactly the values
//     the oracle's per-date expectation holds: per-date model publication is
//     the owner's decision of 2026-10-01 (fast-path plan OD-12, decision D7).
//     Without --per-date-expected such a publication cannot be verified and
//     fails the parity gate. The route serves allowance breakdowns v1.3 (owner
//     decision round 7): the compare accepts exactly the declared relabel and
//     catalog-baseline model-metadata block and holds the v1.3 block's v1.1
//     reduction to the oracle, and the breakdownsV13Declared gate requires that
//     a served breakdown is that declared v1.3;
//  8. runs analytics-refresh again and checks it creates no new revision;
//  9. drops every schema it created (unless --keep-schema).
//
// Current Q-1 mode directly invokes the source-pinned Worker/D1 helper on the
// immutable synthetic corpus before any PG query. It requires the verified
// Node 26.2.0 binary, full current response/preview/cache equality and all
// importer/idempotency gates and immutable daily conservation; other historical
// contract differences remain separate diagnostics.
// --out preserves the original fresh reference, pre-execution input binding and
// acceptance receipt with wx. The receipt is an audit trail, not cryptographic
// execution attestation. No saved-reference or injected-producer CLI path exists.
//
// Options:
//   --comparison-mode <mode>    historical (default), current-worker-d1, or
//                               current-worker-d1-d7 (the closed two-case Q1 mode)
//   --golden <dir>              the oracle golden (required)
//   --dump <usage-monitor-db.json>
//                               the golden's source dump when the golden does not
//                               commit it (golden-dense); its sha256 must equal
//                               the golden manifest's sourceDump.jsonSha256
//   --per-date-expected <file>  the oracle's per-date expectation for this golden's
//                               clock (OD-12): the values on the golden's withheld
//                               dates are held to it, and the stored preview and the
//                               served allowanceBreakdowns are also compared with it
//                               whole (perDateEqual). For the Q-1 golden it is
//                               analytics-v2-test/golden-q1-node/per-date-expected.json
//   --owner-reference <dir>     also hold every owner's stored fits, model dates,
//                               owner-day values, cache bands and refusals to an
//                               oracle's direct native references (owner-results.json
//                               and cache-reference.json; scripts/analytics-v2-owner-parity-compare.mjs)
//   --dense                     the golden is a dense production-code golden
//                               (golden-dense): its served read was captured before
//                               production's graph lane published, so the allowance
//                               and preview families are held to its
//                               per-date-expected.json, and its owner references
//                               are the golden directory itself
//   --refresh-timeout-minutes <n>  per analytics-refresh run (default 30, at most 720)
//   --reuse-schema <schema>     skip steps 1 to 3 and run against a target an earlier
//                               --keep-schema run imported (never dropped here)
//   --staged-primary <name>     also apply this staged primary migration (repeatable;
//                               postgres/staged-migrations/primary/<name>) through the
//                               staged-migrations harness, as the specs do: its SQL
//                               runs after the stock chain and is not recorded as a
//                               receipt. For a line whose code needs a not yet
//                               promoted migration (K-STAMP's kernel stamps)
//   --refresh-workers <n>       run analytics-refresh with --workers=<n> (default 1,
//                               inline; K-PAR)
//   --synthetic-revision-floor  REV-SEED (round 14): before the first refresh, load a
//                               synthetic revision floor through the cutover loader
//                               (cutover-revision-floor.mjs): every golden day but each
//                               seventh at its golden revision plus (its index mod 5).
//                               The gate revisionFloorRespected then holds every
//                               published day at exactly its floor + 1 (r1 without
//                               one). Needs the floor migration (--staged-primary
//                               <its staged name> while it is staged). Parity
//                               normalizes revision fields, so it is unchanged
//   --keep-schema, --out <file>, --node22 <path>
//
// Rehearsal-only and local-only: it never reads production, never pushes and
// never deploys. Inputs are the oracle's synthetic, content-free corpus; the
// report holds counts, digests, day keys and synthetic aggregate values only.
//
// Exit codes: 0 when every step completed, both refresh runs completed (not
// LOCK_HELD), the second run created no revision and every requested compare
// found no unexpected difference; 1 when a step completed but a gate failed
// (the report says which); 2 when the rehearsal could not run.

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

import {
  ANALYTICS_V2_CURRENT_CONTRACT_REPORT_VERSION,
  ANALYTICS_V2_PARITY_REPORT_VERSION,
  compareAnalyticsV2CurrentContract,
  compareAnalyticsV2Parity,
  perDateExpectationFor,
  withheldModelDatesOf,
} from "./analytics-v2-parity-compare.mjs";
import {
  compareAnalyticsV2OwnerParity,
  readAnalyticsV2OwnerRows,
} from "./analytics-v2-owner-parity-compare.mjs";
import { comparePerDate } from "./gcp-fastpath-dense-oracle/per-date-compare.mjs";
import {
  CUTOVER_REVISION_FLOOR_SCHEMA,
  loadRevisionFloorInTransaction,
  parseRevisionFloorFile,
  renderRevisionFloorFile,
} from "./cutover-revision-floor.mjs";
import { rebuildOracleSqlite } from "./gcp-fastpath-oracle-sqlite.mjs";
import {
  compareFastpathOwnerRevisions,
  compareFastpathOwnerRoster,
  compareFastpathPublicSourceOwners,
  openSealedFastpathIdentitySource,
  runPostgresFastpathIdentityCopy,
  runPostgresFastpathTransportCopy,
} from "./postgres-fastpath-identity-copy.mjs";
import {
  createSealedSqliteIngestionJournalSource,
  transferPostgresIngestionJournal,
} from "./postgres-ingestion-journal-transfer.mjs";
import { applyPostgresMigrations, readPostgresMigrations } from "./postgres-migrations.mjs";
import { applyStockAndStagedMigrations } from "../postgres-test/staged-migrations-harness.mjs";
import {
  createSealedSqliteTypedLegacyRehearsalSource,
  POSTGRES_FASTPATH_REHEARSAL_TARGET_SCHEMA_PREFIX,
  POSTGRES_TYPED_LEGACY_CONTROL_SCHEMA_PREFIX,
  runPostgresTypedLegacyTransfer,
} from "./postgres-typed-legacy-transfer.mjs";
import {
  createSealedSqliteUsageCorrectionSource,
  runPostgresUsageCorrectionTransfer,
} from "./postgres-usage-correction-transfer.mjs";
import {
  createSealedSqliteV12RehearsalSource,
  loadPostgresV12EffectiveReader,
  runPostgresV12Transfer,
} from "./postgres-v12-transfer.mjs";

import { createS9Progress, S9_REHEARSAL_DEADLINE_MS } from "./s9-rehearsal-diagnostics.mjs";

export const GCP_FASTPATH_REHEARSAL_REPORT_VERSION = "gcp-fastpath-rehearsal-report-v1";
export const GCP_FASTPATH_CURRENT_REHEARSAL_REPORT_VERSION = "gcp-fastpath-current-rehearsal-report-v1";
export const GCP_FASTPATH_CURRENT_D7_REHEARSAL_REPORT_VERSION = "gcp-fastpath-current-d7-rehearsal-report-v1";

const execFileAsync = promisify(execFile);
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLOUD_RUN_ROOT = join(WORKER_ROOT, "cloud-run");
const DIST_REFRESH = join(CLOUD_RUN_ROOT, "dist", "analytics-refresh.mjs");
const DIST_SERVER = join(CLOUD_RUN_ROOT, "dist", "server.mjs");
const DEFAULT_NODE22 = join(homedir(), ".nvm/versions/node/v22.16.0/bin/node");
const PRIVATE_SOCKET = /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const CURRENT_D7_CASES = Object.freeze(["conflictPreserving", "conflictFreePositive"]);
const CURRENT_D7_CASE_DIRECTORY = Object.freeze({
  conflictPreserving: "conflictPreserving",
  conflictFreePositive: "conflictFreePositive",
});
const CURRENT_D7_STATEMENT_TIMEOUT_RESERVE_MS = 1_000;
const CURRENT_D7_ORIGIN_TERM_GRACE_MS = 1_000;
const CURRENT_D7_ORIGIN_KILL_REAP_MS = 1_000;
const CURRENT_D7_ORIGIN_READINESS_CHALLENGE = "current-d7-origin-readiness-challenge-v1";
const CURRENT_D7_ORIGIN_READINESS_ACK = "current-d7-origin-readiness-ack-v1";
const INTERNAL_CURRENT_D7_CASE = Symbol("internal-current-d7-case");
const COMMUNITY_DAILY_PATH = "/api/v1/community/daily";
const DEFAULT_REFRESH_TIMEOUT_MINUTES = 30;
const MAX_REFRESH_TIMEOUT_MINUTES = 720;
/**
 * The allowance read state production serves once a preview is published
 * (the Q-1 golden's served read). A dense golden's own read was captured
 * before its graph lane published, so its per-date expectation stands in.
 */
const PUBLISHED_ALLOWANCE_STATE = Object.freeze({ allowanceState: "ready", allowanceReadState: "confirmed" });
/**
 * The Node heap analytics-refresh runs with, as the deployed Job does
 * (gcp-fastpath-test-deploy.mjs REFRESH_JOB_RESOURCES.heapMiB, pinned equal by
 * its check): the job's default memory budget needs it.
 */
export const GCP_FASTPATH_REHEARSAL_REFRESH_HEAP_MIB = 6_144;
/**
 * V8's semi-space for an inline rehearsal refresh, as the deployed inline Job
 * runs it (REFRESH_JOB_RESOURCES.semiSpaceMiB, pinned equal by its check;
 * owner decisions round 19, item SEMI). A run with compute Workers sets none,
 * as the dense-workers profile does.
 */
export const GCP_FASTPATH_REHEARSAL_REFRESH_SEMI_SPACE_MIB = 64;

class RehearsalError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

function fail(code, details) {
  throw new RehearsalError(code, details);
}

/** Current qualification always preserves its original producer evidence.
 * This value-only guard must precede all filesystem or runtime operations. */
export function currentRehearsalOutputDestinations(out) {
  if (typeof out !== "string" || out.length === 0 || out.length > 4_096
    || /[\u0000-\u001f\u007f]/u.test(out) || !isAbsolute(out)
    || resolve(out) !== out || dirname(out) === out) {
    fail("REHEARSAL_ARGUMENT_INVALID", { argument: "--out" });
  }
  return [out, `${out}.current-reference.json`, `${out}.current-reference-binding.json`,
    `${out}.current-reference-acceptance.json`];
}

/** Preflight only; wx remains mandatory at every eventual write to close races. */
export async function assertCurrentRehearsalOutputsNew(out) {
  const destinations = currentRehearsalOutputDestinations(out);
  let parent;
  try { parent = await lstat(dirname(out)); } catch { fail("REHEARSAL_CURRENT_OUTPUT_UNAVAILABLE"); }
  if (!parent.isDirectory() || parent.isSymbolicLink()) fail("REHEARSAL_CURRENT_OUTPUT_UNAVAILABLE");
  for (const [index, path] of destinations.entries()) {
    let exists = false;
    try { await lstat(path); exists = true; } catch (error) {
      if (error?.code !== "ENOENT") fail("REHEARSAL_CURRENT_OUTPUT_UNAVAILABLE", { destination: index });
    }
    if (exists) fail("REHEARSAL_CURRENT_OUTPUT_EXISTS", { destination: index });
  }
  return destinations;
}

/** Closed sidecar output set for the explicit two-case D7 handoff. */
export function currentD7RehearsalOutputDestinations(out) {
  if (typeof out !== "string" || out.length === 0 || out.length > 4_096
    || /[\u0000-\u001f\u007f]/u.test(out) || !isAbsolute(out)
    || resolve(out) !== out || dirname(out) === out) {
    fail("REHEARSAL_ARGUMENT_INVALID", { argument: "--out" });
  }
  return [out, `${out}.current-d7-reference.json`, `${out}.current-d7-binding.json`,
    `${out}.current-d7-producer-acceptance.json`, `${out}.current-d7-conflict-preserving-case.json`,
    `${out}.current-d7-conflict-free-positive-case.json`, `${out}.current-d7-contract.json`,
    `${out}.current-d7-input-binding-capture.json`];
}

/** Preflight the entire v3 handoff without following existing destinations. */
export async function assertCurrentD7RehearsalOutputsNew(out) {
  const destinations = currentD7RehearsalOutputDestinations(out);
  let parent;
  try { parent = await lstat(dirname(out)); } catch { fail("REHEARSAL_CURRENT_OUTPUT_UNAVAILABLE"); }
  if (!parent.isDirectory() || parent.isSymbolicLink() || (process.getuid && parent.uid !== process.getuid())
    || (parent.mode & 0o077) !== 0 || (parent.mode & 0o700) !== 0o700
    || await realpath(dirname(out)) !== dirname(out)) fail("REHEARSAL_CURRENT_OUTPUT_UNAVAILABLE");
  for (const [index, path] of destinations.entries()) {
    try {
      await lstat(path);
      fail("REHEARSAL_CURRENT_OUTPUT_EXISTS", { destination: index });
    } catch (error) {
      if (error instanceof RehearsalError) throw error;
      if (error?.code !== "ENOENT") fail("REHEARSAL_CURRENT_OUTPUT_UNAVAILABLE", { destination: index });
    }
  }
  return destinations;
}

export function parseArguments(argv) {
  const options = {
    golden: null, keepSchema: false, out: null, node22: process.env.GCP_FASTPATH_NODE22 || DEFAULT_NODE22,
    dump: null, perDateExpected: null, ownerReference: null, dense: false, comparisonMode: "historical",
    refreshTimeoutMinutes: DEFAULT_REFRESH_TIMEOUT_MINUTES, reuseSchema: null, stagedPrimary: [],
    refreshWorkers: 1, refreshModelBlockSize: 10, refreshModelFanOut: "auto", syntheticRevisionFloor: false,
  };
  const valueOf = (index, argument) => {
    const value = argv[index];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      fail("REHEARSAL_ARGUMENT_INVALID", { argument });
    }
    return value;
  };
  let comparisonModeSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--golden") options.golden = valueOf(++index, argument);
    else if (argument === "--keep-schema") options.keepSchema = true;
    else if (argument === "--dense") options.dense = true;
    else if (argument === "--comparison-mode") {
      const mode = valueOf(++index, argument);
      if (comparisonModeSeen || !["historical", "current-worker-d1", "current-worker-d1-d7"].includes(mode)) {
        fail("REHEARSAL_ARGUMENT_INVALID", { argument });
      }
      comparisonModeSeen = true; options.comparisonMode = mode;
    }
    else if (argument === "--synthetic-revision-floor") options.syntheticRevisionFloor = true;
    else if (argument === "--out") options.out = valueOf(++index, argument);
    else if (argument === "--node22") options.node22 = valueOf(++index, argument);
    else if (argument === "--dump") options.dump = valueOf(++index, argument);
    else if (argument === "--per-date-expected") options.perDateExpected = valueOf(++index, argument);
    else if (argument === "--owner-reference") options.ownerReference = valueOf(++index, argument);
    else if (argument === "--reuse-schema") options.reuseSchema = valueOf(++index, argument);
    else if (argument === "--staged-primary") {
      const name = valueOf(++index, argument);
      if (!/^\d{4}_[a-z][a-z0-9_-]*\.sql$/u.test(name) || options.stagedPrimary.includes(name)) {
        fail("REHEARSAL_ARGUMENT_INVALID", { argument });
      }
      options.stagedPrimary.push(name);
    } else if (argument === "--refresh-workers") {
      const workers = Number(valueOf(++index, argument));
      if (!Number.isSafeInteger(workers) || workers < 1 || workers > 16) fail("REHEARSAL_ARGUMENT_INVALID", { argument });
      options.refreshWorkers = workers;
    }
    else if (argument === "--refresh-model-block-size") {
      const size = Number(valueOf(++index, argument));
      if (!Number.isSafeInteger(size) || size < 1 || size > 70) fail("REHEARSAL_ARGUMENT_INVALID", { argument });
      options.refreshModelBlockSize = size;
    } else if (argument === "--refresh-model-fanout") {
      const mode = valueOf(++index, argument);
      if (!["auto", "all", "off"].includes(mode)) fail("REHEARSAL_ARGUMENT_INVALID", { argument });
      options.refreshModelFanOut = mode;
    } else if (argument === "--refresh-timeout-minutes") {
      const minutes = Number(valueOf(++index, argument));
      if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_REFRESH_TIMEOUT_MINUTES) {
        fail("REHEARSAL_ARGUMENT_INVALID", { argument });
      }
      options.refreshTimeoutMinutes = minutes;
    } else fail("REHEARSAL_ARGUMENT_INVALID", { argument });
  }
  if (typeof options.golden !== "string" || options.golden.length === 0) fail("REHEARSAL_GOLDEN_REQUIRED");
  options.golden = resolve(options.golden);
  for (const key of ["out", "dump", "perDateExpected", "ownerReference"]) {
    if (options[key] !== null) options[key] = resolve(options[key]);
  }
  if (options.comparisonMode === "current-worker-d1" && options.reuseSchema !== null) {
    fail("REHEARSAL_ARGUMENT_INVALID", { argument: "--reuse-schema" });
  }
  if (options.comparisonMode === "current-worker-d1") currentRehearsalOutputDestinations(options.out);
  if (options.comparisonMode === "current-worker-d1" && (options.dense || options.ownerReference !== null)) {
    fail("REHEARSAL_ARGUMENT_INVALID", { argument: "--comparison-mode" });
  }
  if (options.comparisonMode === "current-worker-d1-d7") {
    if (!options.keepSchema) fail("REHEARSAL_ARGUMENT_INVALID", { argument: "--keep-schema" });
    if (options.reuseSchema !== null) fail("REHEARSAL_ARGUMENT_INVALID", { argument: "--reuse-schema" });
    if (options.dump !== null) fail("REHEARSAL_ARGUMENT_INVALID", { argument: "--dump" });
    if (options.perDateExpected !== null) fail("REHEARSAL_ARGUMENT_INVALID", { argument: "--per-date-expected" });
    if (options.ownerReference !== null || options.dense || options.syntheticRevisionFloor
      || options.stagedPrimary.length > 0) {
      fail("REHEARSAL_ARGUMENT_INVALID", { argument: "--comparison-mode" });
    }
    currentD7RehearsalOutputDestinations(options.out);
  }
  if (options.dense) {
    // A dense golden carries its own per-date expectation and owner references.
    if (options.perDateExpected !== null || options.ownerReference !== null) {
      fail("REHEARSAL_ARGUMENT_INVALID", { argument: "--dense" });
    }
    options.perDateExpected = join(options.golden, "per-date-expected.json");
    options.ownerReference = options.golden;
  }
  // A floor is loadable only before the first publication: never on a reused schema.
  if (options.syntheticRevisionFloor && options.reuseSchema !== null) {
    fail("REHEARSAL_ARGUMENT_INVALID", { argument: "--synthetic-revision-floor" });
  }
  if (options.reuseSchema !== null) {
    if (!options.reuseSchema.startsWith(POSTGRES_FASTPATH_REHEARSAL_TARGET_SCHEMA_PREFIX)) {
      fail("REHEARSAL_ARGUMENT_INVALID", { argument: "--reuse-schema" });
    }
    fastpathRehearsalSchemas(options.reuseSchema.slice(POSTGRES_FASTPATH_REHEARSAL_TARGET_SCHEMA_PREFIX.length));
  }
  return options;
}

/** Historical declarations remain confined to historical qualification.
 * Current qualification requires the complete independently bound D1 result. */
export function rehearsalComparisonGates({ comparisonMode, parity, currentContractParity,
  hasAllowanceBreakdowns, perDate, producerAcceptance }) {
  if (comparisonMode === "historical") return {
    parityZeroUnexpected: parity?.unexpectedDiffs === 0,
    ...(hasAllowanceBreakdowns ? { breakdownsV13Declared: parity?.breakdownsV13?.accepted === true } : {}),
    ...(perDate === undefined ? {} : { perDateEqual: perDate.equal === true }),
  };
  if (comparisonMode !== "current-worker-d1") fail("REHEARSAL_ARGUMENT_INVALID", { argument: "--comparison-mode" });
  const bound = currentContractParity?.schemaVersion === ANALYTICS_V2_CURRENT_CONTRACT_REPORT_VERSION
    && currentContractParity.comparisonMode === "current-worker-d1"
    && currentContractParity.referenceBound === true && currentContractParity.referenceComplete === true
    && currentContractParity.recomputationComplete === true && currentContractParity.corpusConvergenceComplete === true
    && currentContractParity.strictExportRefusalVerified === true;
  const evidenceFields = ["referenceSha256", "recomputationSha256", "corpusConvergenceSha256", "strictExportRefusalSha256"];
  const evidenceBound = evidenceFields.every((field) => typeof currentContractParity?.[field] === "string"
    && /^[a-f0-9]{64}$/u.test(currentContractParity[field]) && producerAcceptance?.[field] === currentContractParity[field]);
  const producerAccepted = producerAcceptance?.schemaVersion === "current-q1-d1-producer-acceptance-v2"
    && producerAcceptance.accepted === true && producerAcceptance.actualHelperInvocation === true
    && producerAcceptance.resultReturnedAfterOwnedCleanup === true && producerAcceptance.cryptographicExecutionAttestation === false
    && evidenceBound;
  // These immutable daily families predate the evolving allowance/catalog
  // contracts. Equality between two current runtimes alone cannot conserve
  // their corpus amounts. Missing families or incomplete comparisons fail.
  const days = parity?.days;
  const coverage = parity?.schemaVersion === ANALYTICS_V2_PARITY_REPORT_VERSION
    && Number.isSafeInteger(days?.golden) && days.golden > 0 && days.actual === days.golden
    && Array.isArray(days.missingInActual) && days.missingInActual.length === 0
    && Array.isArray(days.extraInActual) && days.extraInActual.length === 0;
  const conserved = coverage && Array.isArray(parity?.families)
    && ["daily-days", "daily-totals", "daily-cells", "daily-other"].every((name) => {
      const found = parity.families.filter((entry) => entry?.family === name);
      const expected = name === "daily-days" ? 1 : days.golden;
      return found.length === 1 && found[0].expected === false && found[0].diffCount === 0
        && found[0].compared === expected && found[0].equal === expected;
    });
  return { currentWorkerD1ProducerAccepted: producerAccepted,
    currentWorkerD1ReferenceComplete: producerAccepted && bound,
    currentWorkerD1Equality: producerAccepted && bound && currentContractParity.equal === true && currentContractParity.unexpectedDiffs === 0,
    immutableCorpusDailyConserved: conserved === true };
}

async function sha256OfFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sameD7FileStat(left, right) {
  return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.nlink === right.nlink
    && left.size === right.size && left.mode === right.mode && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** Recheck both exact sealed transport files, their ownership and descriptor hashes. */
async function verifyCurrentD7PgCaseInputFiles({ descriptor, binding, caseId, pgInputDirectory, validateDescriptor }) {
  validateDescriptor(descriptor, binding, caseId, { expectedDirectory: join(pgInputDirectory, CURRENT_D7_CASE_DIRECTORY[caseId]) });
  const rootStat = await lstat(pgInputDirectory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (process.getuid && rootStat.uid !== process.getuid())
    || (rootStat.mode & 0o777) !== 0o700 || await realpath(pgInputDirectory) !== pgInputDirectory) {
    fail("REHEARSAL_CURRENT_D7_INPUT_INVALID");
  }
  const caseDirectory = join(pgInputDirectory, CURRENT_D7_CASE_DIRECTORY[caseId]);
  const directoryStat = await lstat(caseDirectory);
  const canonicalDirectory = await realpath(caseDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || canonicalDirectory !== caseDirectory
    || (process.getuid && directoryStat.uid !== process.getuid()) || (directoryStat.mode & 0o777) !== 0o700) {
    fail("REHEARSAL_CURRENT_D7_INPUT_INVALID");
  }
  const names = (await readdir(caseDirectory)).sort();
  if (JSON.stringify(names) !== JSON.stringify(["ingestion.sqlite", "journal.sqlite"])) {
    fail("REHEARSAL_CURRENT_D7_INPUT_INVALID");
  }
  const observed = {};
  for (const [kind, name] of [["ingestion", "ingestion.sqlite"], ["journal", "journal.sqlite"]]) {
    const file = descriptor[kind];
    const expectedPath = join(caseDirectory, name);
    if (file.path !== expectedPath) fail("REHEARSAL_CURRENT_D7_INPUT_INVALID");
    let before;
    try { before = await lstat(file.path); } catch { fail("REHEARSAL_CURRENT_D7_INPUT_INVALID"); }
    if (!before.isFile() || before.isSymbolicLink() || (process.getuid && before.uid !== process.getuid())
      || before.nlink !== 1 || (before.mode & 0o777) !== 0o444 || before.size !== file.bytes
      || await realpath(file.path) !== file.path) fail("REHEARSAL_CURRENT_D7_INPUT_INVALID");
    const sha256 = await sha256OfFile(file.path);
    let after;
    try { after = await lstat(file.path); } catch { fail("REHEARSAL_CURRENT_D7_INPUT_INVALID"); }
    if (!sameD7FileStat(before, after) || sha256 !== file.sha256) fail("REHEARSAL_CURRENT_D7_INPUT_INVALID");
    observed[kind] = { sha256, bytes: before.size, dev: before.dev, ino: before.ino, uid: before.uid,
      mode: before.mode, nlink: before.nlink, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs };
  }
  return observed;
}

async function writeCurrentD7Sidecar(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (process.getuid && metadata.uid !== process.getuid())
    || (metadata.mode & 0o777) !== 0o600 || metadata.nlink !== 1 || metadata.size !== bytes.length) {
    fail("REHEARSAL_CURRENT_D7_OUTPUT_INVALID");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

function exactCurrentD7Keys(value, keys, code = "REHEARSAL_CURRENT_D7_EVIDENCE_INVALID") {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) fail(code);
  return value;
}

function sameCurrentD7Json(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function currentD7Hash(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function cloneAndFreezeCurrentD7Json(value) {
  let clone;
  try { clone = JSON.parse(JSON.stringify(value)); }
  catch { fail("REHEARSAL_CURRENT_D7_INPUT_BINDING_INVALID"); }
  const freeze = (current) => {
    if (current !== null && typeof current === "object" && !Object.isFrozen(current)) {
      for (const child of Object.values(current)) freeze(child);
      Object.freeze(current);
    }
    return current;
  };
  return freeze(clone);
}

async function currentD7SidecarMetadata(path) {
  let metadata;
  try { metadata = await lstat(path); } catch { fail("REHEARSAL_CURRENT_D7_OUTPUT_INVALID"); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (process.getuid && metadata.uid !== process.getuid())
    || (metadata.mode & 0o777) !== 0o600 || metadata.nlink !== 1 || await realpath(path) !== path) {
    fail("REHEARSAL_CURRENT_D7_OUTPUT_INVALID");
  }
  return metadata;
}

async function verifyCurrentD7InputBindingCapture(path, expectedMetadata, expectedSha256) {
  const before = await currentD7SidecarMetadata(path);
  if (!sameD7FileStat(expectedMetadata, before)) fail("REHEARSAL_CURRENT_D7_INPUT_BINDING_CAPTURE_CHANGED");
  const sha256 = await sha256OfFile(path);
  const after = await currentD7SidecarMetadata(path);
  if (!sameD7FileStat(before, after) || sha256 !== expectedSha256) {
    fail("REHEARSAL_CURRENT_D7_INPUT_BINDING_CAPTURE_CHANGED");
  }
  return sha256;
}

/** Pin the actual PG runner inputs independently of its output. */
async function currentPostgresInputBinding({ node22, node22Version, stagedPrimary }) {
  if (node22Version !== "v22.16.0") fail("REHEARSAL_CURRENT_IMAGE_RUNTIME_INVALID");
  const imageRuntime = await verifyCurrentImageRuntimePath(node22);
  const primary = (await readPostgresMigrations({ role: "primary" })).map(({ name, sha256 }) => ({ name, sha256 }));
  const staged = [];
  for (const name of [...stagedPrimary].sort()) staged.push({ name,
    sha256: await sha256OfFile(join(WORKER_ROOT, "postgres", "staged-migrations", "primary", name)) });
  const bundles = [];
  for (const name of ["analytics-refresh.mjs", "server.mjs"]) bundles.push({
    path: `apps/worker/cloud-run/dist/${name}`, sha256: await sha256OfFile(join(CLOUD_RUN_ROOT, "dist", name)) });
  return { schemaVersion: "current-q1-postgres-input-binding-v1", primary, staged, bundles,
    controller: { path: "apps/worker/scripts/gcp-fastpath-rehearsal.mjs", sha256: await sha256OfFile(fileURLToPath(import.meta.url)) },
    node22: { version: imageRuntime.version, sha256: imageRuntime.binarySha256 } };
}

const CURRENT_IMAGE_NODE22_PINS = Object.freeze({
  "darwin/arm64": "a45751fbfe88440bebff63cd44814e4ed6deb642bc3e3c4a14c4f8ae0ed9e019",
  "linux/x64": "8142d37c6f2f372ef040419e7a111a6baf17df89f8078d02447d6c639ae20c1d",
});

export function assertCurrentImageRuntime({ version, platform, arch, binarySha256 }) {
  const expected = CURRENT_IMAGE_NODE22_PINS[`${platform}/${arch}`];
  if (version !== "v22.16.0" || typeof expected !== "string" || binarySha256 !== expected) {
    fail("REHEARSAL_CURRENT_IMAGE_RUNTIME_INVALID");
  }
}

/** Hash only an explicit regular retained executable, before probing it. */
export async function verifyCurrentImageRuntimePath(node) {
  if (typeof node !== "string" || !isAbsolute(node) || resolve(node) !== node
    || /[\u0000-\u001f\u007f]/u.test(node)) fail("REHEARSAL_CURRENT_IMAGE_RUNTIME_INVALID");
  let metadata;
  try { metadata = await lstat(node); } catch { fail("REHEARSAL_CURRENT_IMAGE_RUNTIME_INVALID"); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 512 * 1024 * 1024) {
    fail("REHEARSAL_CURRENT_IMAGE_RUNTIME_INVALID");
  }
  const identity = { version: "v22.16.0", platform: process.platform, arch: process.arch,
    binarySha256: await sha256OfFile(node) };
  assertCurrentImageRuntime(identity);
  const after = await lstat(node);
  if (!after.isFile() || after.isSymbolicLink() || after.dev !== metadata.dev || after.ino !== metadata.ino
    || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs) {
    fail("REHEARSAL_CURRENT_IMAGE_RUNTIME_INVALID");
  }
  return identity;
}

/**
 * The golden's source dump: committed under <golden>/dump, or given with
 * --dump when the golden records only its digest. A dump the golden pins
 * (manifest sourceDump.jsonSha256) must match it byte for byte.
 */
export async function resolveRehearsalDump({ golden, dump, manifest }) {
  const committed = join(golden, "dump", "usage-monitor-db.json");
  if (dump !== null && existsSync(committed)) fail("REHEARSAL_DUMP_AMBIGUOUS");
  const path = dump ?? committed;
  if (!existsSync(path)) fail("REHEARSAL_DUMP_MISSING");
  const pinned = manifest?.sourceDump?.jsonSha256;
  if (dump !== null && typeof pinned !== "string") fail("REHEARSAL_DUMP_UNPINNED");
  const sha256 = await sha256OfFile(path);
  if (typeof pinned === "string" && sha256 !== pinned) fail("REHEARSAL_DUMP_DIGEST_MISMATCH");
  return { path, sha256, pinned: typeof pinned === "string" };
}

async function localEndpoint(env) {
  const socket = env.PG_TEST_SOCKET || undefined;
  const host = env.PG_TEST_HOST || undefined;
  const port = Number(env.PG_TEST_PORT ?? "55432");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) fail("REHEARSAL_DATABASE_INVALID");
  if (socket !== undefined) {
    if (!PRIVATE_SOCKET.test(socket)) fail("REHEARSAL_DATABASE_INVALID");
    const link = await lstat(socket);
    const real = await realpath(socket);
    const metadata = await stat(real);
    if (link.isSymbolicLink() || !metadata.isDirectory() || !real.startsWith("/private/tmp/tibotattle-pg-")
        || (metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid()) {
      fail("REHEARSAL_DATABASE_INVALID");
    }
    return { host: real, port };
  }
  if (host !== undefined && LOOPBACK_HOSTS.has(host)) return { host, port };
  return fail("REHEARSAL_DATABASE_UNCONFIGURED");
}

function poolOptions(endpoint, max, applicationName, { deadlineMonotonicMs } = {}) {
  const statementTimeoutMs = deadlineMonotonicMs === undefined ? null
    : currentD7StatementTimeoutMs(deadlineMonotonicMs);
  return {
    host: endpoint.host,
    port: endpoint.port,
    user: process.env.PG_TEST_USER || "postgres",
    database: process.env.PG_TEST_DATABASE || "postgres",
    ...(process.env.PG_TEST_PASSWORD ? { password: process.env.PG_TEST_PASSWORD } : {}),
    ssl: false,
    max,
    connectionTimeoutMillis: statementTimeoutMs === null ? 10_000 : Math.min(10_000, statementTimeoutMs),
    ...(statementTimeoutMs === null ? {} : { statement_timeout: statementTimeoutMs }),
    application_name: applicationName,
  };
}

function quoteIdentifier(name) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(name)) fail("REHEARSAL_IDENTIFIER_INVALID");
  return `"${name}"`;
}

async function timed(timings, name, work) {
  const started = performance.now();
  try {
    return await work();
  } finally {
    timings[name] = Math.round(performance.now() - started);
  }
}

/** One monotonic deadline is shared by both D7 cases and every child start. */
export function currentD7RemainingMs(deadlineMonotonicMs, nowMonotonicMs = performance.now()) {
  if (!Number.isFinite(deadlineMonotonicMs) || !Number.isFinite(nowMonotonicMs)) {
    fail("REHEARSAL_CURRENT_D7_DEADLINE_INVALID");
  }
  const remaining = Math.floor(deadlineMonotonicMs - nowMonotonicMs);
  if (remaining <= 0) fail("REHEARSAL_CURRENT_D7_DEADLINE_EXHAUSTED");
  return remaining;
}

/**
 * Reserve a short local-connection margin for setting the server timeout before
 * each D7 statement. PostgreSQL's statement_timeout performs server-side query
 * cancellation; the parent process deadline remains the absolute 40-minute cap.
 */
export function currentD7StatementTimeoutMs(deadlineMonotonicMs, nowMonotonicMs = performance.now()) {
  const remaining = currentD7RemainingMs(deadlineMonotonicMs, nowMonotonicMs);
  const statementTimeoutMs = remaining - CURRENT_D7_STATEMENT_TIMEOUT_RESERVE_MS;
  if (statementTimeoutMs <= 0) fail("REHEARSAL_CURRENT_D7_DEADLINE_EXHAUSTED");
  return statementTimeoutMs;
}

function assertCurrentD7PromisePgArguments(args, operation) {
  if (args.length === 0 || args.some((argument) => typeof argument === "function")) {
    fail("REHEARSAL_CURRENT_D7_PG_ADAPTER_INVALID", { operation });
  }
}

async function checkoutCurrentD7Client(pool, deadlineMonotonicMs) {
  const remainingMs = currentD7RemainingMs(deadlineMonotonicMs);
  let timedOut = false;
  let timer;
  const timeoutError = new RehearsalError("REHEARSAL_CURRENT_D7_DEADLINE_EXHAUSTED");
  const pending = Promise.resolve().then(() => pool.connect());
  pending.then((client) => {
    if (timedOut) {
      try { client.release(timeoutError); } catch { /* no query may use a late checkout */ }
    }
  }, () => {});
  const deadline = new Promise((resolveDeadline, rejectDeadline) => {
    timer = setTimeout(() => {
      timedOut = true;
      rejectDeadline(timeoutError);
    }, remainingMs);
  });
  let client;
  try {
    client = await Promise.race([pending, deadline]);
    if (timedOut) throw timeoutError;
    currentD7RemainingMs(deadlineMonotonicMs);
    return client;
  } catch (error) {
    if (client) {
      try { client.release(error); } catch { /* preserve the acquisition failure */ }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function currentD7QueryText(args) {
  const query = args[0];
  if (typeof query === "string") return query;
  if (query !== null && typeof query === "object" && typeof query.text === "string") return query.text;
  return "";
}

/** Only importer-owned string statements may bypass the per-query setter. */
function isCurrentD7OwnedRollbackCleanup(args) {
  if (args.length !== 1 || typeof args[0] !== "string") return false;
  const text = args[0];
  const statement = text.trim().replace(/\s+/gu, " ").replace(/;$/u, "").toUpperCase();
  return statement === "ROLLBACK"
    || statement === "ROLLBACK TO SAVEPOINT TIBOTATTLE_TRANSFER_TRIGGER_POLICY";
}

function makeCurrentD7DeadlineClient(client, deadlineMonotonicMs) {
  let tail = Promise.resolve();
  let discardError = null;
  const query = (...args) => {
    assertCurrentD7PromisePgArguments(args, "query");
    const operation = tail.then(async () => {
      if (discardError !== null) throw discardError;
      try {
        // An aborted transaction only accepts ROLLBACK. These two exact
        // importer cleanup statements cannot be preceded by set_config: that
        // command is itself refused by PostgreSQL in an aborted transaction.
        // The connection retains the server-side statement_timeout installed
        // by poolOptions or the last successful D7 statement. The controller's
        // original absolute child deadline remains the outer bound; refuse
        // cleanup with less than the setter reserve and discard the session.
        if (isCurrentD7OwnedRollbackCleanup(args)) {
          currentD7StatementTimeoutMs(deadlineMonotonicMs);
          return await client.query(...args);
        }

        const timeoutMs = currentD7StatementTimeoutMs(deadlineMonotonicMs);
        await client.query("SELECT set_config('statement_timeout', $1, false)", [`${timeoutMs}ms`]);
        // Config/target stay adjacent in this per-client queue, and a query that
        // waited for another operation or for connection acquisition is refused.
        // The setter itself has a bounded startup/prior-session timeout. If it
        // consumed the one-second reserve, do not send a target statement whose
        // server timeout could now outlive this controller's absolute deadline.
        currentD7StatementTimeoutMs(deadlineMonotonicMs);
        return await client.query(...args);
      } catch (error) {
        if (error?.code === "REHEARSAL_CURRENT_D7_DEADLINE_EXHAUSTED"
          || performance.now() >= deadlineMonotonicMs) {
          // A timed-out owner must not return an open or aborted session to pg's
          // reusable pool. Do not permit later work after this point either.
          discardError ??= error;
        } else if (isCurrentD7OwnedRollbackCleanup(args)) {
          // A failed rollback leaves transaction state unknown. pg discards the
          // session when release receives this error.
          discardError ??= error;
        }
        throw error;
      }
    });
    tail = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const release = (...args) => {
    const releaseAfterPendingQueries = () => client.release(args[0] ?? discardError, ...args.slice(1));
    return tail.then(releaseAfterPendingQueries, releaseAfterPendingQueries);
  };
  return new Proxy(client, {
    get(target, property) {
      if (property === "query") return query;
      if (property === "release") return release;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * D7-only adapter over pg's public Pool/PoolClient query/connect/end surface.
 * It configures PostgreSQL statement_timeout on the same checked-out client as
 * each statement, serializing that setup with the statement for transactions.
 */
export function createCurrentD7DeadlinePool(pool, deadlineMonotonicMs) {
  if (pool === null || typeof pool !== "object" || typeof pool.connect !== "function"
    || typeof pool.end !== "function") fail("REHEARSAL_CURRENT_D7_PG_ADAPTER_INVALID");
  currentD7RemainingMs(deadlineMonotonicMs);
  return new Proxy(pool, {
    get(target, property) {
      if (property === "connect") return async (...args) => {
        if (args.length !== 0) fail("REHEARSAL_CURRENT_D7_PG_ADAPTER_INVALID", { operation: "connect" });
        const client = await checkoutCurrentD7Client(target, deadlineMonotonicMs);
        return makeCurrentD7DeadlineClient(client, deadlineMonotonicMs);
      };
      if (property === "query") return async (...args) => {
        assertCurrentD7PromisePgArguments(args, "query");
        const client = await checkoutCurrentD7Client(target, deadlineMonotonicMs);
        let releaseError;
        try {
          return await makeCurrentD7DeadlineClient(client, deadlineMonotonicMs).query(...args);
        } catch (error) {
          releaseError = error;
          throw error;
        } finally {
          client.release(releaseError);
        }
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function waitForCurrentD7OwnedChildExit(exited, timeoutMs) {
  let timer;
  return Promise.race([exited, new Promise((resolveExit) => {
    timer = setTimeout(() => resolveExit(null), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

async function stopCurrentD7OwnedChild(child, exited, spawned) {
  const running = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  if (child.pid === undefined && child.exitCode === null && child.signalCode === null) {
    const didSpawn = await waitForCurrentD7OwnedChildExit(spawned, CURRENT_D7_ORIGIN_TERM_GRACE_MS);
    if (didSpawn === false) return (await waitForCurrentD7OwnedChildExit(exited, CURRENT_D7_ORIGIN_TERM_GRACE_MS))
      ?? { spawnError: true };
    if (didSpawn === null) fail("REHEARSAL_ORIGIN_CHILD_CLEANUP_FAILED");
  }
  if (!running()) {
    const result = await waitForCurrentD7OwnedChildExit(exited, CURRENT_D7_ORIGIN_TERM_GRACE_MS);
    if (result === null) fail("REHEARSAL_ORIGIN_CHILD_CLEANUP_FAILED");
    return result;
  }
  try { child.kill("SIGTERM"); } catch { /* still wait, then use SIGKILL if the owned child remains */ }
  let result = await waitForCurrentD7OwnedChildExit(exited, CURRENT_D7_ORIGIN_TERM_GRACE_MS);
  if (result !== null) return result;
  if (running()) {
    try { child.kill("SIGKILL"); } catch { /* the bounded reap below reports failure if it remains */ }
  }
  result = await waitForCurrentD7OwnedChildExit(exited, CURRENT_D7_ORIGIN_KILL_REAP_MS);
  if (result === null) fail("REHEARSAL_ORIGIN_CHILD_CLEANUP_FAILED");
  return result;
}

/** Await the owned origin child's stdout record and nonce-bound IPC acknowledgement. */
export async function awaitCurrentD7OriginReadiness(child, { readyTimeoutMs, readinessNonce }) {
  if (!child || !child.stdout || !child.stderr || typeof child.kill !== "function"
    || typeof child.send !== "function" || !Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1
    || typeof readinessNonce !== "string" || !/^[a-f0-9]{64}$/u.test(readinessNonce)) {
    fail("REHEARSAL_ORIGIN_START_FAILED");
  }
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4_000); });
  const spawned = child.pid !== undefined ? Promise.resolve(true) : new Promise((resolveSpawned) => {
    child.once("spawn", () => resolveSpawned(true));
    child.once("error", () => resolveSpawned(false));
  });
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
    : new Promise((resolveExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
      child.once("error", () => {
        if (child.pid === undefined) resolveExit({ spawnError: true });
      });
    });
  try {
    return await new Promise((resolveReady, rejectReady) => {
      let buffer = Buffer.alloc(0);
      let readyRecord = null;
      let readinessRecordConsumed = false;
      let challengeSent = false;
      let challengeDeliveryConfirmed = false;
      let acknowledged = false;
      let ipcUnavailable = !child.connected;
      let spawnConfirmed = child.pid !== undefined;
      let settled = false;
      const deadlineMonotonicMs = performance.now() + readyTimeoutMs;
      let timer;
      const expire = () => finish(rejectReady, new RehearsalError(ipcUnavailable
        ? "REHEARSAL_ORIGIN_START_FAILED" : "REHEARSAL_ORIGIN_START_TIMEOUT"));
      const expireIfPastDeadline = () => {
        if (performance.now() < deadlineMonotonicMs) return false;
        expire();
        return true;
      };
      const finish = (work, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.removeListener("data", onData);
        child.removeListener("message", onMessage);
        child.removeListener("error", onError);
        child.removeListener("disconnect", onDisconnect);
        child.removeListener("spawn", onSpawn);
        work(value);
      };
      const maybeResolve = () => {
        if (expireIfPastDeadline()) return;
        if (ipcUnavailable || !child.connected) return;
        if (!spawnConfirmed || readyRecord === null || !acknowledged) return;
        if (!challengeDeliveryConfirmed) return;
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
          finish(rejectReady, new RehearsalError("REHEARSAL_ORIGIN_START_FAILED"));
          return;
        }
        finish(resolveReady, { ready: readyRecord, exited });
      };
      const onData = (chunk) => {
        if (readinessRecordConsumed || expireIfPastDeadline()) return;
        let chunkBytes;
        try { chunkBytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); }
        catch { finish(rejectReady, new RehearsalError("REHEARSAL_ORIGIN_START_FAILED")); return; }
        const newline = chunkBytes.indexOf(0x0a);
        if (newline < 0) {
          if (buffer.length + chunkBytes.length > 8_192) {
            finish(rejectReady, new RehearsalError("REHEARSAL_ORIGIN_START_FAILED"));
            return;
          }
          buffer = Buffer.concat([buffer, chunkBytes]);
          return;
        }
        if (buffer.length + newline > 8_192) {
          finish(rejectReady, new RehearsalError("REHEARSAL_ORIGIN_START_FAILED"));
          return;
        }
        const line = Buffer.concat([buffer, chunkBytes.subarray(0, newline)]).toString("utf8");
        buffer = Buffer.alloc(0);
        readinessRecordConsumed = true;
        child.stdout.removeListener("data", onData);
        let value;
        try {
          value = JSON.parse(line);
          if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.origin !== "string") {
            throw new Error("invalid readiness record");
          }
        } catch { finish(rejectReady, new RehearsalError("REHEARSAL_ORIGIN_START_FAILED")); return; }
        readyRecord = value;
        challengeSent = true;
        if (!child.connected) ipcUnavailable = true;
        else {
          try {
            child.send({ type: CURRENT_D7_ORIGIN_READINESS_CHALLENGE, nonce: readinessNonce }, (error) => {
              if (error) ipcUnavailable = true;
              else challengeDeliveryConfirmed = true;
              maybeResolve();
            });
          } catch { ipcUnavailable = true; }
        }
        maybeResolve();
      };
      const onMessage = (message) => {
        if (expireIfPastDeadline()) return;
        if (ipcUnavailable || !child.connected) {
          ipcUnavailable = true;
          return;
        }
        if (!challengeSent || readyRecord === null) {
          finish(rejectReady, new RehearsalError("REHEARSAL_ORIGIN_START_FAILED"));
          return;
        }
        let valid = false;
        try {
          const acknowledgement = exactCurrentD7Keys(message, ["type", "nonce", "origin"],
            "REHEARSAL_ORIGIN_START_FAILED");
          valid = acknowledgement.type === CURRENT_D7_ORIGIN_READINESS_ACK
            && acknowledgement.nonce === readinessNonce && acknowledgement.origin === readyRecord.origin;
        } catch { /* reject only with the closed origin-start error */ }
        if (!valid) {
          finish(rejectReady, new RehearsalError("REHEARSAL_ORIGIN_START_FAILED"));
          return;
        }
        acknowledged = true;
        maybeResolve();
      };
      const onError = () => { ipcUnavailable = true; };
      // ChildProcess may emit disconnect before exit and still have exitCode=null.
      // Defer classification to the exit event or this same readiness deadline.
      const onDisconnect = () => { ipcUnavailable = true; };
      const onSpawn = () => { spawnConfirmed = true; maybeResolve(); };
      const onExit = (outcome) => {
        if (outcome === null) return;
        const last = stderr.trim().split("\n").filter(Boolean).at(-1) ?? "";
        let childCode = "REHEARSAL_ORIGIN_EXITED";
        try {
          const parsedCode = JSON.parse(last).code;
          if (typeof parsedCode === "string" && /^[A-Z0-9_]{1,80}$/u.test(parsedCode)) childCode = parsedCode;
        } catch { /* keep the closed child code */ }
        finish(rejectReady, new RehearsalError("REHEARSAL_ORIGIN_START_FAILED", { childCode }));
      };
      timer = setTimeout(expire, Math.max(0, deadlineMonotonicMs - performance.now()));
      child.stdout.on("data", onData);
      child.on("message", onMessage);
      child.once("error", onError);
      child.once("disconnect", onDisconnect);
      if (child.pid === undefined) child.once("spawn", onSpawn);
      spawned.then((didSpawn) => {
        if (!didSpawn) finish(rejectReady, new RehearsalError("REHEARSAL_ORIGIN_START_FAILED"));
        else { spawnConfirmed = true; maybeResolve(); }
      });
      exited.then(onExit);
      if (!child.connected) ipcUnavailable = true;
      if (child.exitCode !== null || child.signalCode !== null) onExit({ code: child.exitCode, signal: child.signalCode });
    });
  } catch (error) {
    await stopCurrentD7OwnedChild(child, exited, spawned);
    const code = error?.code === "REHEARSAL_ORIGIN_START_TIMEOUT"
      ? "REHEARSAL_ORIGIN_START_TIMEOUT" : "REHEARSAL_ORIGIN_START_FAILED";
    throw new RehearsalError(code, code === "REHEARSAL_ORIGIN_START_FAILED" && error?.details?.childCode
      ? { childCode: error.details.childCode } : {});
  }
}

const CURRENT_D7_CASE_RECEIPT_KEYS = Object.freeze([
  "caseId", "schemaVersion", "referenceSha256", "expectationSha256", "corpusSha256", "admissionSha256",
  "sourceInvariantSha256", "pgInputSha256", "bootstrapPreservationSha256", "strictExportSha256",
  "actualResponseSha256", "actualPreviewSha256", "schema", "controlSchema", "currentDay", "retainedForS9Cleanup",
]);
const CURRENT_D7_QUALIFICATION_KEYS = Object.freeze([
  "schemaVersion", "comparisonMode", "decisionId", "caseIds", "inputBindingSha256",
  "inputBindingCaptureContentSha256", "bindingSha256",
  "referenceContentSha256", "producerAcceptanceContentSha256", "contractContentSha256", "caseReceipts",
  "sidecars", "cleanupPending", "qualifying", "establishesNativeExecution", "deadlineMs", "elapsedMs",
  "pgInputSnapshotsRemoved",
]);
const CURRENT_D7_SIDECAR_HASH_KEYS = Object.freeze([
  "referenceSha256", "bindingSha256", "producerAcceptanceSha256", "conflictPreservingCaseSha256",
  "conflictFreePositiveCaseSha256", "contractSha256", "inputBindingCaptureSha256",
]);

/** Validate the only controller handoff S9 may consume: two owned schema pairs,
 * all original-source and actual-response hashes, and explicit pending cleanup. */
export function validateCurrentD7ControllerQualification(value) {
  exactCurrentD7Keys(value, CURRENT_D7_QUALIFICATION_KEYS);
  if (value.schemaVersion !== "current-q1-d7-controller-qualification-v1"
    || value.comparisonMode !== "current-worker-d1-d7" || value.decisionId !== "D7"
    || !sameCurrentD7Json(value.caseIds, CURRENT_D7_CASES)
    || value.cleanupPending !== true || value.qualifying !== false || value.establishesNativeExecution !== false
    || value.deadlineMs !== S9_REHEARSAL_DEADLINE_MS || !Number.isSafeInteger(value.elapsedMs)
    || value.elapsedMs < 0 || value.elapsedMs > S9_REHEARSAL_DEADLINE_MS || value.pgInputSnapshotsRemoved !== true) {
    fail("REHEARSAL_CURRENT_D7_EVIDENCE_INVALID");
  }
  for (const field of ["inputBindingSha256", "inputBindingCaptureContentSha256", "bindingSha256", "referenceContentSha256",
    "producerAcceptanceContentSha256", "contractContentSha256"]) {
    if (typeof value[field] !== "string" || !/^[a-f0-9]{64}$/u.test(value[field])) {
      fail("REHEARSAL_CURRENT_D7_EVIDENCE_INVALID");
    }
  }
  exactCurrentD7Keys(value.sidecars, CURRENT_D7_SIDECAR_HASH_KEYS);
  for (const digest of Object.values(value.sidecars)) {
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) fail("REHEARSAL_CURRENT_D7_EVIDENCE_INVALID");
  }
  if (value.referenceContentSha256 !== value.sidecars.referenceSha256
    || value.producerAcceptanceContentSha256 !== value.sidecars.producerAcceptanceSha256
    || value.contractContentSha256 !== value.sidecars.contractSha256
    || value.inputBindingCaptureContentSha256 !== value.sidecars.inputBindingCaptureSha256) {
    fail("REHEARSAL_CURRENT_D7_EVIDENCE_INVALID");
  }
  exactCurrentD7Keys(value.caseReceipts, CURRENT_D7_CASES);
  const suffixes = new Set();
  const schemas = new Set();
  const expectedCurrentDay = "2026-10-01";
  for (const caseId of CURRENT_D7_CASES) {
    const receipt = exactCurrentD7Keys(value.caseReceipts[caseId], CURRENT_D7_CASE_RECEIPT_KEYS);
    if (receipt.caseId !== caseId || receipt.schemaVersion !== "current-q1-d7-controller-case-receipt-v1"
      || receipt.currentDay !== expectedCurrentDay || receipt.retainedForS9Cleanup !== true) {
      fail("REHEARSAL_CURRENT_D7_EVIDENCE_INVALID");
    }
    for (const field of ["referenceSha256", "expectationSha256", "corpusSha256", "admissionSha256",
      "sourceInvariantSha256", "pgInputSha256", "bootstrapPreservationSha256", "strictExportSha256",
      "actualResponseSha256", "actualPreviewSha256"]) {
      if (typeof receipt[field] !== "string" || !/^[a-f0-9]{64}$/u.test(receipt[field])) {
        fail("REHEARSAL_CURRENT_D7_EVIDENCE_INVALID");
      }
    }
    const match = /^typed_legacy_transfer_rehearsal_target_fastpath_([0-9a-f]{8})$/u.exec(receipt.schema);
    if (!match || receipt.controlSchema !== `typed_legacy_transfer_rehearsal_ctl_${match[1]}`
      || suffixes.has(match[1]) || schemas.has(receipt.schema) || schemas.has(receipt.controlSchema)) {
      fail("REHEARSAL_CURRENT_D7_EVIDENCE_INVALID");
    }
    suffixes.add(match[1]); schemas.add(receipt.schema); schemas.add(receipt.controlSchema);
  }
  return value;
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function runRefresh({ node22, endpointEnv, schema, nowIso, timeoutMinutes, workers = 1, modelBlockSize = 10,
  modelFanOut = "auto", deadlineMonotonicMs }) {
  const started = performance.now();
  const remainingMs = deadlineMonotonicMs === undefined ? null : currentD7RemainingMs(deadlineMonotonicMs);
  const timeoutMs = remainingMs === null ? timeoutMinutes * 60_000 : Math.min(timeoutMinutes * 60_000, remainingMs);
  let stdout;
  let stderr;
  let exitCode = 0;
  try {
    // With compute Workers no heap flag: V8 applies it to every isolate, over
    // the Workers' own limits, and the Job refuses it (K-PAR-MEM).
    ({ stdout, stderr } = await execFileAsync(node22, [
      ...(workers > 1 ? [] : [`--max-old-space-size=${GCP_FASTPATH_REHEARSAL_REFRESH_HEAP_MIB}`]),
      ...(workers > 1 ? [] : [`--max-semi-space-size=${GCP_FASTPATH_REHEARSAL_REFRESH_SEMI_SPACE_MIB}`]),
      DIST_REFRESH, "--mode=full", `--now=${nowIso}`, `--schema=${schema}`,
      ...(workers > 1 ? [`--workers=${workers}`] : []),
      `--model-block-size=${modelBlockSize}`, `--model-fanout=${modelFanOut}`], {
      cwd: CLOUD_RUN_ROOT,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ANALYTICS_V2_TEST_CLOCK: "1", ...endpointEnv },
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
    }));
  } catch (error) {
    stdout = error.stdout ?? "";
    stderr = error.stderr ?? "";
    exitCode = typeof error.code === "number" ? error.code : 1;
  }
  const wallMs = Math.round(performance.now() - started);
  const lines = String(stdout).trim().split("\n").filter(Boolean);
  let receipt = null;
  try { receipt = lines.length > 0 ? JSON.parse(lines.at(-1)) : null; } catch { receipt = null; }
  let error = null;
  const errorLines = String(stderr).trim().split("\n").filter(Boolean);
  if (errorLines.length > 0) {
    try { error = JSON.parse(errorLines.at(-1)); } catch { error = { code: "ANALYTICS_REFRESH_STDERR_UNPARSED" }; }
  }
  return { exitCode, wallMs, receipt, error };
}

const JOURNAL_OBJECTS = Object.freeze(["storage_source_state", "storage_ingestion_changes",
  "storage_ingestion_owner_cursor"]);

/**
 * The ingestion-journal importer reads a sealed journal-only SQLite (exactly
 * storage_source_state, storage_ingestion_changes and its owner cursor index,
 * STRICT). Project it from the same oracle dump with the dump's own DDL and
 * rows, seal it 0444 and return its digest.
 */
export async function buildJournalSqlite(dumpPath, outPath) {
  const dump = JSON.parse(await readFile(dumpPath, "utf8"));
  const database = new DatabaseSync(outPath);
  try {
    database.exec("PRAGMA journal_mode=DELETE");
    database.exec("BEGIN");
    for (const name of JOURNAL_OBJECTS) {
      const entry = dump.schema.find((item) => item.name === name);
      if (!entry || typeof entry.sql !== "string") fail("REHEARSAL_JOURNAL_DDL_MISSING", { name });
      database.exec(entry.sql);
    }
    for (const name of ["storage_source_state", "storage_ingestion_changes"]) {
      const table = dump.tables.find((item) => item.name === name);
      if (!table) fail("REHEARSAL_JOURNAL_TABLE_MISSING", { name });
      const columns = table.columns.map((column) => `"${column}"`);
      const insert = database.prepare(`INSERT INTO "${name}" (${columns.join(",")})
        VALUES (${columns.map(() => "?").join(",")})`);
      for (const row of table.rows) insert.run(...row);
    }
    database.exec("COMMIT");
  } finally {
    database.close();
  }
  await chmod(outPath, 0o444);
  const sha256 = createHash("sha256").update(await readFile(outPath)).digest("hex");
  return { path: await realpath(outPath), sha256 };
}

/**
 * The schema names one rehearsal target uses: the importers' shared
 * fast-path target (typed_legacy_transfer_rehearsal_target_fastpath_<suffix>)
 * and the importers' control schema. `suffix` is 8 lower-case hex digits.
 * There is no ledger schema: the deletion ledger is retired (decisions D2,
 * D4 and D6 of 2026-09-26) and the runner refuses the ledger role.
 */
export function fastpathRehearsalSchemas(suffix) {
  if (typeof suffix !== "string" || !/^[0-9a-f]{8}$/u.test(suffix)) fail("REHEARSAL_SUFFIX_INVALID");
  const schema = `${POSTGRES_FASTPATH_REHEARSAL_TARGET_SCHEMA_PREFIX}${suffix}`;
  return Object.freeze({
    suffix,
    schema,
    controlSchema: `${POSTGRES_TYPED_LEGACY_CONTROL_SCHEMA_PREFIX}ctl_${suffix}`,
  });
}

/**
 * Step 2: rebuild the oracle's USAGE_MONITOR_DB dump (`dumpPath`) into a
 * sealed SQLite inside `workDirectory`. Returns the sealed source the
 * importers open and the report fields.
 */
export async function sealFastpathRehearsalSource({ dumpPath, workDirectory }) {
  const sealed = await rebuildOracleSqlite(dumpPath, join(workDirectory, "usage-monitor-db.sqlite"));
  const report = {
    sha256: sealed.sha256, bytes: sealed.bytes, integrityCheck: sealed.integrityCheck,
    populatedTables: sealed.populatedTables, sealReady: sealed.sealReady,
  };
  if (!sealed.sealReady) fail("REHEARSAL_SQLITE_NOT_SEALED");
  return { sealedSource: { path: sealed.path, expectedSha256: sealed.sha256 }, report };
}

/**
 * Step 3: the importer chain, in the plan's order, into ONE migrated
 * fast-path rehearsal target schema: T-1 identity/authority copy, the
 * typed-legacy transfer, T-1's legacy-transport copy, T-2 v1.2, T-1's v1.2
 * event-source copy, the usage-correction transfer and the ingestion-journal
 * transfer (from a journal-only SQLite projected from the same dump), then
 * the read-only T-1 verifications and per-table row counts.
 *
 * The local rehearsal and the GCP seed (gcp-fastpath-seed.mjs) both call
 * this, so refresh and origin read the same imported data in either place.
 * `pool` is any pg-compatible pool that may write `schema` and
 * `controlSchema`; `timings` collects per-importer wall times. Every source
 * it opens is closed before it returns. Only the GCP seed passes
 * `cloudFastpathTarget: true`, which the ingestion-journal importer accepts
 * in place of a local Unix-socket session solely for the fast-path Cloud SQL
 * target (scripts/gcp-fastpath-cloud-target.mjs); the local rehearsal never
 * passes it. `maxSourceTableRows` raises the T-1 copies' per-table bound
 * (postgres-fastpath-identity-copy.mjs maxTableRows) for the production-shaped
 * measurement corpus (scripts/gcp-fastpath-prod-shape) only; the rehearsal and
 * the GCP seed leave it at the copies' default.
 */
export async function loadFastpathRehearsalImporters({
  pool, schema, controlSchema, suffix, sealedSource, dumpPath, sealedJournalSource = null,
  workDirectory, roster, timings = {},
  cloudFastpathTarget = false, maxSourceTableRows = undefined,
}) {
  if (typeof schema !== "string" || !schema.startsWith(POSTGRES_FASTPATH_REHEARSAL_TARGET_SCHEMA_PREFIX)) {
    fail("REHEARSAL_TARGET_SCHEMA_INVALID");
  }
  if ((sealedJournalSource !== null && (dumpPath !== null && dumpPath !== undefined))
    || (sealedJournalSource === null && (typeof dumpPath !== "string" || dumpPath.length === 0))) {
    fail("REHEARSAL_JOURNAL_INPUT_AMBIGUOUS");
  }
  const steps = {};
  const sources = [];
  try {
    const identitySource = await openSealedFastpathIdentitySource(sealedSource);
    sources.push(identitySource);
    steps.identityCopy = await timed(timings, "importer:t1-identity", async () => {
      const receipt = await runPostgresFastpathIdentityCopy({
        source: identitySource, pool, targetSchema: schema, publicSourceOwnerParity: "defer",
        maxTableRows: maxSourceTableRows,
      });
      return {
        status: receipt.status,
        tables: Object.keys(receipt.tables).length,
        rows: Object.values(receipt.tables).reduce((sum, table) => sum + table.targetRows, 0),
        publicSourceOwners: receipt.publicSourceOwners,
        foreignKeysChecked: receipt.foreignKeysChecked,
      };
    });

    const typedLegacySource = await createSealedSqliteTypedLegacyRehearsalSource(sealedSource);
    sources.push(typedLegacySource);
    steps.typedLegacy = await timed(timings, "importer:typed-legacy", async () => {
      const receipt = await runPostgresTypedLegacyTransfer({
        source: typedLegacySource, destinationPool: pool, targetSchema: schema, controlSchema,
        transferId: `fastpath-rehearsal-typed-legacy-${suffix}`,
      });
      return { status: receipt.status, tables: receipt.tables ? Object.keys(receipt.tables).length : null,
        rows: receipt.rowCount ?? receipt.rows ?? null };
    });

    // No importer in the plan's chain writes the v1/v1.1 transport and
    // admission tables the occurrence adapter joins, so the rehearsal copies
    // them (and, after T-2, the v1.2 event sources) with T-1's engine.
    const transportReceipt = (receipt) => ({
      status: receipt.status,
      part: receipt.part,
      rows: Object.fromEntries(Object.entries(receipt.tables).map(([name, table]) => [name, table.targetRows])),
      foreignKeysChecked: receipt.foreignKeysChecked,
    });
    steps.legacyTransport = await timed(timings, "importer:legacy-transport", async () =>
      transportReceipt(await runPostgresFastpathTransportCopy({
        source: identitySource, pool, targetSchema: schema, part: "legacy-transport",
        maxTableRows: maxSourceTableRows,
      })));

    const v12Source = await createSealedSqliteV12RehearsalSource(sealedSource);
    sources.push(v12Source);
    steps.v12 = await timed(timings, "importer:t2-v12", async () => {
      const effectiveReader = await loadPostgresV12EffectiveReader({ workerRoot: WORKER_ROOT });
      try {
        const receipt = await runPostgresV12Transfer({
          source: v12Source, destinationPool: pool, targetSchema: schema, controlSchema,
          transferId: `fastpath-rehearsal-v12-${suffix}`, effectiveReader,
        });
        return { status: receipt.status, effective: receipt.effective ?? null,
          sourceSha256Equal: receipt.source?.sha256 === receipt.target?.sha256 || null };
      } finally {
        await effectiveReader.close?.();
      }
    });

    steps.v12EventSources = await timed(timings, "importer:v12-event-sources", async () =>
      transportReceipt(await runPostgresFastpathTransportCopy({
        source: identitySource, pool, targetSchema: schema, part: "v12-event-sources",
        maxTableRows: maxSourceTableRows,
      })));

    const correctionSource = await createSealedSqliteUsageCorrectionSource(sealedSource);
    sources.push(correctionSource);
    steps.usageCorrection = await timed(timings, "importer:usage-correction", async () => {
      const receipt = await runPostgresUsageCorrectionTransfer({
        source: correctionSource, destinationPool: pool, targetSchema: schema,
        transferId: `fastpath-rehearsal-correction-${suffix}`,
      });
      return { status: receipt.status, rows: receipt.rows ?? receipt.tables ?? null };
    });

    const sourceId = identitySource.database()
      .prepare("SELECT source_id FROM storage_source_state WHERE singleton = 1").get()?.source_id;
    let journalSealed;
    let journalSource;
    if (sealedJournalSource !== null) {
      if (typeof sealedJournalSource !== "object" || Array.isArray(sealedJournalSource)
        || JSON.stringify(Object.keys(sealedJournalSource).sort()) !== JSON.stringify(["expectedSha256", "expectedSourceId", "path"])
        || sealedJournalSource.expectedSourceId !== sourceId || typeof sealedJournalSource.path !== "string"
        || !isAbsolute(sealedJournalSource.path) || !/^[a-f0-9]{64}$/u.test(sealedJournalSource.expectedSha256)) {
        fail("REHEARSAL_JOURNAL_SOURCE_MISMATCH");
      }
      journalSealed = { path: sealedJournalSource.path, sha256: sealedJournalSource.expectedSha256 };
      steps.journalSqlite = { sha256: journalSealed.sha256 };
      journalSource = await timed(timings, "sqlite:journal", async () =>
        createSealedSqliteIngestionJournalSource({ ...sealedJournalSource }));
    } else {
      journalSealed = await timed(timings, "sqlite:journal", async () =>
        buildJournalSqlite(dumpPath, join(workDirectory, "storage-ingestion-journal.sqlite")));
      steps.journalSqlite = { sha256: journalSealed.sha256 };
      journalSource = await createSealedSqliteIngestionJournalSource({
        path: journalSealed.path, expectedSha256: journalSealed.sha256, expectedSourceId: sourceId,
      });
    }
    sources.push(journalSource);
    steps.ingestionJournal = await timed(timings, "importer:ingestion-journal", async () => {
      const receipt = await transferPostgresIngestionJournal({
        source: journalSource, destinationPool: pool, targetSchema: schema,
        transferId: `synthetic-ingestion-journal-fastpath-${suffix}`,
        cloudFastpathTarget: cloudFastpathTarget === true,
      });
      return { status: receipt.status, rows: receipt.rowCount ?? receipt.rows ?? null,
        lastSequence: receipt.lastSequence ?? null };
    });

    steps.importVerification = await timed(timings, "importer:verify", async () => ({
      ownerRoster: await compareFastpathOwnerRoster({ pool, targetSchema: schema, roster }),
      publicSourceOwners: await compareFastpathPublicSourceOwners({ source: identitySource, pool, targetSchema: schema }),
      ownerRevisions: await compareFastpathOwnerRevisions({ source: identitySource, pool, targetSchema: schema }),
    }));
    steps.importedRows = await tableCounts(pool, schema, FASTPATH_REHEARSAL_COUNTED_TABLES);
    return steps;
  } finally {
    for (const source of sources) {
      try { source.close?.(); } catch { /* already closed */ }
    }
  }
}

/** The imported tables both the rehearsal and the GCP seed count. */
export const FASTPATH_REHEARSAL_COUNTED_TABLES = Object.freeze([
  "participants", "storage_v11_owner_links", "typed_telemetry_records", "telemetry_v12_records",
  "telemetry_v12_day_manifests", "telemetry_v1_chunks", "telemetry_v11_chunks", "telemetry_v11_day_manifests",
  "telemetry_v11_domain_days", "typed_v11_record_proofs", "typed_v1_record_admissions",
  "storage_v11_event_sources", "typed_v1_event_sources", "storage_v12_event_sources", "storage_ingestion_changes",
  "telemetry_usage_correction_facts",
]);

/**
 * One refresh run's content-free cost: wall time, the job's own phase timings
 * and memory summary (its peak resident set included), straight from its
 * receipt.
 */
export function refreshMeasurement(run) {
  const receipt = run.receipt ?? {};
  return {
    wallMs: run.wallMs,
    state: receipt.state ?? null,
    timingsMs: receipt.timings ?? null,
    memory: receipt.memory ?? null,
  };
}

/**
 * REV-SEED: the rehearsal's synthetic revision floor, a pure function of the
 * golden (every golden day but each seventh, at its golden revision plus its
 * index mod 5), loaded through the cutover loader in one transaction.
 */
export function syntheticRehearsalFloorDays(goldenDays) {
  return [...goldenDays].map(({ day, revision }) => [day, revision]).sort(([left], [right]) => (left < right ? -1 : 1))
    .flatMap(([day, revision], index) => (index % 7 === 6 ? [] : [[day, revision + (index % 5)]]));
}

async function loadSyntheticRehearsalFloor(pool, schema, { golden, manifest, nowIso }) {
  const days = syntheticRehearsalFloorDays(golden.days);
  const digest = (label) => createHash("sha256").update(`gcp-fastpath-rehearsal:${label}`).digest("hex");
  const { text, floorSha256 } = renderRevisionFloorFile({ schema: CUTOVER_REVISION_FLOOR_SCHEMA, provenance: "synthetic",
    sealId: digest(`seal:${manifest.nowMs}`), fenceReceiptSha256: digest("fence"), sourceCommit: manifest.sourceCommit,
    capturedAt: nowIso, capture: null, days, dayCount: days.length,
    maxRevision: Math.max(...days.map(([, revision]) => revision)) });
  const floor = parseRevisionFloorFile(new TextEncoder().encode(text), floorSha256);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const receipt = await loadRevisionFloorInTransaction({ client, schema, floor });
    await client.query("COMMIT");
    return { receipt, floor: new Map(days) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function publishedSnapshot(pool, schema) {
  const result = await pool.query(`SELECT to_char(day,'YYYY-MM-DD') AS day, revision, payload_sha256,
      run_id::text AS run_id FROM ${quoteIdentifier(schema)}.analytics_v2_published_daily ORDER BY day`);
  return result.rows.map((row) => ({ day: row.day, revision: Number(row.revision), payloadSha256: row.payload_sha256 }));
}

async function refusalSummary(pool, schema) {
  const runs = await pool.query(`SELECT run_id::text AS run_id, refusals, publication, timings, owners, owner_days
      FROM ${quoteIdentifier(schema)}.analytics_v2_runs ORDER BY finished_at, started_at`);
  return runs.rows.map((row) => {
    const byReason = {};
    const byFamily = {};
    for (const refusal of Array.isArray(row.refusals) ? row.refusals : []) {
      const key = `${refusal.family}:${refusal.reason}`;
      byReason[key] = (byReason[key] ?? 0) + 1;
      byFamily[refusal.family] = (byFamily[refusal.family] ?? 0) + 1;
    }
    return {
      owners: Number(row.owners),
      ownerDays: Number(row.owner_days),
      refusals: Array.isArray(row.refusals) ? row.refusals.length : null,
      refusalsByFamilyReason: Object.fromEntries(Object.entries(byReason).sort()),
      refusalsByFamily: byFamily,
      refusalOwnersByReason: Object.fromEntries(Object.entries(Object.groupBy(row.refusals ?? [],
        (refusal) => `${refusal.family}:${refusal.reason}`)).map(([key, list]) =>
        [key, [...new Set(list.map((refusal) => refusal.ownerDigest.slice(0, 8)))].sort()]).sort()),
      refusalDaysByReason: Object.fromEntries(Object.entries(Object.groupBy(row.refusals ?? [],
        (refusal) => `${refusal.family}:${refusal.reason}`)).map(([key, list]) =>
        [key, [...new Set(list.map((refusal) => refusal.day ?? "owner"))].sort()]).sort()),
      publication: {
        published: row.publication?.published?.length ?? null,
        unchanged: row.publication?.unchanged?.length ?? null,
        blocked: row.publication?.blocked ?? null,
      },
      timingsMs: row.timings,
    };
  });
}

async function storedPreview(pool, schema) {
  const result = await pool.query(`SELECT preview FROM ${quoteIdentifier(schema)}.analytics_v2_preview WHERE id = 1`);
  return result.rows[0]?.preview ?? null;
}

async function tableCounts(pool, schema, tables) {
  const counts = {};
  for (const table of tables) {
    const result = await pool.query(`SELECT count(*)::integer AS n FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`);
    counts[table] = result.rows[0].n;
  }
  return counts;
}

async function startOrigin({ endpoint, schema, nowMs, deadlineMonotonicMs }) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const bucket = "synthetic-fastpath-rehearsal-bucket";
  const environment = {
    POSTGRES_TEST_HTTP_MODE: "fastpath-test",
    HOST: "127.0.0.1",
    PORT: String(port),
    HOST_ORIGIN: origin,
    PRIMARY_SCHEMA: schema,
    PRIMARY_DATABASE: process.env.PG_TEST_DATABASE || "postgres",
    PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:synthetic-fastpath-rehearsal",
    POSTGRES_IAM_USER: "synthetic-fastpath-rehearsal@synthetic.iam",
    POSTGRES_RATE_LIMIT_SECRET: randomBytes(32).toString("hex"),
    ENVELOPE_PUBLIC_JWK: '{"synthetic":"unused-public-key"}',
    ENVELOPE_PRIVATE_JWK: "synthetic-unused-private-key",
    GCS_BUCKET_NAME: bucket,
    GCS_QUARANTINE_BUCKET_HISTORY_PROOF: JSON.stringify({
      bucket, bucketGeneration: "1", bucketMetageneration: "1", softDeleteRetentionDurationSeconds: "0",
    }),
    ANALYTICS_V2_ENABLED: "1",
    ANALYTICS_V2_TEST_NOW_MS: String(nowMs),
  };
  for (const [name, value] of Object.entries(environment)) process.env[name] = value;
  const server = await import(pathToFileURL(DIST_SERVER).href);
  const pools = [];
  const refuse = (name) => async () => { throw new Error(`${name} is not available in the local rehearsal`); };
  const dependencies = {
    ...server.originCompositionDependencies(process.env),
    createConnector() { return { close() {} }; },
    async createIamPool(options) {
      const created = new pg.Pool(poolOptions(endpoint, options.max ?? 3, "gcp-fastpath-origin-" + options.role,
        { deadlineMonotonicMs }));
      created.on("error", () => {});
      pools.push(created);
      return deadlineMonotonicMs === undefined ? created : createCurrentD7DeadlinePool(created, deadlineMonotonicMs);
    },
    async createGoogleAccessTokenProvider() { return refuse("google access token"); },
    createGcsQuarantineObjectStore() { return { put: refuse("objectStore.put"), delete: refuse("objectStore.delete") }; },
  };
  const runtime = await server.createRuntime({ dependencies });
  const close = await server.serve(runtime);
  return { origin, close, pools, mode: runtime.postgresTestHostMode };
}

/**
 * The origin child: compose and serve dist/server.mjs, print one JSON line
 * with its origin, and run until SIGTERM (serve() closes the listener and
 * the pools, then exits).
 */
async function originChild() {
  const config = JSON.parse(process.env.GCP_FASTPATH_REHEARSAL_ORIGIN ?? "null");
  if (config === null || typeof config !== "object") fail("REHEARSAL_ORIGIN_CONFIG_INVALID");
  delete process.env.GCP_FASTPATH_REHEARSAL_ORIGIN;
  const readinessNonce = config.readinessNonce;
  if (readinessNonce !== undefined && (typeof readinessNonce !== "string" || !/^[a-f0-9]{64}$/u.test(readinessNonce))) {
    fail("REHEARSAL_ORIGIN_CONFIG_INVALID");
  }
  let deadlineMonotonicMs;
  if (config.deadlineDurationMs !== undefined) {
    if (!Number.isSafeInteger(config.deadlineDurationMs) || config.deadlineDurationMs < 1
      || config.deadlineDurationMs > S9_REHEARSAL_DEADLINE_MS) fail("REHEARSAL_ORIGIN_CONFIG_INVALID");
    deadlineMonotonicMs = performance.now() + config.deadlineDurationMs;
  }
  const started = await startOrigin({ endpoint: config.endpoint, schema: config.schema, nowMs: config.nowMs,
    deadlineMonotonicMs });
  if (readinessNonce !== undefined) {
    if (typeof process.send !== "function") fail("REHEARSAL_ORIGIN_START_FAILED");
    let acknowledged = false;
    process.on("message", (message) => {
      if (acknowledged) return;
      let valid = false;
      try {
        const challenge = exactCurrentD7Keys(message, ["type", "nonce"], "REHEARSAL_ORIGIN_START_FAILED");
        valid = challenge.type === CURRENT_D7_ORIGIN_READINESS_CHALLENGE && challenge.nonce === readinessNonce;
      } catch { /* ignore malformed parent messages and never expose them */ }
      if (!valid) return;
      acknowledged = true;
      try {
        process.send({ type: CURRENT_D7_ORIGIN_READINESS_ACK, nonce: readinessNonce, origin: started.origin },
          (error) => { if (error) process.exitCode = 1; });
      } catch { process.exitCode = 1; }
    });
  }
  process.stdout.write(`${JSON.stringify({ origin: started.origin, mode: started.mode, node: process.version })}\n`);
}

/** Start the origin child under `node`, and resolve once it is listening. */
async function spawnOrigin({ node, endpoint, schema, nowMs, deadlineMonotonicMs }) {
  const readyTimeoutMs = deadlineMonotonicMs === undefined ? 60_000
    : Math.min(60_000, currentD7RemainingMs(deadlineMonotonicMs));
  const deadlineDurationMs = deadlineMonotonicMs === undefined ? undefined : currentD7RemainingMs(deadlineMonotonicMs);
  const readinessNonce = deadlineMonotonicMs === undefined ? undefined : randomBytes(32).toString("hex");
  const child = spawn(node, [fileURLToPath(import.meta.url), "--origin-child"], {
    cwd: CLOUD_RUN_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...(process.env.PG_TEST_USER ? { PG_TEST_USER: process.env.PG_TEST_USER } : {}),
      ...(process.env.PG_TEST_DATABASE ? { PG_TEST_DATABASE: process.env.PG_TEST_DATABASE } : {}),
      GCP_FASTPATH_REHEARSAL_ORIGIN: JSON.stringify({ endpoint, schema, nowMs,
        ...(deadlineDurationMs === undefined ? {} : { deadlineDurationMs }),
        ...(readinessNonce === undefined ? {} : { readinessNonce }) }),
    },
    stdio: deadlineMonotonicMs === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", "ipc"],
  });
  if (deadlineMonotonicMs !== undefined) {
    const { ready, exited } = await awaitCurrentD7OriginReadiness(child, { readyTimeoutMs, readinessNonce });
    return {
      ...ready,
      async close() {
        // The process has already reached spawn by the time it emitted readiness.
        return stopCurrentD7OwnedChild(child, exited, Promise.resolve(true));
      },
    };
  }
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4_000); });
  const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
  const ready = await new Promise((resolveReady, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new RehearsalError("REHEARSAL_ORIGIN_START_TIMEOUT")), readyTimeoutMs);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      try { resolveReady(JSON.parse(buffer.slice(0, newline))); } catch { reject(new RehearsalError("REHEARSAL_ORIGIN_START_FAILED")); }
    });
    exited.then(() => {
      clearTimeout(timer);
      const last = stderr.trim().split("\n").filter(Boolean).at(-1) ?? "";
      let code = "REHEARSAL_ORIGIN_EXITED";
      try { code = JSON.parse(last).code ?? code; } catch { /* keep the closed code */ }
      reject(new RehearsalError("REHEARSAL_ORIGIN_START_FAILED", { childCode: code }));
    });
  });
  return {
    ...ready,
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const result = await exited;
      return result;
    },
  };
}

function currentD7Day(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function currentD7CaseWindow(reference) {
  const body = reference?.snapshot?.publicResponse?.body;
  if (!body || !currentD7Day(body.from) || !currentD7Day(body.to) || body.from > body.to) {
    fail("REHEARSAL_CURRENT_D7_REFERENCE_INVALID");
  }
  return { fromDay: body.from, throughDay: body.to };
}

function validateCurrentD7ProducerResult(result, { inputBinding, contract, currentPostgresInputs }) {
  const { currentQ1D7JsonSha256, validateCurrentQ1D7Binding, validateCurrentQ1D7InputBinding,
    validateCurrentQ1D7PerDateExpectation, validateCurrentQ1D7CaseReference, validateCurrentQ1D7PgCaseInput,
    assessCurrentQ1D7Qualification, validateCurrentQ1D7ProducerAcceptance } = contract;
  exactCurrentD7Keys(result, ["reference", "binding", "acceptance", "cases", "expectations", "expectationSha256",
    "pgInputs", "expectedController"]);
  validateCurrentQ1D7InputBinding(inputBinding);
  validateCurrentQ1D7Binding(result.binding, inputBinding);
  exactCurrentD7Keys(result.cases, CURRENT_D7_CASES);
  exactCurrentD7Keys(result.expectations, CURRENT_D7_CASES);
  exactCurrentD7Keys(result.expectationSha256, CURRENT_D7_CASES);
  exactCurrentD7Keys(result.pgInputs, CURRENT_D7_CASES);
  const controllerPin = result.binding.source.files.find((entry) => entry.path === "apps/worker/scripts/gcp-fastpath-rehearsal.mjs");
  if (!controllerPin || currentD7Hash(controllerPin) !== currentD7Hash(currentPostgresInputs.controller)
    || !sameCurrentD7Json(result.expectedController, controllerPin)) fail("REHEARSAL_CURRENT_D7_CONTROLLER_PIN_INVALID");

  exactCurrentD7Keys(result.reference, ["schemaVersion", "synthetic", "qualification", "decisionId", "sourceId",
    "sourceNamespace", "bounds", "provenance", "cases", "expectationSha256"]);
  if (result.reference.schemaVersion !== "current-q1-d7-reference-v4" || result.reference.synthetic !== true
    || result.reference.qualification !== "structurally_complete" || result.reference.decisionId !== "D7"
    || result.reference.sourceId !== result.binding.sourceId || result.reference.sourceNamespace !== result.binding.sourceNamespace
    || !sameCurrentD7Json(result.reference.bounds, result.binding.bounds)
    || !sameCurrentD7Json(result.reference.cases, result.cases)
    || !sameCurrentD7Json(result.reference.expectationSha256, result.expectationSha256)) {
    fail("REHEARSAL_CURRENT_D7_REFERENCE_INVALID");
  }
  exactCurrentD7Keys(result.reference.provenance, ["source", "runtime", "migrationSha256"]);
  if (!sameCurrentD7Json(result.reference.provenance.source, result.binding.source)
    || !sameCurrentD7Json(result.reference.provenance.runtime, result.binding.runtime)
    || result.reference.provenance.migrationSha256 !== result.binding.migrationSha256) {
    fail("REHEARSAL_CURRENT_D7_REFERENCE_INVALID");
  }
  for (const caseId of CURRENT_D7_CASES) {
    const expectedSha256 = result.expectationSha256[caseId];
    if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
      fail("REHEARSAL_CURRENT_D7_EXPECTATION_INVALID");
    }
    validateCurrentQ1D7PerDateExpectation(result.expectations[caseId], result.binding, { expectedSha256 });
    validateCurrentQ1D7CaseReference(result.cases[caseId], result.binding, {
      expectation: result.expectations[caseId], expectedExpectationSha256: expectedSha256,
    });
    if (result.cases[caseId].pgInputSha256 !== currentQ1D7JsonSha256(result.pgInputs[caseId])) {
      fail("REHEARSAL_CURRENT_D7_REFERENCE_INVALID");
    }
    validateCurrentQ1D7PgCaseInput(result.pgInputs[caseId], result.binding, caseId);
  }
  const caseMap = result.cases;
  const assessment = assessCurrentQ1D7Qualification({ binding: result.binding, cases: caseMap,
    expectations: result.expectations, expectationSha256: result.expectationSha256, pgInputs: result.pgInputs });
  if (assessment.state !== "structurally_complete" || assessment.establishesNativeExecution !== false) {
    fail("REHEARSAL_CURRENT_D7_EVIDENCE_INCOMPLETE");
  }
  const acceptanceResult = validateCurrentQ1D7ProducerAcceptance(result.acceptance, {
    inputBinding, binding: result.binding, cases: caseMap, expectations: result.expectations,
    expectationSha256: result.expectationSha256, pgInputs: result.pgInputs, expectedController: controllerPin,
  });
  if (acceptanceResult.establishesNativeExecution !== false) fail("REHEARSAL_CURRENT_D7_EVIDENCE_INCOMPLETE");
  return { ...result, controllerPin, assessment };
}

async function assertCurrentD7PgInputRoot({ pgInputs, binding, pgInputDirectory, validateDescriptor }) {
  const root = await lstat(pgInputDirectory);
  if (!root.isDirectory() || root.isSymbolicLink() || (process.getuid && root.uid !== process.getuid())
    || (root.mode & 0o777) !== 0o700 || await realpath(pgInputDirectory) !== pgInputDirectory) {
    fail("REHEARSAL_CURRENT_D7_INPUT_INVALID");
  }
  const childNames = (await readdir(pgInputDirectory)).sort();
  if (!sameCurrentD7Json(childNames, ["conflictFreePositive", "conflictPreserving"])) {
    fail("REHEARSAL_CURRENT_D7_INPUT_INVALID");
  }
  const snapshots = {};
  for (const caseId of CURRENT_D7_CASES) snapshots[caseId] = await verifyCurrentD7PgCaseInputFiles({
    descriptor: pgInputs[caseId], binding, caseId, pgInputDirectory, validateDescriptor,
  });
  return { root: { dev: root.dev, ino: root.ino, uid: root.uid, mode: root.mode }, cases: snapshots };
}

async function cleanupCurrentD7OwnedSchemas(results, deadlineMonotonicMs) {
  const owned = [];
  for (const result of results) {
    if (!result?.schema || !result?.controlSchema || result.report?.reusedSchema !== false) continue;
    const { suffix, schema, controlSchema } = fastpathRehearsalSchemas(result.suffix);
    if (schema !== result.schema || controlSchema !== result.controlSchema) fail("REHEARSAL_CURRENT_D7_SCHEMA_OWNERSHIP_INVALID");
    const kept = result.report?.keptSchemas;
    if (!Array.isArray(kept) || kept.some((name) => name !== schema && name !== controlSchema)) {
      fail("REHEARSAL_CURRENT_D7_SCHEMA_OWNERSHIP_INVALID");
    }
    for (const name of kept) owned.push({ suffix, name });
  }
  if (owned.length === 0) return [];
  if (new Set(owned.map(({ name }) => name)).size !== owned.length) fail("REHEARSAL_CURRENT_D7_SCHEMA_OWNERSHIP_INVALID");
  const endpoint = await localEndpoint(process.env);
  let cleanupDeadline = deadlineMonotonicMs;
  try { currentD7RemainingMs(cleanupDeadline); } catch (error) {
    if (error?.code !== "REHEARSAL_CURRENT_D7_DEADLINE_EXHAUSTED") throw error;
    cleanupDeadline = undefined;
  }
  const poolOptionsForCleanup = poolOptions(endpoint, 2, "gcp-fastpath-d7-cleanup",
    cleanupDeadline === undefined ? {} : { deadlineMonotonicMs: cleanupDeadline });
  if (cleanupDeadline === undefined) {
    poolOptionsForCleanup.connectionTimeoutMillis = 5_000;
    poolOptionsForCleanup.statement_timeout = 5_000;
  }
  const pgPool = new pg.Pool(poolOptionsForCleanup);
  pgPool.on("error", () => {});
  const pool = cleanupDeadline === undefined ? pgPool : createCurrentD7DeadlinePool(pgPool, cleanupDeadline);
  try {
    const names = owned.map(({ name }) => name);
    const present = await pool.query("SELECT nspname FROM pg_namespace WHERE nspname = ANY($1) ORDER BY nspname", [names]);
    if (!sameCurrentD7Json(present.rows.map((row) => row.nspname), [...names].sort())) {
      fail("REHEARSAL_CURRENT_D7_SCHEMA_OWNERSHIP_INVALID");
    }
    for (const { name } of [...owned].reverse()) await pool.query(`DROP SCHEMA ${quoteIdentifier(name)} CASCADE`);
    const remaining = await pool.query("SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)", [names]);
    if (remaining.rows.length !== 0) fail("REHEARSAL_CURRENT_D7_SCHEMA_CLEANUP_FAILED");
    return [];
  } finally { await pool.end().catch(() => {}); }
}

function assertCurrentD7ContractAccepted(report, { binding, acceptance, cases, expectationSha256 }) {
  const currentDay = new Date(binding.runtime.pinnedNowMs).toISOString().slice(0, 10);
  if (report.schemaVersion !== "analytics-v2-current-d7-contract-report-v3"
    || report.comparisonMode !== "current-worker-d1-d7" || report.evidenceScope !== "saved-comparison-only"
    || report.decisionId !== "D7" || report.establishesNativeExecution !== false || report.accepted !== true
    || !sameCurrentD7Json(report.acceptedCaseIds, CURRENT_D7_CASES) || report.bindingSha256 !== currentD7Hash(binding)
    || report.producerAcceptanceSha256 !== currentD7Hash(acceptance)
    || report.currentDay !== currentDay || report.strictUnaffectedEqual !== true || report.exactPerDateEqual !== true
    || report.positive70DateEqual !== true || report.unresolved.length !== 0 || report.unexpectedDiffs !== 0
    || !Array.isArray(report.perCase) || report.perCase.length !== CURRENT_D7_CASES.length
    || !sameCurrentD7Json(report.perCase.map((entry) => entry.caseId), CURRENT_D7_CASES)) {
    fail("REHEARSAL_CURRENT_D7_CONTRACT_NOT_ACCEPTED");
  }
  const withheld = cases.conflictPreserving.publicationInventory.filter((entry) => entry.state === "withheld")
    .map((entry) => entry.day).sort();
  if (!sameCurrentD7Json(report.acceptedD7DateSet, withheld) || withheld.length === 0
    || cases.conflictFreePositive.publicationInventory.some((entry) => entry.state !== "published")) {
    fail("REHEARSAL_CURRENT_D7_CONTRACT_NOT_ACCEPTED");
  }
  for (const [index, caseId] of CURRENT_D7_CASES.entries()) {
    const entry = report.perCase[index];
    if (entry.equal !== true || entry.strictUnaffectedEqual !== true || entry.exactPerDateEqual !== true
      || entry.expectationSha256 !== expectationSha256[caseId]
      || (caseId === "conflictFreePositive" && entry.comparedDates !== 70)) {
      fail("REHEARSAL_CURRENT_D7_CONTRACT_NOT_ACCEPTED");
    }
  }
}

function validateCurrentD7DirectOptions(options) {
  const keys = ["golden", "keepSchema", "out", "node22", "dump", "perDateExpected", "ownerReference", "dense",
    "comparisonMode", "refreshTimeoutMinutes", "reuseSchema", "stagedPrimary", "refreshWorkers",
    "refreshModelBlockSize", "refreshModelFanOut", "syntheticRevisionFloor"];
  if (options === null || typeof options !== "object" || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) fail("REHEARSAL_ARGUMENT_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Object.values(descriptors).some((entry) => entry.get || entry.set)
    || Object.getOwnPropertySymbols(options).length > 0) fail("REHEARSAL_ARGUMENT_INVALID");
  exactCurrentD7Keys(options, keys, "REHEARSAL_ARGUMENT_INVALID");
  if (options.comparisonMode !== "current-worker-d1-d7" || options.keepSchema !== true || options.reuseSchema !== null
    || options.dump !== null || options.perDateExpected !== null || options.ownerReference !== null || options.dense !== false
    || options.syntheticRevisionFloor !== false || !Array.isArray(options.stagedPrimary) || options.stagedPrimary.length !== 0
    || typeof options.golden !== "string" || !isAbsolute(options.golden) || resolve(options.golden) !== options.golden
    || typeof options.out !== "string" || !isAbsolute(options.out) || resolve(options.out) !== options.out
    || typeof options.node22 !== "string" || !isAbsolute(options.node22) || resolve(options.node22) !== options.node22
    || !Number.isSafeInteger(options.refreshTimeoutMinutes) || options.refreshTimeoutMinutes < 1
    || options.refreshTimeoutMinutes > MAX_REFRESH_TIMEOUT_MINUTES || !Number.isSafeInteger(options.refreshWorkers)
    || options.refreshWorkers < 1 || options.refreshWorkers > 16 || !Number.isSafeInteger(options.refreshModelBlockSize)
    || options.refreshModelBlockSize < 1 || options.refreshModelBlockSize > 70
    || !["auto", "all", "off"].includes(options.refreshModelFanOut)) fail("REHEARSAL_ARGUMENT_INVALID");
  currentD7RehearsalOutputDestinations(options.out);
}

async function removeCurrentD7PgInputDirectory(path, expectedIdentity) {
  if (path === null) return true;
  let metadata;
  try { metadata = await lstat(path); } catch (error) {
    if (error?.code === "ENOENT") return true;
    fail("REHEARSAL_CURRENT_D7_INPUT_CLEANUP_FAILED");
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (process.getuid && metadata.uid !== process.getuid())
    || (metadata.mode & 0o777) !== 0o700 || await realpath(path) !== path
    || (expectedIdentity && (metadata.dev !== expectedIdentity.dev || metadata.ino !== expectedIdentity.ino))) {
    fail("REHEARSAL_CURRENT_D7_INPUT_CLEANUP_FAILED");
  }
  await rm(path, { recursive: true, force: false });
  try { await lstat(path); fail("REHEARSAL_CURRENT_D7_INPUT_CLEANUP_FAILED"); }
  catch (error) { if (error instanceof RehearsalError) throw error; if (error?.code !== "ENOENT") throw error; }
  return true;
}

async function runCurrentD7Rehearsal(options) {
  // The 40-minute budget starts before any source, runtime, or producer binding.
  const startedMonotonicMs = performance.now();
  const deadlineMonotonicMs = startedMonotonicMs + S9_REHEARSAL_DEADLINE_MS;
  const startedAt = new Date().toISOString();
  const timings = {};
  let progress = null;
  let outputPreflighted = false;
  let reportWritten = false;
  let pgInputDirectory = null;
  let pgInputIdentity = null;
  let pgInputSnapshotsRemoved = false;
  let candidateResults = [];
  let outputSidecars = {};
  let failure = null;
  let handoffComplete = false;
  let schemaCleanupComplete = true;
  const report = {
    schemaVersion: GCP_FASTPATH_CURRENT_D7_REHEARSAL_REPORT_VERSION,
    comparisonMode: "current-worker-d1-d7",
    decisionId: "D7",
    startedAt,
    reusedSchema: false,
    qualifying: false,
    establishesNativeExecution: false,
    keptSchemaPairs: [],
    keptSchemas: [],
    timingsMs: timings,
  };

  try {
    validateCurrentD7DirectOptions(options);
    await assertCurrentD7RehearsalOutputsNew(options.out);
    outputPreflighted = true;
    if (process.version !== "v26.2.0") fail("REHEARSAL_CURRENT_REFERENCE_RUNTIME_INVALID");
    if (performance.now() >= deadlineMonotonicMs) fail("REHEARSAL_CURRENT_D7_DEADLINE_EXHAUSTED");
    progress = createS9Progress("controller");
    progress.phase("input_binding");

    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 13)) fail("REHEARSAL_NODE_UNSUPPORTED");
    const retainedNode22 = await verifyCurrentImageRuntimePath(options.node22);
    const node22Version = (await execFileAsync(options.node22, ["--version"], {
      timeout: Math.min(10_000, currentD7RemainingMs(deadlineMonotonicMs)),
    })).stdout.trim();
    if (node22Version !== retainedNode22.version
      || JSON.stringify(await verifyCurrentImageRuntimePath(options.node22)) !== JSON.stringify(retainedNode22)) {
      fail("REHEARSAL_CURRENT_IMAGE_RUNTIME_INVALID");
    }
    for (const path of [DIST_REFRESH, DIST_SERVER]) if (!existsSync(path)) fail("REHEARSAL_DIST_MISSING");

    const goldenPath = await realpath(options.golden);
    const expectedGoldenPath = await realpath(join(WORKER_ROOT, "analytics-v2-test/golden-q1-node"));
    if (options.golden !== expectedGoldenPath || goldenPath !== expectedGoldenPath) {
      fail("REHEARSAL_CURRENT_D7_GOLDEN_INVALID");
    }
    const manifest = JSON.parse(await readFile(join(goldenPath, "manifest.json"), "utf8"));
    if (manifest?.schemaVersion !== "gcp-fastpath-dense-oracle-manifest-v1"
      || manifest.nowMs !== 1_790_856_000_000 || manifest.now !== "2026-10-01T12:00:00.000Z"
      || manifest.pinnedNow !== manifest.now) fail("REHEARSAL_CURRENT_D7_GOLDEN_INVALID");

    currentD7RemainingMs(deadlineMonotonicMs);
    const currentPostgresInputs = await currentPostgresInputBinding({ node22: options.node22, node22Version,
      stagedPrimary: options.stagedPrimary });
    const producerModule = await import("../postgres-test/fixtures/current-q1-d7-reference.mjs");
    const contract = await import("../postgres-test/fixtures/current-q1-d7-contract.mjs");
    if (typeof producerModule.captureCurrentQ1D7ReferenceBinding !== "function"
      || typeof producerModule.runCurrentQ1D7Reference !== "function") fail("REHEARSAL_CURRENT_D7_PRODUCER_UNAVAILABLE");
    currentD7RemainingMs(deadlineMonotonicMs);
    const capturedInputBinding = await timed(timings, "current-d7:input-binding", producerModule.captureCurrentQ1D7ReferenceBinding);
    currentD7RemainingMs(deadlineMonotonicMs);
    contract.validateCurrentQ1D7InputBinding(capturedInputBinding);
    const inputBinding = cloneAndFreezeCurrentD7Json(capturedInputBinding);
    const producerInputBinding = cloneAndFreezeCurrentD7Json(inputBinding);
    if (inputBinding === producerInputBinding || !Object.isFrozen(inputBinding) || !Object.isFrozen(producerInputBinding)
      || !sameCurrentD7Json(inputBinding, producerInputBinding)) fail("REHEARSAL_CURRENT_D7_INPUT_BINDING_INVALID");
    const negativeCorpusSha256 = inputBinding.cases.conflictPreserving.corpusSha256;
    if (manifest.corpus?.q1?.sha256 !== negativeCorpusSha256) fail("REHEARSAL_CURRENT_D7_GOLDEN_INVALID");

    const outputPaths = currentD7RehearsalOutputDestinations(options.out);
    const inputBindingSha256 = contract.currentQ1D7JsonSha256(inputBinding);
    const inputBindingCapture = {
      schemaVersion: "current-q1-d7-input-binding-capture-v1",
      capturedBeforeProducer: true,
      captureOrdinal: 1,
      inputBindingSha256,
      inputBinding,
    };
    outputSidecars.inputBindingCaptureSha256 = await writeCurrentD7Sidecar(outputPaths[7], inputBindingCapture);
    const inputBindingCaptureMetadata = await currentD7SidecarMetadata(outputPaths[7]);
    const pgInputPrefix = await realpath(dirname(options.out));
    if (pgInputPrefix !== dirname(options.out)) fail("REHEARSAL_CURRENT_D7_OUTPUT_INVALID");
    pgInputDirectory = await mkdtemp(join(pgInputPrefix, ".current-d7-pg-input-"));
    await chmod(pgInputDirectory, 0o700);
    pgInputDirectory = await realpath(pgInputDirectory);
    pgInputIdentity = await lstat(pgInputDirectory);
    if (!pgInputIdentity.isDirectory() || pgInputIdentity.isSymbolicLink()
      || (process.getuid && pgInputIdentity.uid !== process.getuid()) || (pgInputIdentity.mode & 0o777) !== 0o700) {
      fail("REHEARSAL_CURRENT_D7_INPUT_INVALID");
    }

    progress.phase("current_d1_replay");
    currentD7RemainingMs(deadlineMonotonicMs);
    const producerResult = await timed(timings, "current-d7:producer", () => producerModule.runCurrentQ1D7Reference({
      inputBinding: producerInputBinding, deadlineMonotonicMs, pgInputDirectory,
    }));
    currentD7RemainingMs(deadlineMonotonicMs);
    await verifyCurrentD7InputBindingCapture(outputPaths[7], inputBindingCaptureMetadata,
      outputSidecars.inputBindingCaptureSha256);
    if (!sameCurrentD7Json(producerInputBinding, inputBinding)) {
      fail("REHEARSAL_CURRENT_D7_INPUT_BINDING_CAPTURE_CHANGED");
    }
    const acceptedProducer = validateCurrentD7ProducerResult(producerResult, { inputBinding, contract,
      currentPostgresInputs });
    if (contract.CURRENT_Q1_D7_BOUNDS?.s9DeadlineMs !== S9_REHEARSAL_DEADLINE_MS) {
      fail("REHEARSAL_CURRENT_D7_DEADLINE_INVALID");
    }
    if (manifest.corpus.q1.sha256 !== acceptedProducer.binding.cases.conflictPreserving.corpusSha256) {
      fail("REHEARSAL_CURRENT_D7_GOLDEN_INVALID");
    }
    currentD7RemainingMs(deadlineMonotonicMs);
    const afterProducerBinding = await producerModule.captureCurrentQ1D7ReferenceBinding();
    contract.validateCurrentQ1D7Binding(acceptedProducer.binding, afterProducerBinding);
    if (!sameCurrentD7Json(afterProducerBinding, inputBinding)
      || !sameCurrentD7Json(await currentPostgresInputBinding({ node22: options.node22, node22Version,
        stagedPrimary: options.stagedPrimary }), currentPostgresInputs)) {
      fail("REHEARSAL_CURRENT_CANDIDATE_INPUTS_CHANGED");
    }

    const initialSnapshots = await assertCurrentD7PgInputRoot({ pgInputs: acceptedProducer.pgInputs,
      binding: acceptedProducer.binding, pgInputDirectory, validateDescriptor: contract.validateCurrentQ1D7PgCaseInput });
    currentD7RemainingMs(deadlineMonotonicMs);
    const referenceEnvelope = {
      schemaVersion: "current-q1-d7-controller-reference-v1",
      inputBinding,
      reference: acceptedProducer.reference,
      binding: acceptedProducer.binding,
      acceptance: acceptedProducer.acceptance,
      cases: acceptedProducer.cases,
      expectations: acceptedProducer.expectations,
      expectationSha256: acceptedProducer.expectationSha256,
      pgInputs: acceptedProducer.pgInputs,
    };
    outputSidecars.bindingSha256 = await writeCurrentD7Sidecar(outputPaths[2], acceptedProducer.binding);
    outputSidecars.producerAcceptanceSha256 = await writeCurrentD7Sidecar(outputPaths[3], acceptedProducer.acceptance);
    outputSidecars.referenceSha256 = await writeCurrentD7Sidecar(outputPaths[1], referenceEnvelope);

    const currentDay = new Date(acceptedProducer.binding.runtime.pinnedNowMs).toISOString().slice(0, 10);
    const windows = Object.fromEntries(CURRENT_D7_CASES.map((caseId) => [caseId, currentD7CaseWindow(acceptedProducer.cases[caseId])]));
    if (!sameCurrentD7Json(windows.conflictPreserving, windows.conflictFreePositive)
      || windows.conflictPreserving.throughDay !== currentDay) fail("REHEARSAL_CURRENT_D7_REFERENCE_INVALID");

    progress.phase("postgres");
    const seenSuffixes = new Set();
    for (const caseId of CURRENT_D7_CASES) {
      currentD7RemainingMs(deadlineMonotonicMs);
      const pgInput = acceptedProducer.pgInputs[caseId];
      const result = await runRehearsal({ ...options, [INTERNAL_CURRENT_D7_CASE]: {
        caseId,
        fromDay: windows[caseId].fromDay,
        throughDay: windows[caseId].throughDay,
        nowMs: acceptedProducer.binding.runtime.pinnedNowMs,
        deadlineMonotonicMs,
        progress,
        inputBinding,
        binding: acceptedProducer.binding,
        pgInput,
        pgInputDirectory,
        currentPostgresInputs,
        referenceSha256: contract.currentQ1D7JsonSha256(acceptedProducer.cases[caseId]),
        expectationSha256: acceptedProducer.expectationSha256[caseId],
        pgInputSha256: contract.currentQ1D7JsonSha256(pgInput),
      } });
      candidateResults.push(result);
      const gates = result.report?.gates;
      const suffix = result.suffix;
      const expectedPair = fastpathRehearsalSchemas(suffix);
      if (result.caseId !== caseId || result.report?.status !== "pass" || result.report?.reusedSchema !== false
        || result.schema !== expectedPair.schema || result.controlSchema !== expectedPair.controlSchema
        || seenSuffixes.has(suffix) || !Array.isArray(result.report.keptSchemas)
        || !sameCurrentD7Json(result.report.keptSchemas, [result.schema, result.controlSchema])
        || !gates || !Object.values(gates).every(Boolean) || !result.actualResponse || !result.actualPreview
        || !sameCurrentD7Json(result.currentPostgresInputs, currentPostgresInputs)) {
        fail("REHEARSAL_CURRENT_D7_CASE_INCOMPLETE");
      }
      seenSuffixes.add(suffix);
    }
    if (candidateResults.length !== CURRENT_D7_CASES.length || seenSuffixes.size !== 2) {
      fail("REHEARSAL_CURRENT_D7_CASE_SET_INVALID");
    }

    progress.phase("source_recheck");
    currentD7RemainingMs(deadlineMonotonicMs);
    const afterBinding = await producerModule.captureCurrentQ1D7ReferenceBinding();
    contract.validateCurrentQ1D7Binding(acceptedProducer.binding, afterBinding);
    if (!sameCurrentD7Json(afterBinding, inputBinding)
      || !sameCurrentD7Json(await currentPostgresInputBinding({ node22: options.node22, node22Version,
        stagedPrimary: options.stagedPrimary }), currentPostgresInputs)) {
      fail("REHEARSAL_CURRENT_CANDIDATE_INPUTS_CHANGED");
    }
    const finalSnapshots = await assertCurrentD7PgInputRoot({ pgInputs: acceptedProducer.pgInputs,
      binding: acceptedProducer.binding, pgInputDirectory, validateDescriptor: contract.validateCurrentQ1D7PgCaseInput });
    currentD7RemainingMs(deadlineMonotonicMs);
    if (!sameCurrentD7Json(initialSnapshots, finalSnapshots)
      || finalSnapshots.root.dev !== pgInputIdentity.dev || finalSnapshots.root.ino !== pgInputIdentity.ino) {
      fail("REHEARSAL_CURRENT_D7_INPUT_CHANGED");
    }

    const comparator = await import("./analytics-v2-current-d7-compare.mjs");
    if (typeof comparator.compareCurrentQ1D7Contract !== "function") fail("REHEARSAL_CURRENT_D7_COMPARATOR_UNAVAILABLE");
    currentD7RemainingMs(deadlineMonotonicMs);
    const comparatorReport = comparator.compareCurrentQ1D7Contract({
      inputBinding,
      binding: acceptedProducer.binding,
      cases: candidateResults.map((result) => ({ caseId: result.caseId,
        reference: acceptedProducer.cases[result.caseId], expectation: acceptedProducer.expectations[result.caseId],
        actualResponse: result.actualResponse, actualPreview: result.actualPreview, currentDay })),
      expectations: acceptedProducer.expectations,
      expectationSha256: acceptedProducer.expectationSha256,
      pgInputs: acceptedProducer.pgInputs,
      producerAcceptance: acceptedProducer.acceptance,
      expectedController: acceptedProducer.controllerPin,
    });
    assertCurrentD7ContractAccepted(comparatorReport, { binding: acceptedProducer.binding,
      acceptance: acceptedProducer.acceptance, cases: acceptedProducer.cases,
      expectationSha256: acceptedProducer.expectationSha256 });
    currentD7RemainingMs(deadlineMonotonicMs);
    outputSidecars.contractSha256 = await writeCurrentD7Sidecar(outputPaths[6], comparatorReport);

    const caseReceipts = {};
    for (const result of candidateResults) {
      const caseId = result.caseId;
      const caseReference = acceptedProducer.cases[caseId];
      const expectation = acceptedProducer.expectations[caseId];
      caseReceipts[caseId] = {
        caseId,
        schemaVersion: "current-q1-d7-controller-case-receipt-v1",
        referenceSha256: contract.currentQ1D7JsonSha256(caseReference),
        expectationSha256: acceptedProducer.expectationSha256[caseId],
        corpusSha256: acceptedProducer.binding.cases[caseId].corpusSha256,
        admissionSha256: acceptedProducer.binding.cases[caseId].admissionSha256,
        sourceInvariantSha256: acceptedProducer.binding.cases[caseId].sourceInvariantSha256,
        pgInputSha256: contract.currentQ1D7JsonSha256(acceptedProducer.pgInputs[caseId]),
        bootstrapPreservationSha256: contract.currentQ1D7JsonSha256(caseReference.bootstrapPreservation),
        strictExportSha256: contract.currentQ1D7JsonSha256(caseReference.strictExport),
        actualResponseSha256: contract.currentQ1D7JsonSha256(result.actualResponse),
        actualPreviewSha256: contract.currentQ1D7JsonSha256(result.actualPreview),
        schema: result.schema,
        controlSchema: result.controlSchema,
        currentDay,
        retainedForS9Cleanup: true,
      };
      const sidecarPath = caseId === "conflictPreserving" ? outputPaths[4] : outputPaths[5];
      outputSidecars[caseId === "conflictPreserving" ? "conflictPreservingCaseSha256" : "conflictFreePositiveCaseSha256"] =
        await writeCurrentD7Sidecar(sidecarPath, {
          schemaVersion: "current-q1-d7-controller-case-output-v1",
          caseId,
          reference: caseReference,
          expectation,
          actualResponse: result.actualResponse,
          actualPreview: result.actualPreview,
          currentDay,
          controllerReceipt: caseReceipts[caseId],
        });
    }

    const pgInputSnapshotsRemoved = await removeCurrentD7PgInputDirectory(pgInputDirectory,
      { dev: pgInputIdentity.dev, ino: pgInputIdentity.ino });
    pgInputSnapshotsRemoved &&= !(await existsLstat(pgInputDirectory));
    if (!pgInputSnapshotsRemoved) fail("REHEARSAL_CURRENT_D7_INPUT_CLEANUP_FAILED");
    pgInputDirectory = null;
    report.keptSchemaPairs = candidateResults.map((result) => ({ caseId: result.caseId,
      schema: result.schema, controlSchema: result.controlSchema }));
    report.keptSchemas = report.keptSchemaPairs.flatMap(({ schema, controlSchema }) => [schema, controlSchema]);
    if (new Set(report.keptSchemas).size !== 4 || new Set(report.keptSchemaPairs.map((entry) => entry.schema)).size !== 2) {
      fail("REHEARSAL_CURRENT_D7_SCHEMA_OWNERSHIP_INVALID");
    }
    const elapsedMs = Math.max(0, Math.floor(performance.now() - startedMonotonicMs));
    currentD7RemainingMs(deadlineMonotonicMs);
    const qualification = validateCurrentD7ControllerQualification({
      schemaVersion: "current-q1-d7-controller-qualification-v1",
      comparisonMode: "current-worker-d1-d7",
      decisionId: "D7",
      caseIds: [...CURRENT_D7_CASES],
      inputBindingSha256,
      inputBindingCaptureContentSha256: outputSidecars.inputBindingCaptureSha256,
      bindingSha256: contract.currentQ1D7JsonSha256(acceptedProducer.binding),
      referenceContentSha256: outputSidecars.referenceSha256,
      producerAcceptanceContentSha256: outputSidecars.producerAcceptanceSha256,
      contractContentSha256: outputSidecars.contractSha256,
      caseReceipts,
      sidecars: outputSidecars,
      cleanupPending: true,
      qualifying: false,
      establishesNativeExecution: false,
      deadlineMs: S9_REHEARSAL_DEADLINE_MS,
      elapsedMs,
      pgInputSnapshotsRemoved,
    });
    report.status = "cleanup_pending";
    report.qualifying = false;
    report.establishesNativeExecution = false;
    report.finishedAt = new Date().toISOString();
    report.currentD7Qualification = qualification;
    report.gates = {
      producerAcceptanceComplete: true,
      bothPostgresCasesComplete: true,
      exactCurrentContractAccepted: true,
      sourceAndInputsUnchanged: true,
      pgInputSnapshotsRemoved: true,
      s9OwnedSchemaCleanupPending: true,
    };
    report.timingsMs.total = Math.round(performance.now() - startedMonotonicMs);
    progress.phase("report");
    await writeCurrentD7Sidecar(options.out, report);
    reportWritten = true;
    handoffComplete = true;
  } catch (error) {
    failure = error;
  } finally {
    if (progress !== null) {
      try { progress.phase("cleanup"); } catch { /* phase reporting cannot alter cleanup */ }
    }
    if (!handoffComplete && pgInputDirectory !== null) {
      try {
        pgInputSnapshotsRemoved = await removeCurrentD7PgInputDirectory(pgInputDirectory,
          pgInputIdentity ? { dev: pgInputIdentity.dev, ino: pgInputIdentity.ino } : null);
        if (pgInputSnapshotsRemoved) pgInputDirectory = null;
      } catch (error) { failure ??= error; }
    }
    if (!handoffComplete && candidateResults.length > 0) {
      try { await cleanupCurrentD7OwnedSchemas(candidateResults, deadlineMonotonicMs); }
      catch (error) { schemaCleanupComplete = false; failure ??= error; }
    }
    progress?.close();
  }

  if (!handoffComplete) {
    const code = typeof failure?.code === "string" && /^[A-Z0-9_]{1,80}$/u.test(failure.code)
      ? failure.code : "REHEARSAL_CURRENT_D7_FAILED";
    report.status = "error";
    report.finishedAt = new Date().toISOString();
    report.qualifying = false;
    report.establishesNativeExecution = false;
    report.error = { code };
    report.pgInputSnapshotsRemoved = pgInputSnapshotsRemoved;
    report.schemaCleanupComplete = schemaCleanupComplete;
    report.cleanupPending = !schemaCleanupComplete || !pgInputSnapshotsRemoved;
    if (schemaCleanupComplete) {
      report.keptSchemaPairs = [];
      report.keptSchemas = [];
    } else {
      report.keptSchemaPairs = candidateResults.filter((result) => result.report?.keptSchemas?.length > 0)
        .map((result) => ({ caseId: result.caseId, schema: result.schema, controlSchema: result.controlSchema }));
      report.keptSchemas = candidateResults.flatMap((result) => result.report?.keptSchemas ?? []);
    }
    report.timingsMs.total = Math.round(performance.now() - startedMonotonicMs);
    if (outputPreflighted && !reportWritten) {
      try {
        const text = `${JSON.stringify(report, null, 2)}\n`;
        await writeCurrentD7Sidecar(options.out, report);
        reportWritten = true;
        process.stdout.write(text);
      } catch { /* The original sanitized failure remains authoritative. */ }
    }
    progress?.close();
    process.exitCode = 2;
    if (!outputPreflighted) throw new RehearsalError(code);
    return report;
  }

  const text = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(text);
  process.exitCode = 0;
  return report;
}

async function existsLstat(path) {
  try { await lstat(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

/** Direct controller callers retain the same fresh-import boundary as CLI.
 * Refuse current schema reuse before any runtime, file, binding or PG access. */
export async function runRehearsal(options) {
  const currentD7Case = options?.[INTERNAL_CURRENT_D7_CASE] ?? null;
  if (options?.comparisonMode === "current-worker-d1-d7" && currentD7Case === null) {
    return runCurrentD7Rehearsal(options);
  }
  if (options.comparisonMode === "current-worker-d1" && options.reuseSchema !== null) {
    fail("REHEARSAL_ARGUMENT_INVALID", { argument: "--reuse-schema" });
  }
  if (options.comparisonMode === "current-worker-d1") {
    currentRehearsalOutputDestinations(options.out);
    await assertCurrentRehearsalOutputsNew(options.out);
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) fail("REHEARSAL_NODE_UNSUPPORTED");
  let node22Version;
  if (options.comparisonMode === "current-worker-d1" || options.comparisonMode === "current-worker-d1-d7") {
    const retained = await verifyCurrentImageRuntimePath(options.node22);
    const node22VersionResult = currentD7Case === null
      ? await execFileAsync(options.node22, ["--version"])
      : await execFileAsync(options.node22, ["--version"], { timeout: currentD7RemainingMs(deadlineMonotonicMs) });
    node22Version = node22VersionResult.stdout.trim();
    if (currentD7Case !== null) currentD7RemainingMs(deadlineMonotonicMs);
    if (node22Version !== retained.version
      || JSON.stringify(await verifyCurrentImageRuntimePath(options.node22)) !== JSON.stringify(retained)) {
      fail("REHEARSAL_CURRENT_IMAGE_RUNTIME_INVALID");
    }
  } else {
    if (!existsSync(options.node22)) fail("REHEARSAL_NODE22_MISSING");
    node22Version = (await execFileAsync(options.node22, ["--version"])).stdout.trim();
    if (!/^v22\./u.test(node22Version)) fail("REHEARSAL_NODE22_MISSING");
  }
  for (const path of [DIST_REFRESH, DIST_SERVER]) if (!existsSync(path)) fail("REHEARSAL_DIST_MISSING", { path });

  const golden = currentD7Case === null
    ? JSON.parse(await readFile(join(options.golden, "community-daily-response.json"), "utf8"))
    : { from: currentD7Case.fromDay, to: currentD7Case.throughDay };
  const goldenPreview = currentD7Case === null
    ? JSON.parse(await readFile(join(options.golden, "preview.json"), "utf8")) : null;
  const manifest = JSON.parse(await readFile(join(options.golden, "manifest.json"), "utf8"));
  const withheldModelDates = currentD7Case === null ? withheldModelDatesOf(manifest) : [];
  let perDateExpected = null;
  if (options.perDateExpected !== null) {
    try {
      perDateExpected = perDateExpectationFor(JSON.parse(await readFile(options.perDateExpected, "utf8")), manifest);
    } catch {
      fail("REHEARSAL_PER_DATE_INVALID");
    }
  }
  const ownerReference = options.ownerReference === null ? null : {
    ownerResults: JSON.parse(await readFile(join(options.ownerReference, "owner-results.json"), "utf8")),
    cacheReference: JSON.parse(await readFile(join(options.ownerReference, "cache-reference.json"), "utf8")),
    conflict: (JSON.parse(await readFile(join(options.ownerReference, "manifest.json"), "utf8"))).conflict ?? null,
  };
  const dump = currentD7Case !== null ? null : options.reuseSchema === null
    ? await resolveRehearsalDump({ golden: options.golden, dump: options.dump, manifest }) : null;
  const dumpPath = dump?.path ?? null;
  const nowMs = currentD7Case?.nowMs ?? manifest.nowMs;
  const nowIso = new Date(nowMs).toISOString();
  if (!Number.isSafeInteger(nowMs) || nowIso !== manifest.now) fail("REHEARSAL_GOLDEN_CLOCK_INVALID");

  const deadlineMonotonicMs = currentD7Case?.deadlineMonotonicMs;
  if (deadlineMonotonicMs !== undefined) currentD7RemainingMs(deadlineMonotonicMs);
  const endpoint = await localEndpoint(process.env);
  const endpointEnv = {
    ...(process.env.PG_TEST_SOCKET ? { PG_TEST_SOCKET: process.env.PG_TEST_SOCKET } : {}),
    ...(process.env.PG_TEST_HOST ? { PG_TEST_HOST: process.env.PG_TEST_HOST } : {}),
    PG_TEST_PORT: String(endpoint.port),
    ...(process.env.PG_TEST_USER ? { PG_TEST_USER: process.env.PG_TEST_USER } : {}),
    ...(process.env.PG_TEST_DATABASE ? { PG_TEST_DATABASE: process.env.PG_TEST_DATABASE } : {}),
  };
  const { suffix, schema, controlSchema } = fastpathRehearsalSchemas(options.reuseSchema === null
    ? randomBytes(4).toString("hex")
    : options.reuseSchema.slice(POSTGRES_FASTPATH_REHEARSAL_TARGET_SCHEMA_PREFIX.length));
  const created = [];
  const timings = {};
  const report = {
    schemaVersion: options.comparisonMode === "historical" ? GCP_FASTPATH_REHEARSAL_REPORT_VERSION
      : options.comparisonMode === "current-worker-d1-d7" ? GCP_FASTPATH_CURRENT_D7_REHEARSAL_REPORT_VERSION
        : GCP_FASTPATH_CURRENT_REHEARSAL_REPORT_VERSION,
    ...(options.comparisonMode === "historical" ? {} : { comparisonMode: options.comparisonMode }),
    startedAt: new Date().toISOString(),
    node: { rehearsal: process.version, analyticsRefresh: node22Version },
    golden: { nowMs, now: nowIso, from: golden.from, to: golden.to, sourceCommit: manifest.sourceCommit,
      withheldModelDates: withheldModelDates.length, dense: options.dense,
      dump: dump === null ? null : { sha256: dump.sha256, pinnedByManifest: dump.pinned } },
    schema,
    reusedSchema: options.reuseSchema !== null,
    refreshWorkers: options.refreshWorkers,
    steps: {},
    gates: {},
    timingsMs: timings,
  };
  const ownsProgress = currentD7Case?.progress === undefined;
  const progress = currentD7Case?.progress ?? createS9Progress("controller");
  const pgPool = new pg.Pool(poolOptions(endpoint, 6, "gcp-fastpath-rehearsal", { deadlineMonotonicMs }));
  pgPool.on("error", () => {});
  const pool = deadlineMonotonicMs === undefined ? pgPool : createCurrentD7DeadlinePool(pgPool, deadlineMonotonicMs);
  let origin = null;
  let workDirectory = null;
  let currentReference = null, currentReferenceBinding = null, currentReferenceSha256 = null;
  let currentReferenceCapture = null, currentPostgresInputs = null, currentProducerAcceptance = null;
  let currentD7ActualResponse = null, currentD7ActualPreview = null, currentD7ResponseTextSha256 = null;
  try {
    if (options.comparisonMode === "current-worker-d1") {
      // Capture the candidate's input closure before D1 execution, and before
      // any PG read. The expected DTOs come solely from current Worker/D1.
      const { captureCurrentQ1ReferenceBinding, runCurrentQ1D1Reference, validateCurrentQ1ReferenceBinding,
        assessCurrentQ1ReferenceCompleteness } =
        await import("../postgres-test/fixtures/current-q1-d1-reference.mjs");
      currentReferenceCapture = captureCurrentQ1ReferenceBinding;
      currentPostgresInputs = await currentPostgresInputBinding({ node22: options.node22, node22Version,
        stagedPrimary: options.stagedPrimary });
      report.currentPostgresInputs = currentPostgresInputs;
      progress.phase("input_binding");
      currentReferenceBinding = await timed(timings, "current-d1:input-binding", captureCurrentQ1ReferenceBinding);
      const window = currentReferenceBinding.corpusStructure.window;
      if (golden.from !== window.fromDay || golden.to !== window.throughDay
        || nowMs !== currentReferenceBinding.runtime.pinnedNowMs
        || manifest.sourceCommit !== currentReferenceBinding.corpus.sourceCommit) fail("REHEARSAL_CURRENT_CORPUS_MISMATCH");
      progress.phase("current_d1_replay");
      currentReference = await timed(timings, "current-d1:replay", runCurrentQ1D1Reference);
      progress.phase("current_d1_acceptance");
      validateCurrentQ1ReferenceBinding({ reference: currentReference, expected: currentReferenceBinding });
      const complete = assessCurrentQ1ReferenceCompleteness({ reference: currentReference,
        corpus: currentReferenceBinding.corpusStructure, snapshotReadiness: {
          afterForcedRecompute: currentReference.afterForcedRecompute?.readiness,
          afterNativeProbes: currentReference.afterNativeProbes?.readiness,
        } });
      if (currentReference.qualification !== "complete" || complete.state !== "complete") {
        fail("REHEARSAL_CURRENT_REFERENCE_INCOMPLETE");
      }
      const currentEvidenceSha256 = Object.fromEntries(["recomputation", "corpusConvergence", "strictExportRefusal"]
        .map((field) => [`${field}Sha256`, createHash("sha256").update(JSON.stringify(currentReference[field])).digest("hex")]));
      currentReferenceSha256 = createHash("sha256").update(JSON.stringify(currentReference)).digest("hex");
      const bindingSha256 = createHash("sha256").update(JSON.stringify(currentReferenceBinding)).digest("hex");
      // This wx receipt preserves what this controller actually invoked and
      // accepted before PG. It is an audit trail, not cryptographic execution
      // attestation, and arbitrary saved receipts cannot enter this CLI path.
      currentProducerAcceptance = Object.freeze({ schemaVersion: "current-q1-d1-producer-acceptance-v2",
        evidenceScope: "direct-source-pinned-producer-controller", cryptographicExecutionAttestation: false,
        actualHelperInvocation: true, resultReturnedAfterOwnedCleanup: true,
        accepted: true, referenceSha256: currentReferenceSha256, bindingSha256, ...currentEvidenceSha256,
        sourceHead: currentReferenceBinding.source.head, sourceSha256: currentReferenceBinding.source.sha256,
        migrationSha256: currentReferenceBinding.migrationSha256, corpusSha256: currentReferenceBinding.corpus.canonicalSha256,
        helper: currentReferenceBinding.source.files.find((entry) => entry.path === "apps/worker/postgres-test/fixtures/current-q1-d1-reference.mjs"),
        controller: currentPostgresInputs.controller, runtime: currentReferenceBinding.runtime });
      const acceptanceSha256 = createHash("sha256").update(JSON.stringify(currentProducerAcceptance)).digest("hex");
      report.currentReference = { schemaVersion: currentReference.schemaVersion, qualification: currentReference.qualification,
        sha256: currentReferenceSha256, bindingSha256, acceptanceSha256, ...currentEvidenceSha256, source: { head: currentReferenceBinding.source.head,
          sha256: currentReferenceBinding.source.sha256 }, migrationSha256: currentReferenceBinding.migrationSha256,
        corpusSha256: currentReferenceBinding.corpus.canonicalSha256, runtime: currentReferenceBinding.runtime };
      if (options.out !== null) {
        await writeFile(`${options.out}.current-reference.json`, `${JSON.stringify(currentReference, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        await writeFile(`${options.out}.current-reference-binding.json`, `${JSON.stringify(currentReferenceBinding, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        await writeFile(`${options.out}.current-reference-acceptance.json`, `${JSON.stringify(currentProducerAcceptance, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      }
      if (currentReference.qualification !== "complete") fail("REHEARSAL_CURRENT_REFERENCE_INCOMPLETE");
    } else if (currentD7Case !== null) {
      currentPostgresInputs = currentD7Case.currentPostgresInputs;
      report.currentPostgresInputs = currentPostgresInputs;
      report.currentD7Case = { caseId: currentD7Case.caseId,
        referenceSha256: currentD7Case.referenceSha256,
        expectationSha256: currentD7Case.expectationSha256,
        pgInputSha256: currentD7Case.pgInputSha256 };
    }
    progress.phase("postgres");
    const version = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
    if (Math.floor(version.rows[0].version / 10_000) !== 17) fail("REHEARSAL_POSTGRES_17_REQUIRED");

    if (options.reuseSchema !== null) {
      const present = await pool.query("SELECT count(*)::integer AS n FROM pg_namespace WHERE nspname = ANY($1)",
        [[schema]]);
      if (present.rows[0].n !== 1) fail("REHEARSAL_REUSE_SCHEMA_MISSING");
    } else {
      // 1. Fresh schemas, every promoted primary migration through the
      // production runner.
      progress.phase("migrate");
      await timed(timings, "migrate", async () => {
        for (const name of [schema, controlSchema]) {
          await pool.query(`CREATE SCHEMA ${quoteIdentifier(name)}`);
          created.push(name);
        }
        let primary;
        let staged = [];
        if (options.stagedPrimary.length === 0) {
          primary = await applyPostgresMigrations({ role: "primary", schema, pool });
        } else {
          const applied = await applyStockAndStagedMigrations({ role: "primary", schema, pool,
            stagedFiles: options.stagedPrimary });
          primary = { applied: applied.stockApplied, migrations: await readPostgresMigrations({ role: "primary" }) };
          staged = applied.staged.map(({ name, sha256 }) => ({ name, sha256 }));
        }
        const expected = await readPostgresMigrations({ role: "primary" });
        report.steps.migrate = {
          primaryApplied: primary.applied, primaryTail: primary.migrations.at(-1)?.name,
          expectedPrimary: expected.length,
          ...(staged.length === 0 ? {} : { staged }),
        };
        if (primary.applied !== expected.length) fail("REHEARSAL_MIGRATION_INCOMPLETE");
        if (currentPostgresInputs !== null && (JSON.stringify(primary.migrations.map(({ name, sha256 }) => ({ name, sha256 })))
          !== JSON.stringify(currentPostgresInputs.primary) || JSON.stringify(staged) !== JSON.stringify(currentPostgresInputs.staged))) {
          fail("REHEARSAL_CURRENT_MIGRATION_BINDING_CHANGED");
        }
      });

      // 2. The sealed SQLite rebuild of the oracle's USAGE_MONITOR_DB dump.
      progress.phase("sqlite");
      workDirectory = await realpath(await mkdtemp(join(tmpdir(), "gcp-fastpath-rehearsal-")));
      let sealed;
      if (currentD7Case === null) {
        sealed = await timed(timings, "sqlite", async () => sealFastpathRehearsalSource({ dumpPath, workDirectory }));
        report.steps.sqlite = sealed.report;
      } else {
        const input = currentD7Case.pgInput;
        sealed = { sealedSource: { path: input.ingestion.path, expectedSha256: input.ingestion.sha256 },
          report: { sha256: input.ingestion.sha256, bytes: input.ingestion.bytes, producerSealed: true } };
        report.steps.sqlite = sealed.report;
      }

      // 3. Importers, in the plan's order (shared with the GCP seed).
      progress.phase("importers");
      Object.assign(report.steps, await loadFastpathRehearsalImporters({
        pool, schema, controlSchema, suffix, sealedSource: sealed.sealedSource,
        dumpPath: currentD7Case === null ? dumpPath : null,
        sealedJournalSource: currentD7Case === null ? null : {
          path: currentD7Case.pgInput.journal.path, expectedSha256: currentD7Case.pgInput.journal.sha256,
          expectedSourceId: currentD7Case.pgInput.sourceId,
        },
        workDirectory, roster: manifest.owners, timings,
      }));
    }

    // REV-SEED: a synthetic revision floor, before any publication.
    let syntheticFloor = null;
    if (options.syntheticRevisionFloor) {
      syntheticFloor = await loadSyntheticRehearsalFloor(pool, schema, { golden, manifest, nowIso });
      report.steps.revisionFloor = { state: syntheticFloor.receipt.state, dayCount: syntheticFloor.receipt.dayCount,
        maxRevision: syntheticFloor.receipt.maxRevision, floorSha256: syntheticFloor.receipt.floorSha256 };
    }

    // 4. analytics-refresh (dist, Node 22) at the golden's clock.
    progress.phase("refresh_first");
    const first = await runRefresh({ node22: options.node22, endpointEnv, schema, nowIso,
      timeoutMinutes: options.refreshTimeoutMinutes, workers: options.refreshWorkers,
      modelBlockSize: options.refreshModelBlockSize, modelFanOut: options.refreshModelFanOut,
      deadlineMonotonicMs });
    timings["refresh:first"] = first.wallMs;
    report.steps.refreshFirst = { exitCode: first.exitCode, receipt: first.receipt, error: first.error };
    if (first.exitCode !== 0) fail("REHEARSAL_REFRESH_FAILED", { error: first.error });
    // LOCK_HELD means another refresh in this database ran instead: nothing
    // this run would compare was computed by it.
    if (first.receipt?.state !== "complete") fail("REHEARSAL_REFRESH_INCOMPLETE", { state: first.receipt?.state ?? null });
    report.measurement = { refreshFirst: refreshMeasurement(first) };
    const afterFirst = await publishedSnapshot(pool, schema);
    if (syntheticFloor !== null) {
      // Per day: exactly one above the floor, or r1 where there is none.
      const offFloor = afterFirst.filter((row) => row.revision !== (syntheticFloor.floor.get(row.day) ?? 0) + 1);
      report.steps.revisionFloor.publishedDays = afterFirst.length;
      report.steps.revisionFloor.flooredDays = afterFirst.filter((row) => syntheticFloor.floor.has(row.day)).length;
      report.steps.revisionFloor.offFloorDays = offFloor.length;
      report.steps.revisionFloor.receipt = first.receipt?.revisionFloor ?? null;
    }

    // 5-6. The fastpath-test origin and the public read.
    progress.phase("origin");
    origin = await timed(timings, "origin:start", async () => spawnOrigin({
      node: options.node22, endpoint, schema, nowMs, deadlineMonotonicMs,
    }));
    const url = `${origin.origin}${COMMUNITY_DAILY_PATH}?from=${golden.from}&to=${golden.to}`;
    const response = await timed(timings, "origin:get", async () => {
      const result = await fetch(url, deadlineMonotonicMs === undefined ? undefined
        : { signal: AbortSignal.timeout(currentD7RemainingMs(deadlineMonotonicMs)) });
      return { status: result.status, cacheControl: result.headers.get("cache-control"), text: await result.text() };
    });
    report.steps.read = { status: response.status, cacheControl: response.cacheControl, bytes: response.text.length,
      hostMode: origin.mode, originNode: origin.node };
    if (response.status !== 200) fail("REHEARSAL_READ_FAILED", { status: response.status, body: response.text.slice(0, 300) });
    const actual = JSON.parse(response.text);
    const actualPreview = await storedPreview(pool, schema);
    if (currentD7Case !== null) {
      currentD7ActualResponse = actual;
      currentD7ActualPreview = actualPreview;
      currentD7ResponseTextSha256 = createHash("sha256").update(response.text).digest("hex");
    } else if (options.out !== null) {
      await writeFile(`${options.out}.response.json`, `${response.text}\n`, { flag: "wx" });
      await writeFile(`${options.out}.preview.json`, `${JSON.stringify(actualPreview)}\n`, { flag: "wx" });
    }

    // 7. Parity. A dense golden's served read predates production's model and
    // preview publication, so its allowance families come from its per-date
    // expectation; every other family is the served read's.
    progress.phase("parity");
    report.parity = await timed(timings, "parity", async () => (options.dense
      ? compareAnalyticsV2Parity({
        golden: { ...golden, ...PUBLISHED_ALLOWANCE_STATE, allowanceBreakdowns: perDateExpected.allowanceBreakdowns },
        actual, goldenPreview: perDateExpected.preview, actualPreview,
      })
      : compareAnalyticsV2Parity({ golden, actual, goldenPreview, actualPreview, withheldModelDates, perDateExpected })));
    if (perDateExpected !== null) {
      report.perDate = comparePerDate({ expected: perDateExpected, response: actual, preview: actualPreview });
    }
    if (ownerReference !== null) {
      const rows = await timed(timings, "owner-rows", async () => readAnalyticsV2OwnerRows(pool, schema));
      if (options.out !== null) {
        await writeFile(`${options.out}.owner-rows.json`, `${JSON.stringify(rows)}\n`, { flag: "wx" });
      }
      report.ownerParity = await timed(timings, "owner-parity", async () => compareAnalyticsV2OwnerParity({
        ...ownerReference, rows,
      }));
    }

    if (options.comparisonMode === "current-worker-d1") {
      report.historicalComparison = { qualifying: false, parity: report.parity,
        ...(report.perDate === undefined ? {} : { perDate: report.perDate }) };
      report.currentContractParity = await timed(timings, "current-contract-parity", async () =>
        compareAnalyticsV2CurrentContract({ reference: currentReference, referenceBinding: currentReferenceBinding,
          referenceSha256: currentReferenceSha256, actual, actualPreview }));
    }

    // 8. A second run at the same clock must create no revision.
    progress.phase("refresh_second");
    const second = await runRefresh({ node22: options.node22, endpointEnv, schema, nowIso,
      timeoutMinutes: options.refreshTimeoutMinutes, workers: options.refreshWorkers,
      modelBlockSize: options.refreshModelBlockSize, modelFanOut: options.refreshModelFanOut,
      ...(deadlineMonotonicMs === undefined ? {} : { deadlineMonotonicMs }) });
    timings["refresh:second"] = second.wallMs;
    report.steps.refreshSecond = { exitCode: second.exitCode, receipt: second.receipt, error: second.error };
    report.measurement.refreshSecond = refreshMeasurement(second);
    const afterSecond = await publishedSnapshot(pool, schema);
    const changed = afterSecond.filter((row) => {
      const before = afterFirst.find((candidate) => candidate.day === row.day);
      return before === undefined || before.revision !== row.revision || before.payloadSha256 !== row.payloadSha256;
    });
    report.steps.secondRun = {
      publishedDaysBefore: afterFirst.length,
      publishedDaysAfter: afterSecond.length,
      newRevisions: changed.length,
      maxRevision: afterSecond.reduce((max, row) => Math.max(max, row.revision), 0),
    };
    // Internal PG kernel run/refusal history is a distinct diagnostic. Current
    // equality covers refusal fields in the served DTOs; sparse D1 native
    // probe evidence is not a matching PG kernel refusal protocol.
    report.runs = await refusalSummary(pool, schema);
    progress.phase("source_recheck");
    if (currentD7Case !== null) {
      const { captureCurrentQ1D7ReferenceBinding, validateCurrentQ1D7InputBinding,
        validateCurrentQ1D7Binding, validateCurrentQ1D7PgCaseInput } =
        await import("../postgres-test/fixtures/current-q1-d7-reference.mjs");
      const after = await captureCurrentQ1D7ReferenceBinding();
      validateCurrentQ1D7InputBinding(after);
      validateCurrentQ1D7Binding(currentD7Case.binding, after);
      if (JSON.stringify(after) !== JSON.stringify(currentD7Case.inputBinding)
        || JSON.stringify(await currentPostgresInputBinding({ node22: options.node22, node22Version,
          stagedPrimary: options.stagedPrimary })) !== JSON.stringify(currentPostgresInputs)) {
        fail("REHEARSAL_CURRENT_CANDIDATE_INPUTS_CHANGED");
      }
      await verifyCurrentD7PgCaseInputFiles({ descriptor: currentD7Case.pgInput, binding: currentD7Case.binding,
        caseId: currentD7Case.caseId, pgInputDirectory: currentD7Case.pgInputDirectory,
        validateDescriptor: validateCurrentQ1D7PgCaseInput });
      report.currentCandidateInputsUnchanged = true;
    } else if (currentReferenceCapture !== null) {
      const { validateCurrentQ1ReferenceBinding } = await import("../postgres-test/fixtures/current-q1-d1-reference.mjs");
      const after = await currentReferenceCapture();
      validateCurrentQ1ReferenceBinding({ reference: currentReference, expected: after });
      if (JSON.stringify(after) !== JSON.stringify(currentReferenceBinding)
        || JSON.stringify(await currentPostgresInputBinding({ node22: options.node22, node22Version,
          stagedPrimary: options.stagedPrimary })) !== JSON.stringify(currentPostgresInputs)) {
        fail("REHEARSAL_CURRENT_CANDIDATE_INPUTS_CHANGED");
      }
      report.currentCandidateInputsUnchanged = true;
    }

    if (currentD7Case !== null) {
      report.gates = {
        importersCompleted: report.steps.importVerification?.ownerRoster?.equal === true
          && report.steps.importVerification?.publicSourceOwners?.equal === true
          && report.steps.importVerification?.ownerRevisions?.equal === true,
        refreshFirstComplete: first.exitCode === 0 && first.receipt?.state === "complete",
        readStatus200: response.status === 200,
        secondRunZeroNewRevisions: second.exitCode === 0 && second.receipt?.state === "complete" && changed.length === 0,
        currentCandidateInputsUnchanged: report.currentCandidateInputsUnchanged === true,
      };
    } else {
      report.gates = {
        importersCompleted: true,
        refreshFirstComplete: first.exitCode === 0,
        readStatus200: response.status === 200,
        secondRunZeroNewRevisions: second.exitCode === 0 && second.receipt?.state === "complete" && changed.length === 0,
        ...(options.comparisonMode === "historical" ? {} : { currentCandidateInputsUnchanged: report.currentCandidateInputsUnchanged === true }),
        ...rehearsalComparisonGates({ comparisonMode: options.comparisonMode, parity: report.parity,
          currentContractParity: report.currentContractParity, hasAllowanceBreakdowns: actual.allowanceBreakdowns !== undefined,
          perDate: report.perDate, producerAcceptance: currentProducerAcceptance }),
        ...(report.ownerParity === undefined ? {} : { ownerParityZeroUnexpected: report.ownerParity.unexpectedDiffs === 0 }),
        ...(syntheticFloor === null ? {} : { revisionFloorRespected: report.steps.revisionFloor.offFloorDays === 0
          && report.steps.revisionFloor.flooredDays > 0 && report.steps.revisionFloor.receipt?.present === true }),
      };
    }
    report.status = Object.values(report.gates).every(Boolean) ? "pass" : "gate_failed";
  } catch (error) {
    report.status = "error";
    report.error = {
      code: typeof error?.code === "string" ? error.code : "REHEARSAL_FAILED",
      ...(options.comparisonMode === "current-worker-d1" && error?.diagnostic ? { diagnostic: error.diagnostic } : {}),
      ...(error instanceof RehearsalError ? { details: error.details } : {}),
      ...(error?.details && !(error instanceof RehearsalError) ? { details: error.details } : {}),
      ...Object.fromEntries(["table", "column", "sqlState", "field"].filter((key) =>
        typeof error?.[key] === "string" && /^[A-Za-z0-9_.]{1,64}$/u.test(error[key])).map((key) => [key, error[key]])),
      ...(typeof error?.code !== "string" ? { message: String(error?.message ?? error).slice(0, 300) } : {}),
    };
  } finally {
    progress.phase("cleanup");
    try {
      if (origin !== null) {
        report.originExit = await origin.close().catch(() => null);
      }
      if (workDirectory !== null) await rm(workDirectory, { recursive: true, force: true });
      if (options.reuseSchema !== null) {
        report.keptSchemas = [schema, controlSchema];
      } else if (!options.keepSchema) {
        await timed(timings, "cleanup", async () => {
          for (const name of [...created].reverse()) {
            await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(name)} CASCADE`).catch(() => {});
          }
        });
        report.droppedSchemas = created.length;
      } else {
        report.keptSchemas = created;
      }
      await pool.end().catch(() => {});
      report.finishedAt = new Date().toISOString();
    } finally { if (ownsProgress) progress.close(); }
  }
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (currentD7Case !== null) {
    return { report, caseId: currentD7Case.caseId, schema, controlSchema, suffix,
      actualResponse: currentD7ActualResponse, actualPreview: currentD7ActualPreview,
      responseTextSha256: currentD7ResponseTextSha256, currentPostgresInputs };
  }
  if (options.comparisonMode === "current-worker-d1") {
    // Do not emit a qualifying report until the final wx report is preserved.
    await writeFile(options.out, text, { flag: "wx", mode: 0o600 });
    process.stdout.write(text);
  } else {
    process.stdout.write(text);
    if (options.out !== null) await writeFile(options.out, text, { flag: "wx" });
  }
  process.exitCode = report.status === "pass" ? 0 : report.status === "gate_failed" ? 1 : 2;
  process.exit(process.exitCode);
}

async function main() {
  if (process.argv.includes("--origin-child")) {
    await originChild();
    return;
  }
  await runRehearsal(parseArguments(process.argv.slice(2)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "error", code: error?.code ?? "REHEARSAL_FAILED" })}\n`);
    process.exit(2);
  }
}
