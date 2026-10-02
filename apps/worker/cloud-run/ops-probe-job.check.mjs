/**
 * Local checks for the OPS-4 probe jobs: the closed, content-free line
 * contract (ops-probe-contract.mjs), the runtime liveness probe
 * (ops-runtime-probe-job.mjs) and the backup-audit probe
 * (ops-backup-audit-job.mjs). Everything is a dry run: the runtime probe runs
 * against a scripted fake client and the audit against a fake fetch, so no
 * database is opened and no request leaves the machine. Every value is
 * synthetic. The PostgreSQL behaviour of the runtime probe's SQL is qualified
 * by postgres-test/ops-runtime-probe.spec.mjs.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { BACKUP_HORIZON_CODES } from "./ops-backup-horizon.mjs";
import * as audit from "./ops-backup-audit-job.mjs";
import * as contract from "./ops-probe-contract.mjs";
import * as probe from "./ops-runtime-probe-job.mjs";
import { POSTGRES_MAINTENANCE_JOB_APPLICATION_NAME } from "./postgres-maintenance-job-contract.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(ROOT, "..");
const CONNECTION = "synthetic-ops-project:us-east1:synthetic-primary";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
/** Text that must never appear in any output: it stands for a message, a detail, a row value or a credential. */
const SENTINEL = "SENTINEL-must-not-leak-9f3a";

const RUNTIME_ENV = Object.freeze({
  CLOUD_RUN_JOB: "synthetic-ops-runtime-probe",
  DEPLOYMENT_SOURCE_COMMIT: COMMIT,
  OPS_PROBE_TARGET: "production",
  PRIMARY_INSTANCE_CONNECTION_NAME: CONNECTION,
  PRIMARY_DATABASE: "synthetic_primary",
  PRIMARY_SCHEMA: "synthetic_primary",
  POSTGRES_IAM_USER: "synthetic-runtime@synthetic-ops-project.iam",
});
const AUDIT_ENV = Object.freeze({
  CLOUD_RUN_JOB: "synthetic-ops-backup-audit",
  DEPLOYMENT_SOURCE_COMMIT: COMMIT,
  OPS_PROBE_TARGET: "production",
  PRIMARY_INSTANCE_CONNECTION_NAME: CONNECTION,
});

function refusedWith(code, run) {
  assert.throws(run, (error) => error?.code === code && error.message === code, code);
}

// ---------------------------------------------------------------------------
// The contract

test("the probe names are closed, split by job, and carry no ledger, tombstone, replay or erasure signal", () => {
  assert.equal(contract.OPS_PROBE_SCHEMA, "tibotattle-ops-probe-v1");
  assert.deepEqual([...contract.OPS_PROBE_STATES], ["ok", "unavailable"]);
  assert.deepEqual([...contract.OPS_PROBE_JOB_NAMES], ["ops-runtime-probe", "ops-backup-audit"]);
  assert.deepEqual([...contract.OPS_PROBE_NAMES].sort(), [
    "analytics_journal_lag_sequences", "analytics_journal_oldest_undelivered_age_seconds",
    "analytics_journal_pending_events", "analytics_refresh_completed_age_seconds", "backup_audit_level",
    "backup_last_automated_age_hours", "backup_pitr_enabled", "community_daily_head_age_days",
    "database_conflicts_total", "database_deadlocks_total", "database_mxid_age", "database_size_bytes",
    "database_xid_age", "idle_in_transaction_sessions", "ingestion_journal_head_age_seconds",
    "ingestion_journal_head_sequence", "lock_waiting_sessions", "log_redaction_marker",
    "log_redaction_posture", "maintenance_completed_age_seconds", "oldest_transaction_age_seconds",
    "v12_newest_ready_manifest_age_seconds",
  ]);
  for (const name of contract.OPS_PROBE_NAMES) {
    assert.doesNotMatch(name, /ledger|tombstone|replay|erasure|cooldown/u, name);
    assert.ok(contract.OPS_PROBE_JOB_NAMES.includes(contract.OPS_PROBES[name].job), name);
    assert.ok(["gauge", "counter"].includes(contract.OPS_PROBES[name].kind), name);
  }
  assert.deepEqual([...contract.opsProbeNamesForJob("ops-backup-audit")].sort(),
    ["backup_audit_level", "backup_last_automated_age_hours", "backup_pitr_enabled"]);
  assert.equal(contract.opsProbeNamesForJob("ops-runtime-probe").length, contract.OPS_PROBE_NAMES.length - 3);
  assert.deepEqual(contract.OPS_PROBE_NAMES.filter((name) => contract.OPS_PROBES[name].kind === "counter").sort(),
    ["database_conflicts_total", "database_deadlocks_total"]);
  assert.deepEqual(contract.OPS_PROBE_NAMES.filter((name) => contract.OPS_PROBES[name].perClass).sort(),
    ["lock_waiting_sessions", "oldest_transaction_age_seconds"]);
  for (const frozen of [contract.OPS_PROBES, contract.OPS_PROBE_NAMES, contract.OPS_ACTIVITY_CLASSES,
    contract.OPS_APPLICATION_CLASSES, contract.OPS_PROBE_JOBS, contract.OPS_LOG_LINE_FIELDS,
    contract.OPS_LOG_METRIC_FIELDS, contract.OPS_PROBE_UNAVAILABLE_REASONS, contract.OPS_LOG_REDACTION_SETTINGS]) {
    assert.equal(Object.isFrozen(frozen), true);
  }
  assert.equal(contract.OPS_BACKLOG_CAP, 10_001);
});

test("the source files name no retired ledger, tombstone, replay or erasure-job signal", async () => {
  for (const file of ["ops-probe-contract.mjs", "ops-runtime-probe-job.mjs", "ops-backup-audit-job.mjs"]) {
    const source = await readFile(join(ROOT, file), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
    assert.doesNotMatch(code, /ledger|tombstone|erasure_job|restore_replay|deletion_/iu, file);
  }
});

test("the log fields are closed, and a metric may read only low-cardinality labels and the value", () => {
  assert.deepEqual([...contract.OPS_LOG_LINE_FIELDS], [
    "schema", "job", "probe", "class", "state", "value", "reason", "sqlstate_class", "capped", "codes", "marker",
  ]);
  for (const field of contract.OPS_LOG_METRIC_FIELDS) assert.ok(contract.OPS_LOG_LINE_FIELDS.includes(field), field);
  for (const field of ["codes", "marker", "sqlstate_class"]) {
    assert.equal(contract.OPS_LOG_METRIC_FIELDS.includes(field), false, field);
  }
  for (const forbidden of ["query", "message", "detail", "statement", "host", "user", "password", "token",
    "application_name", "httpRequest", "textPayload", "owner", "device", "session", "path", "ip", "email"]) {
    assert.equal(contract.OPS_LOG_LINE_FIELDS.includes(forbidden), false, forbidden);
  }
  assert.deepEqual([...contract.OPS_ACTIVITY_CLASSES], ["origin", "analytics", "maintenance", "migration", "probe", "other"]);
});

test("each application class is the name its own workload's pool sets", async () => {
  const sources = Object.fromEntries(await Promise.all([
    ["cloud-sql.mjs", "cloud-sql.mjs"], ["analytics-refresh.mjs", "analytics-refresh.mjs"],
    ["postgres-production-migrations.mjs", "postgres-production-migrations.mjs"],
  ].map(async ([key, file]) => [key, await readFile(join(ROOT, file), "utf8")])));
  assert.match(sources["cloud-sql.mjs"], /applicationName = "tibotattle-cloud-run-host"/u);
  assert.match(sources["analytics-refresh.mjs"], /application_name: "tibotattle-analytics-refresh"/u);
  assert.match(sources["postgres-production-migrations.mjs"], /MIGRATOR_APPLICATION_NAME = "tibotattle-production-migrator"/u);
  assert.equal(POSTGRES_MAINTENANCE_JOB_APPLICATION_NAME, "tibotattle-maintenance-job");
  assert.equal(contract.OPS_PROBE_JOBS["ops-runtime-probe"].applicationName, "tibotattle-ops-probe");
  assert.deepEqual({ ...contract.OPS_APPLICATION_CLASSES }, {
    "tibotattle-cloud-run-host": "origin",
    "tibotattle-analytics-refresh": "analytics",
    "tibotattle-maintenance-job": "maintenance",
    "tibotattle-production-migrator": "migration",
    "tibotattle-ops-probe": "probe",
  });
  assert.equal(contract.opsActivityClass("tibotattle-maintenance-job"), "maintenance");
  for (const unknown of ["", null, undefined, 7, "psql", "tibotattle-unknown", `${SENTINEL}`]) {
    assert.equal(contract.opsActivityClass(unknown), "other");
  }
});

test("the job definitions are the item's contract: cadence, timeouts, pools, accounts and permissions", () => {
  const runtime = contract.OPS_PROBE_JOBS["ops-runtime-probe"];
  const backup = contract.OPS_PROBE_JOBS["ops-backup-audit"];
  assert.equal(runtime.schedule, "*/5 * * * *");
  assert.equal(runtime.timeoutSeconds, 120);
  assert.equal(runtime.account, "runtime");
  assert.deepEqual({ ...runtime.pools }, { primary: 1 });
  assert.equal(runtime.access, "read-only");
  assert.equal(runtime.statementTimeoutMilliseconds, 2_000);
  assert.equal(runtime.lockTimeoutMilliseconds, 500);
  assert.equal(backup.schedule, "17 * * * *");
  assert.equal(backup.account, "opsBackupAudit");
  assert.deepEqual({ ...backup.pools }, {});
  assert.equal(backup.httpTimeoutMilliseconds, 10_000);
  assert.deepEqual([...backup.permissions], ["cloudsql.backupRuns.list", "cloudsql.instances.get"]);
  for (const definition of [runtime, backup]) {
    assert.ok(definition.deadlineSeconds < definition.timeoutSeconds, "the deadline ends the run before the task timeout");
    // Five-field cron: minute 0-59 or */n, then four wildcards.
    assert.match(definition.schedule, /^(?:\*\/[1-9][0-9]?|[0-9]|[1-5][0-9]) \* \* \* \*$/u);
    assert.match(definition.entry, /^ops-[a-z-]+-job$/u);
  }
  assert.equal(Object.isFrozen(runtime.pools) && Object.isFrozen(runtime.env) && Object.isFrozen(backup.permissions), true);
  // The probe's bounds are the ones the module enforces.
  assert.equal(probe.OPS_RUNTIME_PROBE_ENTRY, runtime.entry);
  assert.equal(audit.OPS_BACKUP_AUDIT_ENTRY, backup.entry);
});

test("buildOpsProbeLine builds the closed ok and unavailable shapes", () => {
  const okLine = contract.buildOpsProbeLine({ probe: "maintenance_completed_age_seconds", state: "ok", value: 42 });
  assert.deepEqual({ ...okLine }, {
    schema: "tibotattle-ops-probe-v1", job: "ops-runtime-probe", probe: "maintenance_completed_age_seconds",
    state: "ok", value: 42,
  });
  assert.equal(Object.isFrozen(okLine), true);
  const gone = contract.buildOpsProbeLine({
    probe: "community_daily_head_age_days", state: "unavailable", reason: "NO_DATA",
  });
  assert.deepEqual({ ...gone }, {
    schema: "tibotattle-ops-probe-v1", job: "ops-runtime-probe", probe: "community_daily_head_age_days",
    state: "unavailable", reason: "NO_DATA",
  });
  assert.equal(Object.hasOwn(gone, "value"), false, "missing data is never a 0");
  const classed = contract.buildOpsProbeLine({ probe: "lock_waiting_sessions", class: "origin", state: "ok", value: 0 });
  assert.equal(classed.class, "origin");
  assert.equal(contract.buildOpsProbeLine({ probe: "database_size_bytes", state: "ok", value: -0 }).value, 0);
  assert.equal(Object.is(contract.buildOpsProbeLine({ probe: "database_size_bytes", state: "ok", value: -0 }).value, 0), true);
  const withClass = contract.buildOpsProbeLine({
    probe: "database_size_bytes", state: "unavailable", reason: "QUERY_FAILED", sqlstateClass: "42",
  });
  assert.equal(withClass.sqlstate_class, "42");
  const serialized = contract.serializeOpsProbeLine(classed);
  assert.equal(serialized,
    '{"schema":"tibotattle-ops-probe-v1","job":"ops-runtime-probe","probe":"lock_waiting_sessions","class":"origin","state":"ok","value":0}');
  assert.deepEqual(JSON.parse(contract.serializeOpsProbeLine(withClass)),
    { ...withClass });
});

test("buildOpsProbeLine refuses a value that is not a finite non-negative number", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.5, "1", "", null,
    undefined, true, false, 1n, [], {}]) {
    refusedWith("OPS_PROBE_VALUE_INVALID", () => contract.buildOpsProbeLine({
      probe: "database_size_bytes", state: "ok", value,
    }));
  }
  for (const value of [0, 1, 0.5, 10 ** 15, Number.MAX_SAFE_INTEGER]) {
    assert.equal(contract.buildOpsProbeLine({ probe: "database_size_bytes", state: "ok", value }).value, value);
  }
  // Enumerated probes take only their own values.
  for (const value of [2, 3, 0.5]) {
    refusedWith("OPS_PROBE_VALUE_INVALID", () => contract.buildOpsProbeLine({ probe: "backup_pitr_enabled", state: "ok", value }));
  }
  refusedWith("OPS_PROBE_VALUE_INVALID", () => contract.buildOpsProbeLine({ probe: "backup_audit_level", state: "ok", value: 3, codes: [] }));
});

