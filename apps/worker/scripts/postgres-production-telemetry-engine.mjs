// D-PT5A: the production-mode engine for the telemetry importer stages on
// PT-1's production transfer target (scripts/postgres-transfer-target.mjs)
// over the sealed ingestion D1 of a PT-2-lite seal (cutover-source-seal.mjs).
//
// It generalizes the pattern PT-3 (postgres-identity-authority-transfer.mjs)
// introduced, so that every telemetry stage (postgres-production-telemetry-
// modes.mjs) shares one reviewed mechanism:
//
//   * A stage is a frozen list of table specs (and a few explicit steps) over
//     the sealed file. Every spec names its sealed table, its PostgreSQL
//     target, its key, every mapped column with a closed type, the reviewed
//     omissions, the reviewed trigger policy and its PT-1 disposition token.
//   * Every check that can refuse on the sealed side runs before the first
//     write and before the target is touched: the seal and the sealed file's
//     sha256 (before, during and after), column closure over the sealed
//     schema, every sealed value canonicalized (so an invalid value, a JSON
//     text a jsonb column cannot hold, or an inserted row larger than one page
//     refuses before page one), the stage's own sealed-source lineage checks.
//     Only then is the target read
//     (stage prerequisites through PT-1's ledger, trigger-policy coverage,
//     target column layout, foreign-key order).
//   * Rows import in pages of at most 256 rows and 4 MiB. A page is one PT-1
//     transaction under SET LOCAL ROLE (withTransferTransaction): a pending
//     checkpoint (row count and prefix chain, never a key), the rows, and the
//     reviewed trigger suppressions for that page only (withTriggerPolicy). A
//     killed run resumes at the last committed page: the sealed prefix must
//     reproduce the checkpoint's chain and the target's row count.
//   * A table completes only when its target digest equals the sealed digest
//     (canonical values on both sides); then its checkpoint and PT-1 table
//     receipt complete. A replay of a finished stage reads and writes nothing
//     that changes a row version.
//   * Errors are closed codes whose details name only a table, a column, a
//     stage, a SQLSTATE or a constant guard name. No value read from the seal
//     or the target ever reaches an error, a receipt or a return value.
//
// Imports only through PT-1's public facade and the PT-2 seal and T-1's
// reviewed value codec; it never imports a rehearsal importer's private
// state, so the rehearsal modes are untouched.

import { createHash } from "node:crypto";
import { CutoverSourceError, openSealedSourceFromSeal, readCutoverSeal } from "./cutover-source-seal.mjs";
import {
  PostgresFastpathIdentityCopyError,
  fastpathIdentitySourceValue,
  fastpathIdentityTargetExpression,
  fastpathIdentityTargetValue,
} from "./postgres-fastpath-identity-copy.mjs";
import {
  EMPTY_PREFIX_CHAIN,
  PostgresTransferTargetError,
  TRANSFER_STAGES,
  advancePrefixChain,
  applyIdentityHighWater,
  assertStageComplete,
  assertTriggerPolicyCoverage,
  createRowsDigest,
  productionTransferId,
  readCheckpoint,
  recordCheckpoint,
  requireImportingRun,
  stageReceipt,
  tableReceipt,
  withTransferTransaction,
  withTriggerPolicy,
} from "./postgres-transfer-target.mjs";

export const TELEMETRY_PRODUCTION_MAX_PAGE_ROWS = 256;
export const TELEMETRY_PRODUCTION_MAX_PAGE_BYTES = 4 * 1024 * 1024;
export const TELEMETRY_PRODUCTION_TARGET_PAGE_ROWS = 2000;
// Tables whose rows can carry a megabyte of text (manifests, domains, JSON records) read in smaller pages.
export const TELEMETRY_PRODUCTION_LARGE_TARGET_PAGE_ROWS = 100;
export const TELEMETRY_PRODUCTION_LARGE_SOURCE_PAGE_ROWS = 8;

export const TELEMETRY_PRODUCTION_ERROR_CODES = Object.freeze([
  "CUTOVER_ADMISSION_PENDING_REQUESTS",
  "CUTOVER_ADMISSION_PROOF_INCOMPLETE",
  "CUTOVER_ADMISSION_SOURCE_UNQUALIFIED",
  "CUTOVER_CHECKPOINT_DIVERGED",
  "CUTOVER_CHUNK_REGISTRATION_MISMATCH",
  "CUTOVER_COLUMN_UNMAPPED",
  "CUTOVER_CORRECTION_CAS_GUARD_PRESENT",
  "CUTOVER_CORRECTION_OWNER_NOT_ACTIVE",
  "CUTOVER_ERASED_OWNER_EVIDENCE_PRESENT",
  "CUTOVER_IMPORT_ORDER_INVALID",
  "CUTOVER_JOURNAL_SOURCE_INVALID",
  "CUTOVER_PAGE_ROW_TOO_LARGE",
  "CUTOVER_PARENT_RECEIPT_MISMATCH",
  "CUTOVER_PENDING_OBJECT_INVALID",
  "CUTOVER_SCHEMA_MARKER_MISMATCH",
  "CUTOVER_SEEDED_ROW_UNMATCHED",
  "CUTOVER_SOURCE_LINEAGE_INVALID",
  "CUTOVER_SOURCE_TABLE_MISSING",
  "CUTOVER_SOURCE_VALUE_INVALID",
  "CUTOVER_TARGET_COLUMN_MISMATCH",
  "CUTOVER_TARGET_ROW_COUNT_DIVERGED",
  "CUTOVER_TARGET_WRITE_REFUSED",
  "CUTOVER_TELEMETRY_ARGUMENT_INVALID",
  "CUTOVER_TELEMETRY_TABLE_DIGEST_MISMATCH",
  "CUTOVER_TELEMETRY_TRANSFER_FAILED",
  "CUTOVER_TYPED_OWNER_AUTHORITY_INVALID",
  "CUTOVER_V12_SOURCE_INVALID",
]);
const ERROR_CODES = new Set(TELEMETRY_PRODUCTION_ERROR_CODES);
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const SQLSTATE = /^[0-9A-Z]{5}$/u;
const CONSTANT_MESSAGE = /^[a-z][a-z0-9_]{2,80}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
export const telemetryProductionHash = value => createHash("sha256").update(value).digest("hex");
const HASH = telemetryProductionHash;

