// MEAS-SYNTH production-tier measurement: the database side of the profile.
//
// readMeasPgStat takes one content-free snapshot of the server's cumulative
// statistics in ONE `BEGIN READ ONLY` transaction (statement timeout 60 s):
// pg_stat_statements (when the extension exists), pg_stat_database for the
// current database, pg_stat_io, pg_stat_wal, pg_stat_checkpointer (or
// pg_stat_bgwriter), the seeded schema's table and index I/O counters, the
// sessions grouped by state and wait event, and the planner/IO settings that
// explain them. measPgStatDelta subtracts two snapshots and ranks the
// statements by server execution time.
//
// Content-free: statement identity is pg_stat_statements' queryid (a
// fingerprint) and its normalized text, cut to 240 characters with every
// quoted literal and dollar-quoted body replaced by '?', and the
// /* analytics_v2:<family> */ tag when it has one; roles are classed
// (migrator, runtime, cloudsqladmin, postgres, other), application names are
// classed by this repository's own names; tables are named by relation name
// only. Every other value is a count, a byte total or a duration. Synthetic
// data only: this runs against the disposable measurement instance
// (gcp-fastpath-test-deploy.mjs meas-pgstat).

export const MEAS_PGSTAT_SCHEMA = "gcp-meas-pgstat-v1";
/** How many statements a snapshot keeps (by total execution time), plus every tagged refresh statement. */
export const MEAS_PGSTAT_STATEMENT_LIMIT = 250;
const STATEMENT_TEXT_LENGTH = 240;
const FAMILY_TAG = /^\s*\/\* analytics_v2:([a-z][a-z0-9_]{0,31}(?:\.[a-z][a-z0-9_]{0,31})?) \*\//u;
const STATEMENT_FIELDS = Object.freeze(["calls", "plans", "rows", "total_exec_time", "total_plan_time",
  "mean_exec_time", "max_exec_time", "shared_blks_hit", "shared_blks_read", "shared_blks_dirtied",
  "shared_blks_written", "local_blks_hit", "local_blks_read", "temp_blks_read", "temp_blks_written",
  "shared_blk_read_time", "shared_blk_write_time", "temp_blk_read_time", "temp_blk_write_time", "blk_read_time",
  "blk_write_time", "wal_records", "wal_bytes", "jit_functions"]);
const DATABASE_FIELDS = Object.freeze(["numbackends", "xact_commit", "xact_rollback", "blks_read", "blks_hit",
  "tup_returned", "tup_fetched", "tup_inserted", "tup_updated", "tup_deleted", "conflicts", "temp_files",
  "temp_bytes", "deadlocks", "blk_read_time", "blk_write_time", "session_time", "active_time",
  "idle_in_transaction_time", "sessions", "sessions_abandoned", "sessions_fatal", "sessions_killed"]);
const IO_FIELDS = Object.freeze(["reads", "read_time", "writes", "write_time", "writebacks", "writeback_time",
  "extends", "extend_time", "op_bytes", "hits", "evictions", "reuses", "fsyncs", "fsync_time"]);
const IO_KEYS = Object.freeze(["backend_type", "object", "context"]);
const WAL_FIELDS = Object.freeze(["wal_records", "wal_fpi", "wal_bytes", "wal_buffers_full", "wal_write", "wal_sync",
  "wal_write_time", "wal_sync_time"]);
const CHECKPOINT_FIELDS = Object.freeze(["num_timed", "num_requested", "restartpoints_timed", "write_time", "sync_time",
  "buffers_written", "checkpoints_timed", "checkpoints_req", "checkpoint_write_time", "checkpoint_sync_time",
  "buffers_checkpoint", "buffers_clean", "maxwritten_clean", "buffers_backend", "buffers_alloc"]);
const TABLE_FIELDS = Object.freeze(["seq_scan", "seq_tup_read", "idx_scan", "idx_tup_fetch", "n_tup_ins", "n_tup_upd",
  "n_tup_del", "n_live_tup", "heap_blks_read", "heap_blks_hit", "idx_blks_read", "idx_blks_hit", "toast_blks_read",
  "toast_blks_hit"]);
