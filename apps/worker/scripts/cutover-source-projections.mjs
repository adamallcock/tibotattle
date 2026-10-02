#!/usr/bin/env node
// PT-2-lite projections over sealed sources (cutover-source-projections.mjs).
//
//   journal             an exact-layout journal-only SQLite for the existing
//                       ingestion-journal importer (postgres-ingestion-journal-
//                       transfer.mjs): storage_source_state,
//                       storage_ingestion_changes and its owner cursor index
//                       with the sealed DDL and rows, the same layout as
//                       buildJournalSqlite (gcp-fastpath-rehearsal.mjs:215-240),
//                       written 0400 with its sha256.
//   deletion-digests    the do-not-restore seed (decision D2): the sorted
//                       deletion_tombstones.participant_digest values of the
//                       sealed deletion ledger and nothing else, one per line,
//                       written 0400 with its sha256. No ledger table is
//                       imported anywhere.
//   intersection        computes src/participant-deletion-digest.ts's digest
//                       for every sealed participant, whatever its state, in
//                       memory and reports only counts: participants per
//                       state and the number that match a projected digest.
//                       It must be 0 (CUTOVER_ERASED_PARTICIPANT_PRESENT
//                       otherwise). No participant id is ever written. A
//                       'deleting' participant (an interrupted Cloudflare
//                       erasure) is hashed like any other: its tombstone may
//                       already be recorded. PT-3 separately refuses any
//                       participant that is not quiescent.

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmod, lstat, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CutoverSourceError,
  assertOwnerDirectory,
  cutoverFail as fail,
  isTrustedCutoverSealedSqlite,
  openSealedSourceFromSeal,
  readCutoverSeal,
  readPrivateFile,
  sha256File,
  sha256Hex,
  writePrivateFileOnce,
  WORKER_ROOT,
} from "./cutover-source-seal.mjs";

export const CUTOVER_DELETION_DIGEST_PROJECTION_SCHEMA = "tibotattle-cutover-deletion-digests-v1";
export const CUTOVER_JOURNAL_PROJECTION_OBJECTS = Object.freeze([
  "storage_source_state", "storage_ingestion_changes", "storage_ingestion_owner_cursor",
]);
// Mirrors src/participant-deletion-digest.ts; the check pins the literal.
export const PARTICIPANT_DELETION_DIGEST_DOMAIN = "app-usagemonitor/deletion-tombstone/v1\0";
export const PARTICIPANT_DELETION_DIGEST_SOURCE = join(WORKER_ROOT, "src", "participant-deletion-digest.ts");

const DIGEST = /^[0-9a-f]{64}$/u;
const JOURNAL_PAGE_ROWS = 5_000;
const MAX_PROJECTION_BYTES = 1024 * 1024 * 1024;

/** sha256(domain || participantId), hex: the Worker's participantDeletionDigest. */
export function participantDeletionDigest(participantId) {
  if (typeof participantId !== "string" || participantId.length === 0) fail("CUTOVER_PROJECTION_INVALID");
  return createHash("sha256").update(`${PARTICIPANT_DELETION_DIGEST_DOMAIN}${participantId}`).digest("hex");
}

function trusted(source) {
  if (!isTrustedCutoverSealedSqlite(source)) fail("CUTOVER_ARGUMENT_INVALID");
  return source;
}

function schemaEntry(database, name) {
  const rows = database.prepare("SELECT type, sql FROM sqlite_schema WHERE name = ?").all(name);
  if (rows.length !== 1 || typeof rows[0].sql !== "string") fail("CUTOVER_PROJECTION_INVALID");
  return rows[0];
}

/**
 * Project the ingestion journal from a sealed ingestion source into a fresh
 * 0400 SQLite with exactly the importer's layout. Rows are copied in
 * sequence pages; nothing else of the seal is read.
 */