export class TelemetryProductionError extends Error {
  constructor(code, details = undefined) {
    const safe = {};
    if (details && typeof details === "object") {
      for (const key of ["table", "column"]) {
        if (typeof details[key] === "string" && IDENTIFIER.test(details[key])) safe[key] = details[key];
      }
      if (typeof details.stage === "string" && TRANSFER_STAGES.includes(details.stage)) safe.stage = details.stage;
      if (typeof details.sqlState === "string" && SQLSTATE.test(details.sqlState)) safe.sqlState = details.sqlState;
      if (typeof details.guard === "string" && CONSTANT_MESSAGE.test(details.guard)) safe.guard = details.guard;
    }
    const suffix = Object.entries(safe).map(([key, value]) => `${key}=${value}`).join(" ");
    super(suffix ? `${code} [${suffix}]` : code);
    this.name = "TelemetryProductionError";
    this.code = ERROR_CODES.has(code) ? code : "CUTOVER_TELEMETRY_TRANSFER_FAILED";
    Object.assign(this, safe);
  }
}

export function telemetryFail(code, details = undefined) {
  throw new TelemetryProductionError(code, details);
}
const fail = telemetryFail;

export function quote(name) {
  if (typeof name !== "string" || !IDENTIFIER.test(name)) fail("CUTOVER_TELEMETRY_ARGUMENT_INVALID");
  return `"${name}"`;
}

function sqlStateOf(error) {
  return typeof error?.code === "string" && SQLSTATE.test(error.code) ? error.code : undefined;
}

/** Run one target statement; refusals carry the SQLSTATE and the constant guard name only. */
export async function targetQuery(client, text, values, table = undefined) {
  try {
    return await client.query(text, values);
  } catch (error) {
    if (error instanceof TelemetryProductionError || error instanceof PostgresTransferTargetError) throw error;
    const guard = typeof error?.message === "string" && CONSTANT_MESSAGE.test(error.message) ? error.message : undefined;
    return fail("CUTOVER_TARGET_WRITE_REFUSED", { table, sqlState: sqlStateOf(error), guard });
  }
}
const q = targetQuery;

// ---------------------------------------------------------------------------
// The column vocabulary. Sealed values are read with BigInt integers
// (setReadBigInts), so every INTEGER cell is a bigint and a number is a REAL.

const PG_TYPES = Object.freeze({
  text: Object.freeze(["text"]),
  i16: Object.freeze(["smallint"]),
  i32: Object.freeze(["integer"]),
  i64: Object.freeze(["bigint"]),
  bool01: Object.freeze(["boolean"]),
  bytes: Object.freeze(["bytea"]),
  instant: Object.freeze(["timestamp with time zone"]),
  day: Object.freeze(["date"]),
  real: Object.freeze(["double precision"]),
  json: Object.freeze(["jsonb"]),
});
const INT_BOUNDS = Object.freeze({ i16: [-32_768n, 32_767n], i32: [-2_147_483_648n, 2_147_483_647n] });
// Key column types whose PostgreSQL order equals the sealed (SQLite) order: text under COLLATE "C", integers, bytes bytewise, instants, days.
const ORDERED_KEY_TYPES = Object.freeze(["text", "i16", "i32", "i64", "day", "instant", "bytes"]);

export function col(name, type, options = {}) {
  if (!IDENTIFIER.test(name) || !Object.hasOwn(PG_TYPES, type)) throw new TypeError("telemetry production column invalid");
  const sealed = options.sql === undefined ? (options.sealed ?? name) : null;
  if (sealed !== null && !IDENTIFIER.test(sealed)) throw new TypeError("telemetry production column invalid");
  return Object.freeze({ name, type, sealed, sql: options.sql ?? null, override: options.override ?? null });
}

function jsonCanonical(value) {
  if (Array.isArray(value)) return value.map(jsonCanonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, jsonCanonical(value[key])]));
  }
  return value;
}

/**
 * JSON text can spell what a jsonb value cannot hold: U+0000 and an unpaired
 * surrogate, in a string or a key (PostgreSQL refuses them with 22P05 and
 * 22P02). Refusing them here keeps the failure in the sealed-side preflight
 * instead of mid-stage on a page.
 */
function assertJsonStorable(value, table, column) {
  if (typeof value === "string") {
    if (value.includes("\0") || !value.isWellFormed()) fail("CUTOVER_SOURCE_VALUE_INVALID", { table, column });
  } else if (Array.isArray(value)) {
    for (const item of value) assertJsonStorable(item, table, column);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertJsonStorable(key, table, column);
      assertJsonStorable(item, table, column);
    }
  }
}

/** Returns [canonical, parameter] for one sealed cell. */
export function canonicalSourceValue(type, value, table, column) {
  if (value === null || value === undefined) return [null, null];
  try {
    switch (type) {
      case "text": case "bytes": case "instant": case "day": case "bool01":
        return fastpathIdentitySourceValue(type, value, table, column);
      case "i64":
        return fastpathIdentitySourceValue("int", value, table, column);
      case "i16": case "i32": {
        const pair = fastpathIdentitySourceValue("int", value, table, column);
        const [min, max] = INT_BOUNDS[type];
        const parsed = BigInt(pair[0]);
        if (parsed < min || parsed > max) fail("CUTOVER_SOURCE_VALUE_INVALID", { table, column });
        return pair;
      }
      case "real": {
        const number = typeof value === "bigint" ? Number(value) : value;
        if (typeof number !== "number" || !Number.isFinite(number)) fail("CUTOVER_SOURCE_VALUE_INVALID", { table, column });
        const canonical = Object.is(number, -0) ? 0 : number;
        return [canonical, canonical];
      }
      case "json": {
        if (typeof value !== "string" || value.includes("\0")) fail("CUTOVER_SOURCE_VALUE_INVALID", { table, column });
        let parsed;
        try {
          parsed = JSON.parse(value);
        } catch {
          return fail("CUTOVER_SOURCE_VALUE_INVALID", { table, column });
        }
        assertJsonStorable(parsed, table, column);
        return [JSON.stringify(jsonCanonical(parsed)), value];
      }
      default:
        return fail("CUTOVER_TELEMETRY_ARGUMENT_INVALID");
    }
  } catch (error) {
    if (error instanceof PostgresFastpathIdentityCopyError) fail("CUTOVER_SOURCE_VALUE_INVALID", { table, column });
    throw error;
  }
}

