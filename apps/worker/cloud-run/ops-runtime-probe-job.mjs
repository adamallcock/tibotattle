#!/usr/bin/env node

/**
 * ops-runtime-probe-job: the OPS-4 runtime liveness probe, a Cloud Run Job
 * (build entry "ops-runtime-probe-job" -> dist/ops-runtime-probe-job.mjs).
 *
 * One execution reads a fixed set of content-free signals from the primary
 * database and writes one JSON line per signal (cloud-run/ops-probe-contract.mjs
 * OPS_PROBES), so log-based metrics and alerts can watch liveness without
 * ever reading a row of owner data. It is a separate workload from the
 * origin: it has no HOST_MODE, serves nothing and takes no secret.
 *
 * Read only. The probe holds one primary connection (createIamPool max 1)
 * and every read is its own `BEGIN READ ONLY` transaction with
 * `SET LOCAL statement_timeout = 2000` and `SET LOCAL lock_timeout = 500`,
 * so a signal is either on time or unavailable. The one exception is
 * --probe=log-redaction, which needs a TEMP table (a read-only transaction
 * refuses CREATE) and rolls it back: it writes no persistent relation.
 *
 * Signals (the closed names are in the contract):
 *   - lifecycle: age of the last completed maintenance pass
 *     (retention_state.last_completed_at);
 *   - analytics: age of the last complete refresh run (analytics_v2_runs),
 *     and the age in days of the newest published community day
 *     (analytics_v2_published_daily);
 *   - the global ingestion journal (the source named by storage_source_state):
 *     head sequence and age, the lag to the analytics cursor, the pending
 *     rows counted up to OPS_BACKLOG_CAP (10001, exact below it) and the age
 *     of the oldest undelivered row;
 *   - v1.2 delivery: age of the newest ready manifest;
 *   - the database: size, transaction-id and multixact age, the cumulative
 *     deadlock and conflict counts (the probe keeps no state, so a consumer
 *     differences two lines);
 *   - sessions by application class: lock waiters, the oldest open
 *     transaction, and the idle-in-transaction count. These read
 *     pg_stat_activity, which hides other roles' sessions from a role that is
 *     not a member of pg_read_all_stats. Without membership the three signals
 *     are unavailable (PRIVILEGE_MISSING): a count over only the visible
 *     sessions would read healthy while hiding the sessions that matter. The
 *     probe never selects query text, and never prints an application name.
 *
 * Missing evidence is `unavailable` with a closed reason, never 0. A database
 * error becomes a closed reason and its two-character SQLSTATE class; its
 * message, detail and query are never read. The whole run has a 100 s
 * deadline, inside the 120 s task timeout.
 *
 * --probe=log-redaction (the log-redaction marker): inserts one fresh random
 * marker twice into a TEMP table so PostgreSQL raises a unique violation
 * (SQLSTATE 23505), then rolls back. Cloud SQL runs with
 * log_error_verbosity=terse, so the error line must not carry the DETAIL
 * "Key (...)=(marker)". The job writes the marker and 1 when the violation
 * occurred as expected; an operator then searches the Cloud SQL logs for the
 * marker and expects no match. A second line says whether the five logging
 * settings that keep errors content-free still hold.
 *
 * Arguments (closed): none, --probe=log-redaction, or --help alone.
 *
 * Environment (closed; cloud-run/ops-probe-contract.mjs readOpsProbeEnvironment):
 *   CLOUD_RUN_JOB, DEPLOYMENT_SOURCE_COMMIT, OPS_PROBE_TARGET,
 *   PRIMARY_INSTANCE_CONNECTION_NAME, PRIMARY_DATABASE, PRIMARY_SCHEMA,
 *   POSTGRES_IAM_USER. Refused: HOST_MODE, K_SERVICE, PG_TEST_*, any other
 *   OPS_PROBE_* variable and any credential-named variable.
 *
 * Output: one JSON line per signal on stdout. Exit 0 once the signals ran,
 * whatever their state; 1 for a configuration or connection failure (one
 * {schema, job, status:"failed", code} line on stderr); 2 for a usage refusal.
 */

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connector } from "@google-cloud/cloud-sql-connector";
import { closeCloudSqlResources, createIamPool } from "./cloud-sql.mjs";
import {
  OPS_ACTIVITY_CLASSES,
  OPS_BACKLOG_CAP,
  OPS_LOG_REDACTION_SETTINGS,
  OPS_PROBE_JOBS,
  OPS_PROBE_SCHEMA,
  buildOpsProbeLine,
  buildOpsProbeUnavailable,
  opsActivityClass,
  opsProbeFailureFromError,
  readOpsProbeEnvironment,
  safeOpsProbeCode,
  serializeOpsProbeLine,
} from "./ops-probe-contract.mjs";