export async function projectIngestionJournal({ sealedIngestion, outputPath } = {}) {
  const source = trusted(sealedIngestion);
  if (typeof outputPath !== "string" || !outputPath.endsWith(".sqlite")) fail("CUTOVER_ARGUMENT_INVALID");
  if (await lstat(outputPath).then(() => true, () => false)) fail("CUTOVER_OUTPUT_EXISTS");
  await source.verify();
  const sealed = source.database();
  const ddl = CUTOVER_JOURNAL_PROJECTION_OBJECTS.map(name => schemaEntry(sealed, name));
  if (ddl[0].type !== "table" || ddl[1].type !== "table" || ddl[2].type !== "index") fail("CUTOVER_PROJECTION_INVALID");
  const previousUmask = process.umask(0o077);
  let output;
  let rows = 0;
  try {
    output = new DatabaseSync(outputPath, { allowExtension: false });
    output.exec("PRAGMA journal_mode=DELETE");
    output.exec("BEGIN");
    for (const entry of ddl) output.exec(entry.sql);
    const copyRows = (table, columns, keyColumn) => {
      const list = columns.map(column => `"${column}"`).join(",");
      const read = sealed.prepare(`SELECT ${list} FROM "${table}" WHERE "${keyColumn}" > ? ORDER BY "${keyColumn}" LIMIT ?`);
      read.setReadBigInts(true);
      const insert = output.prepare(`INSERT INTO "${table}" (${list}) VALUES (${columns.map(() => "?").join(",")})`);
      let after = -1n;
      for (;;) {
        const page = read.all(after, JOURNAL_PAGE_ROWS);
        for (const row of page) {
          insert.run(...columns.map(column => row[column]));
          rows += 1;
        }
        if (page.length < JOURNAL_PAGE_ROWS) break;
        after = page.at(-1)[keyColumn];
      }
    };
    copyRows("storage_source_state", ["singleton", "source_id", "authority_epoch"], "singleton");
    copyRows("storage_ingestion_changes", ["sequence", "event_digest", "owner_digest", "revision", "kind", "object_digest",
      "content_digest", "authority_epoch", "public_authority_epoch", "recorded_ms"], "sequence");
    output.exec("COMMIT");
  } catch (error) {
    try { output?.exec("ROLLBACK"); } catch { /* discarded below */ }
    if (error instanceof CutoverSourceError) throw error;
    fail("CUTOVER_PROJECTION_INVALID");
  } finally {
    output?.close();
    process.umask(previousUmask);
  }
  await source.verify();
  await chmod(outputPath, 0o400);
  return Object.freeze({ path: outputPath, sha256: await sha256File(outputPath), rows });
}

/**
 * The do-not-restore seed: sorted participant digests from the sealed
 * deletion ledger's deletion_tombstones (deletion-ledger-migrations/0001),
 * one per line, written once 0400. Every value must be a 64-hex digest.
 */
export async function projectDeletionDigests({ sealedLedger, outputPath } = {}) {
  const source = trusted(sealedLedger);
  if (typeof outputPath !== "string") fail("CUTOVER_ARGUMENT_INVALID");
  await source.verify();
  const database = source.database();
  const table = database.prepare(`SELECT sql FROM sqlite_schema WHERE type='table' AND name='deletion_tombstones'`).all();
  if (table.length !== 1) fail("CUTOVER_PROJECTION_INVALID");
  const digests = database.prepare("SELECT participant_digest AS digest FROM deletion_tombstones ORDER BY participant_digest")
    .all().map(row => row.digest);
  if (digests.some(digest => typeof digest !== "string" || !DIGEST.test(digest))) fail("CUTOVER_PROJECTION_INVALID");
  for (let index = 1; index < digests.length; index += 1) {
    if (digests[index - 1] >= digests[index]) fail("CUTOVER_PROJECTION_INVALID");
  }
  await source.verify();
  const text = digests.map(digest => `${digest}\n`).join("");
  const sha256 = await writePrivateFileOnce(outputPath, text, 0o400);
  return Object.freeze({
    schema: CUTOVER_DELETION_DIGEST_PROJECTION_SCHEMA,
    path: outputPath,
    sha256,
    count: digests.length,
  });
}

/** Read a deletion-digest projection back (owner-only file, closed format). */
export async function readDeletionDigestProjection({ path, expectedSha256 } = {}) {
  // An empty projection is a valid seed with no digests.
  const bytes = await readPrivateFile(path, MAX_PROJECTION_BYTES, "CUTOVER_PROJECTION_INVALID", { allowEmpty: true });
  if (sha256Hex(bytes) !== expectedSha256) fail("CUTOVER_PROJECTION_INVALID");
  const text = bytes.toString("utf8");
  if (text.length === 0) return Object.freeze(new Set());
  if (!text.endsWith("\n")) fail("CUTOVER_PROJECTION_INVALID");
  const digests = text.slice(0, -1).split("\n");
  for (let index = 0; index < digests.length; index += 1) {
    if (!DIGEST.test(digests[index]) || (index > 0 && digests[index - 1] >= digests[index])) {
      fail("CUTOVER_PROJECTION_INVALID");
    }
  }
  return Object.freeze(new Set(digests));
}

// The participant states the D1 schema admits (migrations 0001 and 0058:
// CHECK (state IN ('active', 'deleting'))). Any other value is not a
// participant this projection can account for.
export const CUTOVER_PARTICIPANT_STATES = Object.freeze(["active", "deleting"]);

/**
 * Count, in memory, the sealed participants (every state) whose deletion
 * digest is in the projected set. Only counts leave this function.
 */