function targetColumnExpression(column) {
  switch (column.type) {
    case "i16": case "i32": case "i64": return `${quote(column.name)}::text`;
    case "json": return `${quote(column.name)}::text`;
    case "real": return quote(column.name);
    default: return fastpathIdentityTargetExpression({ target: column.name, type: column.type });
  }
}

function canonicalTargetValue(column, value, table) {
  if (value === null || value === undefined) return null;
  switch (column.type) {
    case "real": {
      if (typeof value !== "number" || !Number.isFinite(value)) fail("CUTOVER_SOURCE_VALUE_INVALID", { table, column: column.name });
      return Object.is(value, -0) ? 0 : value;
    }
    case "json": {
      try {
        return JSON.stringify(jsonCanonical(JSON.parse(value)));
      } catch {
        return fail("CUTOVER_SOURCE_VALUE_INVALID", { table, column: column.name });
      }
    }
    case "i16": case "i32": case "i64":
      return fastpathIdentityTargetValue("text", value, table, column.name);
    default:
      try {
        return fastpathIdentityTargetValue(column.type, value, table, column.name);
      } catch (error) {
        if (error instanceof PostgresFastpathIdentityCopyError) fail("CUTOVER_SOURCE_VALUE_INVALID", { table, column: column.name });
        throw error;
      }
  }
}

// ---------------------------------------------------------------------------
// Table specs.

/**
 * A sealed table (or a reviewed join over sealed tables) and its target.
 *   name         the spec name and checkpoint name (unique in a stage)
 *   sealedTable  the sealed table the PT-1 table receipt is keyed by
 *   target       the PostgreSQL table
 *   key          target column names, in the sealed key order
 *   columns      col(...) entries; `sql` columns are computed in the sealed select
 *   from/where   a reviewed sealed FROM clause (joins) and filter
 *   closure      [{table, columns, omitted}] sealed columns this spec consumes
 *   omitted      reviewed omissions of the sealed table, name -> reason
 *   mode         'insert' | 'update-seeded' (rewrite the migration-seeded rows)
 *   token        the PT-1 disposition token, or null when a sibling spec owns the receipt
 *   suppress/fire  reviewed trigger policy for the target, name -> reason
 *   expectEmpty  the target must hold no row before the stage writes (default for insert)
 */
export function defineTable(options) {
  const {
    name, sealedTable = name, target = name, key, columns, from = null, where = null, closure = null,
    omitted = {}, mode = "insert", token, suppress = {}, fire = {}, beforeInsert = null, matchColumns = null,
    receipt = true, targetRestrict = null, large = false,
  } = options;
  if (!IDENTIFIER.test(name) || !IDENTIFIER.test(sealedTable) || !IDENTIFIER.test(target)
      || !Array.isArray(key) || key.length === 0 || !Array.isArray(columns) || columns.length === 0
      || key.some(item => !columns.some(column => column.name === item))
      || new Set(columns.map(column => column.name)).size !== columns.length
      || !["insert", "update-seeded"].includes(mode)
      || (receipt && (typeof token !== "string" || token.length === 0))) {
    throw new TypeError("telemetry production table definition invalid");
  }
  const defaultClosure = from === null
    ? [{ table: sealedTable, columns: columns.filter(column => column.sealed !== null).map(column => column.sealed), omitted }]
    : null;
  const resolvedClosure = closure ?? defaultClosure;
  if (resolvedClosure === null) throw new TypeError("telemetry production table definition invalid");
  for (const entry of resolvedClosure) {
    if (!IDENTIFIER.test(entry.table) || !Array.isArray(entry.columns)) throw new TypeError("telemetry production closure invalid");
  }
  const triggerNames = [...Object.keys(suppress), ...Object.keys(fire)];
  if (new Set(triggerNames).size !== triggerNames.length) throw new TypeError("telemetry production trigger policy invalid");
  return Object.freeze({
    name, sealedTable, target, key: Object.freeze([...key]), columns: Object.freeze([...columns]),
    from, where, closure: Object.freeze(resolvedClosure.map(entry => Object.freeze({
      table: entry.table, columns: Object.freeze([...entry.columns]), omitted: Object.freeze({ ...(entry.omitted ?? {}) }),
    }))), omitted: Object.freeze({ ...omitted }), mode, token: token ?? null, receipt,
    suppress: Object.freeze({ ...suppress }), fire: Object.freeze({ ...fire }), beforeInsert, matchColumns,
    large: large === true,
    targetRestrict: targetRestrict === null ? null : Object.freeze({ sql: targetRestrict.sql, values: Object.freeze([...(targetRestrict.values ?? [])]) }),
  });
}

/** The trigger-policy map entry (PT-1 shape) of one table spec. */
export function specTriggerPolicy(spec) {
  return Object.freeze({
    ...Object.fromEntries(Object.entries(spec.suppress).map(([trigger, reason]) => [trigger, Object.freeze({ policy: "suppress", reason })])),
    ...Object.fromEntries(Object.entries(spec.fire).map(([trigger, reason]) => [trigger, Object.freeze({ policy: "fire", reason })])),
  });
}

// ---------------------------------------------------------------------------
// Sealed source reads.

export function sourceAll(database, sql, values = [], table = undefined) {
  try {
    const statement = database.prepare(sql);
    statement.setReadBigInts(true);
    return statement.all(...values);
  } catch {
    return fail("CUTOVER_SOURCE_TABLE_MISSING", { table });
  }
}

export function sourceCount(database, sql, values = [], table = undefined) {
  const [row] = sourceAll(database, sql, values, table);
  if (typeof row?.n !== "bigint" || row.n < 0n) fail("CUTOVER_SOURCE_LINEAGE_INVALID", { table });
  return Number(row.n);
}

export function sourceTablePresent(database, table) {
  return sourceAll(database, "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?", [table], table).length === 1;
}

export function sourceColumns(database, table) {
  if (!sourceTablePresent(database, table)) fail("CUTOVER_SOURCE_TABLE_MISSING", { table });
  return sourceAll(database, `PRAGMA table_xinfo(${quote(table)})`, [], table)
    .filter(column => Number(column.hidden) === 0).map(column => String(column.name));
}

