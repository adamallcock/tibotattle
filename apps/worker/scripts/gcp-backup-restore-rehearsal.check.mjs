import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SCRATCH_INSTANCE_PATTERN } from "../cloud-run/postgres-production-migrations.mjs";
import {
  EXIT_CODES,
  FINGERPRINT_QUERIES,
  OPERATION_WAIT_BOUNDS_MS,
  POINT_IN_TIME_AFTER_PREFLIGHT,
  RESTORE_REHEARSAL_COMMANDS,
  RESTORE_REHEARSAL_RECEIPT_SCHEMA,
  SCRATCH_SETTLE_BOUND_MS,
  adoptCleanupAuthorization,
  cleanupAuthorization,
  cleanupRehearsalScratch,
  compareFingerprints,
  doNotRestoreOutcome,
  fingerprintDatabase,
  guardedRehearsalGcloud,
  main,
  manifestRelation,
  parseRehearsalArgs,
  planRestoreRehearsal,
  rehearsalExitCode,
  rehearsalTarget,
  runRestoreRehearsal,
  scratchInstanceName,
} from "./gcp-backup-restore-rehearsal.mjs";
import { TEST_TARGET_NAMES, loadCommittedDesiredState } from "./gcp-ops-infra-manifest.mjs";

// The committed staging desired state is read as is; every database row,
// backup, instance and operation below is a synthetic fake. Nothing calls gcloud.
const STAGING = loadCommittedDesiredState("staging");
const SOURCE = STAGING.cloudSql.instance;
const PROJECT = STAGING.project;
const REGION = STAGING.region;
const ID = "a1b2c3d4";
const PITR_SCRATCH = `${SOURCE}-rehearsal-${ID}`;
const BACKUP_SCRATCH = `${SOURCE}-rehearsal-${ID}b`;
const NOW = Date.parse("2026-10-02T18:00:00.000Z");
const POINT_IN_TIME = "2026-10-02T17:00:00Z";
const BACKUP_ID = "1790000000000";
const KEY = "0123456789abcdef".repeat(4);
const PITR_REQUEST = Object.freeze({ environment: "staging", path: "pitr", pointInTime: POINT_IN_TIME, rehearsalId: ID });
const COVERED_REQUEST = Object.freeze({ ...PITR_REQUEST, pointInTime: POINT_IN_TIME_AFTER_PREFLIGHT });
const BACKUP_REQUEST = Object.freeze({ environment: "staging", path: "backup", backupId: BACKUP_ID, rehearsalId: ID });
const MIGRATIONS = Object.freeze([1, 2, 3].map((version) => Object.freeze({
  version, name: `000${version}_synthetic.sql`, sha256: createHash("sha256").update(`m${version}`).digest("hex"),
})));
const HISTORY = MIGRATIONS.map(({ version, name, sha256 }) => ({ version, name, checksum_sha256: sha256 }));
const ALL_LABELS = { "tibotattle-purpose": "restore-rehearsal", "tibotattle-rehearsal": ID };

/** A clock that advances 1 ms per read and by exactly `ms` per sleep. */
function virtualClock(start = NOW) {
  let value = start;
  return {
    now: () => {
      value += 1;
      return value;
    },
    sleep: async (ms) => {
      value += Math.max(0, ms);
    },
    peek: () => value,
  };
}

function sourceInstance(overrides = {}) {
  return {
    name: SOURCE,
    project: PROJECT,
    region: REGION,
    state: "RUNNABLE",
    databaseVersion: "POSTGRES_17",
    settings: {
      tier: "db-custom-4-16384",
      dataDiskSizeGb: "50",
      deletionProtectionEnabled: true,
      retainBackupsOnDelete: false,
      finalBackupConfig: { enabled: true, retentionDays: 30 },
      backupConfiguration: { enabled: true, pointInTimeRecoveryEnabled: true, transactionLogRetentionDays: 7 },
      ipConfiguration: { ipv4Enabled: true, authorizedNetworks: [] },
      // Not a rehearsal label; a clone inherits it.
      userLabels: { env: "staging" },
      ...overrides.settings,
    },
    ...overrides.top,
  };
}

function successfulBackup(overrides = {}) {
  return { id: BACKUP_ID, instance: SOURCE, status: "SUCCESSFUL", type: "AUTOMATED",
    windowStartTime: "2026-10-02T07:00:00.000Z", endTime: "2026-10-02T07:04:00.000Z", ...overrides };
}

function parseLabels(value) {
  return Object.fromEntries(value.split(",").map((pair) => pair.split("=")));
}

/** Describes of an operation before it reports DONE. */
const DEFAULT_POLLS = Object.freeze({ "sql instances clone": 2, "sql instances create": 1, "sql backups restore": 2,
  "sql instances patch": 0, "sql instances delete": 1 });

/**
 * A fake gcloud over an in-memory estate with Cloud SQL's operation model.
 * Every --async mutation returns an operation that reports DONE after a number
 * of observations (an operations describe, or an operations list of its
 * instance). A clone or create shows PENDING_CREATE until its operation is
 * done. A patch or delete of an instance with an unfinished operation is
 * refused, as Cloud SQL refuses it, and recorded in `refusedWhileBusy`.
 *
 * - `refuse`: that shape exits 1 with no effect (after `onRefuse(fake)`).
 * - `refuseButStart`: that shape exits 1 although its operation started (gcloud
 *   failed after sending).
 * - `failOperation`: a shape, or a predicate over the argv, whose operation
 *   ends DONE with an error.
 * - `noOperationName`: that shape exits 0 with no readable operation.
 * - `finalState`: the scratch's state once its create, clone or restore is done.
 */
function fakeGcloud({ source = sourceInstance(), backups = { [BACKUP_ID]: successfulBackup() }, existing = [],
  polls = {}, finalState = "RUNNABLE", refuse = null, onRefuse = null, refuseButStart = null, failOperation = null,
  noOperationName = null, ignoreDisarm = false, keepFinalBackupSetting = false, backupListFails = false,
  leaveBackupOnDelete = false } = {}) {
  const instances = new Map([[SOURCE, structuredClone(source)]]);
  // A clone copies the source's settings, its user labels included.
  const copyOfSource = (name, labels = {}) => ({ ...structuredClone(instances.get(SOURCE)), name,
    settings: { ...structuredClone(instances.get(SOURCE).settings),
      userLabels: { ...instances.get(SOURCE).settings.userLabels, ...labels } } });
  for (const name of existing) instances.set(name, copyOfSource(name));
  const operations = new Map();
  const leftovers = [];
  const calls = [];
  const refusedWhileBusy = [];
  let counter = 0;
  const ok = (value) => ({ status: 0, stdout: value === undefined ? "" : JSON.stringify(value) });
  const no = () => ({ status: 1, stdout: "" });
  const busy = (name) => [...operations.values()].some((op) => op.target === name && op.status !== "DONE");
  const view = (op) => ({ kind: "sql#operation", name: op.name, status: op.status, operationType: op.type,
    targetId: op.target, targetProject: PROJECT,
    ...(op.status === "DONE" && op.failed ? { error: { errors: [{ code: "SYNTHETIC_FAILURE" }] } } : {}) });
  const finish = (op) => {
    op.status = "DONE";
    (op.failed ? op.onFail : op.onDone)?.();
  };
  const observe = (op) => {
    if (op.status === "DONE") return;
    op.remaining -= 1;
    if (op.remaining <= 0) finish(op);
  };
  let failing = false;
  const start = (shape, target, type, { onDone, onFail, remaining } = {}) => {
    counter += 1;
    const op = { name: `0000${counter}-synthetic-operation`, target, type, status: "RUNNING",
      remaining: remaining ?? polls[shape] ?? DEFAULT_POLLS[shape], failed: failing, onDone, onFail };
    operations.set(op.name, op);
    if (op.remaining <= 0) finish(op);
    return op;
  };
  const fake = {
    calls, instances, leftovers, operations, refusedWhileBusy,
    /** Another run's clone holding `name`, unlabelled, busy for `remaining` observations. */
    foreignClone(name, remaining = 3, labels = {}) {
      failing = false;
      const instance = { ...copyOfSource(name, labels), state: "PENDING_CREATE" };
      instances.set(name, instance);
      start("sql instances clone", name, "CLONE", { remaining, onDone: () => { instance.state = "RUNNABLE"; } });
    },
    /** Sets how many more observations each unfinished operation on `name` needs. */
    setRemaining(name, remaining) {
      for (const op of operations.values()) if (op.target === name && op.status !== "DONE") op.remaining = remaining;
    },
  };
  const mutate = (shape, argv, names, flag) => {
    failing = typeof failOperation === "function" ? failOperation(argv) : failOperation === shape;
    switch (shape) {
      case "sql instances clone": {
        const instance = { ...copyOfSource(names[1]), state: "PENDING_CREATE" };
        instances.set(names[1], instance);
        return start(shape, names[1], "CLONE", { onDone: () => { instance.state = finalState; },
          onFail: () => { instance.state = "FAILED"; } });
      }
      case "sql instances create": {
        const instance = { name: names[0], project: PROJECT, region: flag("--region"), state: "PENDING_CREATE",
          databaseVersion: flag("--database-version"), settings: { tier: flag("--tier"), deletionProtectionEnabled: false,
            backupConfiguration: { enabled: false }, userLabels: parseLabels(flag("--labels")),
            ipConfiguration: { ipv4Enabled: true, authorizedNetworks: [] } } };
        instances.set(names[0], instance);
        return start(shape, names[0], "CREATE", { onDone: () => { instance.state = "RUNNABLE"; },
          onFail: () => { instance.state = "FAILED"; } });
      }
      case "sql backups restore": {
        const instance = instances.get(flag("--restore-instance"));
        if (instance === undefined || backups[names[0]] === undefined || busy(instance.name)) return null;
        return start(shape, instance.name, "RESTORE_VOLUME", { onDone: () => { instance.state = finalState; } });
      }
      case "sql instances patch": {
        const instance = instances.get(names[0]);
        if (instance === undefined) return null;
        if (busy(names[0])) {
          refusedWhileBusy.push(argv);
          return null;
        }
        const labels = flag("--update-labels");
        if (labels !== undefined) Object.assign(instance.settings.userLabels, parseLabels(labels));
        if (!ignoreDisarm) {
          if (argv.includes("--no-deletion-protection")) instance.settings.deletionProtectionEnabled = false;
          if (argv.includes("--no-final-backup") && !keepFinalBackupSetting) {
            instance.settings.finalBackupConfig = { enabled: false };
          }
          if (argv.includes("--no-retain-backups-on-delete")) instance.settings.retainBackupsOnDelete = false;
        }
        return start(shape, names[0], "UPDATE");
      }
      case "sql instances delete": {
        const instance = instances.get(names[0]);
        if (instance === undefined || instance.settings.deletionProtectionEnabled) return null;
        if (busy(names[0])) {
          refusedWhileBusy.push(argv);
          return null;
        }
        instance.state = "PENDING_DELETE";
        return start(shape, names[0], "DELETE", { onDone: () => {
          if (instance.settings.finalBackupConfig?.enabled === true || leaveBackupOnDelete) {
            leftovers.push({ instance: names[0], type: "FINAL" });
          }
          instances.delete(names[0]);
        } });
      }
      default:
        throw new Error(`unexpected mutation ${shape}`);
    }
  };
  fake.runner = (argv) => {
    calls.push(argv);
    const shape = argv.slice(0, 3).join(" ");
    const names = argv.slice(3).filter((arg) => !arg.startsWith("-"));
    const flag = (name) => argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
    if (shape === refuse) {
      onRefuse?.(fake);
      return no();
    }
    switch (shape) {
      case "sql instances describe": {
        const instance = instances.get(names[0]);
        return instance === undefined ? no() : ok(instance);
      }
      case "sql instances list": {
        const name = flag("--filter").slice("name=".length);
        return ok(instances.has(name) ? [{ name }] : []);
      }
      case "sql backups describe": {
        const backup = backups[names[0]];
        return backup === undefined ? no() : ok(backup);
      }
      case "sql backups list": {
        if (backupListFails) return no();
        const instance = flag("--filter").slice("instance=".length);
        return ok(leftovers.filter((entry) => entry.instance === instance));
      }
      case "sql operations describe": {
        const op = operations.get(names[0]);
        if (op === undefined) return no();
        observe(op);
        return ok(view(op));
      }
      case "sql operations list": {
        const listed = [...operations.values()].filter((op) => op.target === flag("--instance"));
        for (const op of listed) observe(op);
        return ok(listed.map(view));
      }
      default: {
        const op = mutate(shape, argv, names, flag);
        if (op === null || shape === refuseButStart) return no();
        return ok(shape === noOperationName ? { kind: "sql#operation" } : view(op));
      }
    }
  };
  return fake;
}

