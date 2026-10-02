/**
 * OPS-4 probe contract: the closed, content-free line the two ops probe jobs
 * write, and the job definitions a scheduler registration would read.
 *
 *   cloud-run/ops-runtime-probe-job.mjs   runtime liveness probe (read only)
 *   cloud-run/ops-backup-audit-job.mjs    backup-audit probe (Cloud SQL Admin API)
 *
 * Runtime-neutral leaf: no process, filesystem, network or database access,
 * and no imports. Both jobs and their checks import this one module, so the
 * vocabulary, the line shape and the redaction rules live in one place.
 *
 * Adapted to the append-only line (decision record 2026-09-26): there is no
 * deletion ledger, tombstone, restore replay or erasure-job state to probe,
 * so the closed probe names (OPS_PROBES) carry none. The Worker-era lane
 * heartbeats and the graph-day lane do not exist on the fast path. The
 * analytics refresh is one job over one journal, so the analytics signals
 * here are that job's last complete run (analytics_v2_runs), its journal
 * cursor lag and the oldest undelivered journal row.
 *
 * One line per signal, as one JSON object on stdout (Cloud Run Jobs parse it
 * into jsonPayload):
 *
 *   {"schema":"tibotattle-ops-probe-v1","job":"ops-runtime-probe",
 *    "probe":"maintenance_completed_age_seconds","state":"ok","value":42}
 *   {"schema":"tibotattle-ops-probe-v1","job":"ops-runtime-probe",
 *    "probe":"community_daily_head_age_days","state":"unavailable",
 *    "reason":"NO_DATA"}
 *
 * Evidence rules:
 * - Missing evidence is `unavailable` with a closed reason. It is never 0, and
 *   an unavailable line carries no value (buildOpsProbeLine refuses one).
 * - A value is a finite, non-negative number. NaN, Infinity, a negative
 *   number, a string, a boolean and a bigint are refused.
 * - A line holds only the closed keys in OPS_LOG_LINE_FIELDS. It never holds
 *   query text, parameters, a database error message, an owner, device,
 *   session or file name, an address or a credential. A database error
 *   becomes a closed reason and, at most, its two-character SQLSTATE class.
 * - A per-session probe is split by a closed application class
 *   (OPS_ACTIVITY_CLASSES), never by the raw application name.
 * - Log-based metrics may read only OPS_LOG_METRIC_FIELDS.
 *
 * Every refusal throws an Error whose message and `code` are the same named
 * constant.
 */

export const OPS_PROBE_SCHEMA = "tibotattle-ops-probe-v1";
export const OPS_PROBE_STATES = Object.freeze(["ok", "unavailable"]);
export const OPS_PROBE_JOB_NAMES = Object.freeze(["ops-runtime-probe", "ops-backup-audit"]);
/** The environments a probe may report on; the target of the plane it runs in. */
export const OPS_PROBE_TARGETS = Object.freeze(["production", "staging"]);

/**
 * The count bound of the pending-journal probe. A count of exactly this value
 * means "at least this many"; the line then carries capped: true.
 */
export const OPS_BACKLOG_CAP = 10_001;

/** The closed session classes. Raw application names never leave the probe. */
export const OPS_ACTIVITY_CLASSES = Object.freeze([
  "origin", "analytics", "maintenance", "migration", "probe", "other",
]);

/**
 * Application name to class. The names are the ones each workload's pool sets
 * (cloud-run/cloud-sql.mjs's default for the origin, analytics-refresh.mjs,
 * postgres-maintenance-job.mjs, postgres-production-migrations.mjs and the
 * runtime probe itself); the probe check pins each to its source. Any other
 * name, and any session whose name is empty, is class "other".
 */
export const OPS_APPLICATION_CLASSES = Object.freeze({
  "tibotattle-cloud-run-host": "origin",
  "tibotattle-analytics-refresh": "analytics",
  "tibotattle-maintenance-job": "maintenance",
  "tibotattle-production-migrator": "migration",
  "tibotattle-ops-probe": "probe",
});

/** The class of one session's application name (never the name itself). */
export function opsActivityClass(applicationName) {
  return typeof applicationName === "string" && Object.hasOwn(OPS_APPLICATION_CLASSES, applicationName)
    ? OPS_APPLICATION_CLASSES[applicationName] : "other";
}