/** Closure: every sealed column is consumed or a reviewed omission, and every consumed column exists. */
export function assertSealedClosure(database, entry) {
  const actual = sourceColumns(database, entry.table);
  for (const column of actual) {
    if (!entry.columns.includes(column) && !Object.hasOwn(entry.omitted, column)) {
      fail("CUTOVER_COLUMN_UNMAPPED", { table: entry.table, column: IDENTIFIER.test(column) ? column : undefined });
    }
  }
  for (const column of entry.columns) {
    if (!actual.includes(column)) fail("CUTOVER_COLUMN_UNMAPPED", { table: entry.table, column });
  }
}

function selectList(spec) {
  return spec.columns.map(column => `${column.sql === null ? quote(column.sealed) : `(${column.sql})`} AS ${quote(column.name)}`).join(", ");
}

function sealedFromClause(spec) {
  return `${spec.from ?? quote(spec.sealedTable)}${spec.where === null ? "" : ` WHERE ${spec.where}`}`;
}

function keyColumns(spec) {
  return spec.key.map(name => spec.columns.find(column => column.name === name));
}

function keyOrderSql(spec) {
  return spec.key.map(quote).join(", ");
}

/** One keyset page of sealed rows after `after` (raw key values), in key order. */
export function readSourcePage(database, spec, after, limit) {
  const inner = `SELECT ${selectList(spec)} FROM ${sealedFromClause(spec)}`;
  const tuple = spec.key.length === 1 ? quote(spec.key[0]) : `(${spec.key.map(quote).join(", ")})`;
  const marks = spec.key.length === 1 ? "?" : `(${spec.key.map(() => "?").join(", ")})`;
  const where = after === null ? "" : ` WHERE ${tuple} > ${marks}`;
  const rows = sourceAll(database, `SELECT * FROM (${inner})${where} ORDER BY ${keyOrderSql(spec)} LIMIT ?`,
    [...(after ?? []), limit], spec.sealedTable);
  return rows.map(row => ({ row, key: spec.key.map(name => row[name]) }));
}

export function canonicalRow(spec, row) {
  const values = [];
  const parameters = [];
  let size = 0;
  for (const column of spec.columns) {
    const [canonical, parameter] = canonicalSourceValue(column.type, row[column.name], spec.sealedTable, column.name);
    values.push(canonical);
    parameters.push(parameter);
    size += parameter === null ? 0 : Buffer.isBuffer(parameter) ? parameter.length
      : typeof parameter === "string" ? Buffer.byteLength(parameter) : 8;
  }
  return { values, parameters, size };
}

function sourcePageRows(spec, maxRows) {
  return spec.large ? Math.min(maxRows, TELEMETRY_PRODUCTION_LARGE_SOURCE_PAGE_ROWS) : maxRows;
}

function pageOf(database, spec, after, maxRows, maxBytes) {
  const candidates = readSourcePage(database, spec, after, sourcePageRows(spec, maxRows));
  const page = [];
  let bytesTotal = 0;
  for (const candidate of candidates) {
    const canonical = canonicalRow(spec, candidate.row);
    if (canonical.size > maxBytes) fail("CUTOVER_PAGE_ROW_TOO_LARGE", { table: spec.sealedTable });
    if (page.length > 0 && bytesTotal + canonical.size > maxBytes) break;
    page.push({ ...canonical, key: candidate.key, raw: candidate.row });
    bytesTotal += canonical.size;
  }
  return { rows: page, bytes: bytesTotal };
}

/**
 * Stream the whole sealed spec once: count, bytes, digest and final prefix
 * chain. With `maxBytes`, an inserted row that cannot fit one page refuses
 * here, in the preflight, with the same code pageOf uses (a seeded-row rewrite
 * does not page by bytes).
 */
export function sourceTableFacts(database, spec, maxRows, maxBytes = null) {
  const pageRows = sourcePageRows(spec, maxRows);
  const digest = createRowsDigest();
  let chain = EMPTY_PREFIX_CHAIN;
  let after = null;
  let rows = 0;
  let bytesTotal = 0;
  for (;;) {
    const page = readSourcePage(database, spec, after, pageRows);
    for (const { row, key } of page) {
      const canonical = canonicalRow(spec, row);
      if (maxBytes !== null && spec.mode === "insert" && canonical.size > maxBytes) {
        fail("CUTOVER_PAGE_ROW_TOO_LARGE", { table: spec.sealedTable });
      }
      digest.update(canonical.values);
      chain = advancePrefixChain(chain, canonical.values);
      rows += 1;
      bytesTotal += canonical.size;
      after = key;
    }
    if (page.length < pageRows) break;
  }
  return { rows, bytes: bytesTotal, sha256: digest.digest(), chain };
}

/** Replay the first `count` sealed rows: their prefix chain and the key after them. */
function sourcePrefix(database, spec, count, maxRows) {
  let chain = EMPTY_PREFIX_CHAIN;
  let after = null;
  let seen = 0;
  while (seen < count) {
    const page = readSourcePage(database, spec, after, Math.min(sourcePageRows(spec, maxRows), count - seen));
    if (page.length === 0) fail("CUTOVER_CHECKPOINT_DIVERGED", { table: spec.sealedTable });
    for (const { row, key } of page) {
      chain = advancePrefixChain(chain, canonicalRow(spec, row).values);
      after = key;
      seen += 1;
    }
  }
  return { chain, after };
}

/** A content-free digest of an arbitrary sealed table (every column), ordered by every column. */
export function genericSealedDigest(database, table) {
  const digest = createRowsDigest();
  const columns = sourceColumns(database, table);
  const statement = database.prepare(`SELECT ${columns.map(quote).join(", ")} FROM ${quote(table)}
    ORDER BY ${columns.map((_, index) => String(index + 1)).join(", ")}`);
  statement.setReadBigInts(true);
  let rows = 0;
  for (const row of statement.iterate()) {
    digest.update(Object.fromEntries(Object.entries(row).map(([name, value]) =>
      [name, typeof value === "bigint" ? value.toString() : value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value])));
    rows += 1;
  }
  return { rows, sha256: digest.digest() };
}

/**
 * Every foreign key the sealed table declares must be satisfied inside the
 * seal (a NULL column in a composite key is exempt, as in SQLite): the
 * parents of a stage's rows are the sealed ones, so a foreign-key refusal can
 * never surface mid-stage after pages have committed. Counts only.
 */
