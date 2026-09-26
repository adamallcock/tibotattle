/**
 * A `D1Database` over `node:sqlite`, for operator-local tooling that runs the
 * Worker's own D1 code against scratch copies of sealed D1 exports.
 *
 * This is NOT a production database binding and never enters the Cloud Run
 * image: it exists so the D1 export oracle can reproduce D1 behaviour offline.
 * Its semantics follow the D1 client contract the Worker relies on:
 *
 * - `prepare(sql).bind(...values)` returns a new immutable statement; SQL is
 *   compiled at execution time, as D1 does.
 * - Values bind as D1 binds them: integral numbers as INTEGER, other finite
 *   numbers as REAL, booleans as 0/1, byte arrays and buffers as BLOB, strings
 *   as TEXT and null as NULL. `undefined`, bigint and other objects are
 *   refused. The number of values must equal the statement's parameter count.
 * - Integers read back as JS numbers. A stored integer outside the safe range
 *   throws `ADAPTER_INTEGER_UNSAFE` instead of silently losing precision.
 *   BLOBs read back as arrays of byte values, as D1 returns them.
 * - `batch` is one `BEGIN IMMEDIATE ... COMMIT` transaction: a failing
 *   statement rolls back every earlier statement of the batch.
 * - `meta.changes` counts the rows the statement itself changed (not rows its
 *   triggers changed) and `meta.size_after` is the database size in bytes.
 * - `readOnly` opens the file read-only and refuses every write before it runs.
 * - The adapter opens only the path it is given: ATTACH, DETACH and extension
 *   loading are refused, so SQL can never reach another file.
 * - `pinnedNowMs` pins SQLite's own clock: every date function reading 'now'
 *   (or an omitted time value) and the CURRENT_* keywords read that instant
 *   instead of the wall clock. Worker SQL compares leases and authorization
 *   expiry with `strftime(...,'now')`, so without it a result would depend on
 *   when the tool ran. Every other input is evaluated by SQLite's own built-in
 *   on a private in-memory connection, so the results are the built-in's.
 *
 * It needs Node.js 24.10 or newer (`DatabaseSync#setAuthorizer` and the
 * authorizer constants). An older runtime is refused with
 * `ADAPTER_RUNTIME_UNSUPPORTED` before any file is opened.
 *
 * Errors carry closed `ADAPTER_*` codes for adapter refusals. SQLite errors keep
 * the D1 shape (`D1_ERROR: <sqlite message>`) because the Worker matches a few
 * of them (for example missing-table probes and trigger RAISE codes).
 */

import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync, StatementSync, constants } from "node:sqlite";

export const SEALED_SQLITE_D1_ADAPTER_ERRORS = Object.freeze([
  "ADAPTER_PATH_INVALID",
  "ADAPTER_DATABASE_INVALID",
  "ADAPTER_CLOSED",
  "ADAPTER_READ_ONLY",
  "ADAPTER_ATTACH_REFUSED",
  "ADAPTER_INTEGER_UNSAFE",
  "ADAPTER_TYPE_UNSUPPORTED",
  "ADAPTER_PARAMETER_COUNT",
  "ADAPTER_COLUMN_NOT_FOUND",
  "ADAPTER_FOREIGN_STATEMENT",
  "ADAPTER_BATCH_EMPTY",
  "ADAPTER_RUNTIME_UNSUPPORTED",
  "ADAPTER_CLOCK_INVALID",
]);

/** The node:sqlite surface this adapter relies on (Node.js 24.10+). */
export function sealedSqliteD1RuntimeSupported() {
  return typeof DatabaseSync?.prototype?.setAuthorizer === "function"
    && typeof DatabaseSync.prototype.function === "function"
    && typeof StatementSync?.prototype?.setReturnArrays === "function"
    && typeof StatementSync.prototype.columns === "function"
    && typeof StatementSync.prototype.setReadBigInts === "function"
    && ["SQLITE_OK", "SQLITE_DENY", "SQLITE_ATTACH", "SQLITE_DETACH", "SQLITE_INSERT", "SQLITE_UPDATE",
      "SQLITE_DELETE", "SQLITE_SAVEPOINT"].every((name) => Number.isInteger(constants?.[name]));
}

function adapterError(code) {
  return Object.assign(new Error(code), { code });
}