function dataset({ history = HISTORY, tables, database = STAGING.cloudSql.database, readOnly = "on", watermark = "w0",
  shape = { columns: 40, indexes: 12, constraints: 9, functions: 4 } } = {}) {
  return {
    database,
    readOnly,
    history,
    shape,
    watermark,
    tables: tables ?? [
      { name: "participants", primaryKey: ["participant_id"], rows: ["(1,a)", "(2,b)", "(3,c)"] },
      { name: "usage_days", primaryKey: ["owner_id", "day"], rows: Array.from({ length: 150 }, (_, i) => `(${i},x)`) },
      { name: "audit_events", primaryKey: null, rows: ["(e1)"] },
    ],
  };
}

const ALLOWED_STATEMENT = /^(?:BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|ROLLBACK|SET LOCAL [a-zA-Z_]+ = .+|\/\* rehearsal:[a-z:]+ \*\/ SELECT [\s\S]+)$/u;
const WRITE_WORDS = /\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|COMMIT)\b/iu;

/** A fake pg pool over a dataset; it records each statement and refuses anything but the fingerprint reads. */
function fakePool(data, log) {
  return {
    async connect() {
      return {
        async query(text, params = []) {
          log.push(text);
          assert.match(text, ALLOWED_STATEMENT, `statement not allowed: ${text.slice(0, 60)}`);
          assert.doesNotMatch(text.replace(/\/\*[^*]*\*\//gu, ""), WRITE_WORDS);
          const tag = /^\/\* rehearsal:([a-z:]+) \*\//u.exec(text)?.[1];
          if (tag === undefined) return { rows: [] };
          const table = /FROM "[a-z_]+"\."([a-z_]+)"/u.exec(text)?.[1];
          const entry = data.tables.find((candidate) => candidate.name === table);
          if (tag === "identity") {
            return { rows: [{ database: data.database, read_only: data.readOnly, server_version_num: "170004" }] };
          }
          if (tag === "watermark") {
            return { rows: [{ tables: data.tables.length,
              digest: createHash("sha256").update(`w:${data.watermark}`).digest("hex") }] };
          }
          if (tag === "presence") return { rows: [{ schema_present: true, history_present: data.history !== null }] };
          if (tag === "history") return { rows: data.history };
          if (tag.startsWith("shape:")) {
            const category = tag.slice("shape:".length);
            return { rows: [{ entries: data.shape[category],
              digest: createHash("sha256").update(`${category}:${data.shape[category]}`).digest("hex") }] };
          }
          if (tag === "tables") {
            return { rows: data.tables.map((candidate) => ({ table_name: candidate.name, primary_key: candidate.primaryKey })) };
          }
          if (tag === "count") return { rows: [{ row_count: String(entry.rows.length) }] };
          if (tag === "sample:head" || tag === "sample:tail") {
            const [key, limit] = params;
            const ordered = tag === "sample:head" ? entry.rows : [...entry.rows].reverse();
            const lines = ordered.slice(0, limit);
            return { rows: [{ sampled: lines.length,
              digest: createHash("sha256").update(`${key}${lines.join("\n")}`).digest("hex") }] };
          }
          throw new Error(`unexpected tag ${tag}`);
        },
        release() {},
      };
    },
  };
}

/** connect(): source datasets in order (before, after), the scratch dataset for the scratch. */
function fakeConnect({ sources, scratch, failRole = null, clock = null }) {
  const opened = [];
  const logs = { source: [], scratch: [] };
  let sourceIndex = 0;
  const connect = async (spec) => {
    opened.push({ ...spec, at: clock?.peek() ?? null });
    if (spec.role === failRole) throw new Error("connection refused");
    const data = spec.role === "source" ? sources[Math.min(sourceIndex++, sources.length - 1)] : scratch;
    return { pool: fakePool(data, logs[spec.role]), async close() {} };
  };
  return { connect, opened, logs };
}

function equalCopy(options = {}) {
  return fakeConnect({ sources: [dataset()], scratch: dataset(), ...options });
}

async function rehearse({ request = PITR_REQUEST, desired = STAGING, gcloud = fakeGcloud(), db, doNotRestore = null,
  migrations = MIGRATIONS, authorize, clock = virtualClock() } = {}) {
  const plan = planRestoreRehearsal(desired, request, { nowMs: NOW });
  const database = db ?? equalCopy({ clock });
  const stamps = [];
  const options = {
    authorize: authorize ?? plan.authorization,
    runner: (argv, runOptions) => {
      stamps.push({ argv, at: clock.peek() });
      return gcloud.runner(argv, runOptions);
    },
    connect: database.connect,
    doNotRestore,
    readMigrations: async () => migrations,
    now: clock.now,
    sleep: clock.sleep,
    randomKey: () => KEY,
  };
  return { plan, gcloud, db: database, stamps, clock, run: () => runRestoreRehearsal(desired, request, options) };
}

function mutationCalls(calls) {
  return calls.filter((argv) => RESTORE_REHEARSAL_COMMANDS[argv.slice(0, 3).join(" ")] === "mutate");
}

function assertSourceOnlyRead(calls, scratch) {
  for (const argv of calls) {
    const shape = argv.slice(0, 3).join(" ");
    assert.ok(Object.hasOwn(RESTORE_REHEARSAL_COMMANDS, shape), shape);
    if (RESTORE_REHEARSAL_COMMANDS[shape] !== "mutate") continue;
    assert.ok(argv.includes("--async"), shape);
    const names = argv.slice(3).filter((arg) => !arg.startsWith("-"));
    if (shape === "sql instances clone") assert.deepEqual(names, [SOURCE, scratch]);
    else if (shape === "sql backups restore") {
      assert.ok(argv.includes(`--restore-instance=${scratch}`));
      assert.ok(argv.includes(`--backup-instance=${SOURCE}`));
    } else assert.deepEqual(names, [scratch], shape);
  }
}

function withDesired(mutate) {
  const desired = structuredClone(STAGING);
  mutate(desired);
  return desired;
}

function productionFilledText() {
  return readFile(new URL("../cloud-run/infra/production.desired-state.json", import.meta.url), "utf8")
    .then((text) => {
      const value = JSON.parse(text);
      Object.assign(value, { project: "tibotattle-prod", projectNumber: "874229235044", region: "us-east1" });
      value.bucket.location = "US-EAST1";
      return JSON.stringify(value);
    });
}

async function expectCode(promiseOrFn, code) {
  await assert.rejects(typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

async function expectFailure(promise, check) {
  await assert.rejects(promise, (error) => {
    check(error);
    return true;
  });
}

async function cli(argv, options = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => NOW,
    sleep: async () => {},
    ...options,
  });
  const parse = (chunks) => (chunks.length === 0 ? null : JSON.parse(chunks.join("")));
  return { code, out: parse(out), err: parse(err) };
}

function cleanup(gcloud, { adoptUnlabelled = false, path = "pitr", authorize, clock = virtualClock() } = {}) {
  const target = rehearsalTarget(STAGING, { ...PITR_REQUEST, path });
  return cleanupRehearsalScratch(STAGING, { environment: "staging", path, rehearsalId: ID, adoptUnlabelled,
    authorize: authorize ?? (adoptUnlabelled ? adoptCleanupAuthorization(target) : cleanupAuthorization(target)),
    runner: gcloud.runner, now: clock.now, sleep: clock.sleep });
}

const PITR_ARGS = ["rehearse", "--environment=staging", "--path=pitr", `--point-in-time=${POINT_IN_TIME}`, `--rehearsal-id=${ID}`];
const NO_GCLOUD = () => {
  throw new Error("gcloud must not be called");
};

// ---------------------------------------------------------------------------
// Plan and dry run

test("the scratch is the source plus -rehearsal-<id>, b for the backup path, and OPS-10's scratch pattern", () => {
  assert.equal(scratchInstanceName(SOURCE, ID, "pitr"), PITR_SCRATCH);
  assert.equal(scratchInstanceName(SOURCE, ID, "backup"), BACKUP_SCRATCH);
  for (const name of [PITR_SCRATCH, BACKUP_SCRATCH]) assert.match(name, SCRATCH_INSTANCE_PATTERN);
  const target = rehearsalTarget(STAGING, PITR_REQUEST);
  assert.equal(target.scratchConnectionName, `${PROJECT}:${REGION}:${PITR_SCRATCH}`);
  assert.equal(target.identity.iamUser, `${STAGING.serviceAccounts.migrator.accountId}@${PROJECT}.iam`);
});

test("the dry run makes no call and prints the exact authorization, plan and operation bounds", async () => {
  const { code, out } = await cli(PITR_ARGS, { runner: NO_GCLOUD, connect: NO_GCLOUD });
  assert.equal(code, 0);
  assert.equal(out.status, "dry_run");
  assert.equal(out.scratch, PITR_SCRATCH);
  assert.match(out.authorization, new RegExp(`^restore-rehearsal:staging:${PITR_SCRATCH}:[a-f0-9]{16}$`, "u"));
  assert.deepEqual(out.mutations.map((entry) => entry.step), ["clone", "label", "disarm", "delete"]);
  assert.equal(out.uploadsMayReopen, false);
  assert.equal(out.doNotRestore.code, "DO_NOT_RESTORE_STEP_NOT_PROVIDED");
  assert.equal(out.recoveryPointCoveredBySourceReads, false);
  assert.deepEqual(out.operationWaitBoundsMs, { ...OPERATION_WAIT_BOUNDS_MS });
  assert.equal(out.scratchSettleBoundMs, SCRATCH_SETTLE_BOUND_MS);
  assertSourceOnlyRead(out.mutations.map((entry) => entry.argv), PITR_SCRATCH);
  // gcloud never waits: every mutation is submitted --async and polled by the tool.
  assert.ok(out.mutations.every((entry) => entry.argv.filter((arg) => arg === "--async").length === 1
    && !entry.argv.includes("--enable-final-backup")));
  const covered = await cli(PITR_ARGS.map((arg) => (arg.startsWith("--point-in-time=")
    ? `--point-in-time=${POINT_IN_TIME_AFTER_PREFLIGHT}` : arg)), { runner: NO_GCLOUD });
  assert.equal(covered.out.recoveryPointCoveredBySourceReads, true);
  assert.notEqual(covered.out.authorization, out.authorization);
});

test("a dry run without --rehearsal-id generates one and says so", async () => {
  const { code, out } = await cli(PITR_ARGS.filter((arg) => !arg.startsWith("--rehearsal-id")),
    { runner: NO_GCLOUD, randomId: () => "zz9900aa" });
  assert.equal(code, 0);
  assert.equal(out.rehearsalIdGenerated, true);
  assert.equal(out.scratch, `${SOURCE}-rehearsal-zz9900aa`);
});

test("the backup path creates a disarmed, labelled scratch and restores into it", () => {
  const plan = planRestoreRehearsal(STAGING, BACKUP_REQUEST, { nowMs: NOW });
  const [create, restore] = plan.mutations;
  assert.equal(create.step, "create");
  for (const flag of ["--no-deletion-protection", "--no-backup", "--assign-ip", "--connector-enforcement=REQUIRED",
    "--labels=tibotattle-purpose=restore-rehearsal,tibotattle-rehearsal=a1b2c3d4", `--tier=${STAGING.cloudSql.tier}`]) {
    assert.ok(create.argv.includes(flag), flag);
  }
  assert.ok(create.argv.some((arg) => arg.startsWith("--database-flags=") && arg.includes("cloudsql.iam_authentication=on")));
  assert.deepEqual(restore.argv.slice(0, 4), ["sql", "backups", "restore", BACKUP_ID]);
  assertSourceOnlyRead(plan.mutations.map((entry) => entry.argv), BACKUP_SCRATCH);
});

test("the authorization binds the plan: another point in time or path needs another authorization", () => {
  const first = planRestoreRehearsal(STAGING, PITR_REQUEST, { nowMs: NOW });
  const later = planRestoreRehearsal(STAGING, { ...PITR_REQUEST, pointInTime: "2026-10-02T17:30:00Z" }, { nowMs: NOW });
  const more = planRestoreRehearsal(STAGING, { ...PITR_REQUEST, sampleRows: 128 }, { nowMs: NOW });
  assert.notEqual(first.authorization, later.authorization);
  assert.notEqual(first.authorization, more.authorization);
  assert.equal(first.authorization, planRestoreRehearsal(STAGING, PITR_REQUEST, { nowMs: NOW + 5_000 }).authorization);
});

// ---------------------------------------------------------------------------
// Rehearsal outcomes

test("a staging PITR rehearsal verifies, times, deletes the scratch and keeps uploads closed without the list", async () => {
  const { gcloud, db, run } = await rehearse();
  const receipt = await run();
  assert.equal(receipt.schema, RESTORE_REHEARSAL_RECEIPT_SCHEMA);
  assert.equal(receipt.status, "verified");
  assert.equal(receipt.verification.verdict, "passed");
  assert.equal(receipt.verification.code, null);
  assert.equal(receipt.verification.sourceStable, true);
  assert.equal(receipt.recoveryPoint.mode, "explicit");
  assert.equal(receipt.recoveryPoint.coveredBySourceReads, false);
  assert.equal(receipt.manifest.relation, "equal");
  assert.equal(receipt.doNotRestore.status, "not-provided");
  assert.equal(receipt.uploadsMayReopen, false);
  assert.deepEqual(receipt.uploadsBlockedBy, ["DO_NOT_RESTORE_STEP_NOT_PROVIDED"]);
  assert.equal(rehearsalExitCode(receipt), EXIT_CODES.uploadsBlocked);
  assert.equal(receipt.teardown.armed, true);
  assert.equal(receipt.teardown.scratchDeleted, true);
  assert.equal(receipt.teardown.ownership, "labelled");
  assert.equal(receipt.teardown.finalBackups, "none-found");
  assert.equal(gcloud.instances.has(PITR_SCRATCH), false);
  assert.equal(gcloud.leftovers.length, 0);
  assert.deepEqual(gcloud.refusedWhileBusy, []);
  for (const field of ["cloneMs", "labelMs", "restoreMs", "readyMs", "verifyMs", "teardownMs", "totalMs"]) {
    assert.ok(Number.isSafeInteger(receipt.timings[field]) && receipt.timings[field] > 0, field);
  }
  assert.deepEqual(receipt.steps.map((step) => step.step), ["clone", "label", "settle", "disarm", "delete"]);
  assertSourceOnlyRead(gcloud.calls, PITR_SCRATCH);
  // Every operation the run submitted was polled to DONE through operations describe.
  assert.ok([...gcloud.operations.values()].every((op) => op.status === "DONE"));
  assert.ok(gcloud.calls.some((argv) => argv.slice(0, 3).join(" ") === "sql operations describe"));
  // The source is opened twice (before and after), the scratch once, each read-only.
  assert.deepEqual(db.opened.map((spec) => spec.role), ["source", "scratch", "source"]);
  assert.ok(db.opened.every((spec) => spec.role === "source"
    ? spec.connectionName === `${PROJECT}:${REGION}:${SOURCE}` : spec.connectionName.endsWith(`:${PITR_SCRATCH}`)));
  for (const role of ["source", "scratch"]) {
    assert.ok(db.logs[role].every((statement) => !/^COMMIT/u.test(statement)));
    assert.equal(db.logs[role].filter((statement) => statement === FINGERPRINT_QUERIES.begin).length,
      role === "source" ? 2 : 1);
  }
  // Content-free: no sample digest, watermark digest or key reaches the receipt.
  const text = JSON.stringify(receipt);
  assert.equal(text.includes(KEY), false);
  const sampleDigest = createHash("sha256").update(`${KEY}(1,a)\n(2,b)\n(3,c)`).digest("hex");
  assert.equal(text.includes(sampleDigest), false);
  assert.equal(text.includes(createHash("sha256").update("w:w0").digest("hex")), false);
  assert.equal(text.includes("(1,a)"), false);
  const usage = receipt.verification.tables.find((table) => table.table === "usage_days");
  assert.deepEqual(usage, { table: "usage_days", rows: { source: "150", scratch: "150" }, rowsEqual: true,
    sample: "equal", sampleOrder: "primary-key", sampledRows: 128 });
  assert.equal(receipt.verification.tables.find((table) => table.table === "audit_events").sampleOrder, "row-text");
});

test("uploads may reopen only after the injected do-not-restore step reports done on the scratch", async () => {
  const seen = [];
  const doNotRestore = { async reapply(target) {
    seen.push(target);
    return { status: "done", listSha256: "f".repeat(64), entries: 2, matched: 1, purged: 1 };
  } };
  const { run } = await rehearse({ doNotRestore });
  const receipt = await run();
  assert.equal(receipt.uploadsMayReopen, true);
  assert.deepEqual(receipt.uploadsBlockedBy, []);
  assert.equal(rehearsalExitCode(receipt), EXIT_CODES.uploadsMayReopen);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].instance, PITR_SCRATCH);
  assert.notEqual(seen[0].instance, SOURCE);
  assert.ok(Object.isFrozen(seen[0]));
});

