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
//     schema (plus its "_ledger" pair and an importer control schema) and
//     applies every promoted migration with the production runner;
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
//  7. compares the response and the stored preview with the golden
//     (scripts/analytics-v2-parity-compare.mjs, publication fields only
//     normalized) and reports every difference per family. The model dates
//     the golden manifest lists as withheld (modelPublications.missing) may
//     be published by the fast path, and only those, with exactly the values
//     the oracle's per-date expectation holds: per-date model publication is
//     the owner's decision of 2026-10-01 (fast-path plan OD-12, decision D7).
//     Without --per-date-expected such a publication cannot be verified and
//     fails the parity gate;
//  8. runs analytics-refresh again and checks it creates no new revision;
//  9. drops every schema it created (unless --keep-schema).
//
// Options:
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
import { chmod, lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

import {
  compareAnalyticsV2Parity,
  perDateExpectationFor,
  withheldModelDatesOf,
} from "./analytics-v2-parity-compare.mjs";
import {
  compareAnalyticsV2OwnerParity,
  readAnalyticsV2OwnerRows,
} from "./analytics-v2-owner-parity-compare.mjs";
import { comparePerDate } from "./gcp-fastpath-dense-oracle/per-date-compare.mjs";
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

export const GCP_FASTPATH_REHEARSAL_REPORT_VERSION = "gcp-fastpath-rehearsal-report-v1";

const execFileAsync = promisify(execFile);
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLOUD_RUN_ROOT = join(WORKER_ROOT, "cloud-run");
const DIST_REFRESH = join(CLOUD_RUN_ROOT, "dist", "analytics-refresh.mjs");
const DIST_SERVER = join(CLOUD_RUN_ROOT, "dist", "server.mjs");
const DEFAULT_NODE22 = join(homedir(), ".nvm/versions/node/v22.16.0/bin/node");
const PRIVATE_SOCKET = /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
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

export function parseArguments(argv) {
  const options = {
    golden: null, keepSchema: false, out: null, node22: process.env.GCP_FASTPATH_NODE22 || DEFAULT_NODE22,
    dump: null, perDateExpected: null, ownerReference: null, dense: false,
    refreshTimeoutMinutes: DEFAULT_REFRESH_TIMEOUT_MINUTES, reuseSchema: null,
  };
  const valueOf = (index, argument) => {
    const value = argv[index];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      fail("REHEARSAL_ARGUMENT_INVALID", { argument });
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--golden") options.golden = valueOf(++index, argument);
    else if (argument === "--keep-schema") options.keepSchema = true;
    else if (argument === "--dense") options.dense = true;
    else if (argument === "--out") options.out = valueOf(++index, argument);
    else if (argument === "--node22") options.node22 = valueOf(++index, argument);
    else if (argument === "--dump") options.dump = valueOf(++index, argument);
    else if (argument === "--per-date-expected") options.perDateExpected = valueOf(++index, argument);
    else if (argument === "--owner-reference") options.ownerReference = valueOf(++index, argument);
    else if (argument === "--reuse-schema") options.reuseSchema = valueOf(++index, argument);
    else if (argument === "--refresh-timeout-minutes") {
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
  if (options.dense) {
    // A dense golden carries its own per-date expectation and owner references.
    if (options.perDateExpected !== null || options.ownerReference !== null) {
      fail("REHEARSAL_ARGUMENT_INVALID", { argument: "--dense" });
    }
    options.perDateExpected = join(options.golden, "per-date-expected.json");
    options.ownerReference = options.golden;
  }
  if (options.reuseSchema !== null) {
    if (!options.reuseSchema.startsWith(POSTGRES_FASTPATH_REHEARSAL_TARGET_SCHEMA_PREFIX)) {
      fail("REHEARSAL_ARGUMENT_INVALID", { argument: "--reuse-schema" });
    }
    fastpathRehearsalSchemas(options.reuseSchema.slice(POSTGRES_FASTPATH_REHEARSAL_TARGET_SCHEMA_PREFIX.length));
  }
  return options;
}

async function sha256OfFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
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

function poolOptions(endpoint, max, applicationName) {
  return {
    host: endpoint.host,
    port: endpoint.port,
    user: process.env.PG_TEST_USER || "postgres",
    database: process.env.PG_TEST_DATABASE || "postgres",
    ...(process.env.PG_TEST_PASSWORD ? { password: process.env.PG_TEST_PASSWORD } : {}),
    ssl: false,
    max,
    connectionTimeoutMillis: 10_000,
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

async function runRefresh({ node22, endpointEnv, schema, nowIso, timeoutMinutes }) {
  const started = performance.now();
  let stdout;
  let stderr;
  let exitCode = 0;
  try {
    ({ stdout, stderr } = await execFileAsync(node22, [`--max-old-space-size=${GCP_FASTPATH_REHEARSAL_REFRESH_HEAP_MIB}`,
      DIST_REFRESH, "--mode=full", `--now=${nowIso}`, `--schema=${schema}`], {
      cwd: CLOUD_RUN_ROOT,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ANALYTICS_V2_TEST_CLOCK: "1", ...endpointEnv },
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMinutes * 60_000,
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
 * fast-path target (typed_legacy_transfer_rehearsal_target_fastpath_<suffix>),
 * its "_ledger" pair and the importers' control schema. `suffix` is 8
 * lower-case hex digits, so "<schema>_ledger" stays a PostgreSQL identifier.
 */
export function fastpathRehearsalSchemas(suffix) {
  if (typeof suffix !== "string" || !/^[0-9a-f]{8}$/u.test(suffix)) fail("REHEARSAL_SUFFIX_INVALID");
  const schema = `${POSTGRES_FASTPATH_REHEARSAL_TARGET_SCHEMA_PREFIX}${suffix}`;
  return Object.freeze({
    suffix,
    schema,
    ledgerSchema: `${schema}_ledger`,
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
 * passes it.
 */
export async function loadFastpathRehearsalImporters({
  pool, schema, controlSchema, suffix, sealedSource, dumpPath, workDirectory, roster, timings = {},
  cloudFastpathTarget = false,
}) {
  if (typeof schema !== "string" || !schema.startsWith(POSTGRES_FASTPATH_REHEARSAL_TARGET_SCHEMA_PREFIX)) {
    fail("REHEARSAL_TARGET_SCHEMA_INVALID");
  }
  const steps = {};
  const sources = [];
  try {
    const identitySource = await openSealedFastpathIdentitySource(sealedSource);
    sources.push(identitySource);
    steps.identityCopy = await timed(timings, "importer:t1-identity", async () => {
      const receipt = await runPostgresFastpathIdentityCopy({
        source: identitySource, pool, targetSchema: schema, publicSourceOwnerParity: "defer",
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
    const journalSealed = await timed(timings, "sqlite:journal", async () =>
      buildJournalSqlite(dumpPath, join(workDirectory, "storage-ingestion-journal.sqlite")));
    steps.journalSqlite = { sha256: journalSealed.sha256 };
    const journalSource = await createSealedSqliteIngestionJournalSource({
      path: journalSealed.path, expectedSha256: journalSealed.sha256, expectedSourceId: sourceId,
    });
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
function refreshMeasurement(run) {
  const receipt = run.receipt ?? {};
  return {
    wallMs: run.wallMs,
    state: receipt.state ?? null,
    timingsMs: receipt.timings ?? null,
    memory: receipt.memory ?? null,
  };
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

async function startOrigin({ endpoint, schema, ledgerSchema, nowMs }) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const bucket = "synthetic-fastpath-rehearsal-bucket";
  const environment = {
    POSTGRES_TEST_HTTP_MODE: "fastpath-test",
    HOST: "127.0.0.1",
    PORT: String(port),
    HOST_ORIGIN: origin,
    PRIMARY_SCHEMA: schema,
    LEDGER_SCHEMA: ledgerSchema,
    PRIMARY_DATABASE: process.env.PG_TEST_DATABASE || "postgres",
    PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:synthetic-fastpath-rehearsal",
    POSTGRES_IAM_USER: "synthetic-fastpath-rehearsal@synthetic.iam",
    POSTGRES_RATE_LIMIT_SECRET: randomBytes(32).toString("hex"),
    ENVELOPE_PUBLIC_JWK: '{"synthetic":"unused-public-key"}',
    ENVELOPE_PRIVATE_JWK: "synthetic-unused-private-key",
    GCS_BUCKET_NAME: bucket,
    GCS_ERASURE_BUCKET_HISTORY_PROOF: JSON.stringify({
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
      const created = new pg.Pool(poolOptions(endpoint, options.max ?? 3, `gcp-fastpath-origin-${options.role}`));
      created.on("error", () => {});
      pools.push(created);
      return created;
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
  const started = await startOrigin(config);
  process.stdout.write(`${JSON.stringify({ origin: started.origin, mode: started.mode, node: process.version })}\n`);
}

/** Start the origin child under `node`, and resolve once it is listening. */
async function spawnOrigin({ node, endpoint, schema, ledgerSchema, nowMs }) {
  const child = spawn(node, [fileURLToPath(import.meta.url), "--origin-child"], {
    cwd: CLOUD_RUN_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...(process.env.PG_TEST_USER ? { PG_TEST_USER: process.env.PG_TEST_USER } : {}),
      ...(process.env.PG_TEST_DATABASE ? { PG_TEST_DATABASE: process.env.PG_TEST_DATABASE } : {}),
      GCP_FASTPATH_REHEARSAL_ORIGIN: JSON.stringify({ endpoint, schema, ledgerSchema, nowMs }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4_000); });
  const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
  const ready = await new Promise((resolveReady, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new RehearsalError("REHEARSAL_ORIGIN_START_TIMEOUT")), 60_000);
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

async function main() {
  if (process.argv.includes("--origin-child")) {
    await originChild();
    return;
  }
  const options = parseArguments(process.argv.slice(2));
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) fail("REHEARSAL_NODE_UNSUPPORTED");
  if (!existsSync(options.node22)) fail("REHEARSAL_NODE22_MISSING");
  const node22Version = (await execFileAsync(options.node22, ["--version"])).stdout.trim();
  if (!/^v22\./u.test(node22Version)) fail("REHEARSAL_NODE22_MISSING");
  for (const path of [DIST_REFRESH, DIST_SERVER]) if (!existsSync(path)) fail("REHEARSAL_DIST_MISSING", { path });

  const golden = JSON.parse(await readFile(join(options.golden, "community-daily-response.json"), "utf8"));
  const goldenPreview = JSON.parse(await readFile(join(options.golden, "preview.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(options.golden, "manifest.json"), "utf8"));
  const withheldModelDates = withheldModelDatesOf(manifest);
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
  const dump = options.reuseSchema === null
    ? await resolveRehearsalDump({ golden: options.golden, dump: options.dump, manifest }) : null;
  const dumpPath = dump?.path ?? null;
  const nowMs = manifest.nowMs;
  const nowIso = new Date(nowMs).toISOString();
  if (!Number.isSafeInteger(nowMs) || nowIso !== manifest.now) fail("REHEARSAL_GOLDEN_CLOCK_INVALID");

  const endpoint = await localEndpoint(process.env);
  const endpointEnv = {
    ...(process.env.PG_TEST_SOCKET ? { PG_TEST_SOCKET: process.env.PG_TEST_SOCKET } : {}),
    ...(process.env.PG_TEST_HOST ? { PG_TEST_HOST: process.env.PG_TEST_HOST } : {}),
    PG_TEST_PORT: String(endpoint.port),
    ...(process.env.PG_TEST_USER ? { PG_TEST_USER: process.env.PG_TEST_USER } : {}),
    ...(process.env.PG_TEST_DATABASE ? { PG_TEST_DATABASE: process.env.PG_TEST_DATABASE } : {}),
  };
  const { suffix, schema, ledgerSchema, controlSchema } = fastpathRehearsalSchemas(options.reuseSchema === null
    ? randomBytes(4).toString("hex")
    : options.reuseSchema.slice(POSTGRES_FASTPATH_REHEARSAL_TARGET_SCHEMA_PREFIX.length));
  const created = [];
  const timings = {};
  const report = {
    schemaVersion: GCP_FASTPATH_REHEARSAL_REPORT_VERSION,
    startedAt: new Date().toISOString(),
    node: { rehearsal: process.version, analyticsRefresh: node22Version },
    golden: { nowMs, now: nowIso, from: golden.from, to: golden.to, sourceCommit: manifest.sourceCommit,
      withheldModelDates: withheldModelDates.length, dense: options.dense,
      dump: dump === null ? null : { sha256: dump.sha256, pinnedByManifest: dump.pinned } },
    schema,
    reusedSchema: options.reuseSchema !== null,
    steps: {},
    gates: {},
    timingsMs: timings,
  };
  const pool = new pg.Pool(poolOptions(endpoint, 6, "gcp-fastpath-rehearsal"));
  pool.on("error", () => {});
  let origin = null;
  let workDirectory = null;
  try {
    const version = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
    if (Math.floor(version.rows[0].version / 10_000) !== 17) fail("REHEARSAL_POSTGRES_17_REQUIRED");

    if (options.reuseSchema !== null) {
      const present = await pool.query("SELECT count(*)::integer AS n FROM pg_namespace WHERE nspname = ANY($1)",
        [[schema, ledgerSchema]]);
      if (present.rows[0].n !== 2) fail("REHEARSAL_REUSE_SCHEMA_MISSING");
    } else {
      // 1. Fresh schemas, every promoted migration through the production runner.
      await timed(timings, "migrate", async () => {
        for (const name of [schema, ledgerSchema, controlSchema]) {
          await pool.query(`CREATE SCHEMA ${quoteIdentifier(name)}`);
          created.push(name);
        }
        const primary = await applyPostgresMigrations({ role: "primary", schema, pool });
        const ledger = await applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool });
        const expected = await readPostgresMigrations({ role: "primary" });
        report.steps.migrate = {
          primaryApplied: primary.applied, primaryTail: primary.migrations.at(-1)?.name,
          ledgerApplied: ledger.applied, expectedPrimary: expected.length,
        };
        if (primary.applied !== expected.length) fail("REHEARSAL_MIGRATION_INCOMPLETE");
      });

      // 2. The sealed SQLite rebuild of the oracle's USAGE_MONITOR_DB dump.
      workDirectory = await realpath(await mkdtemp(join(tmpdir(), "gcp-fastpath-rehearsal-")));
      const sealed = await timed(timings, "sqlite", async () => sealFastpathRehearsalSource({ dumpPath, workDirectory }));
      report.steps.sqlite = sealed.report;

      // 3. Importers, in the plan's order (shared with the GCP seed).
      Object.assign(report.steps, await loadFastpathRehearsalImporters({
        pool, schema, controlSchema, suffix, sealedSource: sealed.sealedSource, dumpPath, workDirectory,
        roster: manifest.owners, timings,
      }));
    }

    // 4. analytics-refresh (dist, Node 22) at the golden's clock.
    const first = await runRefresh({ node22: options.node22, endpointEnv, schema, nowIso,
      timeoutMinutes: options.refreshTimeoutMinutes });
    timings["refresh:first"] = first.wallMs;
    report.steps.refreshFirst = { exitCode: first.exitCode, receipt: first.receipt, error: first.error };
    if (first.exitCode !== 0) fail("REHEARSAL_REFRESH_FAILED", { error: first.error });
    // LOCK_HELD means another refresh in this database ran instead: nothing
    // this run would compare was computed by it.
    if (first.receipt?.state !== "complete") fail("REHEARSAL_REFRESH_INCOMPLETE", { state: first.receipt?.state ?? null });
    report.measurement = { refreshFirst: refreshMeasurement(first) };
    const afterFirst = await publishedSnapshot(pool, schema);

    // 5-6. The fastpath-test origin and the public read.
    origin = await timed(timings, "origin:start", async () => spawnOrigin({
      node: options.node22, endpoint, schema, ledgerSchema, nowMs,
    }));
    const url = `${origin.origin}${COMMUNITY_DAILY_PATH}?from=${golden.from}&to=${golden.to}`;
    const response = await timed(timings, "origin:get", async () => {
      const result = await fetch(url);
      return { status: result.status, cacheControl: result.headers.get("cache-control"), text: await result.text() };
    });
    report.steps.read = { status: response.status, cacheControl: response.cacheControl, bytes: response.text.length,
      hostMode: origin.mode, originNode: origin.node };
    if (response.status !== 200) fail("REHEARSAL_READ_FAILED", { status: response.status, body: response.text.slice(0, 300) });
    const actual = JSON.parse(response.text);
    const actualPreview = await storedPreview(pool, schema);
    if (options.out !== null) {
      await writeFile(`${options.out}.response.json`, `${response.text}\n`, { flag: "wx" });
      await writeFile(`${options.out}.preview.json`, `${JSON.stringify(actualPreview)}\n`, { flag: "wx" });
    }

    // 7. Parity. A dense golden's served read predates production's model and
    // preview publication, so its allowance families come from its per-date
    // expectation; every other family is the served read's.
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

    // 8. A second run at the same clock must create no revision.
    const second = await runRefresh({ node22: options.node22, endpointEnv, schema, nowIso,
      timeoutMinutes: options.refreshTimeoutMinutes });
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
    report.runs = await refusalSummary(pool, schema);

    report.gates = {
      importersCompleted: true,
      refreshFirstComplete: first.exitCode === 0,
      readStatus200: response.status === 200,
      secondRunZeroNewRevisions: second.exitCode === 0 && second.receipt?.state === "complete" && changed.length === 0,
      parityZeroUnexpected: report.parity.unexpectedDiffs === 0,
      ...(report.perDate === undefined ? {} : { perDateEqual: report.perDate.equal === true }),
      ...(report.ownerParity === undefined ? {} : { ownerParityZeroUnexpected: report.ownerParity.unexpectedDiffs === 0 }),
    };
    report.status = Object.values(report.gates).every(Boolean) ? "pass" : "gate_failed";
  } catch (error) {
    report.status = "error";
    report.error = {
      code: typeof error?.code === "string" ? error.code : "REHEARSAL_FAILED",
      ...(error instanceof RehearsalError ? { details: error.details } : {}),
      ...(error?.details && !(error instanceof RehearsalError) ? { details: error.details } : {}),
      ...Object.fromEntries(["table", "column", "sqlState", "field"].filter((key) =>
        typeof error?.[key] === "string" && /^[A-Za-z0-9_.]{1,64}$/u.test(error[key])).map((key) => [key, error[key]])),
      ...(typeof error?.code !== "string" ? { message: String(error?.message ?? error).slice(0, 300) } : {}),
    };
  } finally {
    if (origin !== null) {
      report.originExit = await origin.close().catch(() => null);
    }
    if (workDirectory !== null) await rm(workDirectory, { recursive: true, force: true });
    if (options.reuseSchema !== null) {
      report.keptSchemas = [schema, ledgerSchema, controlSchema];
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
  }
  const text = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(text);
  if (options.out !== null) await writeFile(options.out, text, { flag: "wx" });
  process.exitCode = report.status === "pass" ? 0 : report.status === "gate_failed" ? 1 : 2;
  process.exit(process.exitCode);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "error", code: error?.code ?? "REHEARSAL_FAILED" })}\n`);
    process.exit(2);
  }
}