export const OPS_RUNTIME_PROBE_JOB = "ops-runtime-probe";
export const OPS_RUNTIME_PROBE_ENTRY = OPS_PROBE_JOBS[OPS_RUNTIME_PROBE_JOB].entry;
export const OPS_RUNTIME_PROBE_MODES = Object.freeze(["collect", "log-redaction"]);

export const OPS_RUNTIME_PROBE_USAGE = `Usage: node ops-runtime-probe-job.mjs [--probe=log-redaction]

Read the content-free runtime liveness signals of the primary database and
write one JSON line per signal. Cloud Run Jobs only, every 5 minutes. Exits 0
(the signals ran), 1 (configuration or connection failure) or 2 (usage).

  --probe=log-redaction  force one duplicate-key error on a temp table, roll
                         back, and write the marker for the log search
  --help                 print this text
`;

const POOL_MAX = OPS_PROBE_JOBS[OPS_RUNTIME_PROBE_JOB].pools.primary;
const STATEMENT_TIMEOUT_MS = OPS_PROBE_JOBS[OPS_RUNTIME_PROBE_JOB].statementTimeoutMilliseconds;
const LOCK_TIMEOUT_MS = OPS_PROBE_JOBS[OPS_RUNTIME_PROBE_JOB].lockTimeoutMilliseconds;
const DEADLINE_MS = OPS_PROBE_JOBS[OPS_RUNTIME_PROBE_JOB].deadlineSeconds * 1_000;
const APPLICATION_NAME = OPS_PROBE_JOBS[OPS_RUNTIME_PROBE_JOB].applicationName;

const SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]{0,18})$/u;
/** An age read as a signed integer: two machines' clocks can differ, so it can come back below 0. */
const SIGNED_DECIMAL = /^-?(?:0|[1-9][0-9]{0,18})$/u;
/** cloud-sql.mjs throws these constant messages without a `code`. */
const CLOUD_SQL_MESSAGES = new Set([
  "CLOUD_SQL_CONNECTOR_OPTIONS_FAILED",
  "CLOUD_SQL_CONNECTOR_CLOSE_FAILED",
  "POSTGRES_CONNECTION_FAILED",
  "POSTGRES_POOL_CLOSE_FAILED",
  "INSTANCE_CONNECTION_NAME_INVALID",
  "POSTGRES_DATABASE_INVALID",
  "POSTGRES_IAM_USER_MISSING",
  "POSTGRES_IAM_USER_INVALID",
]);
const FLAG = /^--([a-z-]+)=(.*)$/su;
const MARKER_TABLE = "ops_probe_log_redaction";

function fail(code, extra = {}) {
  throw Object.assign(new Error(code), { code, ...extra });
}

/** Parse the closed argument list. */
export function parseOpsRuntimeProbeArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    fail("OPS_RUNTIME_PROBE_ARGUMENTS_INVALID", { usage: true });
  }
  if (argv.includes("--help")) {
    if (argv.length !== 1) fail("OPS_RUNTIME_PROBE_ARGUMENTS_INVALID", { usage: true });
    return Object.freeze({ help: true, mode: null });
  }
  if (argv.length === 0) return Object.freeze({ help: false, mode: "collect" });
  if (argv.length > 1) fail("OPS_RUNTIME_PROBE_ARGUMENTS_INVALID", { usage: true });
  const match = FLAG.exec(argv[0]);
  if (match === null || match[1] !== "probe" || match[2] !== "log-redaction") {
    fail("OPS_RUNTIME_PROBE_ARGUMENTS_INVALID", { usage: true });
  }
  return Object.freeze({ help: false, mode: "log-redaction" });
}

