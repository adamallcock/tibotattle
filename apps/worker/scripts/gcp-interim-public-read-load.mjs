#!/usr/bin/env node

/**
 * Loader for the interim frozen public read (owner decision OD-10, C-IPR).
 *
 * Until the first GCP publication, GET /api/v1/community/daily serves one
 * frozen copy of Cloudflare's production response. This script validates that
 * copy and writes it, once, to community_daily_frozen_export.
 *
 * THE EXPORT (OWN-4). The owner, read-only and immediately before the seal,
 * saves the exact response body of the production Worker's
 *   GET /api/v1/community/daily?from=<seal day minus 365 days>&to=<seal day>
 * byte for byte (the full 366-day year window the public client asks for), and
 * records four facts next to it:
 *   --sha256          the sha256 of the saved file (`shasum -a 256`), the PIN;
 *   --captured-at     the UTC instant the export was fetched;
 *   --source-commit   the production source commit that served it, from the
 *                     Worker's GET /api/health;
 *   --evidence-date   the UTC day the window ends on (the seal day), which is
 *                     the date the interim answer labels. The capture must be
 *                     on that day or the next.
 * The export is public, content-free data. No participant data export exists.
 *
 * WHEN. Take the export immediately BEFORE the Cloudflare fence: a fenced edge
 * answers every API read, this one included, with 503 MUTATION_BARRIER_ACTIVE
 * (docs/runbooks/production-edge-modes.md). The capture instant records how
 * long before the seal it was taken, and the evidence date is the day the
 * window ends on. Contributions the fence still admits after the export are
 * not in it, which is what "frozen" means here.
 *
 * MODES.
 *   check   Offline. Reads the file, enforces the pin on its exact bytes, then
 *           validates it against the closed community-daily-read-v1.0 contract
 *           (src/analytics-v2/interim-public-read.ts). Writes nothing, opens
 *           no connection. Run it on a trial export before the seal to learn
 *           early whether production's contract has moved past what the
 *           validator accepts; nothing is lost by a refusal here.
 *   load    The check, then one transaction on the target: both tables must
 *           exist, no day may be published yet, and the export is inserted once
 *           and read back through the route's own verification. Loading the
 *           identical export again changes nothing; a different one is refused.
 *           The CLI reaches only a local PostgreSQL (PG_TEST_SOCKET naming a
 *           private socket directory, /private/tmp/tibotattle-pg-<name>/socket,
 *           or a loopback PG_TEST_HOST). The production load is the PT-8-lite
 *           orchestrator calling loadInterimPublicReadInTransaction() inside its
 *           target handle's primary transaction (or loadInterimPublicRead() on
 *           a primary pool), after the import verifies and before the edge
 *           switch.
 *
 * Refused, with a closed code and never a value: a pin that is not 64 lowercase
 * hex or does not match the bytes; a file that is not a regular, non-symlink
 * file within 8 MiB; bytes that are not strict UTF-8 JSON; any key, token or
 * shape outside the contract (including the private capacityByPlanType and the
 * per-day allowance block); a window that is not the full year ending on the
 * evidence date; a day released after the capture; an unknown breakdown
 * schema version.
 *
 * Output: one content-free JSON receipt line on stdout, or one JSON error line
 * on stderr. Exit 0 on success, 2 for a usage refusal, 1 for any other failure.
 *
 *   node scripts/gcp-interim-public-read-load.mjs check --export <file> \
 *     --sha256 <hex> --captured-at <ISO> --source-commit <40-hex> --evidence-date <YYYY-MM-DD>
 *   node scripts/gcp-interim-public-read-load.mjs load <the same flags> --schema <identifier>
 */

import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INTERIM_PUBLIC_READ_MAX_BYTES,
  INTERIM_PUBLIC_READ_ROW_ID,
  INTERIM_PUBLIC_READ_TABLE,
  InterimPublicReadError,
  prepareInterimPublicRead,
  verifyInterimPublicReadRow,
} from "../src/analytics-v2/interim-public-read.ts";