export async function countSealedParticipantDeletionMatches({ sealedIngestion, digests } = {}) {
  const source = trusted(sealedIngestion);
  if (!(digests instanceof Set) || [...digests].some(digest => !DIGEST.test(digest))) fail("CUTOVER_ARGUMENT_INVALID");
  await source.verify();
  const statement = source.database().prepare("SELECT id, state FROM participants WHERE id > ? ORDER BY id LIMIT 1000");
  const byState = Object.fromEntries(CUTOVER_PARTICIPANT_STATES.map(state => [state, 0]));
  let after = "";
  let participants = 0;
  let matches = 0;
  for (;;) {
    const page = statement.all(after);
    for (const row of page) {
      if (typeof row.state !== "string" || !Object.hasOwn(byState, row.state)) fail("CUTOVER_PROJECTION_INVALID");
      participants += 1;
      byState[row.state] += 1;
      if (digests.has(participantDeletionDigest(row.id))) matches += 1;
    }
    if (page.length < 1000) break;
    after = page.at(-1).id;
  }
  await source.verify();
  return Object.freeze({ participants, participantsByState: Object.freeze(byState), deletionDigests: digests.size,
    matches });
}

/** The gate form: zero matches, or CUTOVER_ERASED_PARTICIPANT_PRESENT. */
export async function assertNoSealedParticipantDeletionMatches(options) {
  const result = await countSealedParticipantDeletionMatches(options);
  if (result.matches !== 0) fail("CUTOVER_ERASED_PARTICIPANT_PRESENT");
  return result;
}

/** The digest domain literal in src/participant-deletion-digest.ts, for the pin check. */
export async function readWorkerDeletionDigestDomain(path = PARTICIPANT_DELETION_DIGEST_SOURCE) {
  const text = await readFile(path, "utf8");
  const match = /const DELETION_DIGEST_DOMAIN = "([^"]+)\\0";/u.exec(text);
  return match === null ? null : `${match[1]}\0`;
}

// ---------------------------------------------------------------------------
// CLI: all three read a verified seal; outputs go to the owner directory.

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!["journal", "deletion-digests", "intersection"].includes(command)) fail("CUTOVER_ARGUMENT_INVALID");
  const values = { "--seal": "manifestPath", "--seal-id": "sealId", "--out": "ownerDirectory",
    "--digests": "digestsPath", "--digests-sha256": "digestsSha256" };
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = values[rest[index]];
    const value = rest[index + 1];
    if (key === undefined || options[key] !== undefined || typeof value !== "string" || value.startsWith("--")) {
      fail("CUTOVER_ARGUMENT_INVALID");
    }
    options[key] = value;
  }
  if (!options.manifestPath || !options.sealId) fail("CUTOVER_ARGUMENT_INVALID");
  return options;
}

async function main(argv) {
  const options = parseArguments(argv);
  const seal = await readCutoverSeal({ manifestPath: resolve(options.manifestPath), expectedSealId: options.sealId });
  if (options.command === "intersection") {
    const digests = await readDeletionDigestProjection({ path: resolve(options.digestsPath ?? ""),
      expectedSha256: options.digestsSha256 });
    const ingestion = await openSealedSourceFromSeal(seal, "ingestion");
    try {
      const result = await countSealedParticipantDeletionMatches({ sealedIngestion: ingestion, digests });
      process.stdout.write(`${JSON.stringify({ command: options.command, ...result })}\n`);
      if (result.matches !== 0) process.exitCode = 1;
    } finally {
      ingestion.close();
    }
    return;
  }
  const directory = await assertOwnerDirectory(resolve(options.ownerDirectory ?? ""));
  if (options.command === "journal") {
    const ingestion = await openSealedSourceFromSeal(seal, "ingestion");
    try {
      const result = await projectIngestionJournal({ sealedIngestion: ingestion,
        outputPath: join(directory, "ingestion-journal.projection.sqlite") });
      process.stdout.write(`${JSON.stringify({ command: options.command, file: basename(result.path),
        sha256: result.sha256, rows: result.rows })}\n`);
    } finally {
      ingestion.close();
    }
    return;
  }
  const ledger = await openSealedSourceFromSeal(seal, "deletion-ledger");
  try {
    const result = await projectDeletionDigests({ sealedLedger: ledger,
      outputPath: join(directory, "deletion-digests.projection.txt") });
    process.stdout.write(`${JSON.stringify({ command: options.command, file: basename(result.path),
      sha256: result.sha256, count: result.count })}\n`);
  } finally {
    ledger.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof CutoverSourceError ? error.message : "CUTOVER_FAILED"}\n`);
    process.exitCode = 1;
  });
}