test("buildOpsProbeLine refuses an unavailable line that carries data and an ok line that carries a reason", () => {
  for (const extra of [{ value: 0 }, { value: 5 }, { capped: false }, { codes: [] }, { marker: "x" }]) {
    refusedWith("OPS_PROBE_UNAVAILABLE_CARRIES_VALUE", () => contract.buildOpsProbeLine({
      probe: "analytics_journal_pending_events", state: "unavailable", reason: "NO_DATA", ...extra,
    }));
  }
  refusedWith("OPS_PROBE_REASON_INVALID", () => contract.buildOpsProbeLine({ probe: "database_size_bytes", state: "unavailable" }));
  for (const reason of ["no_data", "", "relation does not exist", SENTINEL, null, 7]) {
    refusedWith("OPS_PROBE_REASON_INVALID", () => contract.buildOpsProbeLine({
      probe: "database_size_bytes", state: "unavailable", reason,
    }));
  }
  refusedWith("OPS_PROBE_REASON_FORBIDDEN", () => contract.buildOpsProbeLine({
    probe: "database_size_bytes", state: "ok", value: 1, reason: "NO_DATA",
  }));
  refusedWith("OPS_PROBE_REASON_FORBIDDEN", () => contract.buildOpsProbeLine({
    probe: "database_size_bytes", state: "ok", value: 1, sqlstateClass: "42",
  }));
  for (const sqlstateClass of ["4", "420", "4p", "", 42, SENTINEL]) {
    refusedWith("OPS_PROBE_SQLSTATE_CLASS_INVALID", () => contract.buildOpsProbeLine({
      probe: "database_size_bytes", state: "unavailable", reason: "QUERY_FAILED", sqlstateClass,
    }));
  }
  refusedWith("OPS_PROBE_STATE_INVALID", () => contract.buildOpsProbeLine({ probe: "database_size_bytes", state: "healthy", value: 1 }));
  refusedWith("OPS_PROBE_STATE_INVALID", () => contract.buildOpsProbeLine({ probe: "database_size_bytes", value: 1 }));
});

test("buildOpsProbeLine refuses unknown probes, unknown keys and every field that could hold content", () => {
  for (const name of ["ledger_age_seconds", "deletion_ledger_probe_stale", "tombstone_count", "erasure_job_pending",
    "restore_replay_incomplete", "", null, 7, "constructor", "__proto__", "toString", "MAINTENANCE_COMPLETED_AGE_SECONDS"]) {
    refusedWith("OPS_PROBE_NAME_UNKNOWN", () => contract.buildOpsProbeLine({ probe: name, state: "ok", value: 1 }));
  }
  for (const key of ["query", "message", "detail", "statement", "host", "user", "password", "token",
    "application_name", "owner", "device", "session", "path", "ip", "email", "error", "stack", "sql", "where"]) {
    refusedWith("OPS_PROBE_LINE_KEY_UNKNOWN", () => contract.buildOpsProbeLine({
      probe: "database_size_bytes", state: "ok", value: 1, [key]: SENTINEL,
    }));
  }
  refusedWith("OPS_PROBE_LINE_INVALID", () => contract.buildOpsProbeLine(null));
  refusedWith("OPS_PROBE_LINE_INVALID", () => contract.buildOpsProbeLine([]));
  refusedWith("OPS_PROBE_LINE_INVALID", () => contract.buildOpsProbeLine("x"));
  // A serialized line cannot be widened either.
  refusedWith("OPS_PROBE_LINE_KEY_UNKNOWN", () => contract.serializeOpsProbeLine({
    schema: "tibotattle-ops-probe-v1", job: "ops-runtime-probe", probe: "database_size_bytes", state: "ok",
    value: 1, query: SENTINEL,
  }));
});

test("class, capped, codes and marker are accepted only where their probe defines them", () => {
  for (const klass of ["", "Origin", "psql", SENTINEL, null, undefined]) {
    refusedWith("OPS_PROBE_CLASS_INVALID", () => contract.buildOpsProbeLine({
      probe: "lock_waiting_sessions", class: klass, state: "ok", value: 0,
    }));
  }
  refusedWith("OPS_PROBE_CLASS_FORBIDDEN", () => contract.buildOpsProbeLine({
    probe: "idle_in_transaction_sessions", class: "origin", state: "ok", value: 0,
  }));
  // The pending-journal count is capped at 10001, exactly.
  const pending = (value, capped) => contract.buildOpsProbeLine({
    probe: "analytics_journal_pending_events", state: "ok", value, capped,
  });
  assert.equal(pending(10_000, false).capped, false);
  assert.equal(pending(10_001, true).capped, true);
  assert.equal(pending(0, false).value, 0);
  for (const [value, capped] of [[10_001, false], [10_000, true], [10_002, true], [0, true], [5, undefined], [5, "no"]]) {
    refusedWith("OPS_PROBE_CAPPED_INVALID", () => pending(value, capped));
  }
  refusedWith("OPS_PROBE_CAPPED_FORBIDDEN", () => contract.buildOpsProbeLine({
    probe: "database_size_bytes", state: "ok", value: 1, capped: false,
  }));
  // The audit's codes are closed OPS-1 style codes, at most 16, unique.
  assert.deepEqual([...contract.buildOpsProbeLine({
    probe: "backup_audit_level", state: "ok", value: 1, codes: ["PITR_DISABLED"],
  }).codes], ["PITR_DISABLED"]);
  for (const codes of [undefined, "PITR_DISABLED", ["lower"], ["A"], [SENTINEL], ["X".repeat(65)], [1], ["PITR_DISABLED", "PITR_DISABLED"],
    Array.from({ length: 17 }, (_, index) => `CODE_${index}`)]) {
    refusedWith("OPS_PROBE_CODES_INVALID", () => contract.buildOpsProbeLine({
      probe: "backup_audit_level", state: "ok", value: 1, codes,
    }));
  }
  refusedWith("OPS_PROBE_CODES_FORBIDDEN", () => contract.buildOpsProbeLine({
    probe: "database_size_bytes", state: "ok", value: 1, codes: [],
  }));
  const marker = `tibotattle-log-redaction-${"ab".repeat(16)}`;
  assert.equal(contract.buildOpsProbeLine({ probe: "log_redaction_marker", state: "ok", value: 1, marker }).marker, marker);
  for (const bad of [undefined, "", SENTINEL, "tibotattle-log-redaction-XYZ", `${marker}0`, `tibotattle-log-redaction-${"AB".repeat(16)}`]) {
    refusedWith("OPS_PROBE_MARKER_INVALID", () => contract.buildOpsProbeLine({
      probe: "log_redaction_marker", state: "ok", value: 1, marker: bad,
    }));
  }
  refusedWith("OPS_PROBE_MARKER_FORBIDDEN", () => contract.buildOpsProbeLine({
    probe: "database_size_bytes", state: "ok", value: 1, marker,
  }));
});