/** The settings that explain the counters (names only from this list are read). */
export const MEAS_PGSTAT_SETTINGS = Object.freeze(["server_version_num", "track_io_timing", "track_activity_query_size",
  "pg_stat_statements.track", "pg_stat_statements.max", "pg_stat_statements.track_utility", "shared_buffers",
  "work_mem", "maintenance_work_mem", "effective_cache_size", "random_page_cost", "max_parallel_workers_per_gather",
  "max_connections", "jit", "default_statistics_target"]);
const KNOWN_APPLICATIONS = Object.freeze(["tibotattle-analytics-refresh", "tibotattle-fastpath-seed",
  "tibotattle-meas-pgstat", "tibotattle-fastpath-d1-verify"]);
const LABEL = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const SEEDED_SCHEMA_PREFIX = "typed_legacy_transfer_rehearsal_target_fastpath_";

function fail(code, detail) {
  throw Object.assign(new Error(detail === undefined ? code : `${code}: ${detail}`), { code });
}

/** A content-free statement text: literals replaced, whitespace collapsed, cut to 240 characters. */
export function measStatementText(text) {
  if (typeof text !== "string") return null;
  if (text === "<insufficient privilege>") return "(hidden)";
  // Literals become a quote-free marker first, so a cut-off literal (no
  // closing quote) is caught by the last rule, then the marker becomes '?'.
  return text
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/gu, "\u0000")
    .replace(/[Ee]?'(?:[^']|'')*'/gu, "\u0000")
    .replace(/'[\s\S]*$/u, "\u0000")
    .replace(/\u0000/gu, "'?'")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, STATEMENT_TEXT_LENGTH);
}

/** The refresh's statement family, or null. */
export function measStatementFamily(text) {
  const match = typeof text === "string" ? FAMILY_TAG.exec(text) : null;
  return match === null ? null : match[1];
}

/** A role as a class, never its name. */
export function measRoleClass(name, { migrator, runtime } = {}) {
  if (typeof name !== "string") return "other";
  if (name === migrator) return "migrator";
  if (name === runtime) return "runtime";
  if (name === "cloudsqladmin" || name === "cloudsqlagent") return "cloudsqladmin";
  if (name === "postgres") return "postgres";
  return "other";
}

function applicationClass(name) {
  if (typeof name !== "string" || name.length === 0) return "none";
  return KNOWN_APPLICATIONS.includes(name) ? name : "other";
}

function pick(row, fields) {
  const out = {};
  for (const field of fields) {
    const value = row?.[field];
    if (value === null || value === undefined) continue;
    const number = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(number)) out[field] = number;
  }
  return out;
}

function closedText(value, pattern = /^[a-z][a-z0-9 _-]{0,63}$/iu) {
  return typeof value === "string" && pattern.test(value) ? value : "other";
}

/**
 * One snapshot (see the header). `client` is one pg client; `roles` names the
 * migrator and runtime IAM users so their rows are classed. Never writes.
 */