test("a do-not-restore step that is malformed, not done or throws keeps uploads closed", async () => {
  for (const reapply of [
    async () => ({ status: "done", listSha256: "f".repeat(64), entries: 2, matched: 2, purged: 1 }),
    async () => ({ status: "pending", listSha256: "f".repeat(64), entries: 0, matched: 0, purged: 0 }),
    async () => ({ status: "done", listSha256: "f".repeat(64), entries: 0, matched: 0, purged: 0, extra: true }),
    async () => "done",
    async () => { throw new Error("boom"); },
  ]) {
    const { run } = await rehearse({ doNotRestore: { reapply } });
    const receipt = await run();
    assert.equal(receipt.uploadsMayReopen, false);
    assert.ok(["not-done", "failed"].includes(receipt.doNotRestore.status));
    assert.deepEqual(receipt.uploadsBlockedBy, ["DO_NOT_RESTORE_STEP_NOT_DONE"]);
    assert.equal(receipt.teardown.scratchDeleted, true);
  }
});

test("a scratch behind the image tail keeps uploads closed even with the step done", async () => {
  const doNotRestore = { reapply: async () => ({ status: "done", listSha256: "a".repeat(64), entries: 0, matched: 0, purged: 0 }) };
  const longer = [...MIGRATIONS, { version: 4, name: "0004_synthetic.sql", sha256: "b".repeat(64) }];
  const { run } = await rehearse({ doNotRestore, migrations: longer });
  const receipt = await run();
  assert.equal(receipt.manifest.relation, "behind");
  assert.equal(receipt.uploadsMayReopen, false);
  assert.deepEqual(receipt.uploadsBlockedBy, ["RESTORE_MIGRATION_BEHIND"]);
});