/**
 * Why a signal is unavailable. A closed set: no free text ever reaches a line.
 *
 * - NO_DATA: the relation exists but holds nothing to measure (nothing ever
 *   completed, no run, no published day, an empty journal).
 * - RELATION_ABSENT: the table or column does not exist in this schema.
 * - PRIVILEGE_MISSING: the probe's role may not read the source. The activity
 *   signals need membership of pg_read_all_stats; without it other roles'
 *   sessions are hidden, and a count from the visible rest would be wrong.
 * - STATEMENT_TIMEOUT, LOCK_TIMEOUT: the read exceeded its bound (2000 ms,
 *   500 ms), so the signal says nothing rather than something late.
 * - QUERY_FAILED: any other database error; the SQLSTATE class is attached.
 * - UNEXPECTED_RESULT: the source answered with a shape or value the probe
 *   cannot interpret (for example a cursor ahead of its journal).
 * - VALUE_OUT_OF_RANGE: a number the line cannot carry exactly.
 * - DEADLINE_EXCEEDED: the job's own deadline passed before this signal ran.
 * - FETCH_FAILED, FETCH_TIMEOUT, HTTP_STATUS, RESPONSE_INVALID, PAGE_LIMIT:
 *   the Cloud SQL Admin API read failed, timed out, answered a non-2xx
 *   status, answered a body the audit cannot read, or paged past its bound.
 * - EVIDENCE_UNREADABLE: the backup evidence was fetched but the OPS-1
 *   assessment could not read it with certainty.
 */
export const OPS_PROBE_UNAVAILABLE_REASONS = Object.freeze([
  "NO_DATA",
  "RELATION_ABSENT",
  "PRIVILEGE_MISSING",
  "STATEMENT_TIMEOUT",
  "LOCK_TIMEOUT",
  "QUERY_FAILED",
  "UNEXPECTED_RESULT",
  "VALUE_OUT_OF_RANGE",
  "DEADLINE_EXCEEDED",
  "FETCH_FAILED",
  "FETCH_TIMEOUT",
  "HTTP_STATUS",
  "RESPONSE_INVALID",
  "PAGE_LIMIT",
  "EVIDENCE_UNREADABLE",
]);

/** Backup-audit levels: the OPS-1 verdicts ok, warn and breach. */
export const OPS_BACKUP_AUDIT_LEVELS = Object.freeze({ ok: 0, warn: 1, breach: 2 });

const BOOLEAN_VALUES = Object.freeze([0, 1]);
const LEVEL_VALUES = Object.freeze([0, 1, 2]);

function descriptor(job, kind, unit, extra = {}) {
  return Object.freeze({ job, kind, unit, perClass: false, capped: false, codes: false, marker: false,
    values: null, ...extra });
}

const RUNTIME = "ops-runtime-probe";
const BACKUP = "ops-backup-audit";

/**
 * The closed probe names. `kind` is gauge (a level) or counter (a cumulative
 * count since the statistics reset, for a consumer to difference between two
 * lines: the probe is read-only and keeps no state between runs). Nothing here
 * names a ledger, tombstone, replay or erasure-job signal: those do not exist
 * on the append-only line.
 */