function quoteSchema(schema) {
  if (typeof schema !== "string" || !SCHEMA_IDENTIFIER.test(schema) || schema.startsWith("pg_")
      || schema === "information_schema") {
    fail("OPS_RUNTIME_PROBE_SCHEMA_INVALID");
  }
  return `"${schema}"`;
}

/** A decimal string from the database as a safe integer, else null. */
function safeInteger(text) {
  if (typeof text !== "string" || !DECIMAL.test(text)) return null;
  const value = BigInt(text);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

const ok = (probe, value, extra = {}) => buildOpsProbeLine({ probe, state: "ok", value, ...extra });
const noData = (probe, klass) => buildOpsProbeUnavailable(probe, { reason: "NO_DATA" }, klass);
const unreadable = (probe, reason, klass) => buildOpsProbeUnavailable(probe, { reason }, klass);

/** An age (seconds or days) as a safe integer, clamped at 0, else null. */
function ageInteger(text) {
  if (typeof text !== "string" || !SIGNED_DECIMAL.test(text)) return null;
  const value = BigInt(text);
  if (value < 0n) return 0;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

/**
 * One value from a one-row result as a line: a safe integer, else NO_DATA for
 * an empty result or a NULL, else a closed refusal. `age` clamps at 0.
 */
function integerLine(probe, text, { noRow = false, age = false } = {}) {
  if (noRow || text === null || text === undefined) return noData(probe);
  const value = age ? ageInteger(text) : safeInteger(text);
  return value === null ? unreadable(probe, "VALUE_OUT_OF_RANGE") : ok(probe, value);
}

/** An age in whole seconds never reads negative: clocks on two machines can differ. */
function ageSeconds(nowMs, recordedMs) {
  return Math.max(0, Math.floor((nowMs - recordedMs) / 1_000));
}

// ---------------------------------------------------------------------------
// Reads. Each takes the connected client and returns lines. A throw is turned
// into unavailable lines for exactly that group's signals.

async function readOnly(client, work) {
  await client.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
  try {
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
    const result = await work();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* the connection is already unusable */ }
    throw error;
  }
}

async function one(client, text, values) {
  const result = await client.query(text, values);
  if (result === null || typeof result !== "object" || !Array.isArray(result.rows)) fail("UNEXPECTED_RESULT");
  return result.rows;
}

function maintenanceGroup(schema) {
  const s = quoteSchema(schema);
  return {
    slots: [{ probe: "maintenance_completed_age_seconds" }],
    async read(client) {
      const rows = await one(client, `SELECT floor(EXTRACT(EPOCH FROM (clock_timestamp() - last_completed_at)))::bigint::text AS age
  FROM ${s}."retention_state" WHERE singleton = 1`);
      return [integerLine("maintenance_completed_age_seconds", rows[0]?.age, { noRow: rows.length === 0, age: true })];
    },
  };
}

function analyticsGroup(schema) {
  const s = quoteSchema(schema);
  return {
    slots: [{ probe: "analytics_refresh_completed_age_seconds" }],
    async read(client) {
      const rows = await one(client, `SELECT floor(EXTRACT(EPOCH FROM (clock_timestamp() - finished_at)))::bigint::text AS age
  FROM ${s}."analytics_v2_runs" WHERE state = 'complete' ORDER BY finished_at DESC LIMIT 1`);
      return [integerLine("analytics_refresh_completed_age_seconds", rows[0]?.age, { noRow: rows.length === 0, age: true })];
    },
  };
}

function communityDailyGroup(schema) {
  const s = quoteSchema(schema);
  return {
    slots: [{ probe: "community_daily_head_age_days" }],
    async read(client) {
      const rows = await one(client, `SELECT ((now() AT TIME ZONE 'UTC')::date - max(day))::text AS age
  FROM ${s}."analytics_v2_published_daily"`);
      return [integerLine("community_daily_head_age_days", rows[0]?.age, { noRow: rows.length === 0, age: true })];
    },
  };
}

function v12ManifestGroup(schema) {
  const s = quoteSchema(schema);
  return {
    slots: [{ probe: "v12_newest_ready_manifest_age_seconds" }],
    async read(client) {
      const rows = await one(client, `SELECT floor(EXTRACT(EPOCH FROM (clock_timestamp() - max(ready_at))))::bigint::text AS age
  FROM ${s}."telemetry_v12_day_manifests" WHERE state = 'ready'`);
      return [integerLine("v12_newest_ready_manifest_age_seconds", rows[0]?.age, { noRow: rows.length === 0, age: true })];
    },
  };
}

function journalHeadGroup(schema) {
  const s = quoteSchema(schema);
  return {
    slots: [{ probe: "ingestion_journal_head_sequence" }, { probe: "ingestion_journal_head_age_seconds" }],
    async read(client) {
      // The one global journal is the source storage_source_state names; the
      // read walks the (source_id, sequence) primary key backwards one row.
      const rows = await one(client, `SELECT head.sequence::text AS sequence,
       head.recorded_ms::text AS recorded_ms,
       floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint::text AS now_ms
  FROM ${s}."storage_source_state" source
  LEFT JOIN LATERAL (
    SELECT change.sequence, change.recorded_ms FROM ${s}."storage_ingestion_changes" change
     WHERE change.source_id = source.source_id ORDER BY change.sequence DESC LIMIT 1
  ) head ON true
 WHERE source.singleton = 1`);
      if (rows.length === 0) return [noData("ingestion_journal_head_sequence"), noData("ingestion_journal_head_age_seconds")];
      const [row] = rows;
      // A source with no journal row yet has head sequence 0 and no age to report.
      if (row.sequence === null || row.sequence === undefined) {
        return [ok("ingestion_journal_head_sequence", 0), noData("ingestion_journal_head_age_seconds")];
      }
      const sequence = safeInteger(row.sequence);
      const recorded = safeInteger(row.recorded_ms);
      const now = safeInteger(row.now_ms);
      return [
        sequence === null ? unreadable("ingestion_journal_head_sequence", "VALUE_OUT_OF_RANGE")
          : ok("ingestion_journal_head_sequence", sequence),
        recorded === null || now === null ? unreadable("ingestion_journal_head_age_seconds", "VALUE_OUT_OF_RANGE")
          : ok("ingestion_journal_head_age_seconds", ageSeconds(now, recorded)),
      ];
    },
  };
}

function journalBacklogGroup(schema) {
  const s = quoteSchema(schema);
  const names = ["analytics_journal_lag_sequences", "analytics_journal_pending_events",
    "analytics_journal_oldest_undelivered_age_seconds"];
  return {
    slots: names.map((probe) => ({ probe })),
    async read(client) {
      // One read of the source, its head and the analytics cursor (absent
      // until the first run, which the admin overview also reads as 0).
      const rows = await one(client, `SELECT source.source_id AS source_id,
       COALESCE((SELECT max(change.sequence) FROM ${s}."storage_ingestion_changes" change
                  WHERE change.source_id = source.source_id), 0)::text AS head,
       (SELECT cursor.last_sequence::text FROM ${s}."analytics_v2_journal_cursor" cursor WHERE cursor.id = 1) AS cursor
  FROM ${s}."storage_source_state" source WHERE source.singleton = 1`);
      if (rows.length === 0) return names.map((probe) => noData(probe));
      const head = safeInteger(rows[0].head);
      const cursor = rows[0].cursor === null || rows[0].cursor === undefined ? 0 : safeInteger(rows[0].cursor);
      if (head === null || cursor === null) return names.map((probe) => unreadable(probe, "VALUE_OUT_OF_RANGE"));
      // A cursor ahead of its own journal is evidence of a fault, not a lag.
      if (cursor > head) return names.map((probe) => unreadable(probe, "UNEXPECTED_RESULT"));
      const sourceId = rows[0].source_id;
      const pending = await one(client, `SELECT count(*)::text AS pending FROM (
  SELECT 1 FROM ${s}."storage_ingestion_changes" change
   WHERE change.source_id = $1 AND change.sequence > $2::bigint ORDER BY change.sequence LIMIT ${OPS_BACKLOG_CAP}
) bounded`, [sourceId, String(cursor)]);
      const count = safeInteger(pending[0]?.pending);
      const oldest = await one(client, `SELECT change.recorded_ms::text AS recorded_ms,
       floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint::text AS now_ms
  FROM ${s}."storage_ingestion_changes" change
 WHERE change.source_id = $1 AND change.sequence > $2::bigint ORDER BY change.sequence LIMIT 1`,
      [sourceId, String(cursor)]);
      let age;
      if (oldest.length === 0) {
        // Nothing is undelivered: no row waits, so its age is 0 (evidence, not a gap).
        age = ok("analytics_journal_oldest_undelivered_age_seconds", 0);
      } else {
        const recorded = safeInteger(oldest[0].recorded_ms);
        const now = safeInteger(oldest[0].now_ms);
        age = recorded === null || now === null
          ? unreadable("analytics_journal_oldest_undelivered_age_seconds", "VALUE_OUT_OF_RANGE")
          : ok("analytics_journal_oldest_undelivered_age_seconds", ageSeconds(now, recorded));
      }
      return [
        ok("analytics_journal_lag_sequences", head - cursor),
        count === null || count > OPS_BACKLOG_CAP ? unreadable("analytics_journal_pending_events", "UNEXPECTED_RESULT")
          : ok("analytics_journal_pending_events", count, { capped: count === OPS_BACKLOG_CAP }),
        age,
      ];
    },
  };
}

function databaseGroup() {
  const names = ["database_size_bytes", "database_xid_age", "database_mxid_age"];
  return {
    slots: names.map((probe) => ({ probe })),
    async read(client) {
      const rows = await one(client, `SELECT pg_database_size(current_database())::text AS size,
       age(datfrozenxid)::text AS xid_age,
       mxid_age(datminmxid)::text AS mxid_age
  FROM pg_database WHERE datname = current_database()`);
      if (rows.length === 0) return names.map((probe) => noData(probe));
      return [integerLine("database_size_bytes", rows[0].size), integerLine("database_xid_age", rows[0].xid_age),
        integerLine("database_mxid_age", rows[0].mxid_age)];
    },
  };
}

function databaseStatsGroup() {
  const names = ["database_deadlocks_total", "database_conflicts_total"];
  return {
    slots: names.map((probe) => ({ probe })),
    async read(client) {
      const rows = await one(client, `SELECT deadlocks::text AS deadlocks, conflicts::text AS conflicts
  FROM pg_stat_database WHERE datname = current_database()`);
      if (rows.length === 0) return names.map((probe) => noData(probe));
      return [integerLine("database_deadlocks_total", rows[0].deadlocks),
        integerLine("database_conflicts_total", rows[0].conflicts)];
    },
  };
}

const IDLE_IN_TRANSACTION = new Set(["idle in transaction", "idle in transaction (aborted)"]);

function activityGroup() {
  const slots = [
    ...OPS_ACTIVITY_CLASSES.map((klass) => ({ probe: "lock_waiting_sessions", class: klass })),
    ...OPS_ACTIVITY_CLASSES.map((klass) => ({ probe: "oldest_transaction_age_seconds", class: klass })),
    { probe: "idle_in_transaction_sessions" },
  ];
  return {
    slots,
    async read(client) {
      const access = await one(client, "SELECT pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS allowed");
      if (access[0]?.allowed !== true) {
        // Other roles' sessions are hidden from this role, so any count would
        // be a count of only the visible ones.
        return slots.map((slot) => unreadable(slot.probe, "PRIVILEGE_MISSING", slot.class));
      }
      // No query text: only the class inputs, the wait type, the state and an age.
      const rows = await one(client, `SELECT application_name AS application, state, wait_event_type AS wait_type,
       CASE WHEN xact_start IS NULL THEN NULL
            ELSE floor(EXTRACT(EPOCH FROM (clock_timestamp() - xact_start)))::bigint::text END AS transaction_age
  FROM pg_stat_activity
 WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()`);
      const waiting = Object.fromEntries(OPS_ACTIVITY_CLASSES.map((klass) => [klass, 0]));
      const oldest = Object.fromEntries(OPS_ACTIVITY_CLASSES.map((klass) => [klass, 0]));
      let idle = 0;
      for (const row of rows) {
        const klass = opsActivityClass(row.application);
        if (row.wait_type === "Lock") waiting[klass] += 1;
        if (IDLE_IN_TRANSACTION.has(row.state)) idle += 1;
        if (row.transaction_age !== null && row.transaction_age !== undefined) {
          const age = safeInteger(row.transaction_age);
          if (age === null) fail("VALUE_OUT_OF_RANGE");
          oldest[klass] = Math.max(oldest[klass], age);
        }
      }
      return [
        ...OPS_ACTIVITY_CLASSES.map((klass) => ok("lock_waiting_sessions", waiting[klass], { class: klass })),
        ...OPS_ACTIVITY_CLASSES.map((klass) => ok("oldest_transaction_age_seconds", oldest[klass], { class: klass })),
        ok("idle_in_transaction_sessions", idle),
      ];
    },
  };
}

function collectGroups(schema) {
  return [
    maintenanceGroup(schema), analyticsGroup(schema), communityDailyGroup(schema), v12ManifestGroup(schema),
    journalHeadGroup(schema), journalBacklogGroup(schema), databaseGroup(), databaseStatsGroup(), activityGroup(),
  ];
}

/**
 * Read every group on one connected client, in order, each in its own
 * read-only transaction. A group past the deadline, or whose read throws,
 * answers unavailable for exactly its own signals. Returns frozen lines.
 */
export async function collectOpsRuntimeSignals({ client, schema, now = Date.now, deadlineMs = DEADLINE_MS }) {
  const startedAt = now();
  const lines = [];
  for (const group of collectGroups(schema)) {
    if (now() - startedAt >= deadlineMs) {
      lines.push(...group.slots.map((slot) => unreadable(slot.probe, "DEADLINE_EXCEEDED", slot.class)));
      continue;
    }
    try {
      lines.push(...await readOnly(client, () => group.read(client)));
    } catch (error) {
      const failure = error?.code === "UNEXPECTED_RESULT" || error?.code === "VALUE_OUT_OF_RANGE"
        ? { reason: error.code } : opsProbeFailureFromError(error);
      lines.push(...group.slots.map((slot) => buildOpsProbeUnavailable(slot.probe, failure, slot.class)));
    }
  }
  return Object.freeze(lines);
}

// ---------------------------------------------------------------------------
// --probe=log-redaction

/**
 * Force one duplicate-key error on a TEMP table and roll back. Returns the
 * marker lines. The error is expected (SQLSTATE 23505); any other outcome is
 * an unavailable marker, never a pass. The marker is a fresh random token and
 * is the only value ever inserted.
 */
export async function runLogRedactionProbe({ client, randomHex = (bytes) => randomBytes(bytes).toString("hex") }) {
  const marker = `tibotattle-log-redaction-${randomHex(16)}`;
  let marked;
  try {
    // A read-only transaction refuses CREATE, so this one is read-write; it
    // creates only a TEMP table, never commits and leaves no relation.
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
      await client.query(`CREATE TEMP TABLE ${MARKER_TABLE} (marker text PRIMARY KEY) ON COMMIT DROP`);
      await client.query(`INSERT INTO ${MARKER_TABLE} (marker) VALUES ($1)`, [marker]);
      await client.query(`INSERT INTO ${MARKER_TABLE} (marker) VALUES ($1)`, [marker]);
      marked = buildOpsProbeUnavailable("log_redaction_marker", { reason: "UNEXPECTED_RESULT" });
    } catch (error) {
      marked = error?.code === "23505"
        ? ok("log_redaction_marker", 1, { marker })
        : buildOpsProbeUnavailable("log_redaction_marker", opsProbeFailureFromError(error));
    } finally {
      try { await client.query("ROLLBACK"); } catch { /* the connection is already unusable */ }
    }
  } catch (error) {
    marked = buildOpsProbeUnavailable("log_redaction_marker", opsProbeFailureFromError(error));
  }
  return Object.freeze([marked, await readLogRedactionPosture(client)]);
}