export const GCP_INTERIM_PUBLIC_READ_LOAD_RECEIPT_SCHEMA = "tibotattle-gcp-interim-public-read-load-v1";

export const GCP_INTERIM_PUBLIC_READ_LOAD_ERROR_CODES = Object.freeze([
  "INTERIM_PUBLIC_READ_LOAD_USAGE",
  "INTERIM_PUBLIC_READ_LOAD_EXPORT_FILE_INVALID",
  "INTERIM_PUBLIC_READ_LOAD_SCHEMA_INVALID",
  "INTERIM_PUBLIC_READ_LOAD_TARGET_UNCONFIGURED",
  "INTERIM_PUBLIC_READ_LOAD_TARGET_UNSUPPORTED",
  "INTERIM_PUBLIC_READ_LOAD_TABLE_MISSING",
  "INTERIM_PUBLIC_READ_LOAD_PUBLICATION_EXISTS",
  "INTERIM_PUBLIC_READ_LOAD_ALREADY_LOADED_DIFFERENT",
  "INTERIM_PUBLIC_READ_LOAD_READBACK_MISMATCH",
  "INTERIM_PUBLIC_READ_LOAD_WRITE_FAILED",
]);

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/u;
const PUBLISHED_TABLE = "analytics_v2_published_daily";
const PRIVATE_SOCKET_DIRECTORY = /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SQLSTATE = /^[0-9A-Z]{5}$/u;
const STATEMENT_TIMEOUT = "30s";
const LOCK_TIMEOUT = "5s";

const FLAGS = Object.freeze({
  "--export": "exportPath",
  "--sha256": "sha256",
  "--captured-at": "capturedAt",
  "--source-commit": "sourceCommit",
  "--evidence-date": "evidenceDate",
  "--schema": "schema",
});

export class GcpInterimPublicReadLoadError extends Error {
  constructor(code, detail = null) {
    super(detail === null ? code : `${code}: ${detail}`);
    this.name = "GcpInterimPublicReadLoadError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = null) {
  throw new GcpInterimPublicReadLoadError(code, detail);
}

function quoteIdentifier(name) {
  return `"${name}"`;
}

function assertSchema(schema) {
  if (typeof schema !== "string" || !SCHEMA_PATTERN.test(schema)) fail("INTERIM_PUBLIC_READ_LOAD_SCHEMA_INVALID");
  return schema;
}

// ---------------------------------------------------------------------------
// The export file
// ---------------------------------------------------------------------------

/**
 * Read the export's exact bytes: a regular file, never a symbolic link, no
 * larger than the export limit (checked before the read and again after it).
 */
export async function readInterimExportFile(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    fail("INTERIM_PUBLIC_READ_LOAD_EXPORT_FILE_INVALID");
  }
  const absolute = resolve(path);
  let bytes;
  try {
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > INTERIM_PUBLIC_READ_MAX_BYTES) {
      fail("INTERIM_PUBLIC_READ_LOAD_EXPORT_FILE_INVALID");
    }
    bytes = await readFile(absolute);
  } catch (error) {
    if (error instanceof GcpInterimPublicReadLoadError) throw error;
    return fail("INTERIM_PUBLIC_READ_LOAD_EXPORT_FILE_INVALID");
  }
  if (bytes.byteLength > INTERIM_PUBLIC_READ_MAX_BYTES) fail("INTERIM_PUBLIC_READ_LOAD_EXPORT_FILE_INVALID");
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// ---------------------------------------------------------------------------
// Check and load
// ---------------------------------------------------------------------------

function receiptFor(mode, prepared, extra = {}) {
  const { record, summary } = prepared;
  return Object.freeze({
    schema: GCP_INTERIM_PUBLIC_READ_LOAD_RECEIPT_SCHEMA,
    mode,
    payloadSha256: record.payloadSha256,
    capturedAt: record.capturedAt,
    sourceCommit: record.sourceCommit,
    evidenceDate: record.evidenceDate,
    export: Object.freeze({ ...summary }),
    ...extra,
  });
}