const WRITE_ACTIONS = new Set([
  constants.SQLITE_INSERT,
  constants.SQLITE_UPDATE,
  constants.SQLITE_DELETE,
  constants.SQLITE_CREATE_INDEX,
  constants.SQLITE_CREATE_TABLE,
  constants.SQLITE_CREATE_TEMP_INDEX,
  constants.SQLITE_CREATE_TEMP_TABLE,
  constants.SQLITE_CREATE_TEMP_TRIGGER,
  constants.SQLITE_CREATE_TEMP_VIEW,
  constants.SQLITE_CREATE_TRIGGER,
  constants.SQLITE_CREATE_VIEW,
  constants.SQLITE_DROP_INDEX,
  constants.SQLITE_DROP_TABLE,
  constants.SQLITE_DROP_TEMP_INDEX,
  constants.SQLITE_DROP_TEMP_TABLE,
  constants.SQLITE_DROP_TEMP_TRIGGER,
  constants.SQLITE_DROP_TEMP_VIEW,
  constants.SQLITE_DROP_TRIGGER,
  constants.SQLITE_DROP_VIEW,
  constants.SQLITE_ALTER_TABLE,
  constants.SQLITE_REINDEX,
  constants.SQLITE_ANALYZE,
  constants.SQLITE_CREATE_VTABLE,
  constants.SQLITE_DROP_VTABLE,
  constants.SQLITE_SAVEPOINT,
]);

/**
 * SQLite's own parameter numbering: `?NNN` takes index NNN, and `?` or a named
 * parameter takes one more than the largest index assigned so far. Literals,
 * quoted identifiers and comments are skipped.
 */
export function countSqlParameters(sql) {
  if (typeof sql !== "string") throw adapterError("ADAPTER_TYPE_UNSUPPORTED");
  let max = 0;
  const named = new Set();
  const length = sql.length;
  let index = 0;
  const skipQuoted = (close) => {
    index += 1;
    while (index < length) {
      if (sql[index] === close) {
        if (close !== "]" && sql[index + 1] === close) { index += 2; continue; }
        index += 1;
        return;
      }
      index += 1;
    }
  };
  while (index < length) {
    const char = sql[index];
    if (char === "'" || char === "\"" || char === "`") { skipQuoted(char); continue; }
    if (char === "[") { skipQuoted("]"); continue; }
    if (char === "-" && sql[index + 1] === "-") {
      while (index < length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? length : end + 2;
      continue;
    }
    if (char === "?") {
      let end = index + 1;
      while (end < length && sql[end] >= "0" && sql[end] <= "9") end += 1;
      if (end > index + 1) max = Math.max(max, Number(sql.slice(index + 1, end)));
      else max += 1;
      index = end;
      continue;
    }
    if ((char === ":" || char === "@" || char === "$") && /[A-Za-z_]/u.test(sql[index + 1] ?? "")) {
      let end = index + 1;
      while (end < length && /[A-Za-z0-9_]/u.test(sql[end])) end += 1;
      const name = sql.slice(index, end);
      if (!named.has(name)) { named.add(name); max += 1; }
      index = end;
      continue;
    }
    index += 1;
  }
  return max;
}

function bindValue(value) {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      return value;
    case "boolean":
      return value ? 1n : 0n;
    case "number":
      if (!Number.isFinite(value)) throw adapterError("ADAPTER_TYPE_UNSUPPORTED");
      if (Number.isInteger(value)) {
        if (!Number.isSafeInteger(value)) throw adapterError("ADAPTER_INTEGER_UNSAFE");
        return BigInt(value);
      }
      return value;
    case "object":
      if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
      if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      }
      if (Array.isArray(value)
          && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
        return Uint8Array.from(value);
      }
      throw adapterError("ADAPTER_TYPE_UNSUPPORTED");
    default:
      throw adapterError("ADAPTER_TYPE_UNSUPPORTED");
  }
}

function readValue(value) {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw adapterError("ADAPTER_INTEGER_UNSAFE");
    }
    return Number(value);
  }
  if (value instanceof Uint8Array) return Array.from(value);
  return value;
}

function realPathOrNull(path) {
  try { return realpathSync(path); } catch { return null; }
}

