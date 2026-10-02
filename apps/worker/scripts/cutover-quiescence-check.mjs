#!/usr/bin/env node
// E-QUIESCE: the read-only pre-fence quiescence check for the GCP cutover.
//
// The seal (cutover-source-seal.mjs) and the identity importer PT-3
// (postgres-identity-authority-transfer.mjs) run inside the outage window,
// after the EP-8 writer fence. Anything either of them refuses there costs
// another fence, release and re-seal cycle. This script reports, before the
// fence, the participants and objects that would make them refuse:
//
//   participants-quiescent           participants that are not 'active' or
//                                    still carry a deletion_session_id: PT-3's
//                                    CUTOVER_PARTICIPANT_ERASURE_PENDING.
//   deletion-digest-intersection     participants whose deletion digest is a
//                                    recorded tombstone: PT-2-lite's and PT-3's
//                                    CUTOVER_ERASED_PARTICIPANT_PRESENT.
//   owner-links-erased               v1.1 owner links already marked erased:
//                                    PT-8's erasure quiescence (specified,
//                                    not yet built).
//   pending-quarantine-registrations pending_quarantine_objects rows: the PT-4
//                                    / PT-8 mapping or emptiness proof
//                                    (specified, not yet built).
//   correction-runtime               the telemetry_usage_correction_runtime
//                                    row and the correction facts: PT-8's
//                                    CUTOVER_CORRECTION_RUNTIME_ACTIVE
//                                    (specified, not yet built).
//   pending-erasure-jobs             unfinished storage_erasure_jobs in the
//                                    deletion ledger: PT-8's pending jobs and
//                                    HX-6's pendingErasureJobs drain check
//                                    (specified, not yet built).
//   analytics-delivery               the analytics delivery cursor against the
//                                    ingestion journal maximum: HX-6's
//                                    cursorEqualsJournalMax drain check and
//                                    the operator's --analytics-drain-complete
//                                    attestation to EP-8.
//
// The first two use the code the seal and PT-3 use, not a copy of it: the
// participant predicate is imported from PT-3 (PARTICIPANT_*_PREDICATE) and the
// tombstone read and the intersection loop from the projections module
// (readDeletionDigestsFromDatabase, countParticipantDeletionMatches). The
// others implement the PT-8, PT-4 and HX-6 briefs; each check says whether its
// refusal exists in code yet (refusals[].implemented). A check whose input is
// absent is 'not-evaluated', never clear: missing evidence is not zero.
//
// Modes (nothing here writes any database, contacts a provider or spawns
// Wrangler):
//
//   check     reads local SQLite files with node:sqlite, read-only:
//               --seal <manifest> --seal-id <sha256>   the sealed ingestion and
//                                                      deletion-ledger files of
//                                                      a seal, opened and
//                                                      hash-verified exactly as
//                                                      PT-3 opens them; or
//               --ingestion <file> [--ledger <file>]   exported D1 SQLite files;
//               --analytics <file>                     an exported analytics D1.
//             It also derives opaque references (refs) for the offending rows.
//   queries   prints the read-only statements, one SELECT per role, that
//             `check` runs; every one passes the seal transport's
//             SELECT-only guard (assertSelectOnly).
//   evaluate  turns the saved output of those statements into the same
//             report: --ingestion-result, --ledger-result, --analytics-result
//             name files holding `wrangler d1 execute --json` output. The
//             deletion-digest intersection and the refs need local hashing and
//             local rows, so this mode reports that check as not-evaluated.
//
// Owner-run read-only Wrangler mode (documented only; this script never runs
// Wrangler). From apps/worker, with the owner's own read-only credentials in
// the environment (never on a command line) and the production database
// names, once per role:
//
//   node scripts/cutover-quiescence-check.mjs queries --role ingestion --sql
//   npx wrangler d1 execute <ingestion-database-name> --config <a wrangler config naming it> \
//     --remote --json \
//     --command "$(node scripts/cutover-quiescence-check.mjs queries --role ingestion --sql)" \
//     > ingestion-result.json
//
// and likewise `--role deletion-ledger` and `--role analytics`. Each statement
// is a single SELECT of about twenty UNION ALL arms. Whether D1 accepts a
// compound SELECT that size has not been verified against the provider: if it
// refuses, split the statement at any UNION ALL (every arm names its own c, k
// and v columns), run the parts, and merge their outputs into one JSON array
// (jq -s add part-1.json part-2.json) before `evaluate`. Then:
//
//   node scripts/cutover-quiescence-check.mjs evaluate --ingestion-result ingestion-result.json \
//     --ledger-result ledger-result.json --analytics-result analytics-result.json
//
// Output is content free: counts, closed state names, one timestamp, and
// opaque 16-hex references (a purpose-separated sha256 prefix of an id, never
// the id or a ledger digest). No participant id, tombstone digest, source id,
// object key, path or secret is printed. Exit status: 0 quiescent, 2 blocked,
// 3 incomplete (nothing blocks, something was not evaluated), 1 an error.
//
// A live source is rarely quiescent: in-flight uploads register quarantine
// objects and the delivery cursor lags the journal. Run it before the fence to
// find mid-erasure participants and unfinished erasure jobs (the items an
// owner must finish on Cloudflare), and again on the sealed source.

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  CutoverSourceError,
  assertSelectOnly,
  openSealedSourceFromSeal,
  readCutoverSeal,
  sha256File,
  sha256Hex,
} from "./cutover-source-seal.mjs";
import {
  CUTOVER_PARTICIPANT_STATES,
  countParticipantDeletionMatches,
  readDeletionDigestsFromDatabase,
} from "./cutover-source-projections.mjs";
import {
  PARTICIPANT_DELETION_FENCED_PREDICATE,
  PARTICIPANT_NOT_ACTIVE_PREDICATE,
  PARTICIPANT_NOT_QUIESCENT_PREDICATE,
} from "./postgres-identity-authority-transfer.mjs";