test("a database error becomes a closed reason and its SQLSTATE class, never its text", () => {
  const poisoned = (code) => Object.assign(new Error(`${SENTINEL} password=hunter2`), {
    code, detail: SENTINEL, hint: SENTINEL, where: SENTINEL, query: `SELECT '${SENTINEL}'`, severity: SENTINEL,
  });
  const cases = [
    ["42P01", { reason: "RELATION_ABSENT", sqlstateClass: "42" }],
    ["42703", { reason: "RELATION_ABSENT", sqlstateClass: "42" }],
    ["3F000", { reason: "RELATION_ABSENT", sqlstateClass: "3F" }],
    ["42501", { reason: "PRIVILEGE_MISSING", sqlstateClass: "42" }],
    ["57014", { reason: "STATEMENT_TIMEOUT", sqlstateClass: "57" }],
    ["55P03", { reason: "LOCK_TIMEOUT", sqlstateClass: "55" }],
    ["23505", { reason: "QUERY_FAILED", sqlstateClass: "23" }],
    ["XX000", { reason: "QUERY_FAILED", sqlstateClass: "XX" }],
  ];
  for (const [code, expected] of cases) {
    const failure = contract.opsProbeFailureFromError(poisoned(code));
    assert.deepEqual({ ...failure }, expected, code);
    assert.doesNotMatch(JSON.stringify(failure), new RegExp(SENTINEL, "u"));
  }
  for (const odd of [new Error(SENTINEL), Object.assign(new Error(SENTINEL), { code: "ECONNREFUSED" }),
    Object.assign(new Error(SENTINEL), { code: "42P0" }), Object.assign(new Error(SENTINEL), { code: 42501 }),
    null, undefined, "boom", {}]) {
    assert.deepEqual({ ...contract.opsProbeFailureFromError(odd) }, { reason: "QUERY_FAILED" });
  }
  assert.equal(contract.safeOpsProbeCode(Object.assign(new Error(SENTINEL), { code: "OPS_PROBE_TARGET_INVALID" })),
    "OPS_PROBE_TARGET_INVALID");
  assert.equal(contract.safeOpsProbeCode(new Error(SENTINEL)), "OPS_PROBE_FAILED");
  assert.equal(contract.safeOpsProbeCode(Object.assign(new Error("x"), { code: "lower case!" }), "FALLBACK_CODE"), "FALLBACK_CODE");
});

// ---------------------------------------------------------------------------
// The environment

test("each job reads a closed environment and refuses everything else", () => {
  const runtime = contract.readOpsProbeEnvironment(RUNTIME_ENV, "ops-runtime-probe");
  assert.deepEqual({ ...runtime }, {
    job: "ops-runtime-probe", cloudRunJob: "synthetic-ops-runtime-probe", target: "production", sourceCommit: COMMIT,
    project: "synthetic-ops-project", region: "us-east1", instance: "synthetic-primary",
    instanceConnectionName: CONNECTION, database: "synthetic_primary", schema: "synthetic_primary",
    iamUser: "synthetic-runtime@synthetic-ops-project.iam",
  });
  assert.equal(Object.isFrozen(runtime), true);
  const backup = contract.readOpsProbeEnvironment(AUDIT_ENV, "ops-backup-audit");
  assert.equal(backup.database, undefined);
  assert.equal(backup.instance, "synthetic-primary");
  const run = (job, mutate) => {
    const env = { ...(job === "ops-runtime-probe" ? RUNTIME_ENV : AUDIT_ENV) };
    mutate(env);
    return () => contract.readOpsProbeEnvironment(env, job);
  };
  for (const job of ["ops-runtime-probe", "ops-backup-audit"]) {
    refusedWith("OPS_PROBE_HOST_MODE_FORBIDDEN", run(job, (env) => { env.HOST_MODE = ""; }));
    refusedWith("OPS_PROBE_CONTEXT_INVALID", run(job, (env) => { env.K_SERVICE = "svc"; }));
    refusedWith("OPS_PROBE_LOCAL_ENDPOINT_FORBIDDEN", run(job, (env) => { env.PG_TEST_SOCKET = "/x"; }));
    refusedWith("OPS_PROBE_LOCAL_ENDPOINT_FORBIDDEN", run(job, (env) => { env.PG_TEST_HOST = ""; }));
    refusedWith("OPS_PROBE_TUNABLE_FORBIDDEN", run(job, (env) => { env.POSTGRES_MAINTENANCE_JOB_X = "1"; }));
    refusedWith("OPS_PROBE_TUNABLE_FORBIDDEN", run(job, (env) => { env.OPS_PROBE_INTERVAL = "5"; }));
    for (const name of ["IDENTITY_LINK_SECRET", "POSTGRES_RATE_LIMIT_SECRET", "DISTRIBUTION_GITHUB_API_TOKEN",
      "APPLE_PRIVATE_KEY", "ENVELOPE_PRIVATE_JWK", "ENVELOPE_PUBLIC_JWK", "SOME_API_TOKEN", "DB_PASSWORD"]) {
      refusedWith("OPS_PROBE_SECRET_FORBIDDEN", run(job, (env) => { env[name] = SENTINEL; }));
    }
    for (const name of ["CLOUD_RUN_JOB", "DEPLOYMENT_SOURCE_COMMIT", "OPS_PROBE_TARGET", "PRIMARY_INSTANCE_CONNECTION_NAME"]) {
      refusedWith(`${name}_MISSING`, run(job, (env) => { delete env[name]; }));
      refusedWith(`${name}_MISSING`, run(job, (env) => { env[name] = ""; }));
    }
    refusedWith("CLOUD_RUN_JOB_INVALID", run(job, (env) => { env.CLOUD_RUN_JOB = "Bad_Name"; }));
    refusedWith("DEPLOYMENT_SOURCE_COMMIT_INVALID", run(job, (env) => { env.DEPLOYMENT_SOURCE_COMMIT = "abc"; }));
    refusedWith("OPS_PROBE_TARGET_INVALID", run(job, (env) => { env.OPS_PROBE_TARGET = "test"; }));
    refusedWith("PRIMARY_INSTANCE_CONNECTION_NAME_INVALID", run(job, (env) => { env.PRIMARY_INSTANCE_CONNECTION_NAME = "p:r"; }));
  }
  for (const name of ["PRIMARY_DATABASE", "PRIMARY_SCHEMA", "POSTGRES_IAM_USER"]) {
    refusedWith(`${name}_MISSING`, run("ops-runtime-probe", (env) => { delete env[name]; }));
    refusedWith("OPS_PROBE_DATABASE_FORBIDDEN", run("ops-backup-audit", (env) => { env[name] = "x_y"; }));
  }
  refusedWith("PRIMARY_DATABASE_INVALID", run("ops-runtime-probe", (env) => { env.PRIMARY_DATABASE = "Bad-Name"; }));
  refusedWith("PRIMARY_SCHEMA_INVALID", run("ops-runtime-probe", (env) => { env.PRIMARY_SCHEMA = "pg;drop"; }));
  refusedWith("POSTGRES_IAM_USER_INVALID", run("ops-runtime-probe", (env) => { env.POSTGRES_IAM_USER = "a b"; }));
  refusedWith("OPS_PROBE_ENVIRONMENT_INVALID", () => contract.readOpsProbeEnvironment(null, "ops-runtime-probe"));
  refusedWith("OPS_PROBE_ENVIRONMENT_INVALID", () => contract.readOpsProbeEnvironment({}, "no-such-job"));
});

// ---------------------------------------------------------------------------
// The runtime probe, against a scripted fake client

const MARKER_HEX = "0123456789abcdef0123456789abcdef";

/** A client that records every statement and answers from `respond`. */
function fakeClient(respond) {
  const statements = [];
  return {
    statements,
    async query(text, values) {
      statements.push({ text, values });
      return respond(text, values);
    },
    release() { this.released = true; },
  };
}

function fakePool(client) {
  return {
    ended: false,
    async connect() { return client; },
    async end() { this.ended = true; },
  };
}

const rows = (list = []) => ({ rows: list, rowCount: list.length });

/** Answers every group with plausible synthetic data. `override(text)` may answer first. */
function healthy(override = () => undefined, { allowed = true, sessions = [] } = {}) {
  return (text) => {
    const custom = override(text);
    if (custom !== undefined) return custom;
    if (/^(?:BEGIN|SET LOCAL|COMMIT|ROLLBACK)/u.test(text)) return rows();
    if (text.includes('"retention_state"')) return rows([{ age: "42" }]);
    if (text.includes('"analytics_v2_runs"')) return rows([{ age: "120" }]);
    if (text.includes('"analytics_v2_published_daily"')) return rows([{ age: "1" }]);
    if (text.includes('"telemetry_v12_day_manifests"')) return rows([{ age: "300" }]);
    if (text.includes("LEFT JOIN LATERAL")) {
      return rows([{ sequence: "500", recorded_ms: String(NOW - 3_000), now_ms: String(NOW) }]);
    }
    if (text.includes('"analytics_v2_journal_cursor"')) return rows([{ source_id: "synthetic-source", head: "500", cursor: "450" }]);
    if (text.includes("count(*)::text AS pending")) return rows([{ pending: "50" }]);
    if (text.includes("recorded_ms::text AS recorded_ms")) return rows([{ recorded_ms: String(NOW - 9_000), now_ms: String(NOW) }]);
    if (text.includes("pg_database_size")) return rows([{ size: "123456789", xid_age: "777", mxid_age: "88" }]);
    if (text.includes("pg_stat_database")) return rows([{ deadlocks: "2", conflicts: "0" }]);
    if (text.includes("pg_has_role")) return rows([{ allowed }]);
    if (text.includes("pg_stat_activity")) return rows(sessions);
    throw new Error(`unexpected statement: ${text.slice(0, 80)}`);
  };
}