export function assertSealedForeignKeys(database, table) {
  const list = sourceAll(database, `PRAGMA foreign_key_list(${quote(table)})`, [], table);
  const groups = new Map();
  for (const entry of list) {
    const group = groups.get(Number(entry.id)) ?? { parent: String(entry.table), pairs: [] };
    group.pairs.push({ seq: Number(entry.seq), from: String(entry.from), to: entry.to === null ? null : String(entry.to) });
    groups.set(Number(entry.id), group);
  }
  for (const group of groups.values()) {
    group.pairs.sort((left, right) => left.seq - right.seq);
    let targets = group.pairs.map(pair => pair.to);
    if (targets.some(target => target === null)) {
      targets = sourceAll(database, `PRAGMA table_info(${quote(group.parent)})`, [], group.parent)
        .filter(column => Number(column.pk) > 0).sort((left, right) => Number(left.pk) - Number(right.pk))
        .map(column => String(column.name));
      if (targets.length !== group.pairs.length) fail("CUTOVER_SOURCE_LINEAGE_INVALID", { table });
    }
    const join = group.pairs.map((pair, index) => `parent.${quote(targets[index])} = child.${quote(pair.from)}`).join(" AND ");
    const present = group.pairs.map(pair => `child.${quote(pair.from)} IS NOT NULL`).join(" AND ");
    const missing = sourceCount(database, `SELECT count(*) AS n FROM ${quote(table)} child
      LEFT JOIN ${quote(group.parent)} parent ON ${join}
     WHERE ${present} AND parent.${quote(targets[0])} IS NULL`, [], table);
    if (missing !== 0) fail("CUTOVER_SOURCE_LINEAGE_INVALID", { table });
  }
  return groups.size;
}

// ---------------------------------------------------------------------------
// Target reads.

async function targetCount(client, schema, table, restrict = null) {
  const where = restrict === null ? "" : ` WHERE ${restrict.sql}`;
  const { rows } = await q(client, `SELECT count(*)::text AS n FROM ${quote(schema)}.${quote(table)}${where}`,
    restrict === null ? [] : [...restrict.values], table);
  return Number(rows[0].n);
}

let scanCounter = 0;

/**
 * Digest of the target rows in the sealed key order: text keys compare under
 * COLLATE "C", SQLite's BINARY order for UTF-8. `restrict` limits the scan to
 * the sealed keys of a merged seed.
 *
 * The rows come from one server-side cursor, so the table is ordered once and
 * read in pages of FETCH. Keyset pages (`WHERE key > $last ORDER BY key LIMIT
 * n`) cannot use a primary-key index under an explicit COLLATE "C", on any
 * database, because the planner matches the index's collation by identity: each
 * page re-scans and re-sorts the rest of the table, so the cost grows with the
 * square of the row count. It must run inside a transaction (the callers
 * already do); a cursor needs one, and a failure outside one is a refusal.
 */
export async function targetTableFacts(client, schema, spec, { restrict = null } = {}) {
  const pageRows = spec.large ? TELEMETRY_PRODUCTION_LARGE_TARGET_PAGE_ROWS : TELEMETRY_PRODUCTION_TARGET_PAGE_ROWS;
  const keys = keyColumns(spec);
  if (keys.some(column => !ORDERED_KEY_TYPES.includes(column.type))) fail("CUTOVER_TELEMETRY_ARGUMENT_INVALID");
  const collate = column => (column.type === "text" ? ` COLLATE "C"` : "");
  const list = spec.columns.map(column => `${targetColumnExpression(column)} AS ${quote(column.name)}`).join(", ");
  // Qualified by the row alias: an unqualified ORDER BY name would match the
  // output alias first (a text projection), sorting integer keys as text.
  const order = keys.map(column => `target_row.${quote(column.name)}${collate(column)}`).join(", ");
  const where = restrict === null ? "" : ` WHERE ${restrict.sql}`;
  const cursor = `telemetry_digest_scan_${scanCounter}`;
  scanCounter = (scanCounter + 1) % 1_000_000;
  const digest = createRowsDigest();
  let rows = 0;
  await q(client, `DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT ${list} FROM ${quote(schema)}.${quote(spec.target)} target_row${where}
    ORDER BY ${order}`, restrict === null ? [] : [...restrict.values], spec.target);
  try {
    for (;;) {
      const result = await q(client, `FETCH FORWARD ${pageRows} FROM ${cursor}`, [], spec.target);
      for (const row of result.rows) {
        digest.update(spec.columns.map(column => canonicalTargetValue(column, row[column.name], spec.target)));
        rows += 1;
      }
      if (result.rows.length < pageRows) break;
    }
  } finally {
    // After a failure the transaction is already aborted and the cursor with it.
    await client.query(`CLOSE ${cursor}`).catch(() => {});
  }
  return { rows, sha256: digest.digest() };
}

/** Column layout of one target table against its spec; unmapped NOT NULL columns without a default refuse. */
async function assertTargetLayout(client, schema, spec) {
  const { rows } = await q(client, `SELECT column_name, data_type, is_nullable, column_default, is_generated, is_identity
      FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`, [schema, spec.target], spec.target);
  if (rows.length === 0) fail("CUTOVER_TARGET_COLUMN_MISMATCH", { table: spec.target });
  const byName = new Map(rows.map(row => [row.column_name, row]));
  for (const column of spec.columns) {
    const row = byName.get(column.name);
    if (!row || !PG_TYPES[column.type].includes(row.data_type) || row.is_generated === "ALWAYS") {
      fail("CUTOVER_TARGET_COLUMN_MISMATCH", { table: spec.target, column: column.name });
    }
  }
  const mapped = new Set(spec.columns.map(column => column.name));
  for (const row of rows) {
    if (mapped.has(row.column_name)) continue;
    if (row.is_nullable === "NO" && row.column_default === null && row.is_identity !== "YES") {
      fail("CUTOVER_COLUMN_UNMAPPED", { table: spec.target, column: IDENTIFIER.test(row.column_name) ? row.column_name : undefined });
    }
  }
}