export async function readMeasPgStat(client, { label, roles = {}, wallClock = Date.now } = {}) {
  if (!LABEL.test(label ?? "")) fail("MEAS_PGSTAT_LABEL_INVALID", String(label));
  const takenAt = new Date(wallClock()).toISOString();
  const snapshot = { schemaVersion: MEAS_PGSTAT_SCHEMA, label, takenAt, settings: {}, extension: null,
    statements: null, statementsTotal: null, hiddenStatements: null, database: null, io: null, wal: null,
    checkpointer: null, tables: null, sessions: null, errors: [] };
  const section = async (name, run) => {
    try {
      await client.query(`SAVEPOINT ${name}`);
      await run();
      await client.query(`RELEASE SAVEPOINT ${name}`);
    } catch (error) {
      snapshot.errors.push({ section: name, sqlState: typeof error?.code === "string" && /^[0-9A-Z]{5}$/u.test(error.code)
        ? error.code : null });
      try { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); } catch { /* the transaction ends below */ }
    }
  };
  await client.query("BEGIN READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout = '60s'");
    await section("settings", async () => {
      const result = await client.query("SELECT name, setting, unit FROM pg_settings WHERE name = ANY($1::text[])",
        [MEAS_PGSTAT_SETTINGS]);
      for (const row of result.rows) {
        snapshot.settings[row.name] = { setting: closedText(row.setting, /^[A-Za-z0-9_.,-]{0,64}$/u),
          unit: row.unit === null ? null : closedText(row.unit, /^[A-Za-z0-9]{0,8}$/u) };
      }
    });
    await section("extension", async () => {
      const result = await client.query("SELECT extversion FROM pg_extension WHERE extname = 'pg_stat_statements'");
      snapshot.extension = result.rows[0] === undefined ? null
        : { name: "pg_stat_statements", version: closedText(result.rows[0].extversion, /^[0-9.]{1,16}$/u) };
    });
    if (snapshot.extension !== null) {
      await section("statements", async () => {
        const result = await client.query(`SELECT pg_get_userbyid(s.userid) AS role, s.queryid::text AS queryid,
            s.toplevel, s.query, to_jsonb(s) - 'query' AS figures
          FROM pg_stat_statements s
         WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`);
        snapshot.statementsTotal = result.rows.length;
        snapshot.hiddenStatements = result.rows.filter((row) => row.query === "<insufficient privilege>").length;
        const rows = result.rows.map((row) => ({
          queryid: /^-?\d{1,20}$/u.test(row.queryid ?? "") ? row.queryid : null,
          role: measRoleClass(row.role, roles),
          toplevel: row.toplevel === true,
          family: measStatementFamily(row.query),
          text: measStatementText(row.query),
          ...pick(row.figures, STATEMENT_FIELDS),
        }));
        rows.sort((left, right) => (right.total_exec_time ?? 0) - (left.total_exec_time ?? 0));
        snapshot.statements = rows.filter((row, index) => index < MEAS_PGSTAT_STATEMENT_LIMIT || row.family !== null);
      });
    }
    await section("database", async () => {
      const result = await client.query(`SELECT to_jsonb(d) AS row FROM pg_stat_database d
        WHERE d.datname = current_database()`);
      snapshot.database = result.rows[0] === undefined ? null : pick(result.rows[0].row, DATABASE_FIELDS);
    });
    await section("io", async () => {
      const result = await client.query("SELECT to_jsonb(i) AS row FROM pg_stat_io i");
      snapshot.io = result.rows.map(({ row }) => ({
        ...Object.fromEntries(IO_KEYS.map((key) => [key, closedText(row?.[key])])),
        ...pick(row, IO_FIELDS),
      })).filter((row) => Object.keys(row).length > IO_KEYS.length);
    });
    await section("wal", async () => {
      const result = await client.query("SELECT to_jsonb(w) AS row FROM pg_stat_wal w");
      snapshot.wal = result.rows[0] === undefined ? null : pick(result.rows[0].row, WAL_FIELDS);
    });
    await section("checkpointer", async () => {
      const present = await client.query("SELECT to_regclass('pg_catalog.pg_stat_checkpointer') IS NOT NULL AS present");
      const view = present.rows[0]?.present === true ? "pg_stat_checkpointer" : "pg_stat_bgwriter";
      const result = await client.query(`SELECT to_jsonb(c) AS row FROM pg_catalog.${view} c`);
      snapshot.checkpointer = result.rows[0] === undefined ? null : { view, ...pick(result.rows[0].row, CHECKPOINT_FIELDS) };
    });
    await section("tables", async () => {
      const result = await client.query(`SELECT t.relname, to_jsonb(t) AS stat, to_jsonb(io) AS io
          FROM pg_stat_user_tables t JOIN pg_statio_user_tables io USING (relid)
         WHERE t.schemaname LIKE $1
         ORDER BY coalesce(io.heap_blks_read, 0) + coalesce(io.heap_blks_hit, 0)
           + coalesce(io.idx_blks_read, 0) + coalesce(io.idx_blks_hit, 0) DESC
         LIMIT 60`, [`${SEEDED_SCHEMA_PREFIX.replaceAll("_", "\\_")}%`]);
      snapshot.tables = result.rows.map((row) => ({ table: closedText(row.relname, /^[a-z_][a-z0-9_]{0,62}$/u),
        ...pick({ ...row.stat, ...row.io }, TABLE_FIELDS) }));
    });
    await section("sessions", async () => {
      const result = await client.query(`SELECT pg_get_userbyid(usesysid) AS role, application_name, backend_type,
          state, wait_event_type, wait_event, count(*)::int AS sessions
        FROM pg_stat_activity WHERE pid <> pg_backend_pid()
        GROUP BY 1, 2, 3, 4, 5, 6`);
      const grouped = new Map();
      for (const row of result.rows) {
        const key = JSON.stringify([measRoleClass(row.role, roles), applicationClass(row.application_name),
          closedText(row.backend_type), row.state === null ? null : closedText(row.state),
          row.wait_event_type === null ? null : closedText(row.wait_event_type, /^[A-Za-z]{1,32}$/u),
          row.wait_event === null ? null : closedText(row.wait_event, /^[A-Za-z0-9]{1,64}$/u)]);
        grouped.set(key, (grouped.get(key) ?? 0) + Number(row.sessions));
      }
      snapshot.sessions = [...grouped].sort(([left], [right]) => (left < right ? -1 : 1)).map(([key, sessions]) => {
        const [role, application, backendType, state, waitEventType, waitEvent] = JSON.parse(key);
        return { role, application, backendType, state, waitEventType, waitEvent, sessions };
      });
    });
  } finally {
    await client.query("ROLLBACK").catch(() => {});
  }
  return snapshot;
}