const FIXED_CLOCK = () => NOW;
const byKey = (lines) => new Map(lines.map((line) => [`${line.probe}${line.class === undefined ? "" : `/${line.class}`}`, line]));
const RUNTIME_SIGNALS = contract.opsProbeNamesForJob("ops-runtime-probe")
  .filter((name) => !["log_redaction_marker", "log_redaction_posture"].includes(name));

test("a healthy run writes one ok line per signal, from the sources it names", async () => {
  const client = fakeClient(healthy(undefined, {
    sessions: [
      { application: "tibotattle-cloud-run-host", state: "idle in transaction", wait_type: null, transaction_age: "30" },
      { application: "tibotattle-cloud-run-host", state: "active", wait_type: "Lock", transaction_age: "5" },
      { application: "tibotattle-maintenance-job", state: "active", wait_type: "Lock", transaction_age: "9" },
      { application: "tibotattle-analytics-refresh", state: "idle in transaction (aborted)", wait_type: null, transaction_age: "400" },
      { application: "psql", state: "idle", wait_type: "Client", transaction_age: null },
      { application: `${SENTINEL}`, state: "active", wait_type: null, transaction_age: "1" },
    ],
  }));
  const lines = await probe.collectOpsRuntimeSignals({ client, schema: "synthetic_primary", now: FIXED_CLOCK });
  const map = byKey(lines);
  const value = (key) => {
    const line = map.get(key);
    assert.ok(line, key);
    assert.equal(line.state, "ok", key);
    return line.value;
  };
  assert.equal(value("maintenance_completed_age_seconds"), 42);
  assert.equal(value("analytics_refresh_completed_age_seconds"), 120);
  assert.equal(value("community_daily_head_age_days"), 1);
  assert.equal(value("v12_newest_ready_manifest_age_seconds"), 300);
  assert.equal(value("ingestion_journal_head_sequence"), 500);
  assert.equal(value("ingestion_journal_head_age_seconds"), 3);
  assert.equal(value("analytics_journal_lag_sequences"), 50);
  assert.equal(value("analytics_journal_pending_events"), 50);
  assert.equal(map.get("analytics_journal_pending_events").capped, false);
  assert.equal(value("analytics_journal_oldest_undelivered_age_seconds"), 9);
  assert.equal(value("database_size_bytes"), 123_456_789);
  assert.equal(value("database_xid_age"), 777);
  assert.equal(value("database_mxid_age"), 88);
  assert.equal(value("database_deadlocks_total"), 2);
  assert.equal(value("database_conflicts_total"), 0);
  assert.equal(value("idle_in_transaction_sessions"), 2);
  assert.equal(value("lock_waiting_sessions/origin"), 1);
  assert.equal(value("lock_waiting_sessions/maintenance"), 1);
  assert.equal(value("lock_waiting_sessions/analytics"), 0);
  assert.equal(value("lock_waiting_sessions/other"), 0);
  assert.equal(value("oldest_transaction_age_seconds/origin"), 30);
  assert.equal(value("oldest_transaction_age_seconds/analytics"), 400);
  assert.equal(value("oldest_transaction_age_seconds/other"), 1);
  assert.equal(value("oldest_transaction_age_seconds/migration"), 0);
  // Every runtime signal appears exactly once, per class where it is per class.
  const expected = RUNTIME_SIGNALS.flatMap((name) => (contract.OPS_PROBES[name].perClass
    ? contract.OPS_ACTIVITY_CLASSES.map((klass) => `${name}/${klass}`) : [name]));
  assert.deepEqual([...map.keys()].sort(), expected.sort());
  assert.equal(lines.length, expected.length);
  // No application name, row value or source id reaches a line.
  const text = lines.map(contract.serializeOpsProbeLine).join("\n");
  for (const secret of [SENTINEL, "psql", "tibotattle-maintenance-job", "synthetic-source", "idle in transaction"]) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test("every statement is a read: a read-only transaction with its two bounds, and no query text or write", async () => {
  const client = fakeClient(healthy(undefined, { sessions: [{ application: "x", state: "active", wait_type: null, transaction_age: "1" }] }));
  await probe.collectOpsRuntimeSignals({ client, schema: "synthetic_primary", now: FIXED_CLOCK });
  const texts = client.statements.map((statement) => statement.text);
  assert.ok(texts.length > 20);
  let begun = 0;
  let open = false;
  let sawStatementTimeout = false;
  let sawLockTimeout = false;
  for (const text of texts) {
    if (text.startsWith("BEGIN")) {
      assert.equal(text, "BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
      assert.equal(open, false);
      open = true;
      begun += 1;
      sawStatementTimeout = false;
      sawLockTimeout = false;
    } else if (text === "COMMIT" || text === "ROLLBACK") {
      assert.equal(open, true);
      assert.equal(sawStatementTimeout && sawLockTimeout, true, "each transaction sets both bounds before it reads");
      open = false;
    } else if (text === "SET LOCAL statement_timeout = 2000") {
      sawStatementTimeout = true;
    } else if (text === "SET LOCAL lock_timeout = 500") {
      sawLockTimeout = true;
    } else {
      assert.equal(open, true, "a read runs only inside its read-only transaction");
      assert.match(text, /^SELECT /u);
      assert.doesNotMatch(text, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|LOCK|VACUUM|ANALYZE|SET\s+ROLE|PERFORM|CALL)\b/iu);
    }
  }
  assert.equal(open, false);
  assert.equal(begun, 9, "one read-only transaction per group");
  const all = texts.join("\n");
  // Content-free: no query text, address, user, client or statement-level view, and no pg_stat_statements.
  assert.doesNotMatch(all, /\b(?:query|client_addr|client_hostname|client_port|usename|usesysid|backend_xid|backend_xmin|pg_stat_statements|pg_stat_ssl|pg_locks|pg_prepared_xacts)\b/iu);
  assert.match(all, /application_name AS application/u);
  assert.match(all, /backend_type = 'client backend'/u);
  assert.match(all, /datname = current_database\(\)/u);
  // The pending count is bounded by the cap, in the statement itself.
  assert.match(all, /LIMIT 10001\n\) bounded/u);
  // Every relation is schema-qualified with the quoted configured schema.
  for (const relation of ["retention_state", "analytics_v2_runs", "analytics_v2_published_daily", "telemetry_v12_day_manifests",
    "storage_source_state", "storage_ingestion_changes", "analytics_v2_journal_cursor"]) {
    assert.match(all, new RegExp(`"synthetic_primary"\\."${relation}"`, "u"), relation);
  }
});

test("a schema name that is not a plain identifier is refused before any statement", async () => {
  for (const schema of ["", "Bad", 'x"; DROP TABLE y; --', "pg_catalog", "information_schema", "a b", null, 7, "x".repeat(64)]) {
    const client = fakeClient(healthy());
    await assert.rejects(() => probe.collectOpsRuntimeSignals({ client, schema, now: FIXED_CLOCK }),
      (error) => error.code === "OPS_RUNTIME_PROBE_SCHEMA_INVALID");
    assert.equal(client.statements.length, 0);
  }
});

test("absent tables, missing data and a hidden stats view are unavailable with a reason, never 0", async () => {
  const absent = (relation) => Object.assign(new Error(`relation "${relation}" does not exist ${SENTINEL}`), {
    code: "42P01", detail: SENTINEL,
  });
  const client = fakeClient(healthy((text) => {
    if (text.includes('"retention_state"')) throw absent("retention_state");
    if (text.includes('"analytics_v2_runs"')) return rows([]);
    if (text.includes('"analytics_v2_published_daily"')) return rows([{ age: null }]);
    if (text.includes('"telemetry_v12_day_manifests"')) throw Object.assign(new Error(SENTINEL), { code: "42703" });
    if (text.includes("LEFT JOIN LATERAL")) return rows([]);
    if (text.includes('"analytics_v2_journal_cursor"')) throw absent("analytics_v2_journal_cursor");
    return undefined;
  }, { allowed: false }));
  const map = byKey(await probe.collectOpsRuntimeSignals({ client, schema: "synthetic_primary", now: FIXED_CLOCK }));
  const reasonOf = (key) => {
    const line = map.get(key);
    assert.equal(line.state, "unavailable", key);
    assert.equal(Object.hasOwn(line, "value"), false, `${key} carries no value`);
    return `${line.reason}${line.sqlstate_class === undefined ? "" : `:${line.sqlstate_class}`}`;
  };
  assert.equal(reasonOf("maintenance_completed_age_seconds"), "RELATION_ABSENT:42");
  assert.equal(reasonOf("analytics_refresh_completed_age_seconds"), "NO_DATA");
  assert.equal(reasonOf("community_daily_head_age_days"), "NO_DATA");
  assert.equal(reasonOf("v12_newest_ready_manifest_age_seconds"), "RELATION_ABSENT:42");
  assert.equal(reasonOf("ingestion_journal_head_sequence"), "NO_DATA");
  assert.equal(reasonOf("ingestion_journal_head_age_seconds"), "NO_DATA");
  for (const name of ["analytics_journal_lag_sequences", "analytics_journal_pending_events",
    "analytics_journal_oldest_undelivered_age_seconds"]) {
    assert.equal(reasonOf(name), "RELATION_ABSENT:42");
  }
  // Without pg_read_all_stats the session signals are unavailable, not a count of the visible few.
  for (const klass of contract.OPS_ACTIVITY_CLASSES) {
    assert.equal(reasonOf(`lock_waiting_sessions/${klass}`), "PRIVILEGE_MISSING");
    assert.equal(reasonOf(`oldest_transaction_age_seconds/${klass}`), "PRIVILEGE_MISSING");
  }
  assert.equal(reasonOf("idle_in_transaction_sessions"), "PRIVILEGE_MISSING");
  // The groups that could be read still are.
  assert.equal(map.get("database_size_bytes").state, "ok");
  assert.equal(map.get("database_deadlocks_total").value, 2);
  assert.equal(JSON.stringify([...map.values()]).includes(SENTINEL), false);
});

test("a journal source with no change rows has head sequence 0 and no age; an empty queue has age 0", async () => {
  const client = fakeClient(healthy((text) => {
    if (text.includes("LEFT JOIN LATERAL")) return rows([{ sequence: null, recorded_ms: null, now_ms: String(NOW) }]);
    if (text.includes('"analytics_v2_journal_cursor"')) return rows([{ source_id: "s", head: "0", cursor: null }]);
    if (text.includes("count(*)::text AS pending")) return rows([{ pending: "0" }]);
    if (text.includes("recorded_ms::text AS recorded_ms")) return rows([]);
    return undefined;
  }));
  const map = byKey(await probe.collectOpsRuntimeSignals({ client, schema: "synthetic_primary", now: FIXED_CLOCK }));
  assert.equal(map.get("ingestion_journal_head_sequence").value, 0);
  assert.equal(map.get("ingestion_journal_head_age_seconds").reason, "NO_DATA");
  assert.equal(map.get("analytics_journal_lag_sequences").value, 0);
  assert.equal(map.get("analytics_journal_pending_events").value, 0);
  assert.equal(map.get("analytics_journal_oldest_undelivered_age_seconds").value, 0);
});

test("the pending-journal count reports 10001 as capped, and 10000 exactly", async () => {
  for (const [pending, capped] of [["10000", false], ["10001", true]]) {
    const client = fakeClient(healthy((text) => (text.includes("count(*)::text AS pending") ? rows([{ pending }]) : undefined)));
    const map = byKey(await probe.collectOpsRuntimeSignals({ client, schema: "synthetic_primary", now: FIXED_CLOCK }));
    assert.equal(map.get("analytics_journal_pending_events").value, Number(pending));
    assert.equal(map.get("analytics_journal_pending_events").capped, capped);
  }
  // A count beyond the cap cannot come from the bounded statement: refuse it.
  const client = fakeClient(healthy((text) => (text.includes("count(*)::text AS pending") ? rows([{ pending: "10002" }]) : undefined)));
  const map = byKey(await probe.collectOpsRuntimeSignals({ client, schema: "synthetic_primary", now: FIXED_CLOCK }));
  assert.equal(map.get("analytics_journal_pending_events").reason, "UNEXPECTED_RESULT");
});

test("a cursor ahead of its journal is a fault, not a lag", async () => {
  const client = fakeClient(healthy((text) => (text.includes('"analytics_v2_journal_cursor"')
    ? rows([{ source_id: "s", head: "10", cursor: "11" }]) : undefined)));
  const map = byKey(await probe.collectOpsRuntimeSignals({ client, schema: "synthetic_primary", now: FIXED_CLOCK }));
  for (const name of ["analytics_journal_lag_sequences", "analytics_journal_pending_events",
    "analytics_journal_oldest_undelivered_age_seconds"]) {
    assert.equal(map.get(name).reason, "UNEXPECTED_RESULT", name);
  }
});

test("values the line cannot carry exactly, and clock skew, are handled without a false 0 or a negative", async () => {
  const client = fakeClient(healthy((text) => {
    if (text.includes('"retention_state"')) return rows([{ age: "-7" }]);
    if (text.includes('"analytics_v2_runs"')) return rows([{ age: "99999999999999999999" }]);
    if (text.includes("pg_database_size")) return rows([{ size: "9007199254740993", xid_age: "not-a-number", mxid_age: "1" }]);
    if (text.includes("LEFT JOIN LATERAL")) return rows([{ sequence: "1", recorded_ms: String(NOW + 5_000), now_ms: String(NOW) }]);
    return undefined;
  }));
  const map = byKey(await probe.collectOpsRuntimeSignals({ client, schema: "synthetic_primary", now: FIXED_CLOCK }));
  assert.equal(map.get("maintenance_completed_age_seconds").value, 0, "a negative age clamps to 0");
  assert.equal(map.get("analytics_refresh_completed_age_seconds").reason, "VALUE_OUT_OF_RANGE");
  assert.equal(map.get("database_size_bytes").reason, "VALUE_OUT_OF_RANGE");
  assert.equal(map.get("database_xid_age").reason, "VALUE_OUT_OF_RANGE");
  assert.equal(map.get("database_mxid_age").value, 1);
  assert.equal(map.get("ingestion_journal_head_age_seconds").value, 0);
});

test("statement and lock timeouts are unavailable with their own reason, and one failing group never hides the rest", async () => {
  let rolledBack = 0;
  const client = fakeClient(healthy((text) => {
    if (text === "ROLLBACK") { rolledBack += 1; return rows(); }
    if (text.includes('"retention_state"')) throw Object.assign(new Error(`canceling ${SENTINEL}`), { code: "57014" });
    if (text.includes('"analytics_v2_runs"')) throw Object.assign(new Error(SENTINEL), { code: "55P03" });
    if (text.includes('"telemetry_v12_day_manifests"')) throw Object.assign(new Error(SENTINEL), { code: "XX001" });
    if (text.includes("pg_stat_database")) throw new Error(SENTINEL);
    return undefined;
  }));
  const map = byKey(await probe.collectOpsRuntimeSignals({ client, schema: "synthetic_primary", now: FIXED_CLOCK }));
  assert.equal(map.get("maintenance_completed_age_seconds").reason, "STATEMENT_TIMEOUT");
  assert.equal(map.get("maintenance_completed_age_seconds").sqlstate_class, "57");
  assert.equal(map.get("analytics_refresh_completed_age_seconds").reason, "LOCK_TIMEOUT");
  assert.equal(map.get("v12_newest_ready_manifest_age_seconds").reason, "QUERY_FAILED");
  assert.equal(map.get("v12_newest_ready_manifest_age_seconds").sqlstate_class, "XX");
  assert.equal(map.get("database_deadlocks_total").reason, "QUERY_FAILED");
  assert.equal(map.get("database_deadlocks_total").sqlstate_class, undefined);
  assert.equal(map.get("database_size_bytes").state, "ok");
  assert.equal(map.get("community_daily_head_age_days").state, "ok");
  assert.equal(rolledBack, 4, "each failing group rolls its transaction back");
  assert.equal(JSON.stringify([...map.values()]).includes(SENTINEL), false);
});

test("a dead connection leaves every remaining signal unavailable instead of throwing", async () => {
  const client = fakeClient((text) => { throw Object.assign(new Error(SENTINEL), { code: "08006" }); });
  const lines = await probe.collectOpsRuntimeSignals({ client, schema: "synthetic_primary", now: FIXED_CLOCK });
  assert.equal(lines.length, RUNTIME_SIGNALS.flatMap((name) => (contract.OPS_PROBES[name].perClass ? contract.OPS_ACTIVITY_CLASSES : [name])).length);
  for (const line of lines) {
    assert.equal(line.state, "unavailable");
    assert.equal(line.reason, "QUERY_FAILED");
    assert.equal(line.sqlstate_class, "08");
  }
});

test("past its deadline the run stops reading and says so, signal by signal", async () => {
  // Each group's start reads the clock once; it advances 30 s a read, so the
  // fourth group starts 120 s after the run began, past the 100 s deadline.
  let clock = NOW;
  const client = fakeClient(healthy());
  const lines = await probe.collectOpsRuntimeSignals({
    client, schema: "synthetic_primary", deadlineMs: 100_000,
    now: () => { const current = clock; clock += 30_000; return current; },
  });
  const map = byKey(lines);
  for (const name of ["maintenance_completed_age_seconds", "analytics_refresh_completed_age_seconds", "community_daily_head_age_days"]) {
    assert.equal(map.get(name).state, "ok", name);
  }
  assert.equal(map.get("v12_newest_ready_manifest_age_seconds").reason, "DEADLINE_EXCEEDED");
  assert.equal(map.get("ingestion_journal_head_sequence").reason, "DEADLINE_EXCEEDED");
  assert.equal(map.get("lock_waiting_sessions/origin").reason, "DEADLINE_EXCEEDED");
  assert.equal(map.get("idle_in_transaction_sessions").reason, "DEADLINE_EXCEEDED");
  assert.equal(client.statements.filter((statement) => statement.text.startsWith("BEGIN")).length, 3);
  assert.equal(contract.OPS_PROBE_JOBS["ops-runtime-probe"].deadlineSeconds * 1_000, 100_000);
});

test("the log-redaction probe forces one duplicate key, rolls back, and writes only the marker", async () => {
  const client = fakeClient((text, values) => {
    if (/^INSERT INTO ops_probe_log_redaction/u.test(text)) {
      if (client.statements.filter((statement) => statement.text.startsWith("INSERT")).length === 2) {
        throw Object.assign(new Error(`duplicate key value ${SENTINEL}`), {
          code: "23505", detail: `Key (marker)=(${values[0]}) already exists.`, constraint: "ops_probe_log_redaction_pkey",
        });
      }
      return rows();
    }
    if (text.includes("current_setting")) {
      return rows([{ s0: "terse", s1: "panic", s2: "0", s3: "0", s4: "none" }]);
    }
    return rows();
  });
  const lines = await probe.runLogRedactionProbe({ client, randomHex: () => MARKER_HEX });
  const marker = `tibotattle-log-redaction-${MARKER_HEX}`;
  assert.deepEqual(lines.map((line) => ({ ...line })), [
    { schema: "tibotattle-ops-probe-v1", job: "ops-runtime-probe", probe: "log_redaction_marker", state: "ok", value: 1, marker },
    { schema: "tibotattle-ops-probe-v1", job: "ops-runtime-probe", probe: "log_redaction_posture", state: "ok", value: 1 },
  ]);
  const texts = client.statements.map((statement) => statement.text);
  assert.deepEqual(texts.slice(0, 6), [
    "BEGIN", "SET LOCAL statement_timeout = 2000", "SET LOCAL lock_timeout = 500",
    "CREATE TEMP TABLE ops_probe_log_redaction (marker text PRIMARY KEY) ON COMMIT DROP",
    "INSERT INTO ops_probe_log_redaction (marker) VALUES ($1)", "INSERT INTO ops_probe_log_redaction (marker) VALUES ($1)",
  ]);
  assert.equal(texts[6], "ROLLBACK", "the forced error is rolled back, never committed");
  assert.equal(texts.includes("COMMIT") && texts.indexOf("COMMIT") < 7, false);
  // The marker is the only value ever inserted, as a bind parameter, and the line never holds the error.
  assert.deepEqual(client.statements.filter((statement) => statement.text.startsWith("INSERT")).map((s) => s.values),
    [[marker], [marker]]);
  assert.equal(JSON.stringify(lines).includes(SENTINEL), false);
  assert.equal(JSON.stringify(lines).includes("already exists"), false);
});

test("the log-redaction probe never reports a pass unless the 23505 was the failure", async () => {
  const run = (respond) => probe.runLogRedactionProbe({ client: fakeClient(respond), randomHex: () => MARKER_HEX });
  // No violation at all: the table accepted the duplicate, so nothing was proved.
  const none = await run((text) => (text.includes("current_setting") ? rows([{ s0: "terse", s1: "panic", s2: "0", s3: "0", s4: "none" }]) : rows()));
  assert.equal(none[0].state, "unavailable");
  assert.equal(none[0].reason, "UNEXPECTED_RESULT");
  // A different error: its class only.
  const other = await run((text) => {
    if (text.startsWith("CREATE TEMP")) throw Object.assign(new Error(SENTINEL), { code: "42501" });
    if (text.includes("current_setting")) throw Object.assign(new Error(SENTINEL), { code: "42501" });
    return rows();
  });
  assert.deepEqual(other.map((line) => ({ state: line.state, reason: line.reason, class: line.sqlstate_class })), [
    { state: "unavailable", reason: "PRIVILEGE_MISSING", class: "42" },
    { state: "unavailable", reason: "PRIVILEGE_MISSING", class: "42" },
  ]);
  // A relaxed logging posture is reported as 0, not hidden.
  let inserts = 0;
  const relaxed = await run((text) => {
    if (text.startsWith("INSERT")) {
      inserts += 1;
      if (inserts === 2) throw Object.assign(new Error(SENTINEL), { code: "23505" });
      return rows();
    }
    if (text.includes("current_setting")) return rows([{ s0: "default", s1: "error", s2: "-1", s3: "0", s4: "none" }]);
    return rows();
  });
  assert.equal(relaxed[0].state, "ok");
  assert.equal(relaxed[1].value, 0);
  // A connection that cannot even begin.
  const dead = await run(() => { throw Object.assign(new Error(SENTINEL), { code: "08006" }); });
  assert.deepEqual(dead.map((line) => line.reason), ["QUERY_FAILED", "QUERY_FAILED"]);
  assert.equal(JSON.stringify(dead).includes(SENTINEL), false);
});

test("the posture is pinned to the settings OPS-2 renders, in the order the contract states", () => {
  assert.deepEqual({ ...contract.OPS_LOG_REDACTION_SETTINGS }, {
    log_error_verbosity: "terse", log_min_error_statement: "panic", log_parameter_max_length: "0",
    log_parameter_max_length_on_error: "0", log_statement: "none",
  });
});

// ---------------------------------------------------------------------------
// The runtime probe job

test("the argument contract is closed", () => {
  assert.deepEqual({ ...probe.parseOpsRuntimeProbeArguments([]) }, { help: false, mode: "collect" });
  assert.deepEqual({ ...probe.parseOpsRuntimeProbeArguments(["--probe=log-redaction"]) }, { help: false, mode: "log-redaction" });
  assert.deepEqual({ ...probe.parseOpsRuntimeProbeArguments(["--help"]) }, { help: true, mode: null });
  for (const argv of [["--help", "--probe=log-redaction"], ["--probe=other"], ["--probe="], ["--probe"], ["x"], ["--schema=public"],
    ["--probe=log-redaction", "--probe=log-redaction"], [""], ["--now=1"], "x", [1], null]) {
    assert.throws(() => probe.parseOpsRuntimeProbeArguments(argv),
      (error) => error.code === "OPS_RUNTIME_PROBE_ARGUMENTS_INVALID" && error.usage === true, JSON.stringify(argv));
  }
});

test("the job connects one read-only pool, runs, and closes everything", async () => {
  const client = fakeClient(healthy());
  const pool = fakePool(client);
  const connector = { closed: false, close() { this.closed = true; } };
  let options;
  const result = await probe.runOpsRuntimeProbe({
    argv: [], env: RUNTIME_ENV, now: FIXED_CLOCK,
    dependencies: {
      createConnector: () => connector,
      createIamPool: async (value) => { options = value; return pool; },
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.lines.length > 20, true);
  assert.deepEqual({ ...options, connector: undefined }, {
    connector: undefined, instanceConnectionName: CONNECTION, database: "synthetic_primary",
    user: "synthetic-runtime@synthetic-ops-project.iam", max: 1, applicationName: "tibotattle-ops-probe",
  });
  assert.equal(options.connector, connector);
  assert.equal(client.released, true);
  assert.equal(pool.ended, true);
  assert.equal(connector.closed, true);
});

test("--probe=log-redaction runs only the marker probe", async () => {
  let inserts = 0;
  const client = fakeClient((text) => {
    if (text.startsWith("INSERT")) { inserts += 1; if (inserts === 2) throw Object.assign(new Error(SENTINEL), { code: "23505" }); return rows(); }
    if (text.includes("current_setting")) return rows([{ s0: "terse", s1: "panic", s2: "0", s3: "0", s4: "none" }]);
    return rows();
  });
  const result = await probe.runOpsRuntimeProbe({
    argv: ["--probe=log-redaction"], env: RUNTIME_ENV,
    dependencies: {
      createConnector: () => ({ close() {} }), createIamPool: async () => fakePool(client), randomHex: () => MARKER_HEX,
    },
  });
  assert.deepEqual(result.lines.map((line) => line.probe), ["log_redaction_marker", "log_redaction_posture"]);
  assert.equal(result.lines[0].value, 1);
  assert.equal(client.statements.some((statement) => statement.text.includes("retention_state")), false);
});

test("configuration refusals happen before any connection", async () => {
  let connected = 0;
  const dependencies = {
    createConnector: () => { connected += 1; return { close() {} }; },
    createIamPool: async () => { connected += 1; return fakePool(fakeClient(healthy())); },
  };
  for (const [mutate, code] of [
    [(env) => { env.HOST_MODE = "production"; }, "OPS_PROBE_HOST_MODE_FORBIDDEN"],
    [(env) => { env.K_SERVICE = "x"; }, "OPS_PROBE_CONTEXT_INVALID"],
    [(env) => { env.PG_TEST_SOCKET = "/tmp/x"; }, "OPS_PROBE_LOCAL_ENDPOINT_FORBIDDEN"],
    [(env) => { env.IDENTITY_LINK_SECRET = SENTINEL; }, "OPS_PROBE_SECRET_FORBIDDEN"],
    [(env) => { env.OPS_PROBE_X = "1"; }, "OPS_PROBE_TUNABLE_FORBIDDEN"],
    [(env) => { delete env.PRIMARY_SCHEMA; }, "PRIMARY_SCHEMA_MISSING"],
  ]) {
    const env = { ...RUNTIME_ENV };
    mutate(env);
    await assert.rejects(() => probe.runOpsRuntimeProbe({ argv: [], env, dependencies }), (error) => error.code === code, code);
  }
  assert.equal(connected, 0);
  assert.deepEqual({ ...await probe.runOpsRuntimeProbe({ argv: ["--help"], env: {}, dependencies }) }, { status: "help" });
});

test("a pool that cannot be made is a coded failure whose text never reaches stderr", async () => {
  const dependencies = {
    createConnector: () => ({ close() {} }),
    createIamPool: async () => { throw new Error("POSTGRES_CONNECTION_FAILED"); },
  };
  await assert.rejects(() => probe.runOpsRuntimeProbe({ argv: [], env: RUNTIME_ENV, dependencies }),
    (error) => probe.safeOpsRuntimeProbeCode(error) === "POSTGRES_CONNECTION_FAILED");
  assert.equal(probe.safeOpsRuntimeProbeCode(new Error(`${SENTINEL} password=hunter2`)), "OPS_RUNTIME_PROBE_FAILED");
  assert.equal(probe.safeOpsRuntimeProbeCode(Object.assign(new Error("x"), { code: "OPS_PROBE_TARGET_INVALID" })), "OPS_PROBE_TARGET_INVALID");
});

// ---------------------------------------------------------------------------
// The backup audit

function describeInstance({ config = {}, name = "synthetic-primary" } = {}) {
  return {
    kind: "sql#instance",
    name,
    project: "synthetic-ops-project",
    region: "us-east1",
    databaseVersion: "POSTGRES_17",
    state: "RUNNABLE",
    settings: {
      kind: "sql#settings",
      tier: "db-custom-4-16384",
      deletionProtectionEnabled: true,
      backupConfiguration: {
        kind: "sql#backupConfiguration",
        enabled: true,
        startTime: "07:00",
        location: "us-east1",
        pointInTimeRecoveryEnabled: true,
        replicationLogArchivingEnabled: true,
        transactionLogRetentionDays: 7,
        transactionalLogStorageState: "CLOUD_STORAGE",
        backupTier: "STANDARD",
        backupRetentionSettings: { retentionUnit: "COUNT", retainedBackups: 30 },
        ...config,
      },
      finalBackupConfig: { enabled: true, retentionDays: 30 },
    },
  };
}

let nextRunId = 1_790_000_000_000;
function backupRun({ ageMs, type = "AUTOMATED", status = "SUCCESSFUL" }) {
  nextRunId += 1;
  const start = new Date(NOW - ageMs).toISOString();
  return {
    kind: "sql#backupRun", id: String(nextRunId), instance: "synthetic-primary", type, status,
    backupKind: "SNAPSHOT", location: "us-east1", enqueuedTime: start, startTime: start,
    endTime: new Date(NOW - ageMs + 300_000).toISOString(), windowStartTime: start,
    description: SENTINEL,
  };
}
const series = (count = 30, newestAgeMs = 10 * HOUR) => Array.from({ length: count }, (_, index) => backupRun({ ageMs: newestAgeMs + index * DAY }));

/** A fetch that serves the instance and its run pages; `fault(url)` may answer first. */
function fakeAdmin({ describe = describeInstance(), pages = [series()], fault = () => undefined } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const custom = fault(url, init);
    if (custom !== undefined) return custom instanceof Error ? Promise.reject(custom) : custom;
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/backupRuns")) {
      const index = Number(parsed.searchParams.get("pageToken")?.replace("page-", "") ?? "0");
      return jsonResponse({
        kind: "sql#backupRunsList", items: pages[index], ...(index + 1 < pages.length ? { nextPageToken: `page-${index + 1}` } : {}),
      });
    }
    return jsonResponse(describe);
  };
  return { calls, fetchImpl };
}

const jsonResponse = (body, status = 200) => ({ status, async text() { return typeof body === "string" ? body : JSON.stringify(body); } });
const tokenProvider = (token = "synthetic-access-token") => async () => async () => token;

async function runAudit(admin, { token } = {}) {
  const result = await audit.runOpsBackupAudit({
    argv: [], env: AUDIT_ENV, now: () => NOW,
    dependencies: { createAccessTokenProvider: tokenProvider(token), fetchImpl: admin.fetchImpl },
  });
  return byKey(result.lines);
}

test("a compliant instance is level 0 with point-in-time recovery on and a fresh backup", async () => {
  const admin = fakeAdmin();
  const map = await runAudit(admin);
  assert.deepEqual({ ...map.get("backup_audit_level") }, {
    schema: "tibotattle-ops-probe-v1", job: "ops-backup-audit", probe: "backup_audit_level", state: "ok", value: 0, codes: [],
  });
  assert.equal(map.get("backup_pitr_enabled").value, 1);
  assert.equal(map.get("backup_last_automated_age_hours").value, 10);
  // Two GETs: the instance, then one page of runs; nothing else, ever.
  assert.equal(admin.calls.length, 2);
  for (const call of admin.calls) {
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.headers.authorization, "Bearer synthetic-access-token");
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.equal(new URL(call.url).origin, "https://sqladmin.googleapis.com");
  }
  assert.equal(admin.calls[0].url, "https://sqladmin.googleapis.com/v1/projects/synthetic-ops-project/instances/synthetic-primary");
  assert.equal(admin.calls[1].url,
    "https://sqladmin.googleapis.com/v1/projects/synthetic-ops-project/instances/synthetic-primary/backupRuns?maxResults=100");
});