/** Every foreign key between two stage tables must run from a later table to an earlier one. */
async function assertFrozenOrder(client, schema, order) {
  const { rows } = await q(client, `SELECT child.relname::text AS child, parent.relname::text AS parent
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class child ON child.oid = con.conrelid
      JOIN pg_catalog.pg_namespace child_ns ON child_ns.oid = child.relnamespace
      JOIN pg_catalog.pg_class parent ON parent.oid = con.confrelid
     WHERE con.contype = 'f' AND child_ns.nspname = $1 AND child.relname = ANY($2::text[])`, [schema, [...order]]);
  for (const { child, parent } of rows) {
    if (child === parent) continue;
    const parentIndex = order.indexOf(parent);
    const childIndex = order.indexOf(child);
    // A parent outside the stage belongs to an earlier stage (checked by its ledger).
    if (parentIndex >= 0 && parentIndex > childIndex) fail("CUTOVER_IMPORT_ORDER_INVALID", { table: child });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Target writes.

function insertSql(schema, spec, rowCount) {
  const names = spec.columns.map(column => quote(column.name)).join(", ");
  const width = spec.columns.length;
  const values = Array.from({ length: rowCount }, (_, rowIndex) => `(${spec.columns.map((_unused, columnIndex) =>
    `$${rowIndex * width + columnIndex + 1}`).join(", ")})`).join(", ");
  return `INSERT INTO ${quote(schema)}.${quote(spec.target)} (${names}) VALUES ${values}`;
}

function pageParameters(spec, rows) {
  return rows.flatMap(row => spec.columns.map((column, index) =>
    (column.override === null ? row.parameters[index] : column.override(row))));
}

async function insertPage(client, schema, spec, rows) {
  const result = await q(client, insertSql(schema, spec, rows.length), pageParameters(spec, rows), spec.target);
  if (result.rowCount !== rows.length) fail("CUTOVER_TARGET_WRITE_REFUSED", { table: spec.target });
}

/**
 * Rewrite one migration-seeded row to its sealed values: matched on `key`
 * (or on matchColumns, which then stay untouched), every other column set.
 */
async function updateSeededRow(client, schema, spec, row) {
  const match = spec.matchColumns ?? spec.key;
  const indexes = match.map(name => spec.columns.findIndex(column => column.name === name));
  const assignments = spec.columns.map((column, index) => (match.includes(column.name) ? null
    : `${quote(column.name)} = $${index + 1}`)).filter(Boolean).join(", ");
  const where = indexes.map(index => `${quote(spec.columns[index].name)} = $${index + 1}`).join(" AND ");
  const result = await q(client, `UPDATE ${quote(schema)}.${quote(spec.target)} SET ${assignments} WHERE ${where}`,
    row.parameters, spec.target);
  if (result.rowCount !== 1) fail("CUTOVER_SEEDED_ROW_UNMATCHED", { table: spec.target });
}

function checkpointName(spec) {
  return `table:${spec.name}`;
}

/**
 * Import one spec in pages with checkpoints. Returns { resumed, pages }.
 * `context` carries { handle, stage, database, sealed, schema, maxRows, maxBytes, onPage }.
 */
async function importTable(context, spec) {
  const { handle, stage, database, schema, maxRows, maxBytes, onPage } = context;
  const name = checkpointName(spec);
  const checkpoint = await withTransferTransaction(handle, "primary", async client => {
    await requireImportingRun(client, handle);
    return readCheckpoint(client, handle, { stage, name });
  }, { readOnly: true });
  if (checkpoint?.state === "complete") {
    if (spec.mode === "insert") {
      const present = await withTransferTransaction(handle, "primary",
        client => targetCount(client, schema, spec.target, spec.targetRestrict), { readOnly: true });
      if (present !== checkpoint.rowCount) fail("CUTOVER_TARGET_ROW_COUNT_DIVERGED", { table: spec.target });
    }
    return { resumed: true, pages: 0 };
  }

  let pages = 0;
  if (spec.mode === "update-seeded") {
    const facts = sourceTableFacts(database, spec, maxRows);
    const rows = [];
    let after = null;
    for (;;) {
      const page = readSourcePage(database, spec, after, maxRows);
      for (const { row, key } of page) {
        rows.push(canonicalRow(spec, row));
        after = key;
      }
      if (page.length < maxRows) break;
    }
    await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      if (spec.receipt) {
        await tableReceipt(client, handle, { stage, sourceRole: "ingestion", sourceTable: spec.sealedTable,
          disposition: spec.token, targetTable: spec.target, state: "started" });
      }
      await recordCheckpoint(client, handle, { stage, name, state: "pending", rowCount: rows.length, prefixChainSha256: facts.chain });
      for (const row of rows) await updateSeededRow(client, schema, spec, row);
    });
    pages = 1;
    await onPage?.({ table: spec.name, page: pages, rows: rows.length });
    return { resumed: false, pages };
  }

  let committed = checkpoint?.rowCount ?? 0;
  let chain = checkpoint?.prefixChainSha256 ?? EMPTY_PREFIX_CHAIN;
  let after = null;
  if (committed > 0) {
    const prefix = sourcePrefix(database, spec, committed, maxRows);
    if (prefix.chain !== chain) fail("CUTOVER_CHECKPOINT_DIVERGED", { table: spec.sealedTable });
    after = prefix.after;
  }
  const present = await withTransferTransaction(handle, "primary",
    client => targetCount(client, schema, spec.target, spec.targetRestrict), { readOnly: true });
  if (present !== committed) fail("CUTOVER_TARGET_ROW_COUNT_DIVERGED", { table: spec.target });
  for (;;) {
    const page = pageOf(database, spec, after, maxRows, maxBytes);
    if (page.rows.length === 0) break;
    let nextChain = chain;
    for (const row of page.rows) nextChain = advancePrefixChain(nextChain, row.values);
    const expectedPrior = committed;
    await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      const current = await readCheckpoint(client, handle, { stage, name });
      if ((current?.rowCount ?? 0) !== expectedPrior) fail("CUTOVER_CHECKPOINT_DIVERGED", { table: spec.sealedTable });
      if (expectedPrior === 0 && spec.receipt) {
        await tableReceipt(client, handle, { stage, sourceRole: "ingestion", sourceTable: spec.sealedTable,
          disposition: spec.token, targetTable: spec.target, state: "started" });
      }
      await recordCheckpoint(client, handle, { stage, name, state: "pending",
        rowCount: expectedPrior + page.rows.length, prefixChainSha256: nextChain });
      if (spec.beforeInsert !== null) await spec.beforeInsert({ client, schema, database, spec, rows: page.rows });
      const write = () => insertPage(client, schema, spec, page.rows);
      const suppress = Object.keys(spec.suppress);
      if (suppress.length > 0) await withTriggerPolicy(client, { schema, table: spec.target, suppress }, write);
      else await write();
    });
    committed += page.rows.length;
    chain = nextChain;
    after = page.rows.at(-1).key;
    pages += 1;
    await onPage?.({ table: spec.name, page: pages, rows: page.rows.length });
  }
  return { resumed: committed > 0 && (checkpoint?.rowCount ?? 0) > 0, pages };
}