/** Validate an export against its pin and the contract. Reads nothing else, writes nothing. */
export async function checkInterimPublicRead({ exportBytes, sha256, capturedAt, sourceCommit, evidenceDate }) {
  const prepared = await prepareInterimPublicRead({
    exportBytes, expectedSha256: sha256, capturedAt, sourceCommit, evidenceDate,
  });
  return { prepared, receipt: receiptFor("check", prepared) };
}

const STORED_ROW_SQL = (schema) => `SELECT f.payload_text::text AS payload_text,
       f.payload_sha256::text AS payload_sha256,
       to_char(f.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at,
       f.source_commit::text AS source_commit,
       to_char(f.evidence_date, 'YYYY-MM-DD') AS evidence_date
  FROM ${quoteIdentifier(schema)}.${quoteIdentifier(INTERIM_PUBLIC_READ_TABLE)} f
 WHERE f.id = ${INTERIM_PUBLIC_READ_ROW_ID}`;

function sameRecord(left, right) {
  return left.payloadText === right.payloadText
    && left.payloadSha256 === right.payloadSha256
    && left.capturedAt === right.capturedAt
    && left.sourceCommit === right.sourceCommit
    && left.evidenceDate === right.evidenceDate;
}

function assertLoadInputs(schema, prepared) {
  assertSchema(schema);
  if (prepared === null || typeof prepared !== "object" || prepared.record === undefined) {
    fail("INTERIM_PUBLIC_READ_LOAD_USAGE");
  }
  return prepared.record;
}

/**
 * The load's statements, inside a transaction the CALLER owns (BEGIN, the
 * timeouts and COMMIT or ROLLBACK are the caller's): both relations exist; no
 * day is published (the first publication ends the interim read, so a load
 * after it would store a row nothing serves); the row is inserted, a
 * conflicting row being compared and never replaced; the row is read back
 * through verifyInterimPublicReadRow, the route's own verification, and must
 * equal what was prepared. Throws on any refusal and leaves the rollback to
 * the caller. This is the entrypoint the PT-8-lite orchestrator composes
 * inside its target handle's primary transaction (withTransferTransaction).
 *
 * Returns the receipt; its `state` is `loaded` or `already-loaded` (the
 * identical export and facts were already there, and nothing was written).
 */