function assertOpenablePath(path, { create }) {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path) || path.includes("\0")) {
    throw adapterError("ADAPTER_PATH_INVALID");
  }
  let stat = null;
  try { stat = lstatSync(path); } catch { stat = null; }
  if (stat === null) {
    // A new file is created only where explicitly requested, inside an
    // existing directory that resolves to itself.
    const parent = dirname(path);
    const parentStat = (() => { try { return lstatSync(parent); } catch { return null; } })();
    if (!create || parentStat === null || !parentStat.isDirectory() || parentStat.isSymbolicLink()
        || realPathOrNull(parent) !== parent) {
      throw adapterError("ADAPTER_PATH_INVALID");
    }
    return;
  }
  if (create || !stat.isFile() || stat.isSymbolicLink() || realPathOrNull(path) !== path) {
    throw adapterError("ADAPTER_PATH_INVALID");
  }
}

/**
 * SQLite's date functions and where each takes its time value. A 'now' there
 * (case-insensitive, as SQLite matches it) or an omitted time value reads the
 * pinned instant; the call is otherwise passed through unchanged. The CURRENT_*
 * keywords are calls of the zero-argument functions of the same name.
 */
const PINNED_CLOCK_VARARGS = Object.freeze([
  ["date", 0], ["time", 0], ["datetime", 0], ["julianday", 0], ["unixepoch", 0], ["strftime", 1],
]);
const PINNED_CLOCK_CURRENT = Object.freeze([
  ["current_date", "date"], ["current_time", "time"], ["current_timestamp", "datetime"],
]);

function isNow(value) {
  return typeof value === "string" && value.length === 3 && value.toLowerCase() === "now";
}

/**
 * Register the pinned clock on `database`. The replacements are deterministic
 * (the instant is fixed), so they remain usable wherever SQLite allows the
 * built-ins, including views, triggers and CHECK constraints.
 */
function installPinnedClock(database, pinnedNowMs) {
  // A UTC instant with millisecond precision, which is exactly what SQLite's
  // 'now' carries; the Z suffix keeps it UTC for the utc/localtime modifiers.
  const instant = new Date(pinnedNowMs).toISOString();
  const builtins = new DatabaseSync(":memory:", { allowExtension: false });
  const compiled = new Map();
  const evaluate = (name, args) => {
    const key = `${name}/${args.length}`;
    let statement = compiled.get(key);
    if (statement === undefined) {
      statement = builtins.prepare(`SELECT ${name}(${args.map(() => "?").join(",")}) AS value`);
      statement.setReadBigInts(true);
      compiled.set(key, statement);
    }
    return statement.get(...args).value;
  };
  const options = { deterministic: true, useBigIntArguments: true };
  for (const [name, timeIndex] of PINNED_CLOCK_VARARGS) {
    database.function(name, { ...options, varargs: true }, (...args) => {
      const values = [...args];
      // strftime() without a format is NULL in SQLite; leave that to it.
      if (values.length === timeIndex && !(name === "strftime" && values.length === 0)) values.push(instant);
      else if (isNow(values[timeIndex])) values[timeIndex] = instant;
      return evaluate(name, values);
    });
  }
  let hasTimediff = true;
  try { evaluate("timediff", ["2000-01-01", "2000-01-01"]); } catch { hasTimediff = false; }
  if (hasTimediff) {
    database.function("timediff", options, (left, right) =>
      evaluate("timediff", [isNow(left) ? instant : left, isNow(right) ? instant : right]));
  }
  for (const [name, builtin] of PINNED_CLOCK_CURRENT) {
    database.function(name, options, () => evaluate(builtin, [instant]));
  }
  return builtins;
}

class AdapterState {
  constructor(database, readOnly) {
    this.database = database;
    this.readOnly = readOnly;
    this.closed = false;
    this.denied = null;
    this.statements = new Map();
    this.changes = database.prepare("SELECT total_changes() AS total,changes() AS direct,last_insert_rowid() AS rowid");
    this.changes.setReadBigInts(false);
    this.size = database.prepare("SELECT page_count*page_size AS bytes FROM pragma_page_count(),pragma_page_size()");
  }