export const OPS_PROBES = Object.freeze({
  // Lifecycle and analytics liveness.
  maintenance_completed_age_seconds: descriptor(RUNTIME, "gauge", "seconds"),
  analytics_refresh_completed_age_seconds: descriptor(RUNTIME, "gauge", "seconds"),
  community_daily_head_age_days: descriptor(RUNTIME, "gauge", "days"),
  v12_newest_ready_manifest_age_seconds: descriptor(RUNTIME, "gauge", "seconds"),
  // The one global ingestion journal and the analytics cursor over it.
  ingestion_journal_head_sequence: descriptor(RUNTIME, "gauge", "sequence"),
  ingestion_journal_head_age_seconds: descriptor(RUNTIME, "gauge", "seconds"),
  analytics_journal_lag_sequences: descriptor(RUNTIME, "gauge", "sequences"),
  analytics_journal_pending_events: descriptor(RUNTIME, "gauge", "events", { capped: true }),
  analytics_journal_oldest_undelivered_age_seconds: descriptor(RUNTIME, "gauge", "seconds"),
  // The database.
  database_size_bytes: descriptor(RUNTIME, "gauge", "bytes"),
  database_xid_age: descriptor(RUNTIME, "gauge", "transactions"),
  database_mxid_age: descriptor(RUNTIME, "gauge", "multixacts"),
  database_deadlocks_total: descriptor(RUNTIME, "counter", "deadlocks"),
  database_conflicts_total: descriptor(RUNTIME, "counter", "conflicts"),
  // Sessions, by application class (OPS_ACTIVITY_CLASSES); counts only.
  lock_waiting_sessions: descriptor(RUNTIME, "gauge", "sessions", { perClass: true }),
  oldest_transaction_age_seconds: descriptor(RUNTIME, "gauge", "seconds", { perClass: true }),
  idle_in_transaction_sessions: descriptor(RUNTIME, "gauge", "sessions"),
  // The log-redaction marker (--probe=log-redaction).
  log_redaction_marker: descriptor(RUNTIME, "gauge", "marker", { marker: true, values: BOOLEAN_VALUES }),
  log_redaction_posture: descriptor(RUNTIME, "gauge", "flag", { values: BOOLEAN_VALUES }),
  // The backup audit.
  backup_audit_level: descriptor(BACKUP, "gauge", "level", { codes: true, values: LEVEL_VALUES }),
  backup_pitr_enabled: descriptor(BACKUP, "gauge", "flag", { values: BOOLEAN_VALUES }),
  backup_last_automated_age_hours: descriptor(BACKUP, "gauge", "hours"),
});
export const OPS_PROBE_NAMES = Object.freeze(Object.keys(OPS_PROBES));

/** The probe names one job writes. */
export function opsProbeNamesForJob(job) {
  return Object.freeze(OPS_PROBE_NAMES.filter((name) => OPS_PROBES[name].job === job));
}

/** Every key a line may carry, in the order a line is written. */
export const OPS_LOG_LINE_FIELDS = Object.freeze([
  "schema", "job", "probe", "class", "state", "value", "reason", "sqlstate_class", "capped", "codes", "marker",
]);
/**
 * The fields a log-based metric filter or extractor may read: low-cardinality
 * labels and the value. `codes`, `sqlstate_class` and `marker` are for a
 * human reading one line, never a metric label.
 */
export const OPS_LOG_METRIC_FIELDS = Object.freeze([
  "schema", "job", "probe", "class", "state", "value", "reason", "capped",
]);

/** The log-redaction marker's grammar: a fresh random token, never data. */
export const OPS_LOG_REDACTION_MARKER_PATTERN = /^tibotattle-log-redaction-[0-9a-f]{32}$/u;
/**
 * The Cloud SQL logging posture that keeps an error line content-free
 * (OPS-2's CLOUD_SQL_LOGGING_FLAGS, pinned equal by the manifest check). The
 * posture probe reads these five settings with current_setting().
 */
export const OPS_LOG_REDACTION_SETTINGS = Object.freeze({
  log_error_verbosity: "terse",
  log_min_error_statement: "panic",
  log_parameter_max_length: "0",
  log_parameter_max_length_on_error: "0",
  log_statement: "none",
});

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/u;
const SQLSTATE_CLASS = /^[0-9A-Z]{2}$/u;
const MAX_CODES = 16;

export class OpsProbeError extends Error {
  constructor(code) {
    super(code);
    this.name = "OpsProbeError";
    this.code = code;
  }
}