export async function loadInterimPublicReadInTransaction({ client, schema, prepared }) {
  const record = assertLoadInputs(schema, prepared);
  if (client === null || typeof client !== "object" || typeof client.query !== "function") {
    fail("INTERIM_PUBLIC_READ_LOAD_USAGE");
  }
  const frozenTable = `${quoteIdentifier(schema)}.${quoteIdentifier(INTERIM_PUBLIC_READ_TABLE)}`;
  const publishedTable = `${quoteIdentifier(schema)}.${quoteIdentifier(PUBLISHED_TABLE)}`;
  const tables = await client.query(
    "SELECT to_regclass($1) IS NOT NULL AS frozen, to_regclass($2) IS NOT NULL AS published",
    [frozenTable, publishedTable],
  );
  if (tables.rows[0]?.frozen !== true || tables.rows[0]?.published !== true) {
    fail("INTERIM_PUBLIC_READ_LOAD_TABLE_MISSING");
  }
  const publication = await client.query(`SELECT EXISTS (SELECT 1 FROM ${publishedTable}) AS published`);
  if (publication.rows[0]?.published !== false) fail("INTERIM_PUBLIC_READ_LOAD_PUBLICATION_EXISTS");
  const inserted = await client.query(
    `INSERT INTO ${frozenTable}
       (id, payload_text, payload_sha256, captured_at, source_commit, evidence_date)
     VALUES (${INTERIM_PUBLIC_READ_ROW_ID}, $1, $2, $3::timestamptz, $4, $5::date)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [record.payloadText, record.payloadSha256, record.capturedAt, record.sourceCommit, record.evidenceDate],
  );
  const wrote = inserted.rowCount === 1;
  const stored = await client.query(STORED_ROW_SQL(schema));
  // A row that was already there and does not verify is as different as one
  // that verifies to another export.
  const differs = wrote
    ? () => fail("INTERIM_PUBLIC_READ_LOAD_READBACK_MISMATCH")
    : (digest) => fail("INTERIM_PUBLIC_READ_LOAD_ALREADY_LOADED_DIFFERENT", digest);
  let verified;
  try {
    verified = await verifyInterimPublicReadRow(stored.rows[0]);
  } catch {
    return differs(null);
  }
  if (!sameRecord(verified.record, record)) differs(verified.record.payloadSha256);
  return receiptFor("load", prepared, { state: wrote ? "loaded" : "already-loaded" });
}

/**
 * Write a prepared export to the frozen table, once, in one bounded
 * transaction of its own on `pool` (see loadInterimPublicReadInTransaction for
 * the statements). Any failure rolls the whole transaction back; the
 * connection is discarded when it failed mid-transaction.
 */
export async function loadInterimPublicRead({ pool, schema, prepared }) {
  assertLoadInputs(schema, prepared);
  if (pool === null || typeof pool !== "object" || typeof pool.connect !== "function") {
    fail("INTERIM_PUBLIC_READ_LOAD_USAGE");
  }
  let client;
  try {
    client = await pool.connect();
  } catch {
    return fail("INTERIM_PUBLIC_READ_LOAD_WRITE_FAILED", "connect");
  }
  let open = false;
  let discard = false;
  try {
    await client.query("BEGIN");
    open = true;
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    const receipt = await loadInterimPublicReadInTransaction({ client, schema, prepared });
    await client.query("COMMIT");
    open = false;
    return receipt;
  } catch (error) {
    if (open) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
    }
    if (error instanceof GcpInterimPublicReadLoadError || error instanceof InterimPublicReadError) throw error;
    discard = true;
    const sqlstate = typeof error?.code === "string" && SQLSTATE.test(error.code) ? error.code : null;
    return fail("INTERIM_PUBLIC_READ_LOAD_WRITE_FAILED", sqlstate);
  } finally {
    try {
      client.release(discard || undefined);
    } catch {
      // The connection is gone either way.
    }
  }
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const USAGE = `usage: gcp-interim-public-read-load.mjs <check|load> --export <file> --sha256 <hex>
         --captured-at <ISO instant> --source-commit <40-hex> --evidence-date <YYYY-MM-DD>
         [--schema <identifier>]   (load only)
`;

/** Parse argv (after the command) into the closed flag set. Unknown, repeated or valueless flags are refused. */
export function parseInterimLoadArguments(argv) {
  if (!Array.isArray(argv) || argv.length === 0) fail("INTERIM_PUBLIC_READ_LOAD_USAGE");
  const [command, ...rest] = argv;
  if (command !== "check" && command !== "load") fail("INTERIM_PUBLIC_READ_LOAD_USAGE");
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (typeof token !== "string" || !token.startsWith("--")) fail("INTERIM_PUBLIC_READ_LOAD_USAGE");
    const equals = token.indexOf("=");
    const flag = equals === -1 ? token : token.slice(0, equals);
    const key = Object.hasOwn(FLAGS, flag) ? FLAGS[flag] : undefined;
    if (key === undefined || Object.hasOwn(options, key)) fail("INTERIM_PUBLIC_READ_LOAD_USAGE");
    let value;
    if (equals !== -1) {
      value = token.slice(equals + 1);
    } else {
      index += 1;
      value = rest[index];
    }
    if (typeof value !== "string" || value.length === 0) fail("INTERIM_PUBLIC_READ_LOAD_USAGE");
    options[key] = value;
  }
  for (const required of ["exportPath", "sha256", "capturedAt", "sourceCommit", "evidenceDate"]) {
    if (options[required] === undefined) fail("INTERIM_PUBLIC_READ_LOAD_USAGE");
  }
  if (command === "load" ? options.schema === undefined : options.schema !== undefined) {
    fail("INTERIM_PUBLIC_READ_LOAD_USAGE");
  }
  return Object.freeze({ command, ...options });
}

async function privateSocketDirectory(directory) {
  if (!PRIVATE_SOCKET_DIRECTORY.test(directory)) fail("INTERIM_PUBLIC_READ_LOAD_TARGET_UNSUPPORTED");
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch {
    return fail("INTERIM_PUBLIC_READ_LOAD_TARGET_UNSUPPORTED");
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || (metadata.mode & 0o077) !== 0
      || metadata.uid !== process.getuid()) {
    fail("INTERIM_PUBLIC_READ_LOAD_TARGET_UNSUPPORTED");
  }
  return directory;
}

/** The local PostgreSQL this CLI may write to. Anything else is refused: production loads through PT-8-lite. */
export async function localInterimTarget(env) {
  const socket = env.PG_TEST_SOCKET || undefined;
  const host = env.PG_TEST_HOST || undefined;
  if (socket === undefined && host === undefined) fail("INTERIM_PUBLIC_READ_LOAD_TARGET_UNCONFIGURED");
  const port = Number(env.PG_TEST_PORT ?? "55432");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) fail("INTERIM_PUBLIC_READ_LOAD_TARGET_UNSUPPORTED");
  let target;
  if (socket !== undefined) target = await privateSocketDirectory(socket);
  else if (LOOPBACK_HOSTS.has(host)) target = host;
  else target = await privateSocketDirectory(host);
  return Object.freeze({
    host: target,
    port,
    user: env.PG_TEST_USER || "postgres",
    database: env.PG_TEST_DATABASE || "postgres",
    ...(env.PG_TEST_PASSWORD ? { password: env.PG_TEST_PASSWORD } : {}),
  });
}

async function defaultCreatePool(target) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    ...target,
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    application_name: "tibotattle-interim-public-read-load",
  });
  pool.on("error", () => {});
  return pool;
}

/**
 * Run the command line. Returns the exit code; writes one JSON line to stdout
 * or to stderr. `createPool` is a test seam: it receives the validated local
 * target and returns a pg-like pool.
 */
export async function runInterimPublicReadLoad(argv, {
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  createPool = defaultCreatePool,
} = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write(USAGE);
    return 0;
  }
  let pool = null;
  try {
    const options = parseInterimLoadArguments(argv);
    const exportBytes = await readInterimExportFile(options.exportPath);
    const { prepared, receipt } = await checkInterimPublicRead({
      exportBytes,
      sha256: options.sha256,
      capturedAt: options.capturedAt,
      sourceCommit: options.sourceCommit,
      evidenceDate: options.evidenceDate,
    });
    if (options.command === "check") {
      stdout.write(`${JSON.stringify(receipt)}\n`);
      return 0;
    }
    assertSchema(options.schema);
    pool = await createPool(await localInterimTarget(env));
    const loaded = await loadInterimPublicRead({ pool, schema: options.schema, prepared });
    stdout.write(`${JSON.stringify(loaded)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof GcpInterimPublicReadLoadError || error instanceof InterimPublicReadError
      ? error.code : "INTERIM_PUBLIC_READ_LOAD_WRITE_FAILED";
    const detail = (error instanceof GcpInterimPublicReadLoadError || error instanceof InterimPublicReadError)
      ? error.detail : null;
    stderr.write(`${JSON.stringify({ error: { code, ...(detail === null ? {} : { detail }) } })}\n`);
    return code === "INTERIM_PUBLIC_READ_LOAD_USAGE" ? 2 : 1;
  } finally {
    if (pool !== null) {
      try {
        await pool.end();
      } catch {
        // Closing is best effort.
      }
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runInterimPublicReadLoad(process.argv.slice(2));
}