/** Compare the target with the sealed facts, then complete the checkpoint and the PT-1 table receipt. */
async function completeTable(context, spec, source) {
  const { handle, stage, schema, database } = context;
  let restrict = spec.targetRestrict;
  if (spec.mode === "update-seeded" && spec.matchColumns !== null) {
    const keys = sourceAll(database, `SELECT ${quote(spec.key[0])} AS k FROM ${sealedFromClause(spec)}`, [], spec.sealedTable)
      .map(row => String(row.k));
    restrict = { sql: `${quote(spec.key[0])} = ANY($1::text[])`, values: [keys] };
  }
  return withTransferTransaction(handle, "primary", async client => {
    await requireImportingRun(client, handle);
    const target = await targetTableFacts(client, schema, spec, { restrict });
    if (target.rows !== source.rows || target.sha256 !== source.sha256) {
      fail("CUTOVER_TELEMETRY_TABLE_DIGEST_MISMATCH", { table: spec.target });
    }
    await recordCheckpoint(client, handle, { stage, name: checkpointName(spec), state: "complete",
      rowCount: source.rows, prefixChainSha256: source.chain });
    if (spec.receipt) {
      await tableReceipt(client, handle, { stage, sourceRole: "ingestion", sourceTable: spec.sealedTable,
        disposition: spec.token, targetTable: spec.target, state: "complete", sourceRowCount: source.rows,
        sourceSha256: source.sha256, targetRowCount: target.rows, targetSha256: target.sha256 });
    }
    return Object.freeze({ sourceRows: source.rows, targetRows: target.rows, bytes: source.bytes, sha256: source.sha256 });
  });
}

// ---------------------------------------------------------------------------
// Stage-level helpers used by the stage definitions.

/** The complete PT-1 table receipts of one stage of this run (read-only). */
export async function readStageTableReceipts(client, handle, stage) {
  const run = await q(client, `SELECT run_id FROM tibotattle_transfer.transfer_runs
    WHERE seal_manifest_sha256 = $1 AND contract_id = $2 AND state <> 'abandoned'`,
  [handle.sealManifestSha256, handle.contractId]);
  if (run.rows.length !== 1) fail("CUTOVER_PARENT_RECEIPT_MISMATCH", { stage });
  const { rows } = await q(client, `SELECT source_table, disposition, target_table, state,
      source_row_count::text AS source_row_count, source_sha256, target_row_count::text AS target_row_count, target_sha256
    FROM tibotattle_transfer.transfer_table_receipts
   WHERE run_id = $1 AND stage = $2 AND source_role = 'ingestion' ORDER BY source_table`, [run.rows[0].run_id, stage]);
  return rows;
}

/**
 * A parent stage's receipts must show each named sealed table complete with
 * target rows equal to the sealed count: the foreign-key parents this stage's
 * rows reference are exactly the sealed ones (the parent stage verified its
 * own digests against the same seal).
 */
export async function assertParentReceipts(client, handle, database, stage, tables) {
  const receipts = await readStageTableReceipts(client, handle, stage);
  for (const table of tables) {
    const receipt = receipts.find(row => row.source_table === table);
    const sealedRows = sourceCount(database, `SELECT count(*) AS n FROM ${quote(table)}`, [], table);
    if (receipt === undefined || receipt.state !== "complete" || receipt.target_row_count === null
        || Number(receipt.target_row_count) !== sealedRows || Number(receipt.source_row_count) !== sealedRows) {
      fail("CUTOVER_PARENT_RECEIPT_MISMATCH", { table, stage });
    }
  }
  return receipts.length;
}

/** Every sequence of the schema: the sealed counter for named tables, null for the rest (PT-1 shape). */
export async function sequencedTables(client, schema) {
  const { rows } = await q(client, `SELECT DISTINCT c.relname::text AS table_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
       AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL
     ORDER BY 1`, [schema]);
  return rows.map(row => row.table_name);
}

export async function raiseIdentityHighWater(client, handle, sealedCounters) {
  const tables = await sequencedTables(client, handle.primarySchema);
  const sealedSequences = Object.fromEntries(tables.map(table =>
    [table, Object.hasOwn(sealedCounters, table) ? sealedCounters[table] : null]));
  return applyIdentityHighWater(client, handle, { sealedSequences });
}

/** The sealed sqlite_sequence counters by name (INTEGER or an integral REAL). */
export function sealedCounters(database) {
  const present = sourceAll(database, "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'").length === 1;
  const counters = present ? sourceAll(database, "SELECT name, seq FROM sqlite_sequence ORDER BY name") : [];
  const sealed = {};
  for (const counter of counters) {
    const seq = typeof counter.seq === "bigint" ? counter.seq : Number.isSafeInteger(counter.seq) ? BigInt(counter.seq) : -1n;
    if (typeof counter.name !== "string" || seq < 0n || seq > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail("CUTOVER_SOURCE_VALUE_INVALID", { table: "sqlite_sequence" });
    }
    sealed[counter.name] = Number(seq);
  }
  return Object.freeze(sealed);
}

function validatePaging(pageRows, pageBytes) {
  if (!Number.isSafeInteger(pageRows) || pageRows < 1 || pageRows > TELEMETRY_PRODUCTION_MAX_PAGE_ROWS
      || !Number.isSafeInteger(pageBytes) || pageBytes < 1024 || pageBytes > TELEMETRY_PRODUCTION_MAX_PAGE_BYTES) {
    fail("CUTOVER_TELEMETRY_ARGUMENT_INVALID");
  }
}

/**
 * Run one stage. `definition`:
 *   stage            a PT-1 TRANSFER_STAGES name
 *   schemaTag        the receipt schema string
 *   prerequisites    stages that must be complete (checked through PT-1's ledger)
 *   items            ordered { kind: 'table', spec } and { kind: 'step', name, run, receipt? } entries
 *   extraSealed      sealed tables referenced by checks that must exist
 *   policySha256     the stage's frozen-policy digest
 *   sourcePreflight  ({database, seal, sealed, facts, pageRows}) => content-free facts (refuses closed)
 *   targetPreflight  async ({client, handle, schema, database, facts}) => content-free facts (read-only)
 *   extraReceipts    async (context) => writes receipts of tables with no target (inside a transaction)
 *   finish           async ({client, handle, database, results, facts}) => content-free facts
 *   countedTables    which table results add to the stage row count (default: every spec)
 */