test("after-preflight picks a point after the first source read, waits for it, and covers it with source reads", async () => {
  const clock = virtualClock();
  const db = equalCopy({ clock });
  const { run, stamps } = await rehearse({ request: COVERED_REQUEST, db, clock });
  const receipt = await run();
  assert.equal(receipt.status, "verified");
  assert.equal(receipt.recoveryPoint.mode, POINT_IN_TIME_AFTER_PREFLIGHT);
  assert.equal(receipt.recoveryPoint.coveredBySourceReads, true);
  assert.equal(receipt.verification.sourceUnchangedSinceRecoveryPoint, true);
  const at = Date.parse(receipt.recoveryPoint.at);
  assert.match(receipt.recoveryPoint.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
  const [firstSource, , closingSource] = db.opened;
  assert.ok(at >= firstSource.at + 60_000, "the point is at least a minute after the first source read");
  const clone = stamps.find(({ argv }) => argv[2] === "clone");
  assert.ok(clone.argv.includes(`--point-in-time=${receipt.recoveryPoint.at}`));
  assert.ok(clone.at >= at + 60_000, "the clone is submitted only once the point is a minute old");
  assert.ok(closingSource.at >= at + 120_000, "the closing source read waits for statistics to publish");
  assert.ok(receipt.timings.pointInTimeWaitMs >= 60_000);
});

test("a scratch that differs, with the recovery point covered, fails verification, skips the step and is deleted", async () => {
  let called = false;
  const doNotRestore = { reapply: async () => { called = true; return {}; } };
  const short = dataset();
  short.tables[1] = { ...short.tables[1], rows: short.tables[1].rows.slice(0, 149) };
  const { run, gcloud } = await rehearse({ request: COVERED_REQUEST, doNotRestore,
    db: equalCopy({ scratch: short }) });
  const receipt = await run();
  assert.equal(receipt.verification.verdict, "failed");
  assert.equal(receipt.verification.code, "RESTORE_SCRATCH_DIFFERS_FROM_SOURCE");
  assert.equal(receipt.status, "verification_failed");
  assert.equal(called, false);
  assert.equal(receipt.doNotRestore.status, "skipped");
  assert.equal(receipt.uploadsMayReopen, false);
  assert.equal(rehearsalExitCode(receipt), EXIT_CODES.verificationFailed);
  assert.equal(gcloud.instances.has(PITR_SCRATCH), false);
});

test("a difference with the recovery point before the run is inconclusive on both paths, never failed", async () => {
  const short = dataset();
  short.tables[1] = { ...short.tables[1], rows: short.tables[1].rows.slice(0, 149) };
  for (const request of [PITR_REQUEST, BACKUP_REQUEST]) {
    const { run, gcloud } = await rehearse({ request, db: equalCopy({ scratch: short }) });
    const receipt = await run();
    assert.equal(receipt.recoveryPoint.coveredBySourceReads, false, request.path);
    assert.equal(receipt.verification.differs, true);
    assert.equal(receipt.verification.sourceStable, true);
    assert.equal(receipt.verification.verdict, "inconclusive", request.path);
    assert.equal(receipt.verification.code, "RESTORE_SOURCE_UNCHANGED_SINCE_RECOVERY_POINT_UNPROVEN");
    assert.equal(receipt.status, "verification_inconclusive");
    assert.equal(receipt.doNotRestore.status, "skipped");
    assert.equal(rehearsalExitCode(receipt), EXIT_CODES.verificationFailed);
    assert.equal(gcloud.instances.size, 1);
  }
});

test("a changed row, history, schema shape or table set each fail verification when the point is covered", async () => {
  const variants = [
    (data) => { data.tables[0].rows = ["(1,a)", "(2,CHANGED)", "(3,c)"]; },
    (data) => { data.history = HISTORY.slice(0, 2); },
    (data) => { data.shape = { ...data.shape, indexes: 11 }; },
    (data) => { data.tables.push({ name: "extra_table", primaryKey: ["id"], rows: [] }); },
    (data) => { data.tables.splice(0, 1); },
  ];
  for (const mutate of variants) {
    const copy = dataset();
    mutate(copy);
    const { run } = await rehearse({ request: COVERED_REQUEST, db: equalCopy({ scratch: copy }) });
    assert.equal((await run()).verification.verdict, "failed");
  }
});

test("a source that moves during the rehearsal, by data or by write watermark alone, is inconclusive", async () => {
  const moved = dataset();
  moved.tables[0] = { ...moved.tables[0], rows: [...moved.tables[0].rows, "(4,d)"] };
  // Same rows before and after, but rows were written and reverted in between.
  const rewritten = dataset({ watermark: "w1" });
  for (const after of [moved, rewritten]) {
    const { run } = await rehearse({ request: COVERED_REQUEST,
      db: fakeConnect({ sources: [dataset(), after], scratch: dataset() }) });
    const receipt = await run();
    assert.equal(receipt.verification.sourceStable, false);
    assert.equal(receipt.verification.sourceUnchangedSinceRecoveryPoint, false);
    assert.equal(receipt.verification.verdict, "inconclusive");
    assert.equal(receipt.verification.code, "RESTORE_SOURCE_MOVED_DURING_RUN");
    assert.equal(receipt.uploadsMayReopen, false);
  }
});

test("the backup path creates, restores, verifies and deletes the b scratch", async () => {
  const { run, gcloud } = await rehearse({ request: BACKUP_REQUEST });
  const receipt = await run();
  assert.equal(receipt.status, "verified");
  assert.equal(receipt.scratch, BACKUP_SCRATCH);
  assert.equal(receipt.recoveryPoint.kind, "backup");
  assert.equal(receipt.recoveryPoint.coveredBySourceReads, false);
  assert.deepEqual(receipt.steps.map((step) => step.step), ["create", "restore", "settle", "disarm", "delete"]);
  assert.ok(receipt.timings.createMs > 0 && receipt.timings.restoreBackupMs > 0);
  assert.equal(gcloud.instances.has(BACKUP_SCRATCH), false);
  assert.deepEqual(gcloud.refusedWhileBusy, []);
  assertSourceOnlyRead(gcloud.calls, BACKUP_SCRATCH);
});

// ---------------------------------------------------------------------------
// Long operations and busy scratches

test("a clone that outlasts its bound is waited out before teardown patches it, then deleted", async () => {
  // About 360 polls fill the six-hour clone bound; the clone ends during the settle wait.
  const gcloud = fakeGcloud({ polls: { "sql instances clone": 400 } });
  const { run } = await rehearse({ gcloud });
  await expectFailure(run(), (error) => {
    assert.equal(error.code, "RESTORE_REHEARSAL_OPERATION_TIMEOUT:clone");
    assert.equal(error.receipt.teardown.armed, true);
    assert.equal(error.receipt.teardown.scratchDeleted, true);
    assert.equal(error.receipt.teardown.ownership, "unlabelled");
    const settle = error.receipt.steps.find((step) => step.step === "settle");
    assert.ok(settle.ms > 60_000, "teardown waited for the clone to finish");
    assert.equal(error.receipt.uploadsMayReopen, false);
  });
  assert.deepEqual(gcloud.refusedWhileBusy, []);
  assert.equal(gcloud.instances.has(PITR_SCRATCH), false);
  assert.equal(gcloud.calls.some((argv) => argv.some((arg) => arg.startsWith("--update-labels"))), false);
});

test("a scratch still busy at the settle bound is never patched; adopt cleanup removes it once it settles", async () => {
  const gcloud = fakeGcloud({ polls: { "sql instances clone": 100_000 } });
  const { run } = await rehearse({ gcloud });
  await expectFailure(run(), (error) => {
    assert.equal(error.code, "RESTORE_REHEARSAL_OPERATION_TIMEOUT:clone");
    assert.deepEqual(error.receipt.teardown, { armed: true, scratchDeleted: false,
      code: "RESTORE_REHEARSAL_SCRATCH_BUSY" });
  });
  assert.equal(gcloud.calls.some((argv) => argv[2] === "patch" || argv[2] === "delete"), false);
  assert.equal(gcloud.instances.get(PITR_SCRATCH).state, "PENDING_CREATE");
  // The clone never got its labels, so plain cleanup refuses it without waiting or mutating.
  const before = gcloud.calls.length;
  await expectCode(cleanup(gcloud), "RESTORE_REHEARSAL_SCRATCH_NOT_OWNED");
  assert.equal(mutationCalls(gcloud.calls.slice(before)).length, 0);
  // Adopting it waits for the clone to finish, then disarms and deletes it.
  gcloud.setRemaining(PITR_SCRATCH, 6);
  const cleaned = await cleanup(gcloud, { adoptUnlabelled: true });
  assert.equal(cleaned.status, "cleaned");
  assert.equal(cleaned.mode, "adopt-unlabelled");
  assert.equal(cleaned.teardown.ownership, "unlabelled");
  assert.deepEqual(cleaned.steps.map((step) => step.step), ["settle", "disarm", "delete"]);
  assert.deepEqual(gcloud.refusedWhileBusy, []);
  assert.equal(gcloud.instances.has(PITR_SCRATCH), false);
  assert.equal(gcloud.instances.has(SOURCE), true);
});

test("a clone that exits non-zero but started is not this run's to delete: never patched, adopted only after it settles", async () => {
  const gcloud = fakeGcloud({ refuseButStart: "sql instances clone", polls: { "sql instances clone": 50 } });
  const { run } = await rehearse({ gcloud });
  await expectFailure(run(), (error) => {
    assert.equal(error.code, "GCLOUD_CALL_FAILED:sql-instances-clone");
    assert.deepEqual(error.receipt.teardown, { armed: false, scratchPresent: true,
      code: "RESTORE_REHEARSAL_SCRATCH_OWNERSHIP_UNPROVEN" });
  });
  assert.deepEqual(mutationCalls(gcloud.calls).map((argv) => argv[2]), ["clone"]);
  // Cloud SQL would refuse a patch now: the instance is unlabelled and busy.
  const target = rehearsalTarget(STAGING, PITR_REQUEST);
  const direct = guardedRehearsalGcloud(gcloud.runner, target);
  assert.throws(() => direct(["sql", "instances", "patch", PITR_SCRATCH, `--project=${PROJECT}`, "--no-deletion-protection",
    "--async", "--quiet", "--format=json"]), { code: "GCLOUD_CALL_FAILED:sql-instances-patch" });
  assert.equal(gcloud.refusedWhileBusy.length, 1);
  await expectCode(cleanup(gcloud), "RESTORE_REHEARSAL_SCRATCH_NOT_OWNED");
  await expectCode(cleanup(gcloud, { adoptUnlabelled: true, authorize: cleanupAuthorization(target) }),
    "RESTORE_REHEARSAL_AUTHORIZATION_MISMATCH");
  const cleaned = await cleanup(gcloud, { adoptUnlabelled: true });
  assert.equal(cleaned.teardown.scratchDeleted, true);
  assert.equal(gcloud.refusedWhileBusy.length, 1, "cleanup waited instead of patching a busy scratch");
  assert.equal(gcloud.instances.has(PITR_SCRATCH), false);
});

test("a create or clone refused because another run now holds the name never touches that run's scratch", async () => {
  const cases = [
    { request: PITR_REQUEST, scratch: PITR_SCRATCH, shape: "sql instances clone", labels: {} },
    // The other run's backup scratch even carries the same labels.
    { request: BACKUP_REQUEST, scratch: BACKUP_SCRATCH, shape: "sql instances create", labels: ALL_LABELS },
  ];
  for (const { request, scratch, shape, labels } of cases) {
    const gcloud = fakeGcloud({ refuse: shape, onRefuse: (fake) => fake.foreignClone(scratch, 1_000, labels) });
    const { run } = await rehearse({ request, gcloud });
    await expectFailure(run(), (error) => {
      assert.equal(error.code, `GCLOUD_CALL_FAILED:${shape.replaceAll(" ", "-")}`);
      assert.deepEqual(error.receipt.teardown, { armed: false, scratchPresent: true,
        code: "RESTORE_REHEARSAL_SCRATCH_OWNERSHIP_UNPROVEN" });
    });
    assert.deepEqual(mutationCalls(gcloud.calls).map((argv) => argv[2]), [shape.split(" ")[2]]);
    assert.equal(gcloud.instances.get(scratch).state, "PENDING_CREATE");
  }
  // A refusal that left nothing reports the name free.
  const none = fakeGcloud({ refuse: "sql instances clone" });
  await expectFailure((await rehearse({ gcloud: none })).run(), (error) => {
    assert.deepEqual(error.receipt.teardown, { armed: false, scratchPresent: false });
  });
});

test("a create or clone whose operation fails, or returns no operation, is not armed; a later step's failure is", async () => {
  for (const options of [{ failOperation: "sql instances clone" }, { noOperationName: "sql instances clone" }]) {
    const gcloud = fakeGcloud(options);
    await expectFailure((await rehearse({ gcloud })).run(), (error) => {
      assert.match(error.code, /^RESTORE_REHEARSAL_OPERATION_(?:FAILED|UNKNOWN):clone$/u);
      assert.equal(error.receipt.teardown.armed, false);
      assert.equal(error.receipt.teardown.scratchPresent, true);
    });
    assert.deepEqual(mutationCalls(gcloud.calls).map((argv) => argv[2]), ["clone"]);
  }
  const labelPatch = (argv) => argv.some((arg) => arg.startsWith("--update-labels="));
  for (const [request, failOperation, scratch, step] of [[PITR_REQUEST, labelPatch, PITR_SCRATCH, "label"],
    [BACKUP_REQUEST, "sql backups restore", BACKUP_SCRATCH, "restore"]]) {
    const gcloud = fakeGcloud({ failOperation });
    await expectFailure((await rehearse({ request, gcloud })).run(), (error) => {
      assert.equal(error.code, `RESTORE_REHEARSAL_OPERATION_FAILED:${step}`);
      assert.equal(error.receipt.teardown.armed, true);
      assert.equal(error.receipt.teardown.scratchDeleted, true);
    });
    assert.equal(gcloud.instances.has(scratch), false);
  }
});

// ---------------------------------------------------------------------------
// Refusals: arguments, environments and targets

test("every environment other than staging and plan-only production is refused", async () => {
  for (const environment of ["test", "dev", "prod", "STAGING", ""]) {
    const args = ["rehearse", `--environment=${environment}`, "--path=pitr", `--point-in-time=${POINT_IN_TIME}`];
    const { code, err } = await cli(args, { runner: NO_GCLOUD });
    assert.equal(code, 1);
    assert.equal(err.code, environment === "" ? "RESTORE_REHEARSAL_ARGUMENT_INVALID" : "RESTORE_REHEARSAL_ENVIRONMENT_REFUSED");
  }
  assert.throws(() => rehearsalTarget(STAGING, { ...PITR_REQUEST, environment: "test" }),
    { code: "RESTORE_REHEARSAL_ENVIRONMENT_REFUSED" });
  assert.throws(() => rehearsalTarget(STAGING, { ...PITR_REQUEST, environment: "production" }),
    { code: "RESTORE_REHEARSAL_ENVIRONMENT_MISMATCH" });
});

test("production needs --production, then a filled desired state, and then only plans", async () => {
  const productionArgs = ["rehearse", "--environment=production", "--path=pitr", `--point-in-time=${POINT_IN_TIME}`];
  assert.equal((await cli(productionArgs, { runner: NO_GCLOUD })).err.code, "RESTORE_REHEARSAL_PRODUCTION_FLAG_REQUIRED");
  // The committed production file is still unfilled (OWN-5).
  const unfilled = await cli([...productionArgs, "--production"], { runner: NO_GCLOUD });
  assert.equal(unfilled.code, 1);
  assert.match(unfilled.err.code, /^DESIRED_STATE_PLACEHOLDER_UNFILLED:/u);
  // Filled in memory: a plan, never an authorization.
  const filledText = await productionFilledText();
  const loadDesired = (environment) => loadCommittedDesiredState(environment, { readFile: () => filledText });
  const planned = await cli([...productionArgs, "--production", `--rehearsal-id=${ID}`], { runner: NO_GCLOUD, loadDesired });
  assert.equal(planned.code, 0);
  assert.equal(planned.out.status, "plan_only");
  assert.equal(planned.out.authorization, null);
  assert.equal(planned.out.scratch, `tibotattle-primary-rehearsal-${ID}`);
  for (const extra of [["--apply", "--authorize=x"], ["--authorize=x"]]) {
    const refused = await cli([...productionArgs, "--production", `--rehearsal-id=${ID}`, ...extra], { runner: NO_GCLOUD, loadDesired });
    assert.equal(refused.err.code, "RESTORE_REHEARSAL_PRODUCTION_PLAN_ONLY");
  }
  for (const extra of [[], ["--adopt-unlabelled"]]) {
    const refused = await cli(["cleanup", "--environment=production", "--production", "--path=pitr", `--rehearsal-id=${ID}`,
      ...extra], { runner: NO_GCLOUD, loadDesired });
    assert.equal(refused.err.code, "RESTORE_REHEARSAL_PRODUCTION_PLAN_ONLY");
  }
  // The library refuses a production run whatever authorization it is handed.
  const desired = loadDesired("production");
  const plan = planRestoreRehearsal(desired, { ...PITR_REQUEST, environment: "production" }, { nowMs: NOW });
  await expectCode(runRestoreRehearsal(desired, { ...PITR_REQUEST, environment: "production" },
    { authorize: plan.authorization, runner: NO_GCLOUD, now: () => NOW }), "RESTORE_REHEARSAL_PRODUCTION_PLAN_ONLY");
  for (const adoptUnlabelled of [false, true]) {
    await expectCode(cleanupRehearsalScratch(desired, { environment: "production", path: "pitr", rehearsalId: ID,
      adoptUnlabelled, authorize: "x", runner: NO_GCLOUD }), "RESTORE_REHEARSAL_PRODUCTION_PLAN_ONLY");
  }
  assert.equal((await cli([...PITR_ARGS, "--production"], { runner: NO_GCLOUD })).err.code, "RESTORE_REHEARSAL_ARGUMENT_INVALID");
});

test("closed arguments: path, id, time, backup id, sample rows, apply and authorize pairs, receipt path, adoption", async () => {
  const cases = [
    [["rehearse"], "RESTORE_REHEARSAL_ENVIRONMENT_REFUSED"],
    [["restore", "--environment=staging"], "RESTORE_REHEARSAL_COMMAND_INVALID"],
    [[...PITR_ARGS, "--unknown=1"], "RESTORE_REHEARSAL_ARGUMENT_INVALID"],
    [[...PITR_ARGS, "--path=pitr"], "RESTORE_REHEARSAL_ARGUMENT_INVALID"],
    [[...PITR_ARGS, "--adopt-unlabelled"], "RESTORE_REHEARSAL_ARGUMENT_INVALID"],
    [["rehearse", "--environment=staging", "--path=dump", `--point-in-time=${POINT_IN_TIME}`], "RESTORE_REHEARSAL_PATH_INVALID"],
    [["rehearse", "--environment=staging", "--path=pitr", "--rehearsal-id=SHOUTING"], "RESTORE_REHEARSAL_ID_INVALID"],
    [["rehearse", "--environment=staging", "--path=pitr"], "RESTORE_REHEARSAL_ARGUMENT_INVALID"],
    [[...PITR_ARGS, `--backup-id=${BACKUP_ID}`], "RESTORE_REHEARSAL_ARGUMENT_INVALID"],
    [["rehearse", "--environment=staging", "--path=backup", `--rehearsal-id=${ID}`], "RESTORE_REHEARSAL_ARGUMENT_INVALID"],
    [[...PITR_ARGS, "--sample-rows=0"], "RESTORE_REHEARSAL_SAMPLE_ROWS_INVALID"],
    [[...PITR_ARGS, "--apply"], "RESTORE_REHEARSAL_AUTHORIZATION_REQUIRED"],
    [[...PITR_ARGS, "--authorize=x"], "RESTORE_REHEARSAL_AUTHORIZATION_REQUIRED"],
    [[...PITR_ARGS, "--apply", "--dry-run", "--authorize=x"], "RESTORE_REHEARSAL_ARGUMENT_INVALID"],
    [[...PITR_ARGS, "--receipt-out=/tmp/x.json"], "RESTORE_REHEARSAL_ARGUMENT_INVALID"],
    [[...PITR_ARGS, "--apply", "--authorize=x", "--receipt-out=relative.json"], "RESTORE_REHEARSAL_RECEIPT_PATH_INVALID"],
    [["rehearse", "--environment=staging", "--path=pitr", `--point-in-time=${POINT_IN_TIME}`, "--apply", "--authorize=x"],
      "RESTORE_REHEARSAL_ID_INVALID"],
    [["cleanup", "--environment=staging", "--path=pitr"], "RESTORE_REHEARSAL_ID_INVALID"],
    [["cleanup", "--environment=staging", "--path=backup", `--rehearsal-id=${ID}`, "--adopt-unlabelled"],
      "RESTORE_REHEARSAL_ADOPT_PATH_REFUSED"],
    [["cleanup", "--environment=staging", "--path=pitr", `--rehearsal-id=${ID}`, "--adopt-unlabelled",
      "--adopt-unlabelled"], "RESTORE_REHEARSAL_ARGUMENT_INVALID"],
  ];
  for (const [argv, code] of cases) {
    assert.throws(() => parseRehearsalArgs(argv), { code }, argv.join(" "));
  }
  for (const [pointInTime, code] of [["2026-10-02 17:00:00", "RESTORE_REHEARSAL_POINT_IN_TIME_INVALID"],
    ["2026-10-02T17:00:00+01:00", "RESTORE_REHEARSAL_POINT_IN_TIME_INVALID"],
    ["AFTER-PREFLIGHT", "RESTORE_REHEARSAL_POINT_IN_TIME_INVALID"],
    ["2026-10-02T17:59:30Z", "RESTORE_REHEARSAL_POINT_IN_TIME_NOT_PAST"],
    ["2026-10-03T00:00:00Z", "RESTORE_REHEARSAL_POINT_IN_TIME_NOT_PAST"]]) {
    assert.throws(() => planRestoreRehearsal(STAGING, { ...PITR_REQUEST, pointInTime }, { nowMs: NOW }), { code });
  }
  assert.equal(planRestoreRehearsal(STAGING, COVERED_REQUEST, { nowMs: NOW }).pointInTime, POINT_IN_TIME_AFTER_PREFLIGHT);
  assert.throws(() => planRestoreRehearsal(STAGING, { ...BACKUP_REQUEST, backupId: "abc" }, { nowMs: NOW }),
    { code: "RESTORE_REHEARSAL_BACKUP_ID_INVALID" });
  assert.throws(() => planRestoreRehearsal(STAGING, { ...PITR_REQUEST, sampleRows: 1_001 }, { nowMs: NOW }),
    { code: "RESTORE_REHEARSAL_SAMPLE_ROWS_INVALID" });
});

test("non-staging, production-marked, rehearsal, test-estate and synthetic sources are refused", () => {
  const cases = [
    [(d) => { d.cloudSql.instance = "tibotattle-primary"; }, "RESTORE_REHEARSAL_SOURCE_REFUSED"],
    [(d) => { d.cloudSql.instance = "tibotattle-staging-production-primary"; }, "RESTORE_REHEARSAL_SOURCE_REFUSED"],
    [(d) => { d.cloudSql.instance = "tibotattle-staging-primary-rehearsal-abcdefgh"; }, "RESTORE_REHEARSAL_SOURCE_REFUSED"],
    [(d) => { d.cloudSql.instance = TEST_TARGET_NAMES.find((name) => name.includes("primary")); }, "RESTORE_REHEARSAL_TEST_ESTATE_REFUSED"],
    [(d) => { d.cloudSql.instance = "tibotattle-test-staging-primary"; }, "RESTORE_REHEARSAL_TEST_ESTATE_REFUSED"],
    [(d) => { d.synthetic = true; }, "RESTORE_REHEARSAL_SYNTHETIC_TARGET_REFUSED"],
    [(d) => { d.environment = "production"; }, "RESTORE_REHEARSAL_ENVIRONMENT_MISMATCH"],
    [(d) => { d.cloudSql.schema = "Bad-Schema"; }, "RESTORE_REHEARSAL_DESIRED_STATE_INVALID"],
  ];
  for (const [mutate, code] of cases) {
    assert.throws(() => rehearsalTarget(withDesired(mutate), PITR_REQUEST), { code });
  }
});

test("a wrong or stale authorization refuses before any call, connection or receipt file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "restore-rehearsal-"));
  try {
    const receiptOut = join(dir, "receipt.json");
    const wrong = await cli([...PITR_ARGS, "--apply", "--authorize=restore-rehearsal:staging:x:0000000000000000",
      `--receipt-out=${receiptOut}`], { runner: NO_GCLOUD, connect: NO_GCLOUD });
    assert.equal(wrong.err.code, "RESTORE_REHEARSAL_AUTHORIZATION_MISMATCH");
    await assert.rejects(stat(receiptOut));
    const other = planRestoreRehearsal(STAGING, { ...PITR_REQUEST, pointInTime: "2026-10-02T16:00:00Z" }, { nowMs: NOW });
    const { run } = await rehearse({ authorize: other.authorization, gcloud: { runner: NO_GCLOUD } });
    await expectCode(run(), "RESTORE_REHEARSAL_AUTHORIZATION_MISMATCH");
    // The explicit-time authorization does not authorize after-preflight, nor the reverse.
    const covered = planRestoreRehearsal(STAGING, COVERED_REQUEST, { nowMs: NOW });
    const { run: crossed } = await rehearse({ request: COVERED_REQUEST,
      authorize: planRestoreRehearsal(STAGING, PITR_REQUEST, { nowMs: NOW }).authorization, gcloud: { runner: NO_GCLOUD } });
    await expectCode(crossed(), "RESTORE_REHEARSAL_AUTHORIZATION_MISMATCH");
    assert.notEqual(covered.authorization, other.authorization);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Refusals: preflight (reads only, nothing created)

test("preflight refusals create nothing", async () => {
  const cases = [
    [{ gcloud: fakeGcloud({ existing: [PITR_SCRATCH] }) }, "RESTORE_REHEARSAL_SCRATCH_EXISTS"],
    [{ gcloud: fakeGcloud({ source: sourceInstance({ top: { state: "MAINTENANCE" } }) }) }, "RESTORE_REHEARSAL_SOURCE_NOT_RUNNABLE"],
    [{ gcloud: fakeGcloud({ source: sourceInstance({ top: { databaseVersion: "POSTGRES_16" } }) }) },
      "RESTORE_REHEARSAL_SOURCE_VERSION_UNEXPECTED"],
    [{ gcloud: fakeGcloud({ source: sourceInstance({ top: { region: "us-central1" } }) }) },
      "RESTORE_REHEARSAL_SOURCE_DESCRIBE_INVALID"],
    [{ gcloud: fakeGcloud({ source: sourceInstance({ settings: { backupConfiguration: { enabled: true,
      pointInTimeRecoveryEnabled: false, transactionLogRetentionDays: 7 } } }) }) }, "RESTORE_REHEARSAL_SOURCE_PITR_DISABLED"],
    [{ gcloud: fakeGcloud({ source: sourceInstance({ settings: { backupConfiguration: { enabled: true,
      pointInTimeRecoveryEnabled: false, transactionLogRetentionDays: 7 } } }) }), request: COVERED_REQUEST },
    "RESTORE_REHEARSAL_SOURCE_PITR_DISABLED"],
    [{ gcloud: fakeGcloud({ source: sourceInstance({ settings: { backupConfiguration: { enabled: true,
      pointInTimeRecoveryEnabled: true, transactionLogRetentionDays: 1 } } }) }),
    request: { ...PITR_REQUEST, pointInTime: "2026-10-01T12:00:00Z" } }, "RESTORE_REHEARSAL_POINT_IN_TIME_OUTSIDE_RETENTION"],
    [{ request: BACKUP_REQUEST, gcloud: fakeGcloud({ backups: { [BACKUP_ID]: successfulBackup({ status: "FAILED" }) } }) },
      "RESTORE_REHEARSAL_BACKUP_NOT_SUCCESSFUL"],
    [{ request: BACKUP_REQUEST, gcloud: fakeGcloud({ backups: { [BACKUP_ID]: successfulBackup({ instance: "someone-else" }) } }) },
      "RESTORE_REHEARSAL_BACKUP_INVALID"],
    [{ request: BACKUP_REQUEST, gcloud: fakeGcloud({ backups: {} }) }, "GCLOUD_CALL_FAILED:sql-backups-describe"],
    [{ request: BACKUP_REQUEST, gcloud: fakeGcloud({ source: sourceInstance({ settings: { dataDiskSizeGb: "200" } }) }) },
      "RESTORE_REHEARSAL_SOURCE_DISK_EXCEEDS_PLAN"],
    [{ db: equalCopy({ failRole: "source" }) }, "RESTORE_REHEARSAL_CONNECTION_FAILED"],
    [{ db: equalCopy({ sources: [dataset({ readOnly: "off" })] }) }, "RESTORE_REHEARSAL_SESSION_NOT_READ_ONLY"],
    [{ db: equalCopy({ sources: [dataset({ database: "postgres" })] }) }, "RESTORE_REHEARSAL_DATABASE_MISMATCH"],
    [{ db: equalCopy({ sources: [dataset({ history: null })] }) }, "RESTORE_REHEARSAL_SOURCE_HISTORY_ABSENT"],
  ];
  for (const [options, code] of cases) {
    const gcloud = options.gcloud ?? fakeGcloud();
    const { run } = await rehearse({ ...options, gcloud });
    await expectCode(run(), code);
    assert.deepEqual(mutationCalls(gcloud.calls), [], code);
  }
});

// ---------------------------------------------------------------------------
// Refusals: the gcloud guard

test("the guard refuses any mutation of the source, any wait in gcloud, and any shape outside the closed set", () => {
  const target = rehearsalTarget(STAGING, PITR_REQUEST);
  const call = guardedRehearsalGcloud(() => ({ status: 0, stdout: "[]" }), target);
  const project = `--project=${PROJECT}`;
  const tail = ["--async", "--quiet", "--format=json"];
  const refused = [
    [["sql", "instances", "patch", SOURCE, project, "--no-deletion-protection", ...tail], "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "instances", "delete", SOURCE, project, ...tail], "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "instances", "clone", PITR_SCRATCH, SOURCE, project, `--point-in-time=${POINT_IN_TIME}`, ...tail],
      "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "instances", "clone", SOURCE, PITR_SCRATCH, project, `--point-in-time=${POINT_IN_TIME_AFTER_PREFLIGHT}`, ...tail],
      "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "instances", "clone", SOURCE, PITR_SCRATCH, project, ...tail], "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "instances", "create", SOURCE, project, ...tail], "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "backups", "restore", BACKUP_ID, `--restore-instance=${SOURCE}`, `--backup-instance=${SOURCE}`, project,
      ...tail], "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "instances", "describe", "tibotattle-staging-other", project, "--format=json"], "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "instances", "list", project, "--format=json"], "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "backups", "list", project, `--instance=${SOURCE}`, `--filter=instance=${PITR_SCRATCH}`, "--format=json"],
      "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "operations", "list", `--instance=${SOURCE}`, project, "--format=json"], "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "operations", "list", `--instance=${PITR_SCRATCH}`, project, "--filter=status=DONE", "--format=json"],
      "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "operations", "describe", "not-returned-by-this-run", project, "--format=json"], "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "operations", "describe", "--bad", project, "--format=json"], "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "instances", "delete", PITR_SCRATCH, project, "--async", "--format=json"], "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "instances", "delete", PITR_SCRATCH, project, "--quiet", "--format=json"], "GCLOUD_ASYNC_REQUIRED"],
    [["sql", "instances", "delete", PITR_SCRATCH, project, "--async", ...tail], "GCLOUD_ASYNC_REQUIRED"],
    [["sql", "instances", "delete", PITR_SCRATCH, project, "--async=false", ...tail], "GCLOUD_FLAG_FORBIDDEN"],
    [["sql", "instances", "describe", SOURCE, project, "--async", "--format=json"], "GCLOUD_FLAG_FORBIDDEN"],
    [["sql", "instances", "delete", PITR_SCRATCH, project, "--enable-final-backup", ...tail], "GCLOUD_FLAG_FORBIDDEN"],
    [["sql", "instances", "delete", PITR_SCRATCH, "--project=other-project", ...tail], "GCLOUD_PROJECT_FLAG_INVALID"],
    [["sql", "instances", "delete", PITR_SCRATCH, project, project, ...tail], "GCLOUD_PROJECT_FLAG_INVALID"],
    [["sql", "instances", "delete", PITR_SCRATCH, project, "--async", "--quiet"], "GCLOUD_FORMAT_REQUIRED"],
    [["sql", "backups", "delete", BACKUP_ID, `--instance=${SOURCE}`, project, ...tail], "GCLOUD_COMMAND_FORBIDDEN"],
    [["sql", "instances", "restore-backup", SOURCE, project, ...tail], "GCLOUD_COMMAND_FORBIDDEN"],
    [["sql", "operations", "wait", "x", project, "--format=json"], "GCLOUD_COMMAND_FORBIDDEN"],
    [["sql", "operations", "cancel", "x", project, "--format=json"], "GCLOUD_COMMAND_FORBIDDEN"],
    [["sql", "users", "create", "x", `--instance=${SOURCE}`, project, "--format=json"], "GCLOUD_COMMAND_FORBIDDEN"],
    [["sql", "databases", "delete", "x", `--instance=${PITR_SCRATCH}`, project, "--format=json"], "GCLOUD_COMMAND_FORBIDDEN"],
    [["sql", "instances", "describe", SOURCE, project, "--impersonate-service-account=x", "--format=json"], "GCLOUD_FLAG_FORBIDDEN"],
  ];
  for (const [argv, code] of refused) {
    assert.throws(() => call(argv), { code }, argv.join(" "));
  }
  // A scratch that is the source, or not a scratch name, can never be a mutation target.
  const sameAsSource = guardedRehearsalGcloud(() => ({ status: 0, stdout: "" }), { ...target, scratch: SOURCE });
  assert.throws(() => sameAsSource(["sql", "instances", "delete", SOURCE, `--project=${PROJECT}`, ...tail]),
    { code: "GCLOUD_TARGET_FORBIDDEN" });
  // An operation becomes describable only once a mutation through the guard returned it.
  const operation = "abc-123-synthetic";
  const runner = (argv) => ({ status: 0, stdout: JSON.stringify(argv[1] === "operations" ? { name: operation, status: "DONE" }
    : { name: operation, status: "RUNNING" }) });
  const tracked = guardedRehearsalGcloud(runner, target);
  const describe = ["sql", "operations", "describe", operation, project, "--format=json"];
  assert.throws(() => tracked(describe), { code: "GCLOUD_TARGET_FORBIDDEN" });
  assert.deepEqual(tracked(["sql", "instances", "delete", PITR_SCRATCH, project, ...tail]), { accepted: true, operation });
  assert.equal(tracked(describe).status, "DONE");
  // An accepted mutation with unreadable output still reports acceptance, with no operation.
  const unreadable = guardedRehearsalGcloud(() => ({ status: 0, stdout: "not json" }), target);
  assert.deepEqual(unreadable(["sql", "instances", "delete", PITR_SCRATCH, project, ...tail]),
    { accepted: true, operation: null });
});