export function opsProbeFail(code) {
  throw new OpsProbeError(code);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Build one probe line. `input` keys: probe, state, value (ok), reason
 * (unavailable), sqlstateClass (unavailable, optional), class (a per-class
 * probe), capped (the capped probe, ok), codes (backup_audit_level, ok),
 * marker (log_redaction_marker, ok). Returns a frozen object whose keys
 * follow OPS_LOG_LINE_FIELDS; anything else is refused.
 */
export function buildOpsProbeLine(input) {
  if (!isRecord(input)) opsProbeFail("OPS_PROBE_LINE_INVALID");
  const allowed = ["probe", "state", "value", "reason", "sqlstateClass", "class", "capped", "codes", "marker"];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) opsProbeFail("OPS_PROBE_LINE_KEY_UNKNOWN");
  }
  const { probe, state } = input;
  if (typeof probe !== "string" || !Object.hasOwn(OPS_PROBES, probe)) opsProbeFail("OPS_PROBE_NAME_UNKNOWN");
  const spec = OPS_PROBES[probe];
  if (!OPS_PROBE_STATES.includes(state)) opsProbeFail("OPS_PROBE_STATE_INVALID");
  const present = (key) => Object.hasOwn(input, key) && input[key] !== undefined;

  const line = { schema: OPS_PROBE_SCHEMA, job: spec.job, probe };
  if (spec.perClass) {
    if (!OPS_ACTIVITY_CLASSES.includes(input.class)) opsProbeFail("OPS_PROBE_CLASS_INVALID");
    line.class = input.class;
  } else if (present("class")) {
    opsProbeFail("OPS_PROBE_CLASS_FORBIDDEN");
  }
  line.state = state;

  if (state === "ok") {
    if (present("reason") || present("sqlstateClass")) opsProbeFail("OPS_PROBE_REASON_FORBIDDEN");
    const { value } = input;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) opsProbeFail("OPS_PROBE_VALUE_INVALID");
    if (spec.values !== null && !spec.values.includes(value)) opsProbeFail("OPS_PROBE_VALUE_INVALID");
    line.value = Object.is(value, -0) ? 0 : value;
    if (spec.capped) {
      if (typeof input.capped !== "boolean" || line.value > OPS_BACKLOG_CAP
          || input.capped !== (line.value === OPS_BACKLOG_CAP)) {
        opsProbeFail("OPS_PROBE_CAPPED_INVALID");
      }
      line.capped = input.capped;
    } else if (present("capped")) {
      opsProbeFail("OPS_PROBE_CAPPED_FORBIDDEN");
    }
    if (spec.codes) {
      const { codes } = input;
      if (!Array.isArray(codes) || codes.length > MAX_CODES
          || codes.some((code) => typeof code !== "string" || !CODE_PATTERN.test(code))
          || new Set(codes).size !== codes.length) {
        opsProbeFail("OPS_PROBE_CODES_INVALID");
      }
      line.codes = [...codes];
    } else if (present("codes")) {
      opsProbeFail("OPS_PROBE_CODES_FORBIDDEN");
    }
    if (spec.marker) {
      if (typeof input.marker !== "string" || !OPS_LOG_REDACTION_MARKER_PATTERN.test(input.marker)) {
        opsProbeFail("OPS_PROBE_MARKER_INVALID");
      }
      line.marker = input.marker;
    } else if (present("marker")) {
      opsProbeFail("OPS_PROBE_MARKER_FORBIDDEN");
    }
  } else {
    if (present("value") || present("capped") || present("codes") || present("marker")) {
      opsProbeFail("OPS_PROBE_UNAVAILABLE_CARRIES_VALUE");
    }
    if (!OPS_PROBE_UNAVAILABLE_REASONS.includes(input.reason)) opsProbeFail("OPS_PROBE_REASON_INVALID");
    line.reason = input.reason;
    if (present("sqlstateClass")) {
      if (typeof input.sqlstateClass !== "string" || !SQLSTATE_CLASS.test(input.sqlstateClass)) {
        opsProbeFail("OPS_PROBE_SQLSTATE_CLASS_INVALID");
      }
      line.sqlstate_class = input.sqlstateClass;
    }
  }
  return Object.freeze(line);
}

/** An unavailable line (shorthand for buildOpsProbeLine). */
export function buildOpsProbeUnavailable(probe, failure, klass) {
  return buildOpsProbeLine({
    probe,
    state: "unavailable",
    reason: failure.reason,
    ...(failure.sqlstateClass === undefined ? {} : { sqlstateClass: failure.sqlstateClass }),
    ...(klass === undefined ? {} : { class: klass }),
  });
}

/** One line as the JSON text a job writes (no trailing newline). */
export function serializeOpsProbeLine(line) {
  const ordered = {};
  for (const key of OPS_LOG_LINE_FIELDS) {
    if (Object.hasOwn(line, key)) ordered[key] = line[key];
  }
  if (Object.keys(ordered).length !== Object.keys(line).length) opsProbeFail("OPS_PROBE_LINE_KEY_UNKNOWN");
  return JSON.stringify(ordered);
}