export const CUTOVER_QUIESCENCE_REPORT_SCHEMA = "tibotattle-cutover-quiescence-report-v1";
export const CUTOVER_QUIESCENCE_QUERIES_SCHEMA = "tibotattle-cutover-quiescence-queries-v1";
export const QUIESCENCE_SOURCE_ROLES = Object.freeze(["ingestion", "deletion-ledger", "analytics"]);
/** PT-8: the correction runtime must be staged (and hold no facts) for the transfer. */
export const CORRECTION_RUNTIME_STAGED_STATE = "staged";
/** At most this many opaque references are listed per check. */
export const QUIESCENCE_MAX_REFS = 25;

export const QUIESCENCE_ERROR_CODES = Object.freeze([
  "QUIESCENCE_ARGUMENT_INVALID",
  "QUIESCENCE_FACT_DUPLICATE",
  "QUIESCENCE_FACT_INCONSISTENT",
  "QUIESCENCE_FACT_INVALID",
  "QUIESCENCE_FACT_MISSING",
  "QUIESCENCE_FACT_UNKNOWN",
  "QUIESCENCE_RESULT_FILE_UNSAFE",
  "QUIESCENCE_RESULT_INVALID",
  "QUIESCENCE_SOURCE_CHANGED",
  "QUIESCENCE_SOURCE_QUERY_FAILED",
  "QUIESCENCE_SOURCE_UNSAFE",
]);
const ERROR_CODES = new Set(QUIESCENCE_ERROR_CODES);
const SAFE_DETAIL = /^[a-z][a-z0-9_-]{0,63}$/u;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const SOURCE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const STATE_NAME = /^[a-z][a-z_]{0,31}$/u;
const INSTANT_TEXT = /^[0-9TZ:. +-]{1,40}$/u;
const REF_DOMAIN = "tibotattle/e-quiesce/ref/v1\0";
const MAX_FACT_ROWS = 512;
const MAX_CURSOR_ROWS = 64;
const MAX_RESULT_PARTS = 8;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_SQLITE_BYTES = 100 * 1024 * 1024 * 1024;

export class QuiescenceCheckError extends Error {
  constructor(code, details = undefined) {
    const safe = {};
    if (details && typeof details === "object") {
      if (typeof details.role === "string" && QUIESCENCE_SOURCE_ROLES.includes(details.role)) safe.role = details.role;
      if (typeof details.table === "string" && IDENTIFIER.test(details.table)) safe.table = details.table;
      if (typeof details.check === "string" && SAFE_DETAIL.test(details.check)) safe.check = details.check;
    }
    const suffix = Object.entries(safe).map(([key, value]) => `${key}=${value}`).join(" ");
    super(suffix ? `${code} [${suffix}]` : code);
    this.name = "QuiescenceCheckError";
    this.code = ERROR_CODES.has(code) ? code : "QUIESCENCE_ARGUMENT_INVALID";
    Object.assign(this, safe);
  }
}