// ---------------------------------------------------------------------------
// Refusals: teardown

test("teardown refuses to delete a scratch whose final backup or deletion protection is still on", async () => {
  for (const options of [{ ignoreDisarm: true }, { keepFinalBackupSetting: true }]) {
    const gcloud = fakeGcloud(options);
    const { run } = await rehearse({ gcloud });
    await expectFailure(run(), (error) => {
      assert.equal(error.code, "RESTORE_REHEARSAL_TEARDOWN_SETTINGS_UNSAFE");
      assert.equal(error.receipt.teardown.scratchDeleted, false);
      assert.equal(error.receipt.uploadsMayReopen, false);
    });
    assert.equal(gcloud.calls.some((argv) => argv[2] === "delete"), false);
    assert.equal(gcloud.instances.has(PITR_SCRATCH), true);
  }
});

test("a scratch that never becomes ready is still deleted once settled; one stuck in maintenance is left untouched", async () => {
  const failed = fakeGcloud({ finalState: "FAILED" });
  await expectFailure((await rehearse({ gcloud: failed })).run(), (error) => {
    assert.equal(error.code, "RESTORE_REHEARSAL_SCRATCH_NOT_READY");
    assert.equal(error.receipt.teardown.scratchDeleted, true);
  });
  assert.equal(failed.instances.has(PITR_SCRATCH), false);
  const stuck = fakeGcloud({ finalState: "MAINTENANCE" });
  await expectFailure((await rehearse({ gcloud: stuck })).run(), (error) => {
    assert.equal(error.code, "RESTORE_REHEARSAL_SCRATCH_NOT_READY");
    assert.equal(error.receipt.teardown.code, "RESTORE_REHEARSAL_SCRATCH_BUSY");
  });
  assert.equal(stuck.calls.some((argv) => argv[2] === "delete"), false);
  assert.equal(stuck.calls.some((argv) => argv[2] === "patch" && argv.includes("--no-deletion-protection")), false);
  assert.equal(stuck.instances.has(PITR_SCRATCH), true);
});