test("a 366-day-old backup is level 2, and the line carries closed codes only", async () => {
  const old = backupRun({ ageMs: 366 * DAY });
  const map = await runAudit(fakeAdmin({ pages: [[...series(), old]] }));
  const level = map.get("backup_audit_level");
  assert.equal(level.state, "ok");
  assert.equal(level.value, 2);
  assert.deepEqual([...level.codes], ["BACKUP_OLDER_THAN_HORIZON"]);
  for (const code of level.codes) assert.ok(BACKUP_HORIZON_CODES.includes(code));
  assert.equal(JSON.stringify([...map.values()]).includes(SENTINEL), false, "no backup description reaches a line");
  assert.equal(JSON.stringify([...map.values()]).includes(old.id), false, "no backup id reaches a line");
});

test("a stale automated backup is a warning, with its age", async () => {
  const map = await runAudit(fakeAdmin({ pages: [series(30, 40 * HOUR)] }));
  assert.equal(map.get("backup_audit_level").value, 1);
  assert.deepEqual([...map.get("backup_audit_level").codes], ["AUTOMATED_BACKUP_STALE"]);
  assert.equal(map.get("backup_last_automated_age_hours").value, 40);
});

test("point-in-time recovery off reads 0 and warns; an unreadable setting is unavailable, not 0", async () => {
  const off = await runAudit(fakeAdmin({ describe: describeInstance({ config: { pointInTimeRecoveryEnabled: false } }) }));
  assert.equal(off.get("backup_pitr_enabled").value, 0);
  assert.equal(off.get("backup_audit_level").value, 1);
  assert.deepEqual([...off.get("backup_audit_level").codes], ["PITR_DISABLED"]);
  const absent = describeInstance();
  delete absent.settings.backupConfiguration.pointInTimeRecoveryEnabled;
  assert.equal((await runAudit(fakeAdmin({ describe: absent }))).get("backup_pitr_enabled").value, 0);
  for (const flag of ["yes", 1, null, {}]) {
    const unreadable = await runAudit(fakeAdmin({ describe: describeInstance({ config: { pointInTimeRecoveryEnabled: flag } }) }));
    assert.equal(unreadable.get("backup_pitr_enabled").reason, "EVIDENCE_UNREADABLE");
    assert.equal(unreadable.get("backup_audit_level").value, 2, "OPS-1 reads a setting it cannot parse as a breach");
    assert.ok(unreadable.get("backup_audit_level").codes.includes("BACKUP_SETTINGS_UNRECOGNIZED"));
  }
  const noSettings = await runAudit(fakeAdmin({ describe: { kind: "sql#instance", name: "synthetic-primary" } }));
  assert.equal(noSettings.get("backup_pitr_enabled").reason, "EVIDENCE_UNREADABLE");
  assert.equal(noSettings.get("backup_audit_level").value, 2);
});