function fail(code, details = undefined) {
  throw new QuiescenceCheckError(ERROR_CODES.has(code) ? code : "QUIESCENCE_ARGUMENT_INVALID", details);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A one-way, purpose-separated 16-hex reference to an id; never the id, never a ledger digest. */
export function opaqueRef(kind, value) {
  if (typeof kind !== "string" || !/^[a-z-]{1,40}$/u.test(kind) || typeof value !== "string" || value.length === 0) {
    fail("QUIESCENCE_ARGUMENT_INVALID");
  }
  return createHash("sha256").update(`${REF_DOMAIN}${kind}\0${value}`).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// The statements: one SELECT per role, a UNION ALL of (c, k, v) facts. A single
// statement is one snapshot of the source, and one statement is all an owner has
// to run by hand. A table that is absent fails the whole statement (fail loud).

const PARTICIPANT_STATE_LIST = CUTOVER_PARTICIPANT_STATES.map(state => `'${state}'`).join(", ");

// Every arm names its columns, so any part cut at a UNION ALL is a statement of its own.
function selectArm(c, k, value, from) {
  return `SELECT ${c} AS c, ${k} AS k, ${value} AS v${from === "" ? "" : ` ${from}`}`;
}

/** [c, k, type, SQL after SELECT 'c', 'k', ...]: the closed static fact set of a role. */
const INGESTION_FACTS = Object.freeze([
  ["participants", "total", "count", "count(*)", "FROM participants"],
  ["participants", "not_quiescent", "count", "count(*)", `FROM participants WHERE ${PARTICIPANT_NOT_QUIESCENT_PREDICATE}`],
  ["participants", "not_active", "count", "count(*)", `FROM participants WHERE ${PARTICIPANT_NOT_ACTIVE_PREDICATE}`],
  ["participants", "deleting", "count", "count(*)", "FROM participants WHERE state = 'deleting'"],
  ["participants", "deletion_fenced", "count", "count(*)", `FROM participants WHERE ${PARTICIPANT_DELETION_FENCED_PREDICATE}`],
  ["participants", "state_unrecognized", "count", "count(*)",
    `FROM participants WHERE state NOT IN (${PARTICIPANT_STATE_LIST})`],
  ["owner_links", "total", "count", "count(*)", "FROM storage_v11_owner_links"],
  ["owner_links", "erased", "count", "count(*)", "FROM storage_v11_owner_links WHERE state = 'erased'"],
  ["owner_links", "withdrawn", "count", "count(*)", "FROM storage_v11_owner_links WHERE state = 'withdrawn'"],
  ["quarantine", "total", "count", "count(*)", "FROM pending_quarantine_objects"],
  ["quarantine", "registered", "count", "count(*)",
    "FROM pending_quarantine_objects WHERE reconciliation_state = 'registered'"],
  ["quarantine", "deleting", "count", "count(*)",
    "FROM pending_quarantine_objects WHERE reconciliation_state = 'deleting'"],
  ["quarantine", "oldest_registered_at", "instant", "min(registered_at)", "FROM pending_quarantine_objects"],
  ["correction", "runtime_rows", "count", "count(*)", "FROM telemetry_usage_correction_runtime"],
  ["correction", "runtime_state", "state", "(SELECT state FROM telemetry_usage_correction_runtime WHERE id = 1)", ""],
  ["correction", "facts", "count", "count(*)", "FROM telemetry_usage_correction_facts"],
  ["correction", "history", "count", "count(*)", "FROM telemetry_usage_correction_history"],
]);
const INGESTION_DYNAMIC = Object.freeze([
  // The journal head of the (singleton) ingestion source: k is its opaque source id.
  ["journal", "source_id",
    "COALESCE((SELECT max(sequence) FROM storage_ingestion_changes), 0)", "FROM storage_source_state"],
]);
const LEDGER_FACTS = Object.freeze([
  ["erasure_jobs", "total", "count", "count(*)", "FROM storage_erasure_jobs"],
  ["erasure_jobs", "pending", "count", "count(*)", "FROM storage_erasure_jobs WHERE state = 'pending'"],
  ["erasure_jobs", "complete", "count", "count(*)", "FROM storage_erasure_jobs WHERE state = 'complete'"],
  ["erasure_jobs", "pending_participants", "count", "count(DISTINCT participant_digest)",
    "FROM storage_erasure_jobs WHERE state = 'pending'"],
  ["tombstones", "total", "count", "count(*)", "FROM deletion_tombstones"],
]);
const ANALYTICS_FACTS = Object.freeze([
  ["delivery", "cursor_rows", "count", "count(*)", "FROM analytics_source_cursors"],
]);
const ANALYTICS_DYNAMIC = Object.freeze([
  ["delivery_cursor", "source_id", "sequence",
    `FROM (SELECT source_id, sequence FROM analytics_source_cursors ORDER BY source_id LIMIT ${MAX_CURSOR_ROWS + 1})`],
]);

const ROLE_DEFINITIONS = Object.freeze({
  ingestion: Object.freeze({ facts: INGESTION_FACTS, dynamic: INGESTION_DYNAMIC }),
  "deletion-ledger": Object.freeze({ facts: LEDGER_FACTS, dynamic: Object.freeze([]) }),
  analytics: Object.freeze({ facts: ANALYTICS_FACTS, dynamic: ANALYTICS_DYNAMIC }),
});

function buildStatement(role) {
  const { facts, dynamic } = ROLE_DEFINITIONS[role];
  const arms = [];
  for (const [c, k, , value, from] of facts) arms.push(selectArm(`'${c}'`, `'${k}'`, value, from));
  for (const [c, keyColumn, value, from] of dynamic) arms.push(selectArm(`'${c}'`, keyColumn, value, from));
  return assertSelectOnly(arms.join("\nUNION ALL "));
}

/** The read-only statement a role runs, one SELECT (the seal transport's SELECT-only guard holds). */
export const QUIESCENCE_STATEMENTS = Object.freeze(Object.fromEntries(QUIESCENCE_SOURCE_ROLES
  .map(role => [role, buildStatement(role)])));

// ---------------------------------------------------------------------------
// Facts: the closed, typed rows a statement returns.

function coerceFact(type, value, context) {
  if (type === "count") {
    const number = typeof value === "bigint" ? (value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : -1)
      : value;
    if (!Number.isSafeInteger(number) || number < 0) fail("QUIESCENCE_FACT_INVALID", context);
    return number;
  }
  if (value === null) return null;
  if (type === "state" && typeof value === "string" && STATE_NAME.test(value)) return value;
  if (type === "instant" && typeof value === "string" && INSTANT_TEXT.test(value)) return value;
  return fail("QUIESCENCE_FACT_INVALID", context);
}

/**
 * Normalise a role's fact rows into a closed set. Every static fact must be
 * present exactly once; an unknown fact, a duplicate, a wrong type or a value
 * outside its closed form refuses. Nothing is defaulted: a missing fact is
 * QUIESCENCE_FACT_MISSING, never zero.
 */
export function normalizeQuiescenceFacts(role, rows) {
  if (!Object.hasOwn(ROLE_DEFINITIONS, role)) fail("QUIESCENCE_ARGUMENT_INVALID");
  const context = { role };
  if (!Array.isArray(rows) || rows.length > MAX_FACT_ROWS) fail("QUIESCENCE_FACT_INVALID", context);
  const { facts, dynamic } = ROLE_DEFINITIONS[role];
  const staticByKey = new Map(facts.map(([c, k, type]) => [`${c}/${k}`, { c, type }]));
  const families = new Map(dynamic.map(([c]) => [c, new Map()]));
  const values = new Map();
  for (const row of rows) {
    if (!record(row) || Object.keys(row).sort().join(",") !== "c,k,v" || typeof row.c !== "string"
        || typeof row.k !== "string") {
      fail("QUIESCENCE_FACT_INVALID", context);
    }
    const key = `${row.c}/${row.k}`;
    const definition = staticByKey.get(key);
    if (definition !== undefined) {
      if (values.has(key)) fail("QUIESCENCE_FACT_DUPLICATE", { role, check: SAFE_DETAIL.test(row.c) ? row.c : undefined });
      values.set(key, coerceFact(definition.type, row.v, { role, check: row.c }));
      continue;
    }
    const family = families.get(row.c);
    if (family === undefined) fail("QUIESCENCE_FACT_UNKNOWN", context);
    if (!SOURCE_ID.test(row.k)) fail("QUIESCENCE_FACT_INVALID", { role, check: row.c });
    if (family.has(row.k)) fail("QUIESCENCE_FACT_DUPLICATE", { role, check: row.c });
    if (family.size >= MAX_CURSOR_ROWS) fail("QUIESCENCE_FACT_INVALID", { role, check: row.c });
    family.set(row.k, coerceFact("count", row.v, { role, check: row.c }));
  }
  for (const [c, k] of facts) {
    if (!values.has(`${c}/${k}`)) fail("QUIESCENCE_FACT_MISSING", { role, check: c });
  }
  const normalized = Object.freeze({
    role,
    get: (c, k) => values.get(`${c}/${k}`),
    family: (c) => families.get(c),
  });
  assertFactsConsistent(normalized);
  return normalized;
}

/** Relations that hold by the schema's own CHECK constraints; a violation is a tampered or truncated result. */
function assertFactsConsistent(facts) {
  const get = facts.get;
  const need = (condition) => {
    if (!condition) fail("QUIESCENCE_FACT_INCONSISTENT", { role: facts.role });
  };
  if (facts.role === "ingestion") {
    // not_quiescent is the union of the two PT-3 disjuncts, not_active and deletion_fenced.
    const notQuiescent = get("participants", "not_quiescent");
    const notActive = get("participants", "not_active");
    const fenced = get("participants", "deletion_fenced");
    need(get("participants", "total") >= notQuiescent);
    need(notQuiescent >= notActive && notQuiescent >= fenced && notQuiescent <= notActive + fenced);
    need(notActive >= get("participants", "deleting") + get("participants", "state_unrecognized"));
    need(get("owner_links", "total") >= get("owner_links", "erased") + get("owner_links", "withdrawn"));
    need(get("quarantine", "total") === get("quarantine", "registered") + get("quarantine", "deleting"));
    need((get("quarantine", "total") === 0) === (get("quarantine", "oldest_registered_at") === null));
    const rows = get("correction", "runtime_rows");
    need(rows <= 1 && (rows === 1) === (get("correction", "runtime_state") !== null));
  } else if (facts.role === "deletion-ledger") {
    need(get("erasure_jobs", "total") === get("erasure_jobs", "pending") + get("erasure_jobs", "complete"));
    need(get("erasure_jobs", "pending") >= get("erasure_jobs", "pending_participants")
      && (get("erasure_jobs", "pending") === 0) === (get("erasure_jobs", "pending_participants") === 0));
  } else {
    need(get("delivery", "cursor_rows") === facts.family("delivery_cursor").size);
  }
}

// ---------------------------------------------------------------------------
// Reading facts: from a local SQLite file, or from saved `wrangler d1 execute --json` output.

function readStatement(database, sql, role) {
  try {
    const statement = database.prepare(sql);
    statement.setReadBigInts(true);
    return statement.all().map(row => ({ ...row }));
  } catch (error) {
    const table = /no such table: ([A-Za-z_][A-Za-z0-9_]{0,127})/u.exec(String(error?.message ?? ""))?.[1];
    return fail("QUIESCENCE_SOURCE_QUERY_FAILED", { role, table });
  }
}

/** Run a role's statement on an open SQLite database (read-only) and normalise its facts. */
export function readQuiescenceFacts(role, database) {
  return normalizeQuiescenceFacts(role, readStatement(database, QUIESCENCE_STATEMENTS[role], role));
}

/**
 * Parse the saved output of `wrangler d1 execute <db> --remote --json
 * --command "<statement>"`: the envelope the seal's transport accepts (a
 * result with success true and a results array). Up to eight results are
 * accepted and their rows concatenated, so an owner whose D1 refuses the
 * statement as one compound SELECT can run it in parts (split at a UNION ALL)
 * and merge the outputs; every fact is still required exactly once.
 */
export function parseWranglerQuiescenceResult(role, text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("QUIESCENCE_RESULT_INVALID", { role });
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_RESULT_PARTS
      || parsed.some(part => !record(part) || part.success !== true || !Array.isArray(part.results))) {
    fail("QUIESCENCE_RESULT_INVALID", { role });
  }
  return normalizeQuiescenceFacts(role, parsed.flatMap(part => part.results));
}

// ---------------------------------------------------------------------------
// Opening sources.

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return fail("QUIESCENCE_SOURCE_UNSAFE");
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

/**
 * Open an exported (or sealed) D1 SQLite file read-only: a regular file that
 * is not a symbolic link, with no journal beside it, hashed before it is read
 * and re-checked after (QUIESCENCE_SOURCE_CHANGED). The path is never reported.
 */
export async function openExportedSqlite(path, role) {
  let info;
  let canonical;
  try {
    if (typeof path !== "string" || path.length === 0 || path.includes("\0")) fail("QUIESCENCE_SOURCE_UNSAFE", { role });
    info = await lstat(resolve(path));
    canonical = await realpath(resolve(path));
  } catch (error) {
    if (error instanceof QuiescenceCheckError) throw error;
    return fail("QUIESCENCE_SOURCE_UNSAFE", { role });
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_SQLITE_BYTES) {
    fail("QUIESCENCE_SOURCE_UNSAFE", { role });
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (await exists(`${canonical}${suffix}`)) fail("QUIESCENCE_SOURCE_UNSAFE", { role });
  }
  const sha256 = await sha256File(canonical);
  let database;
  try {
    database = new DatabaseSync(canonical, { readOnly: true, allowExtension: false });
    database.exec("PRAGMA query_only=ON");
    if (database.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal") fail("QUIESCENCE_SOURCE_UNSAFE", { role });
  } catch (error) {
    database?.close();
    if (error instanceof QuiescenceCheckError) throw error;
    return fail("QUIESCENCE_SOURCE_UNSAFE", { role });
  }
  let closed = false;
  return Object.freeze({
    role,
    kind: "exported",
    sha256,
    database: () => database,
    async verify() {
      let now;
      try {
        now = await lstat(canonical);
      } catch {
        return fail("QUIESCENCE_SOURCE_CHANGED", { role });
      }
      if (!sameFile(info, now)) fail("QUIESCENCE_SOURCE_CHANGED", { role });
    },
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  });
}

function wrapSealedSource(role, sealed, sealId) {
  return Object.freeze({
    role,
    kind: "sealed",
    sealId,
    sha256: sealed.sha256,
    database: () => sealed.database(),
    verify: () => sealed.verify(),
    close: () => sealed.close(),
  });
}

/** A result file of owner-run Wrangler output: a regular, small, non-symlink file. */
export async function readQuiescenceResultFile(path, role) {
  let handle;
  try {
    if (typeof path !== "string" || path.length === 0 || path.includes("\0")) fail("QUIESCENCE_RESULT_FILE_UNSAFE", { role });
    const absolute = resolve(path);
    const before = await lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > MAX_RESULT_BYTES) {
      fail("QUIESCENCE_RESULT_FILE_UNSAFE", { role });
    }
    handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) {
      fail("QUIESCENCE_RESULT_FILE_UNSAFE", { role });
    }
    const bytes = await handle.readFile();
    if (bytes.length !== before.size) fail("QUIESCENCE_RESULT_FILE_UNSAFE", { role });
    return Object.freeze({ text: bytes.toString("utf8"), sha256: sha256Hex(bytes) });
  } catch (error) {
    if (error instanceof QuiescenceCheckError) throw error;
    return fail("QUIESCENCE_RESULT_FILE_UNSAFE", { role });
  } finally {
    await handle?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Local detail (SQLite mode only): opaque references of the offending rows.

function refsOf(database, sql, kind, project, role) {
  const rows = readStatement(database, sql, role);
  return Object.freeze({
    refs: Object.freeze(rows.slice(0, QUIESCENCE_MAX_REFS).map(row => opaqueRef(kind, project(row)))),
    truncated: rows.length > QUIESCENCE_MAX_REFS,
  });
}

const REF_LIMIT = QUIESCENCE_MAX_REFS + 1;

function ingestionDetail(database) {
  return Object.freeze({
    participants: refsOf(database,
      `SELECT id FROM participants WHERE ${PARTICIPANT_NOT_QUIESCENT_PREDICATE} ORDER BY id LIMIT ${REF_LIMIT}`,
      "participant", row => row.id, "ingestion"),
    erasedLinks: refsOf(database,
      `SELECT participant_id FROM storage_v11_owner_links WHERE state = 'erased' ORDER BY participant_id LIMIT ${REF_LIMIT}`,
      "participant", row => row.participant_id, "ingestion"),
    quarantine: refsOf(database,
      `SELECT contribution_id FROM pending_quarantine_objects ORDER BY registered_at, contribution_id LIMIT ${REF_LIMIT}`,
      "quarantine-registration", row => row.contribution_id, "ingestion"),
  });
}

function ledgerDetail(database) {
  return Object.freeze({
    erasureJobs: refsOf(database,
      `SELECT participant_digest, source_id, owner_digest FROM storage_erasure_jobs WHERE state = 'pending'
        ORDER BY participant_digest, source_id, owner_digest LIMIT ${REF_LIMIT}`,
      "erasure-job", row => `${row.participant_digest}\0${row.source_id}\0${row.owner_digest}`, "deletion-ledger"),
  });
}

/**
 * The do-not-restore intersection through the seal's own helpers: the ledger's
 * tombstone digests and the participant loop. A refusal the seal or PT-3 would
 * raise (CUTOVER_PROJECTION_INVALID) is reported as the finding, not thrown.
 */
function readIntersection(ingestionDatabase, ledgerDatabase) {
  try {
    const digests = new Set(readDeletionDigestsFromDatabase(ledgerDatabase));
    const matched = [];
    const result = countParticipantDeletionMatches(ingestionDatabase, digests, {
      onMatch: id => { if (matched.length <= QUIESCENCE_MAX_REFS) matched.push(opaqueRef("participant", id)); },
    });
    return Object.freeze({
      participants: result.participants,
      deletionDigests: result.deletionDigests,
      matches: result.matches,
      refs: Object.freeze(matched.slice(0, QUIESCENCE_MAX_REFS)),
      truncated: matched.length > QUIESCENCE_MAX_REFS,
    });
  } catch (error) {
    if (error instanceof CutoverSourceError && error.code === "CUTOVER_PROJECTION_INVALID") {
      return Object.freeze({ refused: error.code });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The report.

// implemented: whether the refusal exists in code at this commit. A code of null
// is a refusal the PT-8, PT-4 or HX-6 brief specifies without naming a code.
const refusal = (stage, code, implemented) => Object.freeze([Object.freeze({ stage, code, implemented })]);
const REFUSALS = Object.freeze({
  "participants-quiescent": refusal("PT-3", "CUTOVER_PARTICIPANT_ERASURE_PENDING", true),
  "deletion-digest-intersection": refusal("PT-2-lite, PT-3", "CUTOVER_ERASED_PARTICIPANT_PRESENT", true),
  "owner-links-erased": refusal("PT-8", null, false),
  "pending-quarantine-registrations": refusal("PT-4, PT-8", null, false),
  "correction-runtime": refusal("PT-8", "CUTOVER_CORRECTION_RUNTIME_ACTIVE", false),
  "pending-erasure-jobs": refusal("PT-8, HX-6 drain", null, false),
  "analytics-delivery": refusal("HX-6 drain, EP-8 attestation", null, false),
});
const REQUIRES = Object.freeze({
  "participants-quiescent": ["ingestion"],
  "deletion-digest-intersection": ["ingestion", "deletion-ledger"],
  "owner-links-erased": ["ingestion"],
  "pending-quarantine-registrations": ["ingestion"],
  "correction-runtime": ["ingestion"],
  "pending-erasure-jobs": ["deletion-ledger"],
  "analytics-delivery": ["ingestion", "analytics"],
});
const NOTES = Object.freeze({
  "participants-quiescent": "Finish each erasure on Cloudflare before the fence. After a seal, that costs a fence release, "
    + "the erasure and a re-seal. There is no override.",
  "deletion-digest-intersection": "A participant that matches a recorded tombstone must not be imported (decision D2).",
  "pending-quarantine-registrations": "In-flight uploads register objects on a live source; the fence freezes the set. "
    + "'deleting' is a reconciliation lease the fenced Worker cannot finish.",
  "correction-runtime": "PT-8 requires the runtime staged with no correction facts.",
  "pending-erasure-jobs": "The analytics Workers finish erasure jobs while they still run; wait for them to clear before the seal.",
  "analytics-delivery": "Meaningful after the main Worker is fenced and its drain is complete; some lag is normal on a live source.",
});

function checkBody(id, status, extra = {}) {
  return Object.freeze({ id, status, requires: REQUIRES[id], refusals: REFUSALS[id], ...extra,
    ...(status === "blocked" && NOTES[id] !== undefined ? { note: NOTES[id] } : {}) });
}

const statusOf = (blocked) => (blocked ? "blocked" : "clear");

/**
 * Evaluate the facts into a report. `facts` holds a normalised fact set per
 * supplied role; `local` carries SQLite-mode detail (refs, the intersection).
 */
export function evaluateQuiescence({ facts = {}, local = {}, mode, sources = [], now = () => new Date() } = {}) {
  if (mode !== "sqlite" && mode !== "wrangler-results") fail("QUIESCENCE_ARGUMENT_INVALID");
  const ingestion = facts.ingestion;
  const ledger = facts["deletion-ledger"];
  const analytics = facts.analytics;
  const checks = [];
  const absent = (id, reason) => checkBody(id, "not-evaluated", { reason });
  const refsOfCheck = (detail) => (detail === undefined ? {} : { refs: detail.refs, refsTruncated: detail.truncated });

  if (ingestion === undefined) {
    checks.push(absent("participants-quiescent", "ingestion-not-supplied"));
  } else {
    const get = ingestion.get;
    const counts = {
      participants: get("participants", "total"),
      notQuiescent: get("participants", "not_quiescent"),
      deleting: get("participants", "deleting"),
      deletionFenced: get("participants", "deletion_fenced"),
      stateUnrecognized: get("participants", "state_unrecognized"),
    };
    checks.push(checkBody("participants-quiescent", statusOf(counts.notQuiescent > 0),
      { counts, ...refsOfCheck(local.ingestion?.participants) }));
  }

  if (ingestion === undefined || ledger === undefined) {
    checks.push(absent("deletion-digest-intersection", ingestion === undefined ? "ingestion-not-supplied"
      : "ledger-not-supplied"));
  } else if (local.intersection === undefined) {
    checks.push(absent("deletion-digest-intersection", "requires-local-hashing"));
  } else if (local.intersection.refused !== undefined) {
    checks.push(checkBody("deletion-digest-intersection", "blocked", { counts: null, refused: local.intersection.refused }));
  } else {
    const { participants, deletionDigests, matches, refs, truncated } = local.intersection;
    checks.push(checkBody("deletion-digest-intersection", statusOf(matches > 0),
      { counts: { participants, deletionDigests, matches }, refs, refsTruncated: truncated }));
  }

  if (ingestion === undefined) {
    checks.push(absent("owner-links-erased", "ingestion-not-supplied"));
    checks.push(absent("pending-quarantine-registrations", "ingestion-not-supplied"));
    checks.push(absent("correction-runtime", "ingestion-not-supplied"));
  } else {
    const get = ingestion.get;
    const links = { ownerLinks: get("owner_links", "total"), erased: get("owner_links", "erased"),
      withdrawn: get("owner_links", "withdrawn") };
    checks.push(checkBody("owner-links-erased", statusOf(links.erased > 0),
      { counts: links, ...refsOfCheck(local.ingestion?.erasedLinks) }));
    const quarantine = { registrations: get("quarantine", "total"), registered: get("quarantine", "registered"),
      deleting: get("quarantine", "deleting"), oldestRegisteredAt: get("quarantine", "oldest_registered_at") };
    checks.push(checkBody("pending-quarantine-registrations", statusOf(quarantine.registrations > 0),
      { counts: quarantine, ...refsOfCheck(local.ingestion?.quarantine) }));
    const correction = { runtimeRows: get("correction", "runtime_rows"), runtimeState: get("correction", "runtime_state"),
      facts: get("correction", "facts"), history: get("correction", "history") };
    const runtimeBlocked = correction.runtimeRows !== 1 || correction.runtimeState !== CORRECTION_RUNTIME_STAGED_STATE
      || correction.facts > 0 || correction.history > 0;
    checks.push(checkBody("correction-runtime", statusOf(runtimeBlocked), { counts: correction }));
  }

  if (ledger === undefined) {
    checks.push(absent("pending-erasure-jobs", "ledger-not-supplied"));
  } else {
    const get = ledger.get;
    const jobs = { jobs: get("erasure_jobs", "total"), pending: get("erasure_jobs", "pending"),
      complete: get("erasure_jobs", "complete"), pendingParticipants: get("erasure_jobs", "pending_participants"),
      tombstones: get("tombstones", "total") };
    checks.push(checkBody("pending-erasure-jobs", statusOf(jobs.pending > 0),
      { counts: jobs, ...refsOfCheck(local.ledger?.erasureJobs) }));
  }

  if (ingestion === undefined || analytics === undefined) {
    checks.push(absent("analytics-delivery", ingestion === undefined ? "ingestion-not-supplied" : "analytics-not-supplied"));
  } else {
    const journal = [...ingestion.family("journal")];
    const cursors = analytics.family("delivery_cursor");
    if (journal.length === 0) {
      checks.push(absent("analytics-delivery", "source-state-absent"));
    } else {
      // A source with no cursor row has delivered nothing (the Worker's own
      // delivery trigger reads a missing cursor as 0), but only because the
      // analytics statement succeeded and listed every cursor row.
      const rows = journal.map(([source, journalMax]) => {
        const delivered = cursors.get(source) ?? 0;
        return { sourceRef: opaqueRef("source", source), journalMax, deliveredCursor: delivered,
          undelivered: Math.max(0, journalMax - delivered), cursorAheadBy: Math.max(0, delivered - journalMax) };
      });
      const known = new Set(journal.map(([source]) => source));
      const counts = { sources: rows,
        analyticsCursorsWithoutIngestionSource: [...cursors.keys()].filter(source => !known.has(source)).length };
      checks.push(checkBody("analytics-delivery", statusOf(rows.some(row => row.undelivered > 0 || row.cursorAheadBy > 0)),
        { counts }));
    }
  }

  const blocked = checks.filter(item => item.status === "blocked").map(item => item.id);
  const notEvaluated = checks.filter(item => item.status === "not-evaluated").map(item => item.id);
  const verdict = blocked.length > 0 ? "blocked" : notEvaluated.length > 0 ? "incomplete" : "quiescent";
  return Object.freeze({
    schema: CUTOVER_QUIESCENCE_REPORT_SCHEMA,
    mode,
    checkedAt: now().toISOString(),
    verdict,
    blocked,
    notEvaluated,
    sources: Object.freeze(sources),
    checks: Object.freeze(checks),
  });
}

// ---------------------------------------------------------------------------
// Entry points.

function sourceEntry(role, source) {
  if (source === undefined) return { role, supplied: false };
  return { role, supplied: true, kind: source.kind, sha256: source.sha256,
    ...(source.sealId === undefined ? {} : { sealId: source.sealId }) };
}

/**
 * Check local SQLite sources. Give either `seal` (a manifest path) with
 * `sealId`, which supplies the sealed ingestion and deletion-ledger files, or
 * `ingestion` and `ledger` paths of exported D1 files; `analytics` is always a
 * plain exported file. At least one source is required; an absent one is
 * not-evaluated, never clear.
 */
export async function runQuiescenceCheck({ seal, sealId, ingestion, ledger, analytics, now = () => new Date() } = {}) {
  if (seal !== undefined && (ingestion !== undefined || ledger !== undefined)) fail("QUIESCENCE_ARGUMENT_INVALID");
  if (seal === undefined && sealId !== undefined) fail("QUIESCENCE_ARGUMENT_INVALID");
  if (seal === undefined && ingestion === undefined && ledger === undefined && analytics === undefined) {
    fail("QUIESCENCE_ARGUMENT_INVALID");
  }
  const opened = {};
  try {
    if (seal !== undefined) {
      const sealed = await readCutoverSeal({ manifestPath: resolve(seal), expectedSealId: sealId });
      opened.ingestion = wrapSealedSource("ingestion", await openSealedSourceFromSeal(sealed, "ingestion"), sealId);
      opened["deletion-ledger"] = wrapSealedSource("deletion-ledger",
        await openSealedSourceFromSeal(sealed, "deletion-ledger"), sealId);
    }
    if (ingestion !== undefined) opened.ingestion = await openExportedSqlite(ingestion, "ingestion");
    if (ledger !== undefined) opened["deletion-ledger"] = await openExportedSqlite(ledger, "deletion-ledger");
    if (analytics !== undefined) opened.analytics = await openExportedSqlite(analytics, "analytics");

    for (const source of Object.values(opened)) await source.verify();
    const facts = {};
    const local = {};
    for (const role of QUIESCENCE_SOURCE_ROLES) {
      if (opened[role] !== undefined) facts[role] = readQuiescenceFacts(role, opened[role].database());
    }
    if (opened.ingestion !== undefined) local.ingestion = ingestionDetail(opened.ingestion.database());
    if (opened["deletion-ledger"] !== undefined) local.ledger = ledgerDetail(opened["deletion-ledger"].database());
    if (opened.ingestion !== undefined && opened["deletion-ledger"] !== undefined) {
      local.intersection = readIntersection(opened.ingestion.database(), opened["deletion-ledger"].database());
    }
    for (const source of Object.values(opened)) await source.verify();
    return evaluateQuiescence({
      facts, local, mode: "sqlite", now,
      sources: QUIESCENCE_SOURCE_ROLES.map(role => sourceEntry(role, opened[role])),
    });
  } finally {
    for (const source of Object.values(opened)) source.close();
  }
}

/** Evaluate saved owner-run Wrangler output (documented mode); each argument is a file path. */
export async function evaluateWranglerResults({ ingestion, ledger, analytics, now = () => new Date() } = {}) {
  const inputs = { ingestion, "deletion-ledger": ledger, analytics };
  if (Object.values(inputs).every(value => value === undefined)) fail("QUIESCENCE_ARGUMENT_INVALID");
  const facts = {};
  const sources = [];
  for (const role of QUIESCENCE_SOURCE_ROLES) {
    if (inputs[role] === undefined) {
      sources.push(sourceEntry(role, undefined));
      continue;
    }
    const file = await readQuiescenceResultFile(inputs[role], role);
    facts[role] = parseWranglerQuiescenceResult(role, file.text);
    sources.push(sourceEntry(role, { kind: "wrangler-result", sha256: file.sha256 }));
  }
  return evaluateQuiescence({ facts, mode: "wrangler-results", now, sources });
}

export function quiescenceExitCode(report) {
  return { quiescent: 0, blocked: 2, incomplete: 3 }[report?.verdict] ?? 1;
}

// ---------------------------------------------------------------------------
// CLI.

const COMMAND_FLAGS = Object.freeze({
  check: Object.freeze({ "--seal": "seal", "--seal-id": "sealId", "--ingestion": "ingestion", "--ledger": "ledger",
    "--analytics": "analytics" }),
  evaluate: Object.freeze({ "--ingestion-result": "ingestion", "--ledger-result": "ledger", "--analytics-result": "analytics" }),
  queries: Object.freeze({ "--role": "role" }),
});

export function parseQuiescenceArguments(argv) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(COMMAND_FLAGS, command)) fail("QUIESCENCE_ARGUMENT_INVALID");
  const flags = COMMAND_FLAGS[command];
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (command === "queries" && flag === "--sql") {
      if (options.sql !== undefined) fail("QUIESCENCE_ARGUMENT_INVALID");
      options.sql = true;
      continue;
    }
    const key = Object.hasOwn(flags, flag) ? flags[flag] : undefined;
    const value = rest[index + 1];
    if (key === undefined || options[key] !== undefined || typeof value !== "string" || value.length === 0
        || value.startsWith("--")) {
      fail("QUIESCENCE_ARGUMENT_INVALID");
    }
    options[key] = value;
    index += 1;
  }
  if (command === "queries") {
    if (options.role !== undefined && !QUIESCENCE_SOURCE_ROLES.includes(options.role)) fail("QUIESCENCE_ARGUMENT_INVALID");
    if (options.sql === true && options.role === undefined) fail("QUIESCENCE_ARGUMENT_INVALID");
  }
  return options;
}

/** The statements as a document, or one role's bare SQL (for a shell substitution). */
export function describeQuiescenceQueries({ role, sql = false } = {}) {
  if (sql) return QUIESCENCE_STATEMENTS[role];
  const roles = role === undefined ? QUIESCENCE_SOURCE_ROLES : [role];
  return JSON.stringify({
    schema: CUTOVER_QUIESCENCE_QUERIES_SCHEMA,
    queries: roles.map(name => ({ role: name, sql: QUIESCENCE_STATEMENTS[name], sha256: sha256Hex(QUIESCENCE_STATEMENTS[name]) })),
  });
}

async function main(argv) {
  const options = parseQuiescenceArguments(argv);
  if (options.command === "queries") {
    const text = describeQuiescenceQueries({ role: options.role, sql: options.sql === true });
    process.stdout.write(`${text}\n`);
    return;
  }
  const report = options.command === "check" ? await runQuiescenceCheck(options) : await evaluateWranglerResults(options);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = quiescenceExitCode(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    const known = error instanceof QuiescenceCheckError || error instanceof CutoverSourceError;
    process.stderr.write(`${known ? error.message : "QUIESCENCE_FAILED"}\n`);
    process.exitCode = 1;
  });
}