test("a backup of the deleted scratch that is still listed fails the run", async () => {
  const gcloud = fakeGcloud({ leaveBackupOnDelete: true });
  await expectFailure((await rehearse({ gcloud })).run(), (error) => {
    assert.equal(error.code, "RESTORE_REHEARSAL_SCRATCH_BACKUP_REMAINS");
    assert.equal(error.receipt.teardown.scratchDeleted, true);
    assert.equal(error.receipt.uploadsMayReopen, false);
  });
  assert.equal(gcloud.instances.has(PITR_SCRATCH), false);
  assert.equal(gcloud.calls.some((argv) => argv[1] === "backups" && argv[2] === "delete"), false);
});

test("an unreadable backup listing after delete is reported unavailable, not as none found", async () => {
  const { run } = await rehearse({ gcloud: fakeGcloud({ backupListFails: true }) });
  assert.equal((await run()).teardown.finalBackups, "unavailable");
});

test("cleanup deletes only a scratch labelled for the same rehearsal, or adopts an unlabelled PITR clone, each with its own authorization", async () => {
  const target = rehearsalTarget(STAGING, PITR_REQUEST);
  assert.equal(cleanupAuthorization(target), `restore-rehearsal-cleanup:staging:${PITR_SCRATCH}`);
  assert.equal(adoptCleanupAuthorization(target), `restore-rehearsal-cleanup-adopt-unlabelled:staging:${PITR_SCRATCH}`);
  const unlabelled = fakeGcloud({ existing: [PITR_SCRATCH] });
  await expectCode(cleanup(unlabelled), "RESTORE_REHEARSAL_SCRATCH_NOT_OWNED");
  assert.equal(unlabelled.instances.has(PITR_SCRATCH), true);
  assert.deepEqual(mutationCalls(unlabelled.calls), []);
  const otherId = fakeGcloud({ existing: [PITR_SCRATCH] });
  otherId.instances.get(PITR_SCRATCH).settings.userLabels = { "tibotattle-purpose": "restore-rehearsal", "tibotattle-rehearsal": "zzzzzzzz" };
  const purposeOnly = fakeGcloud({ existing: [PITR_SCRATCH] });
  purposeOnly.instances.get(PITR_SCRATCH).settings.userLabels = { "tibotattle-purpose": "something-else" };
  for (const foreign of [otherId, purposeOnly]) {
    for (const adoptUnlabelled of [false, true]) {
      await expectCode(cleanup(foreign, { adoptUnlabelled }), "RESTORE_REHEARSAL_SCRATCH_NOT_OWNED");
    }
    assert.deepEqual(mutationCalls(foreign.calls), []);
  }
  await expectCode(cleanupRehearsalScratch(STAGING, { environment: "staging", path: "pitr", rehearsalId: ID,
    authorize: "restore-rehearsal-cleanup:staging:other", runner: NO_GCLOUD }), "RESTORE_REHEARSAL_AUTHORIZATION_MISMATCH");
  await expectCode(cleanup({ runner: NO_GCLOUD }, { authorize: adoptCleanupAuthorization(target) }),
    "RESTORE_REHEARSAL_AUTHORIZATION_MISMATCH");
  await expectCode(cleanup({ runner: NO_GCLOUD }, { adoptUnlabelled: true, path: "backup" }),
    "RESTORE_REHEARSAL_ADOPT_PATH_REFUSED");
  const labelled = fakeGcloud({ existing: [PITR_SCRATCH] });
  labelled.instances.get(PITR_SCRATCH).settings.userLabels = { ...ALL_LABELS };
  const cleaned = await cleanup(labelled);
  assert.equal(cleaned.status, "cleaned");
  assert.equal(cleaned.mode, "labelled");
  assert.equal(labelled.instances.has(PITR_SCRATCH), false);
  assert.equal(labelled.instances.has(SOURCE), true);
  assertSourceOnlyRead(labelled.calls, PITR_SCRATCH);
  const adopted = await cleanup(unlabelled, { adoptUnlabelled: true });
  assert.equal(adopted.teardown.ownership, "unlabelled");
  assert.equal(unlabelled.instances.has(PITR_SCRATCH), false);
  assertSourceOnlyRead(unlabelled.calls, PITR_SCRATCH);
  // Nothing to clean is reported, not invented.
  assert.equal((await cleanup(fakeGcloud())).teardown.alreadyAbsent, true);
});