test("a fetch failure is unavailable, never ok and never a breach", async () => {
  const failures = [
    [() => new Error(`connection reset ${SENTINEL}`), "FETCH_FAILED"],
    [() => Object.assign(new Error(SENTINEL), { name: "TimeoutError" }), "FETCH_TIMEOUT"],
    [() => Object.assign(new Error(SENTINEL), { name: "AbortError" }), "FETCH_TIMEOUT"],
    [() => jsonResponse({ error: SENTINEL }, 500), "HTTP_STATUS"],
    [() => jsonResponse({ error: SENTINEL }, 403), "HTTP_STATUS"],
    [() => jsonResponse({ error: SENTINEL }, 302), "HTTP_STATUS"],
    [() => jsonResponse(`not json ${SENTINEL}`), "RESPONSE_INVALID"],
    [() => jsonResponse([1, 2]), "RESPONSE_INVALID"],
    [() => jsonResponse("null"), "RESPONSE_INVALID"],
    [() => ({ status: 200, text: async () => { throw Object.assign(new Error(SENTINEL), { name: "TimeoutError" }); } }), "FETCH_TIMEOUT"],
    [() => ({ nothing: true }), "FETCH_FAILED"],
  ];
  for (const [fault, reason] of failures) {
    // The instance read fails: all three signals are unavailable.
    const bothFail = await runAudit(fakeAdmin({ fault: () => fault() }));
    for (const name of ["backup_audit_level", "backup_pitr_enabled", "backup_last_automated_age_hours"]) {
      assert.equal(bothFail.get(name).state, "unavailable", name);
      assert.equal(bothFail.get(name).reason, reason, `${name} ${reason}`);
      assert.equal(Object.hasOwn(bothFail.get(name), "value"), false);
    }
    // Only the run list fails: the level and freshness are unavailable, the setting stands.
    const runsFail = await runAudit(fakeAdmin({ fault: (url) => (new URL(url).pathname.endsWith("/backupRuns") ? fault() : undefined) }));
    assert.equal(runsFail.get("backup_audit_level").reason, reason);
    assert.equal(runsFail.get("backup_last_automated_age_hours").reason, reason);
    assert.equal(runsFail.get("backup_pitr_enabled").value, 1);
    assert.equal(JSON.stringify([...runsFail.values(), ...bothFail.values()]).includes(SENTINEL), false);
  }
});