function subtract(after, before, fields) {
  const out = {};
  for (const field of fields) {
    if (typeof after?.[field] !== "number") continue;
    out[field] = after[field] - (typeof before?.[field] === "number" ? before[field] : 0);
  }
  return out;
}

/**
 * after - before: statements by queryid and role (ranked by execution time,
 * the top `limit`), the database, I/O and WAL counters. A statement missing
 * from `before` counts from zero.
 */
export function measPgStatDelta(before, after, { limit = 40 } = {}) {
  const key = (row) => `${row.queryid}|${row.role}|${row.toplevel}`;
  const was = new Map((before?.statements ?? []).map((row) => [key(row), row]));
  const statements = [];
  let execMs = 0;
  let planMs = 0;
  for (const row of after?.statements ?? []) {
    const delta = subtract(row, was.get(key(row)), STATEMENT_FIELDS.filter((field) => !field.startsWith("mean_")
      && !field.startsWith("max_")));
    if (!(delta.calls > 0)) continue;
    execMs += delta.total_exec_time ?? 0;
    planMs += delta.total_plan_time ?? 0;
    statements.push({ queryid: row.queryid, role: row.role, family: row.family, text: row.text, ...delta });
  }
  statements.sort((left, right) => (right.total_exec_time ?? 0) - (left.total_exec_time ?? 0));
  const ioKey = (row) => IO_KEYS.map((field) => row[field]).join("|");
  const ioBefore = new Map((before?.io ?? []).map((row) => [ioKey(row), row]));
  const io = (after?.io ?? []).map((row) => ({ ...Object.fromEntries(IO_KEYS.map((field) => [field, row[field]])),
    ...subtract(row, ioBefore.get(ioKey(row)), IO_FIELDS.filter((field) => field !== "op_bytes")) }))
    .filter((row) => IO_FIELDS.some((field) => typeof row[field] === "number" && row[field] !== 0));
  return {
    schemaVersion: `${MEAS_PGSTAT_SCHEMA}-delta`,
    from: { label: before?.label ?? null, takenAt: before?.takenAt ?? null },
    to: { label: after?.label ?? null, takenAt: after?.takenAt ?? null },
    statementsComparable: before?.extension !== null && after?.extension !== null
      && before?.statements !== null && after?.statements !== null,
    execMs: Math.round(execMs),
    planMs: Math.round(planMs),
    statements: statements.slice(0, limit),
    database: subtract(after?.database, before?.database, DATABASE_FIELDS.filter((field) => field !== "numbackends")),
    io,
    wal: subtract(after?.wal, before?.wal, WAL_FIELDS),
  };
}