  /** The compiled statement and its parameter count, cached per SQL text. */
  statement(sql) {
    if (this.closed) throw adapterError("ADAPTER_CLOSED");
    let entry = this.statements.get(sql);
    if (entry === undefined) {
      this.denied = null;
      let compiled;
      try {
        compiled = this.database.prepare(sql);
      } catch (error) {
        throw this.translate(error);
      }
      // Dynamic IN lists make distinct texts; keep the cache bounded.
      if (this.statements.size >= STATEMENT_CACHE_LIMIT) this.statements.clear();
      entry = { compiled, parameters: countSqlParameters(sql) };
      this.statements.set(sql, entry);
    }
    return entry;
  }

  translate(error) {
    if (this.denied !== null) {
      const code = this.denied;
      this.denied = null;
      return adapterError(code);
    }
    if (error && typeof error === "object" && typeof error.code === "string" && error.code.startsWith("ADAPTER_")) {
      return error;
    }
    if (this.readOnly && error && typeof error === "object" && error.errcode === 8) {
      return adapterError("ADAPTER_READ_ONLY");
    }
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`D1_ERROR: ${message}`);
  }
}

const STATEMENT_CACHE_LIMIT = 1024;
const STATE = new WeakMap();
const STATEMENT = new WeakMap();
const BINDING = new WeakMap();

function execute(state, sql, values, mode) {
  const { compiled, parameters } = state.statement(sql);
  const bound = values.map(bindValue);
  if (bound.length !== parameters) throw adapterError("ADAPTER_PARAMETER_COUNT");
  const started = performance.now();
  const before = state.changes.get();
  let rows;
  let columns;
  try {
    compiled.setReadBigInts(true);
    compiled.setReturnArrays(mode === "raw");
    rows = compiled.all(...bound);
    columns = compiled.columns().map((column) => column.name);
  } catch (error) {
    throw state.translate(error);
  }
  const after = state.changes.get();
  const changed = after.total !== before.total;
  const results = mode === "raw"
    ? rows.map((row) => row.map(readValue))
    : rows.map((row) => {
      const plain = {};
      for (const key of Object.keys(row)) plain[key] = readValue(row[key]);
      return plain;
    });
  const sizeAfter = Number(state.size.get().bytes);
  return {
    columns,
    results,
    meta: {
      served_by: "sealed-sqlite-d1-adapter",
      duration: performance.now() - started,
      changes: changed ? after.direct : 0,
      last_row_id: after.rowid,
      changed_db: changed,
      size_after: sizeAfter,
      rows_read: rows.length,
      rows_written: changed ? after.direct : 0,
    },
  };
}

/**
 * Statements and bindings are ordinary class instances, never frozen: the
 * Worker wraps D1 bindings in Proxies (statement meters, test doubles), and a
 * Proxy must be able to return a different value for `prepare` or `bind`.
 */
class SealedSqliteD1Statement {
  constructor(owner, sql, values) {
    STATEMENT.set(this, { owner, sql, values });
  }

  bind(...values) {
    const entry = STATEMENT.get(this);
    return new SealedSqliteD1Statement(entry.owner, entry.sql, values);
  }

  async first(column) {
    const { owner, sql, values } = STATEMENT.get(this);
    const result = execute(STATE.get(owner), sql, values, "objects");
    const row = result.results[0];
    if (row === undefined) return null;
    if (column === undefined) return row;
    if (!Object.hasOwn(row, column)) throw adapterError("ADAPTER_COLUMN_NOT_FOUND");
    return row[column];
  }

  async all() {
    const { owner, sql, values } = STATEMENT.get(this);
    const { results, meta } = execute(STATE.get(owner), sql, values, "objects");
    return { success: true, results, meta };
  }

  async run() {
    return this.all();
  }

  async raw(options = {}) {
    const { owner, sql, values } = STATEMENT.get(this);
    const { columns, results } = execute(STATE.get(owner), sql, values, "raw");
    return options?.columnNames === true ? [columns, ...results] : results;
  }
}

function createStatement(owner, sql, values) {
  return new SealedSqliteD1Statement(owner, sql, values);
}

class SealedSqliteD1Database {
  constructor(owner) {
    BINDING.set(this, owner);
  }

  prepare(sql) {
    const owner = BINDING.get(this);
    if (typeof sql !== "string") throw adapterError("ADAPTER_TYPE_UNSUPPORTED");
    if (STATE.get(owner).closed) throw adapterError("ADAPTER_CLOSED");
    return createStatement(owner, sql, []);
  }