test("runs are paged to their end, and a list that never ends is unavailable", async () => {
  const pages = [series(30, 10 * HOUR).slice(0, 12), series(30, 10 * HOUR).slice(12, 24), series(30, 10 * HOUR).slice(24)];
  const admin = fakeAdmin({ pages });
  const map = await runAudit(admin);
  assert.equal(map.get("backup_audit_level").value, 0);
  assert.equal(admin.calls.length, 4);
  assert.match(admin.calls[2].url, /pageToken=page-1$/u);
  assert.match(admin.calls[3].url, /pageToken=page-2$/u);
  const endless = fakeAdmin({ fault: (url) => (new URL(url).pathname.endsWith("/backupRuns")
    ? jsonResponse({ items: [], nextPageToken: "more" }) : undefined) });
  const capped = await runAudit(endless);
  assert.equal(capped.get("backup_audit_level").reason, "PAGE_LIMIT");
  assert.equal(endless.calls.length, 1 + contract.OPS_PROBE_JOBS["ops-backup-audit"].maxPages);
  for (const token of [" x", "a b", "a".repeat(2_049), 7, "x\n"]) {
    const bad = await runAudit(fakeAdmin({ fault: (url) => (new URL(url).pathname.endsWith("/backupRuns")
      ? jsonResponse({ items: [], nextPageToken: token }) : undefined) }));
    assert.equal(bad.get("backup_audit_level").reason, "RESPONSE_INVALID", JSON.stringify(token));
  }
  const oversize = await runAudit(fakeAdmin({ fault: (url) => (new URL(url).pathname.endsWith("/backupRuns")
    ? jsonResponse({ items: Array.from({ length: 101 }, () => ({})) }) : undefined) }));
  assert.equal(oversize.get("backup_audit_level").reason, "RESPONSE_INVALID");
});

