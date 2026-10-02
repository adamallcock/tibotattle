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
  RESTORE_REHEARSAL_COMMANDS,
  RESTORE_REHEARSAL_RECEIPT_SCHEMA,
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
// backup and instance below is a synthetic fake. Nothing calls gcloud.
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
const BACKUP_REQUEST = Object.freeze({ environment: "staging", path: "backup", backupId: BACKUP_ID, rehearsalId: ID });
const MIGRATIONS = Object.freeze([1, 2, 3].map((version) => Object.freeze({
  version, name: `000${version}_synthetic.sql`, sha256: createHash("sha256").update(`m${version}`).digest("hex"),
})));
const HISTORY = MIGRATIONS.map(({ version, name, sha256 }) => ({ version, name, checksum_sha256: sha256 }));

function clock(start = NOW, step = 1_000) {
  let value = start;
  return () => {
    value += step;
    return value;
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
      userLabels: {},
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

/** A fake gcloud over an in-memory estate; it records every argv. */
function fakeGcloud({ source = sourceInstance(), backups = { [BACKUP_ID]: successfulBackup() }, existing = [],
  pendingPolls = 1, ignoreDisarm = false, keepFinalBackupSetting = false, failShape = null, failAfterCreate = false,
  backupListFails = false, leaveBackupOnDelete = false } = {}) {
  const instances = new Map([[SOURCE, structuredClone(source)]]);
  for (const name of existing) instances.set(name, { ...structuredClone(source), name, settings: { ...structuredClone(source.settings), userLabels: {} } });
  const leftovers = [];
  const calls = [];
  let pending = 0;
  const ok = (value) => ({ status: 0, stdout: value === undefined ? "" : JSON.stringify(value) });
  const no = () => ({ status: 1, stdout: "" });
  const runner = (argv) => {
    calls.push(argv);
    const shape = argv.slice(0, 3).join(" ");
    const names = argv.slice(3).filter((arg) => !arg.startsWith("-"));
    const flag = (name) => argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
    if (shape === failShape) {
      if (failAfterCreate && shape === "sql instances clone") {
        instances.set(names[1], { ...structuredClone(instances.get(names[0])), name: names[1], state: "RUNNABLE" });
      }
      return no();
    }
    switch (shape) {
      case "sql instances describe": {
        const instance = instances.get(names[0]);
        if (instance === undefined) return no();
        if (instance.name !== SOURCE && pending > 0) {
          pending -= 1;
          return ok({ ...instance, state: "PENDING_CREATE" });
        }
        return ok(instance);
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
      case "sql instances clone": {
        const from = instances.get(names[0]);
        instances.set(names[1], { ...structuredClone(from), name: names[1],
          settings: { ...structuredClone(from.settings), userLabels: {} } });
        pending = pendingPolls;
        return ok();
      }
      case "sql instances create": {
        instances.set(names[0], { name: names[0], project: PROJECT, region: flag("--region"), state: "RUNNABLE",
          databaseVersion: flag("--database-version"), settings: { tier: flag("--tier"), deletionProtectionEnabled: false,
            backupConfiguration: { enabled: false }, userLabels: parseLabels(flag("--labels")),
            ipConfiguration: { ipv4Enabled: true, authorizedNetworks: [] } } });
        return ok();
      }
      case "sql backups restore": {
        const target = instances.get(flag("--restore-instance"));
        if (target === undefined || backups[names[0]] === undefined) return no();
        pending = pendingPolls;
        return ok();
      }
      case "sql instances patch": {
        const instance = instances.get(names[0]);
        if (instance === undefined) return no();
        const labels = flag("--update-labels");
        if (labels !== undefined) Object.assign(instance.settings.userLabels, parseLabels(labels));
        if (!ignoreDisarm) {
          if (argv.includes("--no-deletion-protection")) instance.settings.deletionProtectionEnabled = false;
          if (argv.includes("--no-final-backup") && !keepFinalBackupSetting) {
            instance.settings.finalBackupConfig = { enabled: false };
          }
          if (argv.includes("--no-retain-backups-on-delete")) instance.settings.retainBackupsOnDelete = false;
        }
        return ok();
      }
      case "sql instances delete": {
        const instance = instances.get(names[0]);
        if (instance === undefined || instance.settings.deletionProtectionEnabled) return no();
        if (instance.settings.finalBackupConfig?.enabled === true || leaveBackupOnDelete) {
          leftovers.push({ instance: names[0], type: "FINAL" });
        }
        instances.delete(names[0]);
        return ok();
      }
      default:
        throw new Error(`unexpected gcloud shape ${shape}`);
    }
  };
  return { runner, calls, instances, leftovers };
}

function dataset({ history = HISTORY, tables, database = STAGING.cloudSql.database, readOnly = "on",
  shape = { columns: 40, indexes: 12, constraints: 9, functions: 4 } } = {}) {
  return {
    database,
    readOnly,
    history,
    shape,
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
function fakeConnect({ sources, scratch, failRole = null }) {
  const opened = [];
  const logs = { source: [], scratch: [] };
  let sourceIndex = 0;
  const connect = async (spec) => {
    opened.push(spec);
    if (spec.role === failRole) throw new Error("connection refused");
    const data = spec.role === "source" ? sources[Math.min(sourceIndex++, sources.length - 1)] : scratch;
    return { pool: fakePool(data, logs[spec.role]), async close() {} };
  };
  return { connect, opened, logs };
}

function equalCopy(options = {}) {
  return fakeConnect({ sources: [dataset()], scratch: dataset(), ...options });
}

async function rehearse({ request = PITR_REQUEST, desired = STAGING, gcloud = fakeGcloud(), db = equalCopy(),
  doNotRestore = null, migrations = MIGRATIONS, authorize } = {}) {
  const plan = planRestoreRehearsal(desired, request, { nowMs: NOW });
  const options = {
    authorize: authorize ?? plan.authorization,
    runner: gcloud.runner,
    connect: db.connect,
    doNotRestore,
    readMigrations: async () => migrations,
    now: clock(),
    sleep: async () => {},
    randomKey: () => KEY,
  };
  return { plan, gcloud, db, run: () => runRestoreRehearsal(desired, request, options) };
}

function assertSourceOnlyRead(calls, scratch) {
  for (const argv of calls) {
    const shape = argv.slice(0, 3).join(" ");
    assert.ok(Object.hasOwn(RESTORE_REHEARSAL_COMMANDS, shape), shape);
    if (RESTORE_REHEARSAL_COMMANDS[shape] !== "mutate") continue;
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

test("the dry run makes no call and prints the exact authorization and plan", async () => {
  const { code, out } = await cli(PITR_ARGS, { runner: NO_GCLOUD, connect: NO_GCLOUD });
  assert.equal(code, 0);
  assert.equal(out.status, "dry_run");
  assert.equal(out.scratch, PITR_SCRATCH);
  assert.match(out.authorization, new RegExp(`^restore-rehearsal:staging:${PITR_SCRATCH}:[a-f0-9]{16}$`, "u"));
  assert.deepEqual(out.mutations.map((entry) => entry.step), ["clone", "label", "disarm", "delete"]);
  assert.equal(out.uploadsMayReopen, false);
  assert.equal(out.doNotRestore.code, "DO_NOT_RESTORE_STEP_NOT_PROVIDED");
  assertSourceOnlyRead(out.mutations.map((entry) => entry.argv), PITR_SCRATCH);
  assert.ok(out.mutations.every((entry) => !entry.argv.includes("--async") && !entry.argv.includes("--enable-final-backup")));
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
  assert.equal(receipt.verification.sourceStable, true);
  assert.equal(receipt.manifest.relation, "equal");
  assert.equal(receipt.doNotRestore.status, "not-provided");
  assert.equal(receipt.uploadsMayReopen, false);
  assert.deepEqual(receipt.uploadsBlockedBy, ["DO_NOT_RESTORE_STEP_NOT_PROVIDED"]);
  assert.equal(rehearsalExitCode(receipt), EXIT_CODES.uploadsBlocked);
  assert.equal(receipt.teardown.scratchDeleted, true);
  assert.equal(receipt.teardown.finalBackups, "none-found");
  assert.equal(gcloud.instances.has(PITR_SCRATCH), false);
  assert.equal(gcloud.leftovers.length, 0);
  for (const field of ["cloneMs", "restoreMs", "readyMs", "verifyMs", "teardownMs", "totalMs"]) {
    assert.ok(Number.isSafeInteger(receipt.timings[field]) && receipt.timings[field] > 0, field);
  }
  assert.deepEqual(receipt.steps.map((step) => step.step), ["clone", "label", "disarm", "delete"]);
  assertSourceOnlyRead(gcloud.calls, PITR_SCRATCH);
  // The source is opened twice (before and after), the scratch once, each read-only.
  assert.deepEqual(db.opened.map((spec) => spec.role), ["source", "scratch", "source"]);
  assert.ok(db.opened.every((spec) => spec.role === "source"
    ? spec.connectionName === `${PROJECT}:${REGION}:${SOURCE}` : spec.connectionName.endsWith(`:${PITR_SCRATCH}`)));
  for (const role of ["source", "scratch"]) {
    assert.ok(db.logs[role].every((statement) => !/^COMMIT/u.test(statement)));
    assert.equal(db.logs[role].filter((statement) => statement === FINGERPRINT_QUERIES.begin).length,
      role === "source" ? 2 : 1);
  }
  // Content-free: no sample digest and no key reach the receipt.
  const text = JSON.stringify(receipt);
  assert.equal(text.includes(KEY), false);
  const sampleDigest = createHash("sha256").update(`${KEY}(1,a)\n(2,b)\n(3,c)`).digest("hex");
  assert.equal(text.includes(sampleDigest), false);
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

test("a scratch that differs from the source fails verification, skips the step and is still deleted", async () => {
  let called = false;
  const doNotRestore = { reapply: async () => { called = true; return {}; } };
  const short = dataset();
  short.tables[1] = { ...short.tables[1], rows: short.tables[1].rows.slice(0, 149) };
  const { run, gcloud } = await rehearse({ doNotRestore, db: equalCopy({ scratch: short }) });
  const receipt = await run();
  assert.equal(receipt.verification.verdict, "failed");
  assert.equal(receipt.status, "verification_failed");
  assert.equal(called, false);
  assert.equal(receipt.doNotRestore.status, "skipped");
  assert.equal(receipt.uploadsMayReopen, false);
  assert.equal(rehearsalExitCode(receipt), EXIT_CODES.verificationFailed);
  assert.equal(gcloud.instances.has(PITR_SCRATCH), false);
});

test("a changed row, history, schema shape or table set each fail verification", async () => {
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
    const { run } = await rehearse({ db: equalCopy({ scratch: copy }) });
    assert.equal((await run()).verification.verdict, "failed");
  }
});

test("a source that moves during the rehearsal makes the comparison inconclusive, never passed", async () => {
  const moved = dataset();
  moved.tables[0] = { ...moved.tables[0], rows: [...moved.tables[0].rows, "(4,d)"] };
  const { run } = await rehearse({ db: fakeConnect({ sources: [dataset(), moved], scratch: dataset() }) });
  const receipt = await run();
  assert.equal(receipt.verification.sourceStable, false);
  assert.equal(receipt.verification.verdict, "inconclusive");
  assert.equal(receipt.uploadsMayReopen, false);
});

test("the backup path creates, restores, verifies and deletes the b scratch", async () => {
  const { run, gcloud } = await rehearse({ request: BACKUP_REQUEST });
  const receipt = await run();
  assert.equal(receipt.status, "verified");
  assert.equal(receipt.scratch, BACKUP_SCRATCH);
  assert.equal(receipt.recoveryPoint.kind, "backup");
  assert.deepEqual(receipt.steps.map((step) => step.step), ["create", "restore", "disarm", "delete"]);
  assert.ok(receipt.timings.createMs > 0 && receipt.timings.restoreBackupMs > 0);
  assert.equal(gcloud.instances.has(BACKUP_SCRATCH), false);
  assertSourceOnlyRead(gcloud.calls, BACKUP_SCRATCH);
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
  const cleanup = await cli(["cleanup", "--environment=production", "--production", "--path=pitr", `--rehearsal-id=${ID}`],
    { runner: NO_GCLOUD, loadDesired });
  assert.equal(cleanup.err.code, "RESTORE_REHEARSAL_PRODUCTION_PLAN_ONLY");
  // The library refuses a production run whatever authorization it is handed.
  const desired = loadDesired("production");
  const plan = planRestoreRehearsal(desired, { ...PITR_REQUEST, environment: "production" }, { nowMs: NOW });
  await expectCode(runRestoreRehearsal(desired, { ...PITR_REQUEST, environment: "production" },
    { authorize: plan.authorization, runner: NO_GCLOUD, now: () => NOW }), "RESTORE_REHEARSAL_PRODUCTION_PLAN_ONLY");
  await expectCode(cleanupRehearsalScratch(desired, { environment: "production", path: "pitr", rehearsalId: ID,
    authorize: "x", runner: NO_GCLOUD }), "RESTORE_REHEARSAL_PRODUCTION_PLAN_ONLY");
  assert.equal((await cli([...PITR_ARGS, "--production"], { runner: NO_GCLOUD })).err.code, "RESTORE_REHEARSAL_ARGUMENT_INVALID");
});

test("closed arguments: path, id, time, backup id, sample rows, apply and authorize pairs, receipt path", async () => {
  const cases = [
    [["rehearse"], "RESTORE_REHEARSAL_ENVIRONMENT_REFUSED"],
    [["restore", "--environment=staging"], "RESTORE_REHEARSAL_COMMAND_INVALID"],
    [[...PITR_ARGS, "--unknown=1"], "RESTORE_REHEARSAL_ARGUMENT_INVALID"],
    [[...PITR_ARGS, "--path=pitr"], "RESTORE_REHEARSAL_ARGUMENT_INVALID"],
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
  ];
  for (const [argv, code] of cases) {
    assert.throws(() => parseRehearsalArgs(argv), { code }, argv.join(" "));
  }
  for (const [pointInTime, code] of [["2026-10-02 17:00:00", "RESTORE_REHEARSAL_POINT_IN_TIME_INVALID"],
    ["2026-10-02T17:00:00+01:00", "RESTORE_REHEARSAL_POINT_IN_TIME_INVALID"],
    ["2026-10-02T17:59:30Z", "RESTORE_REHEARSAL_POINT_IN_TIME_NOT_PAST"],
    ["2026-10-03T00:00:00Z", "RESTORE_REHEARSAL_POINT_IN_TIME_NOT_PAST"]]) {
    assert.throws(() => planRestoreRehearsal(STAGING, { ...PITR_REQUEST, pointInTime }, { nowMs: NOW }), { code });
  }
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
    const mutations = gcloud.calls.filter((argv) => RESTORE_REHEARSAL_COMMANDS[argv.slice(0, 3).join(" ")] === "mutate");
    assert.deepEqual(mutations, [], code);
  }
});

// ---------------------------------------------------------------------------
// Refusals: the gcloud guard

test("the guard refuses any mutation of the source and any shape outside the closed set", () => {
  const target = rehearsalTarget(STAGING, PITR_REQUEST);
  const call = guardedRehearsalGcloud(() => ({ status: 0, stdout: "[]" }), target);
  const project = `--project=${PROJECT}`;
  const refused = [
    [["sql", "instances", "patch", SOURCE, project, "--no-deletion-protection", "--quiet", "--format=json"], "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "instances", "delete", SOURCE, project, "--quiet", "--format=json"], "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "instances", "clone", PITR_SCRATCH, SOURCE, project, "--quiet", "--format=json"], "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "instances", "create", SOURCE, project, "--quiet", "--format=json"], "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "backups", "restore", BACKUP_ID, `--restore-instance=${SOURCE}`, `--backup-instance=${SOURCE}`, project,
      "--quiet", "--format=json"], "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "instances", "describe", "tibotattle-staging-other", project, "--format=json"], "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "instances", "list", project, "--format=json"], "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "backups", "list", project, `--instance=${SOURCE}`, `--filter=instance=${PITR_SCRATCH}`, "--format=json"],
      "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "instances", "delete", PITR_SCRATCH, project, "--format=json"], "GCLOUD_TARGET_FORBIDDEN"],
    [["sql", "instances", "delete", PITR_SCRATCH, project, "--quiet", "--async", "--format=json"], "GCLOUD_FLAG_FORBIDDEN"],
    [["sql", "instances", "delete", PITR_SCRATCH, project, "--quiet", "--enable-final-backup", "--format=json"], "GCLOUD_FLAG_FORBIDDEN"],
    [["sql", "instances", "delete", PITR_SCRATCH, "--project=other-project", "--quiet", "--format=json"], "GCLOUD_PROJECT_FLAG_INVALID"],
    [["sql", "instances", "delete", PITR_SCRATCH, project, project, "--quiet", "--format=json"], "GCLOUD_PROJECT_FLAG_INVALID"],
    [["sql", "instances", "delete", PITR_SCRATCH, project, "--quiet"], "GCLOUD_FORMAT_REQUIRED"],
    [["sql", "backups", "delete", BACKUP_ID, `--instance=${SOURCE}`, project, "--quiet", "--format=json"], "GCLOUD_COMMAND_FORBIDDEN"],
    [["sql", "instances", "restore-backup", SOURCE, project, "--quiet", "--format=json"], "GCLOUD_COMMAND_FORBIDDEN"],
    [["sql", "users", "create", "x", `--instance=${SOURCE}`, project, "--format=json"], "GCLOUD_COMMAND_FORBIDDEN"],
    [["sql", "databases", "delete", "x", `--instance=${PITR_SCRATCH}`, project, "--format=json"], "GCLOUD_COMMAND_FORBIDDEN"],
    [["sql", "instances", "describe", SOURCE, project, "--impersonate-service-account=x", "--format=json"], "GCLOUD_FLAG_FORBIDDEN"],
  ];
  for (const [argv, code] of refused) {
    assert.throws(() => call(argv), { code }, argv.join(" "));
  }
  // A scratch that is the source, or not a scratch name, can never be a mutation target.
  const sameAsSource = guardedRehearsalGcloud(() => ({ status: 0, stdout: "" }), { ...target, scratch: SOURCE });
  assert.throws(() => sameAsSource(["sql", "instances", "delete", SOURCE, `--project=${PROJECT}`, "--quiet", "--format=json"]),
    { code: "GCLOUD_TARGET_FORBIDDEN" });
});

// ---------------------------------------------------------------------------
// Refusals: teardown

test("teardown refuses to delete a scratch whose final backup or deletion protection is still on", async () => {
  for (const options of [{ ignoreDisarm: true }, { keepFinalBackupSetting: true }]) {
    const gcloud = fakeGcloud(options);
    const { run } = await rehearse({ gcloud });
    await assert.rejects(run(), (error) => {
      assert.equal(error.code, "RESTORE_REHEARSAL_TEARDOWN_SETTINGS_UNSAFE");
      assert.equal(error.receipt.teardown.scratchDeleted, false);
      assert.equal(error.receipt.uploadsMayReopen, false);
      return true;
    });
    assert.equal(gcloud.calls.some((argv) => argv[2] === "delete"), false);
    assert.equal(gcloud.instances.has(PITR_SCRATCH), true);
  }
});

test("a failed clone that left an instance is torn down; one that left none is reported already absent", async () => {
  const left = fakeGcloud({ failShape: "sql instances clone", failAfterCreate: true });
  await assert.rejects((await rehearse({ gcloud: left })).run(), (error) => {
    assert.equal(error.code, "GCLOUD_CALL_FAILED:sql-instances-clone");
    assert.equal(error.receipt.teardown.scratchDeleted, true);
    assert.equal(error.receipt.teardown.alreadyAbsent, false);
    return true;
  });
  assert.equal(left.instances.has(PITR_SCRATCH), false);
  const none = fakeGcloud({ failShape: "sql instances clone" });
  await assert.rejects((await rehearse({ gcloud: none })).run(), (error) => {
    assert.equal(error.receipt.teardown.alreadyAbsent, true);
    return true;
  });
});

test("a scratch that never becomes ready is still deleted", async () => {
  const gcloud = fakeGcloud({ pendingPolls: 1_000 });
  await assert.rejects((await rehearse({ gcloud })).run(), (error) => {
    assert.equal(error.code, "RESTORE_REHEARSAL_SCRATCH_NOT_READY");
    assert.equal(error.receipt.teardown.scratchDeleted, true);
    return true;
  });
  assert.equal(gcloud.instances.has(PITR_SCRATCH), false);
});

test("a backup of the deleted scratch that is still listed fails the run", async () => {
  const gcloud = fakeGcloud({ leaveBackupOnDelete: true });
  await assert.rejects((await rehearse({ gcloud })).run(), (error) => {
    assert.equal(error.code, "RESTORE_REHEARSAL_SCRATCH_BACKUP_REMAINS");
    assert.equal(error.receipt.uploadsMayReopen, false);
    return true;
  });
  assert.equal(gcloud.calls.some((argv) => argv[1] === "backups" && argv[2] === "delete"), false);
});

test("an unreadable backup listing after delete is reported unavailable, not as none found", async () => {
  const { run } = await rehearse({ gcloud: fakeGcloud({ backupListFails: true }) });
  assert.equal((await run()).teardown.finalBackups, "unavailable");
});

test("cleanup deletes only a scratch labelled for the same rehearsal, with its own authorization", async () => {
  const target = rehearsalTarget(STAGING, PITR_REQUEST);
  const authorize = cleanupAuthorization(target);
  assert.equal(authorize, `restore-rehearsal-cleanup:staging:${PITR_SCRATCH}`);
  const unlabelled = fakeGcloud({ existing: [PITR_SCRATCH] });
  await expectCode(cleanupRehearsalScratch(STAGING, { environment: "staging", path: "pitr", rehearsalId: ID, authorize,
    runner: unlabelled.runner }), "RESTORE_REHEARSAL_SCRATCH_NOT_OWNED");
  assert.equal(unlabelled.instances.has(PITR_SCRATCH), true);
  assert.equal(unlabelled.calls.some((argv) => argv[2] === "patch" || argv[2] === "delete"), false);
  const otherId = fakeGcloud({ existing: [PITR_SCRATCH] });
  otherId.instances.get(PITR_SCRATCH).settings.userLabels = { "tibotattle-purpose": "restore-rehearsal", "tibotattle-rehearsal": "zzzzzzzz" };
  await expectCode(cleanupRehearsalScratch(STAGING, { environment: "staging", path: "pitr", rehearsalId: ID, authorize,
    runner: otherId.runner }), "RESTORE_REHEARSAL_SCRATCH_NOT_OWNED");
  await expectCode(cleanupRehearsalScratch(STAGING, { environment: "staging", path: "pitr", rehearsalId: ID,
    authorize: "restore-rehearsal-cleanup:staging:other", runner: NO_GCLOUD }), "RESTORE_REHEARSAL_AUTHORIZATION_MISMATCH");
  const labelled = fakeGcloud({ existing: [PITR_SCRATCH] });
  labelled.instances.get(PITR_SCRATCH).settings.userLabels = { "tibotattle-purpose": "restore-rehearsal", "tibotattle-rehearsal": ID };
  const cleaned = await cleanupRehearsalScratch(STAGING, { environment: "staging", path: "pitr", rehearsalId: ID, authorize,
    runner: labelled.runner, now: clock() });
  assert.equal(cleaned.status, "cleaned");
  assert.equal(labelled.instances.has(PITR_SCRATCH), false);
  assert.equal(labelled.instances.has(SOURCE), true);
  assertSourceOnlyRead(labelled.calls, PITR_SCRATCH);
});

// ---------------------------------------------------------------------------
// CLI receipt file

test("the CLI reserves the receipt before mutating and writes it, owner-only, on success and on failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "restore-rehearsal-"));
  try {
    const plan = planRestoreRehearsal(STAGING, PITR_REQUEST, { nowMs: NOW });
    const receiptOut = join(dir, "receipt.json");
    const ok = await cli([...PITR_ARGS, "--apply", `--authorize=${plan.authorization}`, `--receipt-out=${receiptOut}`],
      { runner: fakeGcloud().runner, connect: equalCopy().connect, now: clock() });
    assert.equal(ok.code, EXIT_CODES.uploadsBlocked);
    const written = JSON.parse(await readFile(receiptOut, "utf8"));
    assert.equal(written.status, "verified");
    assert.equal(written.uploadsMayReopen, false);
    assert.equal((await stat(receiptOut)).mode & 0o777, 0o600);
    // An existing path refuses before any call.
    const taken = await cli([...PITR_ARGS, "--apply", `--authorize=${plan.authorization}`, `--receipt-out=${receiptOut}`],
      { runner: NO_GCLOUD, now: clock() });
    assert.equal(taken.err.code, "RESTORE_REHEARSAL_RECEIPT_PATH_UNAVAILABLE");
    // A failure after the scratch existed still writes the receipt so far.
    const failedOut = join(dir, "failed.json");
    const failed = await cli([...PITR_ARGS, "--apply", `--authorize=${plan.authorization}`, `--receipt-out=${failedOut}`],
      { runner: fakeGcloud({ ignoreDisarm: true }).runner, connect: equalCopy().connect, now: clock() });
    assert.equal(failed.code, 1);
    assert.equal(failed.err.code, "RESTORE_REHEARSAL_TEARDOWN_SETTINGS_UNSAFE");
    assert.equal(JSON.parse(await readFile(failedOut, "utf8")).teardown.scratchDeleted, false);
    // A refusal before any mutation leaves no file behind.
    const preflightOut = join(dir, "preflight.json");
    const preflight = await cli([...PITR_ARGS, "--apply", `--authorize=${plan.authorization}`, `--receipt-out=${preflightOut}`],
      { runner: fakeGcloud({ existing: [PITR_SCRATCH] }).runner, connect: equalCopy().connect, now: clock() });
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

test("fingerprintDatabase reads in one read-only snapshot and rolls it back", async () => {
  const log = [];
  const fingerprint = await fingerprintDatabase(fakePool(dataset(), log), { database: STAGING.cloudSql.database,
    schema: STAGING.cloudSql.schema, sampleRows: 2, key: KEY });
  assert.equal(log[0], FINGERPRINT_QUERIES.begin);
  assert.equal(log.at(-1), FINGERPRINT_QUERIES.end);
  assert.equal(fingerprint.tables.find((table) => table.name === "audit_events").order, "row-text");
  assert.equal(fingerprint.tables.find((table) => table.name === "usage_days").head.sampled, 2);
  assert.match(log.find((statement) => statement.includes("rehearsal:sample:tail") && statement.includes("audit_events")),
    /ORDER BY ROW\(x\.\*\)::text DESC/u);
  assert.equal(compareFingerprints({ sourceBefore: fingerprint, sourceAfter: fingerprint, scratch: fingerprint }).verdict,
    "passed");
  // A table whose name cannot be quoted safely is never silently passed.
  const odd = { ...fingerprint, tables: [...fingerprint.tables, { name: null, status: "unsupported-identifier" }] };
  assert.equal(compareFingerprints({ sourceBefore: odd, sourceAfter: odd, scratch: odd }).verdict, "inconclusive");
  await expectCode(fingerprintDatabase(fakePool(dataset(), []), { database: "x", schema: "s", sampleRows: 1, key: "short" }),
    "RESTORE_REHEARSAL_SAMPLE_KEY_INVALID");
});