const SQLSTATE = /^[0-9A-Z]{5}$/u;
/** SQLSTATEs with a closed reason of their own. Everything else is QUERY_FAILED. */
const SQLSTATE_REASONS = Object.freeze({
  "42P01": "RELATION_ABSENT", // undefined_table
  "42703": "RELATION_ABSENT", // undefined_column
  "3F000": "RELATION_ABSENT", // invalid_schema_name
  "42501": "PRIVILEGE_MISSING", // insufficient_privilege
  "57014": "STATEMENT_TIMEOUT", // query_canceled (statement_timeout)
  "55P03": "LOCK_TIMEOUT", // lock_not_available (lock_timeout)
});

/**
 * A driver error as a closed reason and, when the driver gave a SQLSTATE, its
 * two-character class. The message, detail, hint, where, query and every
 * other field of the error are never read.
 */
export function opsProbeFailureFromError(error) {
  const code = error !== null && typeof error === "object" ? error.code : undefined;
  if (typeof code !== "string" || !SQLSTATE.test(code)) return Object.freeze({ reason: "QUERY_FAILED" });
  return Object.freeze({
    reason: SQLSTATE_REASONS[code] ?? "QUERY_FAILED",
    sqlstateClass: code.slice(0, 2),
  });
}

/**
 * The job definitions a scheduler registration reads. The probe jobs are not
 * in OPS-2's committed desired state yet (the backup audit needs its own
 * Google Cloud account, an owner decision); this is the contract they would
 * be rendered from, and the checks pin it.
 *
 * - ops-runtime-probe: every 5 minutes, 120 s task timeout, the runtime
 *   account, one read-only primary connection, each read bounded by a 2000 ms
 *   statement timeout and a 500 ms lock timeout, the whole run by a 100 s
 *   deadline so it ends before the task timeout.
 * - ops-backup-audit: hourly at minute 17, 120 s task timeout, the opsBackupAudit
 *   account, no database connection. The account needs exactly
 *   cloudsql.instances.get and cloudsql.backupRuns.list on the instance.
 */
export const OPS_PROBE_JOBS = Object.freeze({
  "ops-runtime-probe": Object.freeze({
    entry: "ops-runtime-probe-job",
    schedule: "*/5 * * * *",
    timeoutSeconds: 120,
    deadlineSeconds: 100,
    account: "runtime",
    pools: Object.freeze({ primary: 1 }),
    access: "read-only",
    applicationName: "tibotattle-ops-probe",
    statementTimeoutMilliseconds: 2_000,
    lockTimeoutMilliseconds: 500,
    permissions: Object.freeze([]),
    env: Object.freeze(["OPS_PROBE_TARGET", "PRIMARY_INSTANCE_CONNECTION_NAME", "PRIMARY_DATABASE",
      "PRIMARY_SCHEMA", "POSTGRES_IAM_USER", "DEPLOYMENT_SOURCE_COMMIT"]),
  }),
  "ops-backup-audit": Object.freeze({
    entry: "ops-backup-audit-job",
    schedule: "17 * * * *",
    timeoutSeconds: 120,
    deadlineSeconds: 100,
    account: "opsBackupAudit",
    pools: Object.freeze({}),
    access: "cloud-sql-admin-read",
    applicationName: null,
    httpTimeoutMilliseconds: 10_000,
    maxPages: 20,
    permissions: Object.freeze(["cloudsql.backupRuns.list", "cloudsql.instances.get"]),
    env: Object.freeze(["OPS_PROBE_TARGET", "PRIMARY_INSTANCE_CONNECTION_NAME", "DEPLOYMENT_SOURCE_COMMIT"]),
  }),
});

// ---------------------------------------------------------------------------
// Environment