test("no credential means all three signals are unavailable, and nothing is requested", async () => {
  for (const provider of [async () => async () => { throw new Error(SENTINEL); }, async () => async () => "", async () => { throw new Error(SENTINEL); }]) {
    const admin = fakeAdmin();
    const result = await audit.runOpsBackupAudit({
      argv: [], env: AUDIT_ENV, now: () => NOW,
      dependencies: { createAccessTokenProvider: provider, fetchImpl: admin.fetchImpl },
    });
    assert.deepEqual(result.lines.map((line) => [line.probe, line.state, line.reason]), [
      ["backup_audit_level", "unavailable", "FETCH_FAILED"],
      ["backup_pitr_enabled", "unavailable", "FETCH_FAILED"],
      ["backup_last_automated_age_hours", "unavailable", "FETCH_FAILED"],
    ]);
    assert.equal(admin.calls.length, 0);
    assert.equal(result.exitCode, 0);
  }
});

test("the access token and the response bodies never reach a line", async () => {
  const admin = fakeAdmin({ describe: { ...describeInstance(), ipAddresses: [{ ipAddress: "203.0.113.9" }], serverCaCert: { cert: SENTINEL } } });
  const result = await audit.runOpsBackupAudit({
    argv: [], env: AUDIT_ENV, now: () => NOW,
    dependencies: { createAccessTokenProvider: tokenProvider("synthetic-secret-token-value"), fetchImpl: admin.fetchImpl },
  });
  const text = result.lines.map(contract.serializeOpsProbeLine).join("\n");
  for (const secret of ["synthetic-secret-token-value", "203.0.113.9", SENTINEL, "synthetic-primary", "synthetic-ops-project"]) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test("the audit's argument and environment contract is closed", async () => {
  assert.deepEqual({ ...audit.parseOpsBackupAuditArguments([]) }, { help: false });
  assert.deepEqual({ ...audit.parseOpsBackupAuditArguments(["--help"]) }, { help: true });
  for (const argv of [["x"], ["--help", "x"], ["--probe=log-redaction"], [""], null, [1]]) {
    assert.throws(() => audit.parseOpsBackupAuditArguments(argv),
      (error) => error.code === "OPS_BACKUP_AUDIT_ARGUMENTS_INVALID" && error.usage === true);
  }
  for (const [mutate, code] of [
    [(env) => { env.PRIMARY_DATABASE = "x_y"; }, "OPS_PROBE_DATABASE_FORBIDDEN"],
    [(env) => { env.POSTGRES_IAM_USER = "x"; }, "OPS_PROBE_DATABASE_FORBIDDEN"],
    [(env) => { env.HOST_MODE = ""; }, "OPS_PROBE_HOST_MODE_FORBIDDEN"],
    [(env) => { env.GOOGLE_API_KEY_TOKEN = "x"; }, "OPS_PROBE_SECRET_FORBIDDEN"],
    [(env) => { env.OPS_PROBE_TARGET = "dev"; }, "OPS_PROBE_TARGET_INVALID"],
  ]) {
    const env = { ...AUDIT_ENV };
    mutate(env);
    await assert.rejects(() => audit.runOpsBackupAudit({ argv: [], env, dependencies: { fetchImpl: async () => { throw new Error("no request"); } } }),
      (error) => error.code === code, code);
  }
  assert.equal(audit.safeOpsBackupAuditCode(new Error(SENTINEL)), "OPS_BACKUP_AUDIT_FAILED");
});

test("the audit shares OPS-1's closed vocabulary: every code it can emit is an OPS-1 code", async () => {
  const scenarios = [
    series(), series(30, 40 * HOUR), [...series(), backupRun({ ageMs: 366 * DAY })], [],
    [...series(), backupRun({ ageMs: 5 * DAY, type: "ON_DEMAND" })],
  ];
  for (const pages of scenarios) {
    const map = await runAudit(fakeAdmin({ pages: [pages] }));
    for (const code of map.get("backup_audit_level").codes ?? []) assert.ok(BACKUP_HORIZON_CODES.includes(code), code);
  }
  // No automated backup at all: the level warns (AUTOMATED_BACKUP_STALE) and the age is unavailable, not 0.
  const none = await runAudit(fakeAdmin({ pages: [[]] }));
  assert.equal(none.get("backup_audit_level").value, 1);
  assert.equal(none.get("backup_last_automated_age_hours").reason, "NO_DATA");
});

// ---------------------------------------------------------------------------
// Wiring and the dist bundles

test("the image builds both probe jobs and the context ships what they import", async () => {
  const buildSource = await readFile(join(ROOT, "build.mjs"), "utf8");
  const dockerfile = await readFile(join(ROOT, "Dockerfile"), "utf8");
  const context = await readFile(join(WORKER_ROOT, "scripts", "cloud-run-build-context.mjs"), "utf8");
  const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  for (const [entry, constant] of [["ops-runtime-probe-job", "OPS_RUNTIME_PROBE_ENTRY"], ["ops-backup-audit-job", "OPS_BACKUP_AUDIT_ENTRY"]]) {
    assert.ok(buildSource.includes(`const ${constant} = resolve(ROOT, "${entry}.mjs");`), constant);
    assert.ok(buildSource.includes(`"${entry}": ${constant},`), entry);
    assert.ok(buildSource.includes(`"dist/${entry}.mjs"`), entry);
    assert.ok(buildSource.includes(`"${entry}.mjs"`), entry);
    assert.match(dockerfile, new RegExp(`&& test -s dist/${entry}\\.mjs`, "u"), entry);
  }
  for (const file of ["ops-probe-contract.mjs", "ops-runtime-probe-job.mjs", "ops-backup-audit-job.mjs", "ops-probe-job.check.mjs",
    "ops-backup-horizon.mjs"]) {
    assert.ok(context.includes(`source: "cloud-run/${file}"`), file);
  }
  assert.equal(packageJson.scripts["ops:runtime-probe"], "node ./dist/ops-runtime-probe-job.mjs");
  assert.equal(packageJson.scripts["ops:backup-audit"], "node ./dist/ops-backup-audit-job.mjs");
  assert.ok(packageJson.scripts.check.includes("node ./ops-probe-job.check.mjs") || packageJson.scripts.check.includes("./ops-probe-job.check.mjs"));
  assert.ok(packageJson.scripts.check.includes("node --check ./ops-runtime-probe-job.mjs"));
  assert.ok(packageJson.scripts.check.includes("node --check ./ops-backup-audit-job.mjs"));
  assert.ok(packageJson.scripts.check.includes("node --check ./ops-probe-contract.mjs"));
});

test("the dist bundles answer their contracts and never bundle the request-serving host", async () => {
  await mkdir(join(ROOT, "dist"), { recursive: true });
  const directory = await mkdtemp(join(ROOT, "dist", ".ops-probe-check-"));
  try {
    const run = (outfile, args, env = {}) => spawnSync(process.execPath, [outfile, ...args], {
      encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env }, timeout: 60_000,
    });
    for (const [entry, usage, job] of [
      ["ops-runtime-probe-job", /--probe=log-redaction/u, "ops-runtime-probe"],
      ["ops-backup-audit-job", /Cloud SQL Admin API/u, "ops-backup-audit"],
    ]) {
      const outfile = join(directory, `${entry}.mjs`);
      await build({
        entryPoints: [join(ROOT, `${entry}.mjs`)],
        bundle: true, platform: "node", format: "esm", target: "node22", outfile, logLevel: "silent",
        external: ["@google-cloud/cloud-sql-connector", "google-auth-library", "jsonc-parser", "pg"],
      });
      const bundle = await readFile(outfile, "utf8");
      assert.match(bundle, /tibotattle-ops-probe-v1/u);
      assert.doesNotMatch(bundle, /fastpath-test|POSTGRES_TEST_HTTP_COMMAND_UNSUPPORTED|IDENTITY_LINK_SECRET/u);
      const help = run(outfile, ["--help"]);
      assert.equal(help.status, 0);
      assert.match(help.stdout, usage);
      const usageRefusal = run(outfile, ["--bogus"]);
      assert.equal(usageRefusal.status, 2);
      assert.deepEqual(JSON.parse(usageRefusal.stderr), {
        schema: "tibotattle-ops-probe-v1", job, status: "failed",
        code: job === "ops-runtime-probe" ? "OPS_RUNTIME_PROBE_ARGUMENTS_INVALID" : "OPS_BACKUP_AUDIT_ARGUMENTS_INVALID",
      });
      const bare = run(outfile, []);
      assert.equal(bare.status, 1);
      assert.deepEqual(JSON.parse(bare.stderr), { schema: "tibotattle-ops-probe-v1", job, status: "failed", code: "CLOUD_RUN_JOB_MISSING" });
      assert.equal(bare.stdout, "");
      const local = run(outfile, [], { ...RUNTIME_ENV, ...AUDIT_ENV, PG_TEST_SOCKET: "/private/tmp/x/socket" });
      assert.equal(local.status, 1);
      assert.equal(JSON.parse(local.stderr).code, "OPS_PROBE_LOCAL_ENDPOINT_FORBIDDEN");
      assert.equal(local.stdout, "");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