async function readLogRedactionPosture(client) {
  try {
    const names = Object.keys(OPS_LOG_REDACTION_SETTINGS);
    const columns = names.map((name, index) => `current_setting('${name}', false) AS s${index}`).join(", ");
    const holds = await readOnly(client, async () => {
      const rows = await one(client, `SELECT ${columns}`);
      const row = rows[0];
      if (row === undefined) fail("UNEXPECTED_RESULT");
      return names.every((name, index) => row[`s${index}`] === OPS_LOG_REDACTION_SETTINGS[name]);
    });
    return ok("log_redaction_posture", holds ? 1 : 0);
  } catch (error) {
    return buildOpsProbeUnavailable("log_redaction_posture", error?.code === "UNEXPECTED_RESULT"
      ? { reason: "UNEXPECTED_RESULT" } : opsProbeFailureFromError(error));
  }
}

// ---------------------------------------------------------------------------
// The job

/** A closed code for stderr: an uppercase `code`, or one of cloud-sql.mjs's constant messages. */
export function safeOpsRuntimeProbeCode(error) {
  const code = error?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(code)) return code;
  if (error instanceof Error && CLOUD_SQL_MESSAGES.has(error.message)) return error.message;
  return safeOpsProbeCode(error, "OPS_RUNTIME_PROBE_FAILED");
}