test("the cleanup dry run makes no call and prints the mode's own authorization", async () => {
  const base = ["cleanup", "--environment=staging", "--path=pitr", `--rehearsal-id=${ID}`];
  const plain = await cli(base, { runner: NO_GCLOUD });
  assert.equal(plain.out.mode, "labelled");
  assert.equal(plain.out.authorization, `restore-rehearsal-cleanup:staging:${PITR_SCRATCH}`);
  const adopt = await cli([...base, "--adopt-unlabelled"], { runner: NO_GCLOUD });
  assert.equal(adopt.out.mode, "adopt-unlabelled");
  assert.equal(adopt.out.authorization, `restore-rehearsal-cleanup-adopt-unlabelled:staging:${PITR_SCRATCH}`);
  assert.ok(adopt.out.calls.filter((argv) => RESTORE_REHEARSAL_COMMANDS[argv.slice(0, 3).join(" ")] === "mutate")
    .every((argv) => argv.includes("--async")));
  const applied = await cli([...base, "--adopt-unlabelled", "--apply", `--authorize=${plain.out.authorization}`],
    { runner: NO_GCLOUD });
  assert.equal(applied.err.code, "RESTORE_REHEARSAL_AUTHORIZATION_MISMATCH");
});

// ---------------------------------------------------------------------------
// CLI receipt file