export async function runTelemetryStage(definition, {
  handle,
  sealManifestPath,
  pageRows = TELEMETRY_PRODUCTION_MAX_PAGE_ROWS,
  pageBytes = TELEMETRY_PRODUCTION_MAX_PAGE_BYTES,
  onPage = null,
  onStep = null,
} = {}) {
  const { stage } = definition;
  validatePaging(pageRows, pageBytes);
  if (handle === null || typeof handle !== "object" || typeof handle.sealManifestSha256 !== "string"
      || (onPage !== null && typeof onPage !== "function") || (onStep !== null && typeof onStep !== "function")) {
    fail("CUTOVER_TELEMETRY_ARGUMENT_INVALID");
  }
  const seal = await readCutoverSeal({ manifestPath: sealManifestPath, expectedSealId: handle.sealManifestSha256 });
  const sealed = await openSealedSourceFromSeal(seal, "ingestion");
  try {
    await sealed.verify();
    const database = sealed.database();
    const specs = definition.items.filter(item => item.kind === "table").map(item => item.spec);

    // Preflight on the sealed file: everything that can refuse, before the
    // target is read and before the first write.
    for (const spec of specs) for (const entry of spec.closure) assertSealedClosure(database, entry);
    for (const table of new Set(specs.flatMap(spec => spec.closure.map(entry => entry.table)))) {
      assertSealedForeignKeys(database, table);
    }
    for (const table of definition.extraSealed ?? []) {
      if (!sourceTablePresent(database, table)) fail("CUTOVER_SOURCE_TABLE_MISSING", { table });
    }
    const sourceFacts = new Map(specs.map(spec => [spec.name, sourceTableFacts(database, spec, pageRows, pageBytes)]));
    const sourceChecks = definition.sourcePreflight === undefined ? {}
      : await definition.sourcePreflight({ database, seal, sealed, facts: sourceFacts, pageRows });

    // Preflight on the target (read-only).
    const schema = handle.primarySchema;
    const target = await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      for (const prerequisite of definition.prerequisites) await assertStageComplete(handle, prerequisite, client);
      const policy = {};
      for (const spec of specs) policy[spec.target] = specTriggerPolicy(spec);
      const coverage = await assertTriggerPolicyCoverage(client, schema, policy);
      const foreignKeys = await assertFrozenOrder(client, schema, [...new Set(specs.map(spec => spec.target))]);
      for (const spec of specs) await assertTargetLayout(client, schema, spec);
      // A table this stage has not started must be empty; a started one holds exactly its checkpointed rows.
      for (const spec of specs) {
        if (spec.mode !== "insert") continue;
        const started = await readCheckpoint(client, handle, { stage, name: checkpointName(spec) });
        const present = await targetCount(client, schema, spec.target, spec.targetRestrict);
        if (present !== (started?.rowCount ?? 0)) fail("CUTOVER_TARGET_ROW_COUNT_DIVERGED", { table: spec.target });
      }
      const checks = definition.targetPreflight === undefined ? {}
        : await definition.targetPreflight({ client, handle, schema, database, facts: sourceFacts, sourceChecks });
      return Object.freeze({ coverage, foreignKeys, checks });
    }, { readOnly: true });
    await sealed.verify();

    const started = await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      return stageReceipt(client, handle, { stage, state: "started" });
    });

    const context = { handle, stage, database, sealed, schema, maxRows: pageRows, maxBytes: pageBytes, onPage };
    const pages = {};
    const stepResults = {};
    for (const item of definition.items) {
      if (item.kind === "table") {
        const imported = await importTable(context, item.spec);
        pages[item.spec.name] = imported.pages;
      } else {
        stepResults[item.name] = await item.run({ ...context, started });
        await onStep?.({ step: item.name });
      }
    }
    await sealed.verify();
    const tables = {};
    for (const spec of specs) tables[spec.name] = await completeTable(context, spec, sourceFacts.get(spec.name));
    const extra = definition.extraReceipts === undefined ? {} : await definition.extraReceipts(context);
    await sealed.verify();

    const finishFacts = await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      return definition.finish === undefined ? {}
        : definition.finish({ client, handle, database, results: tables, steps: stepResults, sourceChecks, target });
    });
    const summary = {
      schema: definition.schemaTag,
      stage,
      sealId: seal.manifest.sealId,
      sourceSha256: sealed.sha256,
      policySha256: definition.policySha256,
      tables: Object.fromEntries(Object.entries(tables).map(([name, facts]) => [name, { rows: facts.sourceRows, sha256: facts.sha256 }])),
      checks: sourceChecks,
      steps: stepResults,
      extra,
      finish: finishFacts,
    };
    const receiptSha256 = HASH(JSON.stringify(summary));
    const counted = definition.countedTables ?? specs.map(spec => spec.name);
    const rowCount = counted.reduce((total, name) => total + tables[name].sourceRows, 0);
    const byteCount = counted.reduce((total, name) => total + tables[name].bytes, 0);
    await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      await stageReceipt(client, handle, { stage, state: "complete", rowCount, byteCount, receiptSha256 });
    });
    await sealed.verify();
    return Object.freeze({
      schema: definition.schemaTag,
      stage,
      transferId: productionTransferId(stage, seal.manifest.sealId),
      sealId: seal.manifest.sealId,
      sourceSha256: sealed.sha256,
      policySha256: definition.policySha256,
      receiptSha256,
      order: Object.freeze(definition.items.map(item => (item.kind === "table" ? item.spec.name : `step:${item.name}`))),
      tables: Object.freeze(tables),
      pages: Object.freeze(pages),
      checks: Object.freeze(sourceChecks),
      steps: Object.freeze(stepResults),
      extra: Object.freeze(extra),
      finish: Object.freeze(finishFacts),
      triggerPolicy: target.coverage,
      foreignKeysChecked: target.foreignKeys,
      rowCount,
      byteCount,
    });
  } catch (error) {
    if (error instanceof TelemetryProductionError || error instanceof PostgresTransferTargetError
        || error instanceof CutoverSourceError) {
      throw error;
    }
    return fail("CUTOVER_TELEMETRY_TRANSFER_FAILED");
  } finally {
    sealed.close();
  }
}

export { SHA256 };