/**
 * Run the probe. Dependencies are injectable for local qualification:
 * createConnector(), createIamPool(options) and randomHex(bytes). Returns
 * { status: 'help' } or { lines, exitCode }; configuration, usage and
 * connection refusals throw a coded Error.
 */
export async function runOpsRuntimeProbe({
  argv = process.argv.slice(2),
  env = process.env,
  dependencies = {},
  now = Date.now,
} = {}) {
  const args = parseOpsRuntimeProbeArguments(argv);
  if (args.help) return Object.freeze({ status: "help" });
  const configuration = readOpsProbeEnvironment(env, OPS_RUNTIME_PROBE_JOB);
  const connector = typeof dependencies.createConnector === "function"
    ? dependencies.createConnector() : new Connector();
  const pools = [];
  let client = null;
  try {
    const pool = await (dependencies.createIamPool ?? createIamPool)({
      connector,
      instanceConnectionName: configuration.instanceConnectionName,
      database: configuration.database,
      user: configuration.iamUser,
      max: POOL_MAX,
      applicationName: APPLICATION_NAME,
    });
    pools.push(pool);
    client = await pool.connect();
    const lines = args.mode === "log-redaction"
      ? await runLogRedactionProbe({ client, ...(dependencies.randomHex === undefined ? {} : { randomHex: dependencies.randomHex }) })
      : await collectOpsRuntimeSignals({ client, schema: configuration.schema, now });
    return Object.freeze({ lines, exitCode: 0 });
  } finally {
    try { client?.release(); } catch { /* the pool closes below */ }
    await closeCloudSqlResources({ pools, connector });
  }
}

async function main() {
  try {
    const result = await runOpsRuntimeProbe();
    if (result.status === "help") {
      process.stdout.write(OPS_RUNTIME_PROBE_USAGE);
      return;
    }
    process.stdout.write(`${result.lines.map(serializeOpsProbeLine).join("\n")}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schema: OPS_PROBE_SCHEMA,
      job: OPS_RUNTIME_PROBE_JOB,
      status: "failed",
      code: safeOpsRuntimeProbeCode(error),
    })}\n`);
    process.exitCode = error?.usage === true ? 2 : 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