const CLOUD_RUN_JOB = /^[a-z](?:[a-z0-9-]{0,47}[a-z0-9])?$/u;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/u;
const CONNECTION_NAME = /^([a-z][a-z0-9-]{4,28}[a-z0-9]):([a-z]+-[a-z]+[0-9]{1,2}):([a-z](?:[a-z0-9-]{0,96}[a-z0-9])?)$/u;
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;
const IAM_USER = /^[A-Za-z0-9][A-Za-z0-9@_.-]{0,62}$/u;
const FORBIDDEN_VARIABLES = Object.freeze({
  HOST_MODE: "OPS_PROBE_HOST_MODE_FORBIDDEN",
  K_SERVICE: "OPS_PROBE_CONTEXT_INVALID",
});
const FORBIDDEN_PREFIXES = Object.freeze({
  PG_TEST_: "OPS_PROBE_LOCAL_ENDPOINT_FORBIDDEN",
  POSTGRES_MAINTENANCE_JOB_: "OPS_PROBE_TUNABLE_FORBIDDEN",
});
/** A variable that holds a credential. A probe is handed none, whatever its name. */
const SECRET_NAME = /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|PUBLIC_JWK|PRIVATE_JWK)$/u;

/**
 * The job's own environment, validated closed. `job` is a key of
 * OPS_PROBE_JOBS. Refuses HOST_MODE and K_SERVICE (a probe is not the
 * service), any PG_TEST_ local endpoint, any tunable (an OPS_PROBE_ variable
 * other than OPS_PROBE_TARGET) and any credential-named variable. The job
 * reads no other variable. Returns frozen, content-free values.
 */
export function readOpsProbeEnvironment(env, job) {
  if (env === null || typeof env !== "object" || !Object.hasOwn(OPS_PROBE_JOBS, job)) {
    opsProbeFail("OPS_PROBE_ENVIRONMENT_INVALID");
  }
  const has = (name) => Object.prototype.hasOwnProperty.call(env, name);
  for (const [name, code] of Object.entries(FORBIDDEN_VARIABLES)) {
    if (has(name)) opsProbeFail(code);
  }
  const names = Object.keys(env);
  for (const [prefix, code] of Object.entries(FORBIDDEN_PREFIXES)) {
    if (names.some((name) => name.startsWith(prefix))) opsProbeFail(code);
  }
  if (names.some((name) => name.startsWith("OPS_PROBE_") && name !== "OPS_PROBE_TARGET")) {
    opsProbeFail("OPS_PROBE_TUNABLE_FORBIDDEN");
  }
  if (names.some((name) => SECRET_NAME.test(name))) opsProbeFail("OPS_PROBE_SECRET_FORBIDDEN");
  const value = (name) => {
    const raw = has(name) ? env[name] : undefined;
    if (typeof raw !== "string" || raw === "") opsProbeFail(`${name}_MISSING`);
    return raw;
  };
  const matching = (name, pattern) => {
    const raw = value(name);
    if (!pattern.test(raw)) opsProbeFail(`${name}_INVALID`);
    return raw;
  };
  const jobName = matching("CLOUD_RUN_JOB", CLOUD_RUN_JOB);
  const target = value("OPS_PROBE_TARGET");
  if (!OPS_PROBE_TARGETS.includes(target)) opsProbeFail("OPS_PROBE_TARGET_INVALID");
  const commit = matching("DEPLOYMENT_SOURCE_COMMIT", SOURCE_COMMIT);
  const connection = CONNECTION_NAME.exec(value("PRIMARY_INSTANCE_CONNECTION_NAME"));
  if (connection === null) opsProbeFail("PRIMARY_INSTANCE_CONNECTION_NAME_INVALID");
  const result = {
    job,
    cloudRunJob: jobName,
    target,
    sourceCommit: commit,
    project: connection[1],
    region: connection[2],
    instance: connection[3],
    instanceConnectionName: connection[0],
  };
  if (OPS_PROBE_JOBS[job].pools.primary !== undefined) {
    result.database = matching("PRIMARY_DATABASE", DATABASE_NAME);
    result.schema = matching("PRIMARY_SCHEMA", DATABASE_NAME);
    result.iamUser = matching("POSTGRES_IAM_USER", IAM_USER);
  } else {
    // The audit holds no database connection and refuses the settings that
    // would point it at one.
    for (const name of ["PRIMARY_DATABASE", "PRIMARY_SCHEMA", "POSTGRES_IAM_USER"]) {
      if (has(name)) opsProbeFail("OPS_PROBE_DATABASE_FORBIDDEN");
    }
  }
  return Object.freeze(result);
}

/** The closed-code text of an Error for stderr: its code, or a generic one. */
export function safeOpsProbeCode(error, fallback = "OPS_PROBE_FAILED") {
  const code = error?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(code) ? code : fallback;
}