  async batch(statements) {
    return batchStatements(BINDING.get(this), statements);
  }

  async exec(sql) {
    const state = STATE.get(BINDING.get(this));
    if (typeof sql !== "string") throw adapterError("ADAPTER_TYPE_UNSUPPORTED");
    if (state.closed) throw adapterError("ADAPTER_CLOSED");
    const started = performance.now();
    state.denied = null;
    try {
      state.database.exec(sql);
    } catch (error) {
      throw state.translate(error);
    }
    return { count: 1, duration: performance.now() - started };
  }

  async dump() {
    throw adapterError("ADAPTER_TYPE_UNSUPPORTED");
  }

  withSession() {
    const database = this;
    return {
      prepare: (sql) => database.prepare(sql),
      batch: (statements) => database.batch(statements),
      getBookmark: () => null,
    };
  }
}

function batchStatements(owner, statements) {
  const state = STATE.get(owner);
  if (state.closed) throw adapterError("ADAPTER_CLOSED");
  if (!Array.isArray(statements) || statements.length === 0) throw adapterError("ADAPTER_BATCH_EMPTY");
  const entries = statements.map((statement) => {
    const entry = STATEMENT.get(statement);
    if (!entry || entry.owner !== owner) throw adapterError("ADAPTER_FOREIGN_STATEMENT");
    return entry;
  });
  const begin = state.readOnly ? "BEGIN" : "BEGIN IMMEDIATE";
  try {
    state.database.exec(begin);
  } catch (error) {
    throw state.translate(error);
  }
  try {
    const results = entries.map((entry) => {
      const { results: rows, meta } = execute(state, entry.sql, entry.values, "objects");
      return { success: true, results: rows, meta };
    });
    state.database.exec("COMMIT");
    return results;
  } catch (error) {
    try { state.database.exec("ROLLBACK"); } catch { /* The original failure is reported. */ }
    throw state.translate(error);
  }
}

/**
 * Open one SQLite file as a D1 binding. `readOnly` refuses every write;
 * `create` is only for building synthetic fixtures and refuses an existing
 * file; `pinnedNowMs` (a positive safe integer of epoch milliseconds) pins
 * SQLite's own clock to that instant.
 */
export function openSealedSqliteD1(path, { readOnly = false, create = false, pinnedNowMs = null } = {}) {
  if (typeof readOnly !== "boolean" || typeof create !== "boolean" || (readOnly && create)) {
    throw adapterError("ADAPTER_PATH_INVALID");
  }
  if (pinnedNowMs !== null && (!Number.isSafeInteger(pinnedNowMs) || pinnedNowMs <= 0)) {
    throw adapterError("ADAPTER_CLOCK_INVALID");
  }
  if (!sealedSqliteD1RuntimeSupported()) throw adapterError("ADAPTER_RUNTIME_UNSUPPORTED");
  assertOpenablePath(path, { create });
  let database;
  let clock = null;
  let state;
  // Statements carry this token; `batch` refuses statements of any other binding.
  const owner = Object.freeze({});
  try {
    database = new DatabaseSync(path, {
      readOnly,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    // The clock and the authorizer are in place before any caller SQL is
    // compiled; the adapter's own two bookkeeping statements are fixed reads.
    if (pinnedNowMs !== null) clock = installPinnedClock(database, pinnedNowMs);
    state = new AdapterState(database, readOnly);
    database.setAuthorizer((action) => {
      if (action === constants.SQLITE_ATTACH || action === constants.SQLITE_DETACH) {
        state.denied = "ADAPTER_ATTACH_REFUSED";
        return constants.SQLITE_DENY;
      }
      if (readOnly && WRITE_ACTIONS.has(action)) {
        state.denied = "ADAPTER_READ_ONLY";
        return constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    });
  } catch {
    try { database?.close(); } catch { /* Already closed or never opened. */ }
    try { clock?.close(); } catch { /* Already closed. */ }
    throw adapterError("ADAPTER_DATABASE_INVALID");
  }
  STATE.set(owner, state);
  const binding = new SealedSqliteD1Database(owner);
  return Object.freeze({
    database: binding,
    close() {
      if (state.closed) return;
      state.closed = true;
      state.statements.clear();
      database.close();
      clock?.close();
    },
  });
}