test("the CLI reserves the receipt before mutating and writes it, owner-only, on success and on failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "restore-rehearsal-"));
  try {
    const plan = planRestoreRehearsal(STAGING, PITR_REQUEST, { nowMs: NOW });
    const receiptOut = join(dir, "receipt.json");
    const clock = () => {
      const vc = virtualClock();
      return { now: vc.now, sleep: vc.sleep };
    };
    const ok = await cli([...PITR_ARGS, "--apply", `--authorize=${plan.authorization}`, `--receipt-out=${receiptOut}`],
      { runner: fakeGcloud().runner, connect: equalCopy().connect, ...clock() });
    assert.equal(ok.code, EXIT_CODES.uploadsBlocked);
    const written = JSON.parse(await readFile(receiptOut, "utf8"));
    assert.equal(written.status, "verified");
    assert.equal(written.uploadsMayReopen, false);
    assert.equal((await stat(receiptOut)).mode & 0o777, 0o600);
    // An existing path refuses before any call.
    const taken = await cli([...PITR_ARGS, "--apply", `--authorize=${plan.authorization}`, `--receipt-out=${receiptOut}`],
      { runner: NO_GCLOUD, ...clock() });
    assert.equal(taken.err.code, "RESTORE_REHEARSAL_RECEIPT_PATH_UNAVAILABLE");
    // A failure after the scratch existed still writes the receipt so far.
    const failedOut = join(dir, "failed.json");
    const failed = await cli([...PITR_ARGS, "--apply", `--authorize=${plan.authorization}`, `--receipt-out=${failedOut}`],
      { runner: fakeGcloud({ ignoreDisarm: true }).runner, connect: equalCopy().connect, ...clock() });
    assert.equal(failed.code, 1);
    assert.equal(failed.err.code, "RESTORE_REHEARSAL_TEARDOWN_SETTINGS_UNSAFE");
    assert.equal(JSON.parse(await readFile(failedOut, "utf8")).teardown.scratchDeleted, false);
    // A refused clone writes the receipt too, saying the scratch is not this run's.
    const refusedOut = join(dir, "refused.json");
    const refused = await cli([...PITR_ARGS, "--apply", `--authorize=${plan.authorization}`, `--receipt-out=${refusedOut}`],
      { runner: fakeGcloud({ refuse: "sql instances clone", onRefuse: (fake) => fake.foreignClone(PITR_SCRATCH) }).runner,
        connect: equalCopy().connect, ...clock() });
    assert.equal(refused.code, 1);
    assert.equal(JSON.parse(await readFile(refusedOut, "utf8")).teardown.code, "RESTORE_REHEARSAL_SCRATCH_OWNERSHIP_UNPROVEN");
    // A refusal before any mutation leaves no file behind.
    const preflightOut = join(dir, "preflight.json");
    const preflight = await cli([...PITR_ARGS, "--apply", `--authorize=${plan.authorization}`, `--receipt-out=${preflightOut}`],
      { runner: fakeGcloud({ existing: [PITR_SCRATCH] }).runner, connect: equalCopy().connect, ...clock() });
    assert.equal(preflight.err.code, "RESTORE_REHEARSAL_SCRATCH_EXISTS");
    await assert.rejects(stat(preflightOut));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Units

test("doNotRestoreOutcome accepts only an exact done result", () => {
  assert.equal(doNotRestoreOutcome({ status: "done", listSha256: "a".repeat(64), entries: 3, matched: 2, purged: 2 }).status, "done");
  for (const value of [null, {}, { status: "done" },
    { status: "done", listSha256: "A".repeat(64), entries: 1, matched: 0, purged: 0 },
    { status: "done", listSha256: "a".repeat(64), entries: 1, matched: 2, purged: 2 },
    { status: "done", listSha256: "a".repeat(64), entries: -1, matched: 0, purged: 0 }]) {
    assert.equal(doNotRestoreOutcome(value).status, "not-done");
  }
});

test("manifestRelation reports equal, behind, newer and diverged without throwing", () => {
  assert.equal(manifestRelation(HISTORY, MIGRATIONS).relation, "equal");
  assert.equal(manifestRelation(HISTORY.slice(0, 1), MIGRATIONS).relation, "behind");
  assert.equal(manifestRelation(HISTORY, MIGRATIONS.slice(0, 2)).relation, "newer-than-image");
  assert.equal(manifestRelation([{ ...HISTORY[0], checksum_sha256: "0".repeat(64) }], MIGRATIONS).relation, "diverged");
  assert.equal(manifestRelation(null, MIGRATIONS).relation, "history-absent");
});

test("fingerprintDatabase reads in one read-only snapshot, with a write watermark, and rolls it back", async () => {
  const log = [];
  const fingerprint = await fingerprintDatabase(fakePool(dataset(), log), { database: STAGING.cloudSql.database,
    schema: STAGING.cloudSql.schema, sampleRows: 2, key: KEY });
  assert.equal(log[0], FINGERPRINT_QUERIES.begin);
  assert.equal(log.at(-1), FINGERPRINT_QUERIES.end);
  assert.ok(log.indexOf(FINGERPRINT_QUERIES.watermark) > log.indexOf(FINGERPRINT_QUERIES.identity));
  for (const term of ["FROM pg_stat_user_tables", "n_tup_ins", "n_tup_upd", "n_tup_del", "s.relid", "stats_reset",
    "pg_postmaster_start_time()"]) {
    assert.ok(FINGERPRINT_QUERIES.watermark.includes(term), term);
  }
  assert.equal(fingerprint.writeWatermark.tables, 3);
  assert.equal(fingerprint.tables.find((table) => table.name === "audit_events").order, "row-text");
  assert.equal(fingerprint.tables.find((table) => table.name === "usage_days").head.sampled, 2);
  assert.match(log.find((statement) => statement.includes("rehearsal:sample:tail") && statement.includes("audit_events")),
    /ORDER BY ROW\(x\.\*\)::text DESC/u);
  assert.equal(compareFingerprints({ sourceBefore: fingerprint, sourceAfter: fingerprint, scratch: fingerprint }).verdict,
    "passed");
  // A table whose name cannot be quoted safely is never silently passed.
  const odd = { ...fingerprint, tables: [...fingerprint.tables, { name: null, status: "unsupported-identifier" }] };
  const incomplete = compareFingerprints({ sourceBefore: odd, sourceAfter: odd, scratch: odd });
  assert.equal(incomplete.verdict, "inconclusive");
  assert.equal(incomplete.code, "RESTORE_VERIFICATION_INCOMPLETE");
  await expectCode(fingerprintDatabase(fakePool(dataset(), []), { database: "x", schema: "s", sampleRows: 1, key: "short" }),
    "RESTORE_REHEARSAL_SAMPLE_KEY_INVALID");
});

test("compareFingerprints calls a difference failed only when the source is shown unchanged since the recovery point", async () => {
  const read = (data) => fingerprintDatabase(fakePool(data, []), { database: STAGING.cloudSql.database,
    schema: STAGING.cloudSql.schema, sampleRows: 4, key: KEY });
  const source = await read(dataset());
  const short = dataset();
  short.tables[0] = { ...short.tables[0], rows: short.tables[0].rows.slice(0, 2) };
  const scratch = await read(short);
  const moved = await read(dataset({ watermark: "w9" }));
  const verdicts = [
    [{ sourceAfter: source, recoveryPointCovered: true }, "failed", "RESTORE_SCRATCH_DIFFERS_FROM_SOURCE"],
    [{ sourceAfter: source, recoveryPointCovered: false }, "inconclusive",
      "RESTORE_SOURCE_UNCHANGED_SINCE_RECOVERY_POINT_UNPROVEN"],
    [{ sourceAfter: source }, "inconclusive", "RESTORE_SOURCE_UNCHANGED_SINCE_RECOVERY_POINT_UNPROVEN"],
    [{ sourceAfter: source, recoveryPointCovered: "yes" }, "inconclusive",
      "RESTORE_SOURCE_UNCHANGED_SINCE_RECOVERY_POINT_UNPROVEN"],
    [{ sourceAfter: moved, recoveryPointCovered: true }, "inconclusive", "RESTORE_SOURCE_MOVED_DURING_RUN"],
  ];
  for (const [options, verdict, code] of verdicts) {
    const result = compareFingerprints({ sourceBefore: source, scratch, ...options });
    assert.equal(result.verdict, verdict);
    assert.equal(result.code, code);
    assert.equal(result.differs, true);
  }
  assert.equal(compareFingerprints({ sourceBefore: source, sourceAfter: source, scratch: source }).verdict, "passed");
});
