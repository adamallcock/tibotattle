import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DESCRIPTION_PATTERN,
  assessBackupRuns,
  formatOnDemandDescription,
  onDemandExpiresOn,
} from "../cloud-run/ops-backup-horizon.mjs";
import {
  AUDIT_EXIT_CODES,
  BACKUP_ON_DEMAND_RECEIPT_SCHEMA,
  BACKUP_PRUNE_JOURNAL_SCHEMA,
  INSTANCE_PATTERN,
  PRUNE_MAX_DELETIONS_PER_RUN,
  createOnDemandBackup,
  isTestTargetValue,
  main,
  parseBackupHorizonArgs,
  runBackupHorizonAudit,
  validateCreateOnDemandRequest,
  pruneOnDemandBackups,
  readBackupHorizonReceiptFile,
} from "./gcp-backup-horizon.mjs";
import { GCP_PRIVATE_TEST_TARGET } from "./gcp-test-project.mjs";

import STAGING_DESIRED_STATE from "../cloud-run/infra/staging.desired-state.json" with { type: "json" };
import PRODUCTION_DESIRED_STATE from "../cloud-run/infra/production.desired-state.json" with { type: "json" };

const SCRIPTS_ROOT = dirname(fileURLToPath(import.meta.url));

// Synthetic, content-free identifiers; none of them names a real resource.
const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1_000;
const HOUR = 60 * 60 * 1_000;
const PROJECT = "synthetic-horizon-prod";
const REGION = "us-east1";
const PRIMARY = "synthetic-primary-a";
// A second instance name, only to show that a ledger instance or role is refused.
const LEDGER = "synthetic-ledger-a";
const TEST_PRIMARY = GCP_PRIVATE_TEST_TARGET.primaryInstanceConnectionName.split(":").at(-1);
const TEST_LEDGER = GCP_PRIVATE_TEST_TARGET.retiredLedgerInstanceConnectionName.split(":").at(-1);

function describeInstance(name, config = {}) {
  return {
    kind: "sql#instance",
    name,
    project: PROJECT,
    region: REGION,
    settings: {
      kind: "sql#settings",
      backupConfiguration: {
        kind: "sql#backupConfiguration",
        enabled: true,
        startTime: "07:00",
        location: REGION,
        pointInTimeRecoveryEnabled: true,
        transactionLogRetentionDays: 7,
        backupRetentionSettings: { retentionUnit: "COUNT", retainedBackups: 30 },
        ...config,
      },
      finalBackupConfig: { enabled: true, retentionDays: 30 },
    },
  };
}

let nextId = 1_790_100_000_000;

function backupRun(instance, {
  ageMs,
  type = "AUTOMATED",
  status = "SUCCESSFUL",
  description,
  location = REGION,
  nowMs = NOW,
}) {
  nextId += 1;
  const start = new Date(nowMs - ageMs).toISOString();
  return {
    kind: "sql#backupRun",
    id: String(nextId),
    instance,
    type,
    status,
    location,
    windowStartTime: start,
    enqueuedTime: start,
    ...(description === undefined ? {} : { description }),
  };
}

function labelledOnDemand(instance, { ageDays, expiresInDays, purpose = "pre-migration", status }) {
  const ageMs = ageDays * DAY;
  return backupRun(instance, {
    type: "ON_DEMAND",
    ageMs,
    status,
    description: formatOnDemandDescription({ expiresOn: onDemandExpiresOn(NOW - ageMs, expiresInDays), purpose }),
  });
}

function automatedSeries(instance, newestAgeMs = 10 * HOUR) {
  return Array.from({ length: 30 }, (_, index) => backupRun(instance, { ageMs: newestAgeMs + index * DAY }));
}

function dueOnDemand(instance, ageDays) {
  const ageMs = ageDays * DAY;
  return backupRun(instance, {
    type: "ON_DEMAND",
    ageMs,
    description: formatOnDemandDescription({
      expiresOn: onDemandExpiresOn(NOW - ageMs, Math.max(1, ageDays - 5)),
      purpose: "pre-migration",
    }),
  });
}

/**
 * A fake gcloud over mutable per-instance backup lists. It records every
 * call and never touches the network.
 */
function fakeGcloud({ describes = {}, lists = {}, failWhen = () => false, onCreate, onDelete } = {}) {
  const state = new Map(Object.entries(lists).map(([name, runs]) => [name, structuredClone(runs)]));
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    if (failWhen(args)) {
      return { status: 1, stdout: "", stderr: "ERROR: MARKER-7d1e secret-looking gcloud detail" };
    }
    const flag = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
    const verb = args.slice(0, 3).join(" ");
    if (verb === "sql instances describe") {
      return { status: 0, stdout: JSON.stringify(describes[args[3]] ?? null), stderr: "" };
    }
    if (verb === "sql backups list") {
      return { status: 0, stdout: JSON.stringify(state.get(flag("--instance")) ?? []), stderr: "" };
    }
    if (verb === "sql backups create") {
      const instance = flag("--instance");
      // Without --location gcloud stores the copy in the closest multi-region.
      const request = { instance, description: flag("--description"), location: flag("--location") ?? "us" };
      const created = onCreate
        ? onCreate(request)
        : [backupRun(instance, { type: "ON_DEMAND", ageMs: 0, ...request })];
      state.set(instance, [...(state.get(instance) ?? []), ...created]);
      return { status: 0, stdout: "", stderr: "Backing up Cloud SQL instance...done." };
    }
    if (verb === "sql backups delete") {
      const instance = flag("--instance");
      onDelete?.(args[3]);
      state.set(instance, (state.get(instance) ?? []).filter((run) => run.id !== args[3]));
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 2, stdout: "", stderr: "unexpected" };
  };
  return { spawn, calls, state };
}

function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdout: (text) => { out.push(text); },
    stderr: (text) => { err.push(text); },
  };
}

function auditArgv(extra = []) {
  return [
    "audit",
    "--environment=production",
    `--project=${PROJECT}`,
    `--primary-instance=${PRIMARY}`,
    `--region=${REGION}`,
    ...extra,
  ];
}

function createArgv({ days = "30", purpose = "pre-migration", role = "primary", authorize, extra = [] } = {}) {
  return [
    "create-on-demand",
    "--environment=production",
    `--project=${PROJECT}`,
    `--instance=${role === "primary" ? PRIMARY : LEDGER}`,
    `--instance-role=${role}`,
    `--purpose=${purpose}`,
    `--expires-in-days=${days}`,
    `--region=${REGION}`,
    `--authorize=${authorize ?? `create-on-demand:production:${role}`}`,
    ...extra,
  ];
}

function createRequest(overrides = {}) {
  return {
    environment: "production",
    project: PROJECT,
    instance: PRIMARY,
    instanceRole: "primary",
    purpose: "pre-migration",
    expiresInDays: 30,
    region: REGION,
    ...overrides,
  };
}

function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function redigest(receipt) {
  const { digest: _ignored, ...body } = receipt;
  return { ...receipt, digest: createHash("sha256").update(sortedJson(body)).digest("hex") };
}

function auditReceipt({
  primaryRuns,
  nowMs = NOW,
  project = PROJECT,
  primary = PRIMARY,
}) {
  return JSON.parse(JSON.stringify(assessBackupRuns({
    environment: "production",
    nowMs,
    project,
    region: REGION,
    instances: [
      { role: "primary", instance: primary, settings: describeInstance(primary), backupRuns: primaryRuns },
    ],
  })));
}

function pruneArgv(digest, environment = "production") {
  return ["prune", `--environment=${environment}`, "--receipt=/synthetic/receipt.json", `--authorize=${digest}`];
}

function deleteCalls(calls) {
  return calls.filter(({ args }) => args.slice(0, 3).join(" ") === "sql backups delete");
}

function assertNoShell(calls) {
  for (const { command, args, options } of calls) {
    assert.equal(command, "gcloud");
    assert.equal(Array.isArray(args), true);
    assert.equal(args.every((arg) => typeof arg === "string"), true);
    assert.equal(options.shell, undefined);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(options.windowsHide, true);
  }
}

function errorCode(err) {
  assert.equal(err.length, 1);
  const parsed = JSON.parse(err[0]);
  assert.deepEqual(Object.keys(parsed).sort(), ["code", "status"]);
  return parsed.code;
}

test("INSTANCE_PATTERN matches the reviewed gcp-test-database literal", async () => {
  const source = await readFile(join(SCRIPTS_ROOT, "gcp-test-database.mjs"), "utf8");
  const literals = [...source.matchAll(/^const INSTANCE_PATTERN = \/(.+)\/([a-z]*);$/gmu)];
  assert.equal(literals.length, 1);
  assert.equal(literals[0][1], INSTANCE_PATTERN.source);
  assert.equal(literals[0][2], INSTANCE_PATTERN.flags);
});

test("argument parsing is closed and always refuses test-estate targets", () => {
  assert.deepEqual(parseBackupHorizonArgs(auditArgv()), {
    command: "audit",
    environment: "production",
    project: PROJECT,
    primaryInstance: PRIMARY,
    region: REGION,
  });
  const cases = [
    [["verify"], "BACKUP_HORIZON_COMMAND_INVALID"],
    [auditArgv(["--async=true"]), "BACKUP_HORIZON_ARGUMENT_INVALID"],
    [auditArgv([`--region=${REGION}`]), "BACKUP_HORIZON_ARGUMENT_INVALID"],
    [auditArgv(["--project"]), "BACKUP_HORIZON_ARGUMENT_INVALID"],
    [auditArgv().filter((arg) => !arg.startsWith("--primary-instance")), "BACKUP_HORIZON_ARGUMENT_MISSING"],
    // One instance, no deletion ledger: a ledger instance is an unknown flag.
    [auditArgv([`--ledger-instance=${LEDGER}`]), "BACKUP_HORIZON_ARGUMENT_INVALID"],
    [auditArgv().map((arg) => (arg === "--environment=production" ? "--environment=test" : arg)),
      "BACKUP_HORIZON_ENVIRONMENT_INVALID"],
    [auditArgv().map((arg) => (arg.startsWith("--primary") ? "--primary-instance=-rf" : arg)),
      "BACKUP_HORIZON_INSTANCE_INVALID"],
    [auditArgv().map((arg) => (arg.startsWith("--primary") ? `--primary-instance=${PROJECT}:${REGION}:x` : arg)),
      "BACKUP_HORIZON_INSTANCE_INVALID"],
    [auditArgv().map((arg) => (arg.startsWith("--primary") ? "--primary-instance=Upper" : arg)),
      "BACKUP_HORIZON_INSTANCE_INVALID"],
    [auditArgv().map((arg) => (arg.startsWith("--project") ? "--project=x;y" : arg)),
      "BACKUP_HORIZON_PROJECT_INVALID"],
    [auditArgv().map((arg) => (arg.startsWith("--region") ? "--region=us" : arg)),
      "BACKUP_HORIZON_REGION_INVALID"],
  ];
  for (const [argv, code] of cases) {
    assert.throws(() => parseBackupHorizonArgs(argv), (error) => error.code === code, argv.join(" "));
  }
  for (const value of [
    GCP_PRIVATE_TEST_TARGET.project,
    GCP_PRIVATE_TEST_TARGET.service,
    GCP_PRIVATE_TEST_TARGET.primaryDatabase,
    TEST_PRIMARY,
    TEST_LEDGER,
  ]) {
    assert.equal(isTestTargetValue(value), true, value);
    for (const flag of ["--project", "--primary-instance"]) {
      assert.throws(
        () => parseBackupHorizonArgs(auditArgv().map((arg) => (arg.startsWith(`${flag}=`) ? `${flag}=${value}` : arg))),
        (error) => error.code === "BACKUP_HORIZON_TEST_TARGET_REFUSED",
        `${flag}=${value}`,
      );
    }
  }
  // Region is a location, not a target identity; the fixed test target region stays usable.
  assert.equal(parseBackupHorizonArgs(auditArgv()).region, GCP_PRIVATE_TEST_TARGET.region);
});

test("audit reads only describe and list, and exits by verdict", async () => {
  const scenarios = [
    { name: "ok", primaryRuns: automatedSeries(PRIMARY), config: {}, verdict: "ok" },
    { name: "warn", primaryRuns: automatedSeries(PRIMARY, 40 * HOUR), config: {}, verdict: "warn" },
    {
      name: "breach",
      primaryRuns: automatedSeries(PRIMARY),
      config: { backupRetentionSettings: { retentionUnit: "COUNT", retainedBackups: 31 } },
      verdict: "breach",
    },
    {
      name: "breach by age",
      primaryRuns: [...automatedSeries(PRIMARY), backupRun(PRIMARY, { ageMs: 366 * DAY })],
      config: {},
      verdict: "breach",
    },
  ];
  for (const scenario of scenarios) {
    const gcloud = fakeGcloud({
      describes: { [PRIMARY]: describeInstance(PRIMARY, scenario.config) },
      lists: { [PRIMARY]: scenario.primaryRuns },
    });
    const io = capture();
    const exitCode = await main(auditArgv(), { spawn: gcloud.spawn, now: () => NOW, ...io });
    assert.equal(exitCode, AUDIT_EXIT_CODES[scenario.verdict], scenario.name);
    assert.deepEqual(io.err, []);
    const receipt = JSON.parse(io.out.join(""));
    assert.equal(receipt.verdict, scenario.verdict);
    assert.equal(receipt.project, PROJECT);
    assert.equal(receipt.roles.primary.instance, PRIMARY);
    assert.deepEqual(gcloud.calls.map(({ args }) => args), [
      ["sql", "instances", "describe", PRIMARY, `--project=${PROJECT}`, "--format=json"],
      ["sql", "backups", "list", `--instance=${PRIMARY}`, `--project=${PROJECT}`, "--format=json"],
    ]);
    assert.deepEqual(Object.keys(receipt.roles), ["primary"]);
    assertNoShell(gcloud.calls);
  }
  assert.deepEqual(AUDIT_EXIT_CODES, { ok: 0, warn: 2, breach: 3 });
});

test("audit refuses a test-target instance before any gcloud call", async () => {
  for (const argv of [
    auditArgv().map((arg) => (arg.startsWith("--primary") ? `--primary-instance=${TEST_PRIMARY}` : arg)),
    // The test estate's ledger instance is still a test target.
    auditArgv().map((arg) => (arg.startsWith("--primary") ? `--primary-instance=${TEST_LEDGER}` : arg)),
    auditArgv().map((arg) => (arg.startsWith("--project") ? `--project=${GCP_PRIVATE_TEST_TARGET.project}` : arg)),
  ]) {
    const gcloud = fakeGcloud();
    const io = capture();
    assert.equal(await main(argv, { spawn: gcloud.spawn, now: () => NOW, ...io }), 1);
    assert.equal(errorCode(io.err), "BACKUP_HORIZON_TEST_TARGET_REFUSED");
    assert.equal(gcloud.calls.length, 0);
    assert.deepEqual(io.out, []);
  }
});

test("gcloud failures become named codes that never echo gcloud output", async () => {
  for (const [verb, code] of [
    ["sql instances describe", "BACKUP_HORIZON_DESCRIBE_FAILED"],
    ["sql backups list", "BACKUP_HORIZON_LIST_FAILED"],
  ]) {
    const gcloud = fakeGcloud({
      describes: { [PRIMARY]: describeInstance(PRIMARY) },
      lists: { [PRIMARY]: automatedSeries(PRIMARY) },
      failWhen: (args) => args.slice(0, 3).join(" ") === verb,
    });
    const io = capture();
    assert.equal(await main(auditArgv(), { spawn: gcloud.spawn, now: () => NOW, ...io }), 1);
    assert.equal(errorCode(io.err), code);
    assert.equal([...io.out, ...io.err].join("").includes("MARKER-7d1e"), false);
  }
  const thrown = capture();
  assert.equal(await main(auditArgv(), {
    spawn: () => { throw Object.assign(new Error("spawn ENOENT MARKER-7d1e"), { code: "ENOENT" }); },
    now: () => NOW,
    ...thrown,
  }), 1);
  assert.equal(errorCode(thrown.err), "BACKUP_HORIZON_DESCRIBE_FAILED");
  const garbled = capture();
  assert.equal(await main(auditArgv(), {
    spawn: () => ({ status: 0, stdout: "not json MARKER-7d1e", stderr: "" }),
    now: () => NOW,
    ...garbled,
  }), 1);
  assert.equal(errorCode(garbled.err), "BACKUP_HORIZON_DESCRIBE_INVALID");
  assert.equal(garbled.err.join("").includes("MARKER-7d1e"), false);
});

test("create-on-demand refuses bad requests before any gcloud call", async () => {
  for (const [argv, code] of [
    [createArgv({ days: "91" }), "BACKUP_ON_DEMAND_EXPIRY_INVALID"],
    [createArgv({ days: "0" }), "BACKUP_ON_DEMAND_EXPIRY_INVALID"],
    [createArgv({ days: "30.5" }), "BACKUP_ON_DEMAND_EXPIRY_INVALID"],
    [createArgv({ purpose: "manual" }), "BACKUP_ON_DEMAND_PURPOSE_INVALID"],
    [createArgv({ purpose: "pre-migration;purpose=rehearsal" }), "BACKUP_ON_DEMAND_PURPOSE_INVALID"],
    [createArgv({ authorize: "create-on-demand:production:ledger" }), "BACKUP_ON_DEMAND_AUTHORIZATION_MISMATCH"],
    // There is no ledger role to back up.
    [createArgv({ role: "ledger" }), "BACKUP_HORIZON_ROLE_INVALID"],
    [createArgv({ authorize: "create-on-demand:staging:primary" }), "BACKUP_ON_DEMAND_AUTHORIZATION_MISMATCH"],
    [createArgv({ extra: ["--async=true"] }), "BACKUP_HORIZON_ARGUMENT_INVALID"],
    [createArgv().map((arg) => (arg.startsWith("--instance=") ? `--instance=${TEST_PRIMARY}` : arg)),
      "BACKUP_HORIZON_TEST_TARGET_REFUSED"],
    [createArgv().map((arg) => (arg.startsWith("--project=") ? `--project=${GCP_PRIVATE_TEST_TARGET.project}` : arg)),
      "BACKUP_HORIZON_TEST_TARGET_REFUSED"],
    // Without a region the copy would land in the default multi-region.
    [createArgv().filter((arg) => !arg.startsWith("--region=")), "BACKUP_HORIZON_ARGUMENT_MISSING"],
    [createArgv().map((arg) => (arg.startsWith("--region=") ? "--region=us" : arg)), "BACKUP_HORIZON_REGION_INVALID"],
  ]) {
    const gcloud = fakeGcloud();
    const io = capture();
    assert.equal(await main(argv, { spawn: gcloud.spawn, now: () => NOW, ...io }), 1, argv.join(" "));
    assert.equal(errorCode(io.err), code, argv.join(" "));
    assert.equal(gcloud.calls.length, 0);
  }
  for (const [overrides, code] of [
    [{ expiresInDays: 91 }, "BACKUP_ON_DEMAND_EXPIRY_INVALID"],
    [{ instance: LEDGER, instanceRole: "ledger" }, "BACKUP_HORIZON_ROLE_INVALID"],
    [{ region: undefined }, "BACKUP_HORIZON_REGION_INVALID"],
    [{ region: null }, "BACKUP_HORIZON_REGION_INVALID"],
  ]) {
    const gcloud = fakeGcloud();
    assert.throws(() => createOnDemandBackup({ spawn: gcloud.spawn, now: () => NOW }, createRequest(overrides)),
      (error) => error.code === code, JSON.stringify(overrides));
    assert.equal(gcloud.calls.length, 0);
  }
});

test("create-on-demand labels synchronously and reads the new backup back", async () => {
  const gcloud = fakeGcloud({ lists: { [PRIMARY]: automatedSeries(PRIMARY) } });
  const io = capture();
  assert.equal(await main(createArgv({ days: "90" }), { spawn: gcloud.spawn, now: () => NOW, ...io }), 0);
  assert.deepEqual(io.err, []);
  const description = "tibotattle-expires-on=2026-12-25;purpose=pre-migration";
  assert.deepEqual(gcloud.calls.map(({ args }) => args), [
    ["sql", "backups", "list", `--instance=${PRIMARY}`, `--project=${PROJECT}`, "--format=json"],
    ["sql", "backups", "create", `--instance=${PRIMARY}`, `--project=${PROJECT}`, `--description=${description}`,
      `--location=${REGION}`],
    ["sql", "backups", "list", `--instance=${PRIMARY}`, `--project=${PROJECT}`, "--format=json"],
  ]);
  assert.match(description, DESCRIPTION_PATTERN);
  assert.equal(gcloud.calls.some(({ args }) => args.some((arg) => arg.startsWith("--async"))), false);
  assertNoShell(gcloud.calls);
  const receipt = JSON.parse(io.out.join(""));
  const created = gcloud.state.get(PRIMARY).at(-1);
  assert.deepEqual(receipt, {
    schema: BACKUP_ON_DEMAND_RECEIPT_SCHEMA,
    environment: "production",
    project: PROJECT,
    instance: PRIMARY,
    role: "primary",
    purpose: "pre-migration",
    expiresOn: "2026-12-25",
    id: created.id,
    windowStartTime: created.windowStartTime,
    outcome: "created",
  });

  const STAGING_PRIMARY = STAGING_DESIRED_STATE.cloudSql.instance;
  const located = fakeGcloud({ lists: { [STAGING_PRIMARY]: [] } });
  const stagingReceipt = createOnDemandBackup({ spawn: located.spawn, now: () => NOW }, {
    environment: "staging",
    project: STAGING_DESIRED_STATE.project,
    instance: STAGING_PRIMARY,
    instanceRole: "primary",
    purpose: "pre-restore",
    expiresInDays: 7,
    region: REGION,
  });
  assert.equal(stagingReceipt.expiresOn, "2026-10-03");
  assert.equal(stagingReceipt.role, "primary");
  assert.deepEqual(located.calls[1].args, [
    "sql", "backups", "create", `--instance=${STAGING_PRIMARY}`, `--project=${STAGING_DESIRED_STATE.project}`,
    "--description=tibotattle-expires-on=2026-10-03;purpose=pre-restore", `--location=${REGION}`,
  ]);
  assert.equal(Object.isFrozen(stagingReceipt), true);
});

test("create-on-demand fails closed when the readback is missing, ambiguous or not successful", async () => {
  for (const [onCreate, code] of [
    [() => [], "BACKUP_ON_DEMAND_READBACK_MISSING"],
    [({ instance, description }) => [
      backupRun(instance, { type: "ON_DEMAND", ageMs: 0, description }),
      backupRun(instance, { type: "ON_DEMAND", ageMs: 0, description }),
    ], "BACKUP_ON_DEMAND_READBACK_AMBIGUOUS"],
    [({ instance, description }) => [
      backupRun(instance, { type: "ON_DEMAND", ageMs: 0, description, status: "FAILED" }),
    ], "BACKUP_ON_DEMAND_READBACK_INVALID"],
    [({ instance, description }) => [
      backupRun(instance, { type: "ON_DEMAND", ageMs: 0, description, location: "us" }),
    ], "BACKUP_ON_DEMAND_READBACK_INVALID"],
    [({ instance, description }) => {
      const { location: _dropped, ...run } = backupRun(instance, { type: "ON_DEMAND", ageMs: 0, description });
      return [run];
    }, "BACKUP_ON_DEMAND_READBACK_INVALID"],
  ]) {
    const gcloud = fakeGcloud({ lists: { [PRIMARY]: [] }, onCreate });
    const io = capture();
    assert.equal(await main(createArgv(), { spawn: gcloud.spawn, now: () => NOW, ...io }), 1);
    assert.equal(errorCode(io.err), code);
  }

  // A same-day retry carries the same description as an earlier backup: only a new id is proof.
  const description = "tibotattle-expires-on=2026-10-26;purpose=pre-migration";
  const earlier = backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: 3 * HOUR, description });
  const retryNothing = fakeGcloud({ lists: { [PRIMARY]: [...automatedSeries(PRIMARY), earlier] }, onCreate: () => [] });
  const nothing = capture();
  assert.equal(await main(createArgv(), { spawn: retryNothing.spawn, now: () => NOW, ...nothing }), 1);
  assert.equal(errorCode(nothing.err), "BACKUP_ON_DEMAND_READBACK_MISSING");
  assert.equal(retryNothing.calls[1].args.includes(`--description=${description}`), true);
  const retryAdded = fakeGcloud({ lists: { [PRIMARY]: [...automatedSeries(PRIMARY), earlier] } });
  const added = capture();
  assert.equal(await main(createArgv(), { spawn: retryAdded.spawn, now: () => NOW, ...added }), 0);
  const fresh = retryAdded.state.get(PRIMARY).at(-1);
  assert.notEqual(fresh.id, earlier.id);
  assert.equal(JSON.parse(added.out.join("")).id, fresh.id);
  assert.equal(JSON.parse(added.out.join("")).windowStartTime, new Date(NOW).toISOString());
  const failing = fakeGcloud({ failWhen: (args) => args[2] === "create" });
  const io = capture();
  assert.equal(await main(createArgv(), { spawn: failing.spawn, now: () => NOW, ...io }), 1);
  assert.equal(errorCode(io.err), "BACKUP_ON_DEMAND_CREATE_FAILED");
  assert.equal(io.err.join("").includes("MARKER-7d1e"), false);
});

test("prune refuses a mismatched authorization, a stale receipt and another environment with no gcloud call", async () => {
  const primaryRuns = [...automatedSeries(PRIMARY), dueOnDemand(PRIMARY, 20)];
  const receipt = auditReceipt({ primaryRuns });
  for (const [argv, now, code] of [
    [pruneArgv("f".repeat(64)), NOW, "PRUNE_AUTHORIZATION_MISMATCH"],
    [pruneArgv(receipt.digest), NOW + 24 * HOUR, "PRUNE_RECEIPT_STALE"],
    [pruneArgv(receipt.digest), NOW - HOUR, "PRUNE_RECEIPT_STALE"],
    [pruneArgv(receipt.digest, "staging"), NOW, "PRUNE_ENVIRONMENT_MISMATCH"],
  ]) {
    const gcloud = fakeGcloud({ lists: { [PRIMARY]: primaryRuns } });
    const io = capture();
    const exitCode = await main(argv, {
      spawn: gcloud.spawn,
      now: () => now,
      readReceipt: async () => structuredClone(receipt),
      ...io,
    });
    assert.equal(exitCode, 1);
    assert.equal(errorCode(io.err), code);
    assert.equal(gcloud.calls.length, 0);
    assert.equal(deleteCalls(gcloud.calls).length, 0);
  }
  const tampered = { ...structuredClone(receipt), verdict: "ok" };
  const gcloud = fakeGcloud();
  const io = capture();
  assert.equal(await main(pruneArgv(receipt.digest), {
    spawn: gcloud.spawn, now: () => NOW, readReceipt: async () => tampered, ...io,
  }), 1);
  assert.equal(errorCode(io.err), "BACKUP_HORIZON_RECEIPT_INVALID");
  assert.equal(gcloud.calls.length, 0);
});

test("prune aborts before any deletion when a live target changed or is AUTOMATED", async () => {
  const onDemand = [dueOnDemand(PRIMARY, 20), dueOnDemand(PRIMARY, 30), dueOnDemand(PRIMARY, 40)];
  const primaryRuns = [...automatedSeries(PRIMARY), ...onDemand];
  const receipt = auditReceipt({ primaryRuns });
  assert.equal(receipt.roles.primary.onDemand.filter(({ status }) => status === "due").length, 3);

  const shifted = primaryRuns.map((run) => (run.id === onDemand[1].id
    ? { ...run, windowStartTime: new Date(Date.parse(run.windowStartTime) + 1_000).toISOString() }
    : run));
  const removed = primaryRuns.filter((run) => run.id !== onDemand[2].id);
  const relabelled = primaryRuns.map((run) => (run.id === onDemand[0].id
    ? { ...run, description: "tibotattle-expires-on=2027-01-01;purpose=pre-cutover" }
    : run));
  for (const [name, live] of [["shifted window", shifted], ["already gone", removed], ["relabelled", relabelled]]) {
    const gcloud = fakeGcloud({ lists: { [PRIMARY]: live } });
    const io = capture();
    const exitCode = await main(pruneArgv(receipt.digest), {
      spawn: gcloud.spawn, now: () => NOW + HOUR, readReceipt: async () => structuredClone(receipt), ...io,
    });
    assert.equal(exitCode, 1, name);
    assert.equal(errorCode(io.err), "PRUNE_TARGET_MISMATCH", name);
    assert.equal(deleteCalls(gcloud.calls).length, 0, name);
    assert.deepEqual(io.out, [], name);
  }

  // A doctored (re-digested) receipt that lists an AUTOMATED backup as a due on-demand entry.
  const automated = primaryRuns[5];
  const doctored = redigest({
    ...receipt,
    roles: {
      ...receipt.roles,
      primary: {
        ...receipt.roles.primary,
        onDemand: [
          {
            id: automated.id,
            windowStartTime: automated.windowStartTime,
            ageDays: 5,
            expiresOn: "2026-09-01",
            purpose: "pre-migration",
            status: "due",
          },
          ...receipt.roles.primary.onDemand,
        ],
      },
    },
  });
  const gcloud = fakeGcloud({ lists: { [PRIMARY]: primaryRuns } });
  const io = capture();
  assert.equal(await main(pruneArgv(doctored.digest), {
    spawn: gcloud.spawn, now: () => NOW, readReceipt: async () => doctored, ...io,
  }), 1);
  assert.equal(errorCode(io.err), "PRUNE_TARGET_MISMATCH");
  assert.equal(deleteCalls(gcloud.calls).length, 0);
});

test("prune deletes at most ten due entries per run, oldest first, and journals each", async () => {
  const due = Array.from({ length: 12 }, (_, index) => dueOnDemand(PRIMARY, 20 + index));
  const keep = [
    backupRun(PRIMARY, {
      type: "ON_DEMAND",
      ageMs: 2 * DAY,
      description: formatOnDemandDescription({ expiresOn: onDemandExpiresOn(NOW - 2 * DAY, 30), purpose: "rehearsal" }),
    }),
    backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: 3 * DAY, description: "unlabelled" }),
  ];
  const primaryRuns = [...automatedSeries(PRIMARY), ...due, ...keep];
  const receipt = auditReceipt({ primaryRuns });
  assert.equal(receipt.roles.primary.onDemand.length, 14);
  const gcloud = fakeGcloud({ lists: { [PRIMARY]: primaryRuns } });
  const io = capture();
  const exitCode = await main(pruneArgv(receipt.digest), {
    spawn: gcloud.spawn, now: () => NOW + 2 * HOUR, readReceipt: async () => structuredClone(receipt), ...io,
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(io.err, []);
  assertNoShell(gcloud.calls);
  const deletes = deleteCalls(gcloud.calls);
  assert.equal(PRUNE_MAX_DELETIONS_PER_RUN, 10);
  assert.equal(deletes.length, 10);
  const oldestFirst = [...due].reverse().slice(0, 10);
  assert.deepEqual(deletes.map(({ args }) => args), oldestFirst.map((run) => [
    "sql", "backups", "delete", run.id, `--instance=${PRIMARY}`, `--project=${PROJECT}`, "--quiet",
  ]));
  // Only list and delete, and only the one instance.
  assert.deepEqual(gcloud.calls.filter(({ args }) => args[2] !== "delete").map(({ args }) => args), [
    ["sql", "backups", "list", `--instance=${PRIMARY}`, `--project=${PROJECT}`, "--format=json"],
  ]);
  const lines = io.out.join("").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 11);
  assert.deepEqual(lines.slice(0, 10).map((line) => Object.keys(line).sort()),
    Array(10).fill(["ageDays", "event", "id", "outcome", "role", "schema"]));
  assert.deepEqual(lines.slice(0, 10).map(({ id, ageDays, outcome, schema, role }) => ({ id, ageDays, outcome, schema, role })),
    oldestFirst.map((run, index) => ({
      id: run.id,
      ageDays: 31 - index,
      outcome: "deleted",
      schema: BACKUP_PRUNE_JOURNAL_SCHEMA,
      role: "primary",
    })));
  assert.deepEqual(lines[10], {
    schema: BACKUP_PRUNE_JOURNAL_SCHEMA,
    event: "summary",
    environment: "production",
    receiptDigest: receipt.digest,
    candidates: 12,
    deleted: 10,
    deferred: 2,
  });
  const remaining = new Set(gcloud.state.get(PRIMARY).map((run) => run.id));
  for (const run of [...keep, due[0], due[1]]) {
    assert.equal(remaining.has(run.id), true);
  }
  assert.equal(gcloud.state.get(PRIMARY).filter((run) => run.type === "AUTOMATED").length, 30);
});

test("prune stops at the first failed deletion and journals it", async () => {
  const due = Array.from({ length: 3 }, (_, index) => dueOnDemand(PRIMARY, 20 + index));
  const primaryRuns = [...automatedSeries(PRIMARY), ...due];
  const receipt = auditReceipt({ primaryRuns });
  const gcloud = fakeGcloud({
    lists: { [PRIMARY]: primaryRuns },
    failWhen: (args) => args[2] === "delete" && args[3] === due[1].id,
  });
  const io = capture();
  assert.equal(await main(pruneArgv(receipt.digest), {
    spawn: gcloud.spawn, now: () => NOW, readReceipt: async () => structuredClone(receipt), ...io,
  }), 1);
  assert.equal(errorCode(io.err), "PRUNE_DELETE_FAILED");
  assert.deepEqual(deleteCalls(gcloud.calls).map(({ args }) => args[3]), [due[2].id, due[1].id]);
  const lines = io.out.join("").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map(({ id, outcome }) => [id, outcome]), [[due[2].id, "deleted"], [due[1].id, "failed"]]);
  assert.equal(io.out.join("").includes("MARKER-7d1e"), false);
});

test("prune with nothing due makes no gcloud call", async () => {
  const receipt = auditReceipt({ primaryRuns: automatedSeries(PRIMARY) });
  const gcloud = fakeGcloud();
  const io = capture();
  assert.equal(await main(pruneArgv(receipt.digest), {
    spawn: gcloud.spawn, now: () => NOW, readReceipt: async () => structuredClone(receipt), ...io,
  }), 0);
  assert.equal(gcloud.calls.length, 0);
  assert.equal(JSON.parse(io.out.join("")).deleted, 0);
});

test("prune refuses a verified receipt that names the test estate, before any gcloud call", async () => {
  const receipts = [
    auditReceipt({
      project: GCP_PRIVATE_TEST_TARGET.project,
      primaryRuns: [...automatedSeries(PRIMARY), dueOnDemand(PRIMARY, 20)],
    }),
    auditReceipt({
      primary: TEST_PRIMARY,
      primaryRuns: [...automatedSeries(TEST_PRIMARY), dueOnDemand(TEST_PRIMARY, 20)],
    }),
    auditReceipt({
      primary: TEST_LEDGER,
      primaryRuns: [...automatedSeries(TEST_LEDGER), dueOnDemand(TEST_LEDGER, 20)],
    }),
  ];
  for (const receipt of receipts) {
    // The receipt is well formed and digest-bound; only the test-target guard stops it.
    assert.equal(receipt.roles.primary.onDemand.filter(({ status }) => status === "due").length, 1);
    const gcloud = fakeGcloud({ lists: { [PRIMARY]: [], [TEST_PRIMARY]: [], [TEST_LEDGER]: [] } });
    const io = capture();
    assert.equal(await main(pruneArgv(receipt.digest), {
      spawn: gcloud.spawn, now: () => NOW, readReceipt: async () => structuredClone(receipt), ...io,
    }), 1);
    assert.equal(errorCode(io.err), "BACKUP_HORIZON_TEST_TARGET_REFUSED");
    assert.equal(gcloud.calls.length, 0);
  }
});

test("prune refuses a live list with a duplicated id before any deletion", async () => {
  const target = dueOnDemand(PRIMARY, 20);
  const primaryRuns = [...automatedSeries(PRIMARY), target];
  const receipt = auditReceipt({ primaryRuns });
  const gcloud = fakeGcloud({ lists: { [PRIMARY]: [...primaryRuns, { ...target }] } });
  const io = capture();
  assert.equal(await main(pruneArgv(receipt.digest), {
    spawn: gcloud.spawn, now: () => NOW, readReceipt: async () => structuredClone(receipt), ...io,
  }), 1);
  assert.equal(errorCode(io.err), "PRUNE_LIVE_LIST_UNRECOGNIZED");
  assert.equal(deleteCalls(gcloud.calls).length, 0);
});

test("prune never deletes a labelled backup the policy still keeps", async () => {
  const keep = [
    labelledOnDemand(PRIMARY, { ageDays: 60, expiresInDays: 90, purpose: "pre-restore" }),
    labelledOnDemand(PRIMARY, { ageDays: 29, expiresInDays: 30, purpose: "rehearsal" }),
    labelledOnDemand(PRIMARY, { ageDays: 90, expiresInDays: 90, purpose: "pre-cutover" }),
  ];
  const due = dueOnDemand(PRIMARY, 20);
  const primaryRuns = [...automatedSeries(PRIMARY), ...keep, due];
  const receipt = auditReceipt({ primaryRuns });
  assert.deepEqual(receipt.roles.primary.onDemand.map(({ status }) => status).sort(), ["due", "ok", "ok", "ok"]);
  const gcloud = fakeGcloud({ lists: { [PRIMARY]: primaryRuns } });
  const io = capture();
  assert.equal(await main(pruneArgv(receipt.digest), {
    spawn: gcloud.spawn, now: () => NOW, readReceipt: async () => structuredClone(receipt), ...io,
  }), 0);
  assert.deepEqual(deleteCalls(gcloud.calls).map(({ args }) => args[3]), [due.id]);
  const remaining = new Set(gcloud.state.get(PRIMARY).map((run) => run.id));
  for (const run of keep) assert.equal(remaining.has(run.id), true);
});

test("prune retries an overdue copy whose earlier deletion failed", async () => {
  const failed = labelledOnDemand(PRIMARY, { ageDays: 95, expiresInDays: 90, status: "DELETION_FAILED" });
  const primaryRuns = [...automatedSeries(PRIMARY), failed];
  const receipt = auditReceipt({ primaryRuns });
  assert.deepEqual(receipt.roles.primary.onDemand.map(({ id, status }) => [id, status]), [[failed.id, "overdue"]]);
  const gcloud = fakeGcloud({ lists: { [PRIMARY]: primaryRuns } });
  const io = capture();
  assert.equal(await main(pruneArgv(receipt.digest), {
    spawn: gcloud.spawn, now: () => NOW, readReceipt: async () => structuredClone(receipt), ...io,
  }), 0);
  assert.deepEqual(deleteCalls(gcloud.calls).map(({ args }) => args), [
    ["sql", "backups", "delete", failed.id, `--instance=${PRIMARY}`, `--project=${PROJECT}`, "--quiet"],
  ]);
});

test("prune authorizes nothing when the run evidence was unavailable", async () => {
  const primaryRuns = [...automatedSeries(PRIMARY), { ...dueOnDemand(PRIMARY, 20), expiryTime: "2027-01-01T00:00:00Z" }];
  const receipt = auditReceipt({ primaryRuns });
  assert.equal(receipt.roles.primary.onDemand, null);
  const gcloud = fakeGcloud({ lists: { [PRIMARY]: primaryRuns } });
  const io = capture();
  assert.equal(await main(pruneArgv(receipt.digest), {
    spawn: gcloud.spawn, now: () => NOW, readReceipt: async () => structuredClone(receipt), ...io,
  }), 0);
  assert.equal(gcloud.calls.length, 0);
  assert.equal(JSON.parse(io.out.join("")).deleted, 0);
});

test("prune refuses a receipt that names a ledger role, before any gcloud call", async () => {
  const primaryRuns = [...automatedSeries(PRIMARY), dueOnDemand(PRIMARY, 20)];
  const plain = auditReceipt({ primaryRuns });
  const withLedger = redigest({
    ...plain,
    roles: { ...plain.roles, ledger: { ...plain.roles.primary, instance: LEDGER } },
  });
  const v1 = redigest({ ...withLedger, schema: "tibotattle-backup-horizon-audit-v1" });
  for (const receipt of [withLedger, v1]) {
    const gcloud = fakeGcloud({ lists: { [PRIMARY]: primaryRuns, [LEDGER]: [] } });
    const io = capture();
    assert.equal(await main(pruneArgv(receipt.digest), {
      spawn: gcloud.spawn, now: () => NOW, readReceipt: async () => structuredClone(receipt), ...io,
    }), 1);
    assert.equal(errorCode(io.err), "BACKUP_HORIZON_RECEIPT_INVALID");
    assert.equal(gcloud.calls.length, 0);
  }
});

test("the CLI runs through a symlinked path and never exits 0 silently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gcp-backup-horizon-cli-"));
  try {
    const realPath = join(SCRIPTS_ROOT, "gcp-backup-horizon.mjs");
    const linkedPath = join(directory, "gcp-backup-horizon.mjs");
    await symlink(realPath, linkedPath);
    for (const entry of [realPath, linkedPath]) {
      // An invalid command fails in argument parsing, before any gcloud call.
      const result = spawnSync(process.execPath, [entry, "verify"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/nonexistent" },
      });
      assert.equal(result.status, 1, entry);
      assert.equal(result.stdout, "", entry);
      assert.deepEqual(JSON.parse(result.stderr), { status: "error", code: "BACKUP_HORIZON_COMMAND_INVALID" }, entry);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("receipt files are read bounded, without following links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gcp-backup-horizon-"));
  try {
    const receipt = auditReceipt({ primaryRuns: automatedSeries(PRIMARY) });
    const path = join(directory, "receipt.json");
    await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`);
    assert.deepEqual(await readBackupHorizonReceiptFile(path), receipt);
    const symlinked = join(directory, "link.json");
    await symlink(path, symlinked);
    await assert.rejects(readBackupHorizonReceiptFile(symlinked), (error) => error.code === "PRUNE_RECEIPT_UNREADABLE");
    // A hard link makes both names unreadable: neither can be proven the only name.
    const hardSource = join(directory, "hard-source.json");
    const hardLinked = join(directory, "hard-link.json");
    await writeFile(hardSource, `${JSON.stringify(receipt)}\n`);
    await link(hardSource, hardLinked);
    for (const name of [hardSource, hardLinked]) {
      await assert.rejects(readBackupHorizonReceiptFile(name), (error) => error.code === "PRUNE_RECEIPT_UNREADABLE");
    }
    const oversized = join(directory, "oversized.json");
    await writeFile(oversized, `${JSON.stringify(receipt)}${" ".repeat(1024 * 1024)}`);
    await assert.rejects(readBackupHorizonReceiptFile(oversized), (error) => error.code === "PRUNE_RECEIPT_UNREADABLE");
    const atLimit = join(directory, "at-limit.json");
    const compact = JSON.stringify(receipt);
    await writeFile(atLimit, `${compact}${" ".repeat(1024 * 1024 - Buffer.byteLength(compact))}`);
    assert.deepEqual(await readBackupHorizonReceiptFile(atLimit), receipt);
    await assert.rejects(readBackupHorizonReceiptFile(join(directory, "absent.json")),
      (error) => error.code === "PRUNE_RECEIPT_UNREADABLE");
    const garbled = join(directory, "garbled.json");
    await writeFile(garbled, "{not json");
    await assert.rejects(readBackupHorizonReceiptFile(garbled),
      (error) => error.code === "BACKUP_HORIZON_RECEIPT_INVALID");
    assert.throws(() => parseBackupHorizonArgs(["prune", "--environment=production",
      "--receipt=relative.json", `--authorize=${receipt.digest}`]),
    (error) => error.code === "PRUNE_RECEIPT_PATH_INVALID");
    assert.throws(() => parseBackupHorizonArgs(["prune", "--environment=production",
      `--receipt=${path}`, "--authorize=create-on-demand:production:primary"]),
    (error) => error.code === "PRUNE_AUTHORIZATION_INVALID");

    // End to end through the real file reader.
    const primaryRuns = [...automatedSeries(PRIMARY), dueOnDemand(PRIMARY, 25)];
    const dueReceipt = auditReceipt({ primaryRuns });
    const duePath = join(directory, "due.json");
    await writeFile(duePath, `${JSON.stringify(dueReceipt, null, 2)}\n`);
    const gcloud = fakeGcloud({ lists: { [PRIMARY]: primaryRuns } });
    const io = capture();
    assert.equal(await main(["prune", "--environment=production", `--receipt=${duePath}`,
      `--authorize=${dueReceipt.digest}`], { spawn: gcloud.spawn, now: () => NOW, ...io }), 0);
    assert.equal(deleteCalls(gcloud.calls).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("no gcloud argv is built through a shell", async () => {
  const source = await readFile(join(SCRIPTS_ROOT, "gcp-backup-horizon.mjs"), "utf8");
  assert.doesNotMatch(source, /\bexecSync\b|\bexec\(|\bexecFile|shell:\s*true|["'`](?:sh|bash|zsh)["'`]|\bspawn\(\s*["'`]gcloud ["'`]/u);
  assert.match(source, /spawn\("gcloud", args, \{/u);
  assert.doesNotMatch(source, /["'`]--async/u);
});

test("configured staging and production backup identities admit through CLI and direct audit", async () => {
  for (const desired of [STAGING_DESIRED_STATE, PRODUCTION_DESIRED_STATE]) {
    const environment = desired.environment, project = desired.project, instance = desired.cloudSql.instance;
    const argv = ["audit", `--environment=${environment}`, `--project=${project}`, `--primary-instance=${instance}`, `--region=${REGION}`];
    const config = parseBackupHorizonArgs(argv);
    const gcloud = fakeGcloud({ describes: { [instance]: { ...describeInstance(instance), project } }, lists: { [instance]: automatedSeries(instance) } });
    const receipt = runBackupHorizonAudit(config, { spawn: gcloud.spawn, now: () => NOW });
    assert.equal(receipt.project, project);
    assert.equal(receipt.roles.primary.instance, instance);
    assert.equal(gcloud.calls.length, 2);
    assert.equal(gcloud.calls.every(({ args }) => args.includes(`--project=${project}`)), true);
    assert.deepEqual(validateCreateOnDemandRequest(createRequest({ environment, project, instance })).instance, instance);
    // A valid empty-candidate receipt must remain admissible without provider calls.
    const empty = redigest({ ...auditReceipt({ primaryRuns: [] }), environment, project,
      roles: { primary: { ...auditReceipt({ primaryRuns: [] }).roles.primary, instance } } });
    const prune = fakeGcloud();
    await pruneOnDemandBackups({ environment, receiptPath: "/synthetic/receipt.json", authorize: empty.digest },
      { spawn: prune.spawn, now: () => NOW, readReceipt: async () => empty });
    assert.equal(prune.calls.length, 0);
  }
});

test("whole backup target identity refuses cross-plane and test-estate combinations at every boundary", async () => {
  const stageProject = STAGING_DESIRED_STATE.project, stageInstance = STAGING_DESIRED_STATE.cloudSql.instance;
  const prodProject = PRODUCTION_DESIRED_STATE.project, prodInstance = PRODUCTION_DESIRED_STATE.cloudSql.instance;
  const cases = [
    ["production", stageProject, stageInstance, "BACKUP_HORIZON_TEST_TARGET_REFUSED"],
    ["production", stageProject, prodInstance, "BACKUP_HORIZON_TEST_TARGET_REFUSED"],
    ["production", prodProject, stageInstance, "BACKUP_HORIZON_TARGET_MISMATCH"],
    ["staging", prodProject, prodInstance, "BACKUP_HORIZON_TARGET_MISMATCH"],
    ["staging", prodProject, stageInstance, "BACKUP_HORIZON_TARGET_MISMATCH"],
    ["staging", PROJECT, stageInstance, "BACKUP_HORIZON_TARGET_MISMATCH"],
    ["staging", stageProject, prodInstance, "BACKUP_HORIZON_TEST_TARGET_REFUSED"],
    ["staging", stageProject, "unlisted-primary", "BACKUP_HORIZON_TEST_TARGET_REFUSED"],
    ...["production", "staging"].flatMap(environment => [
      [environment, prodProject, TEST_PRIMARY, "BACKUP_HORIZON_TEST_TARGET_REFUSED"],
      [environment, prodProject, TEST_LEDGER, "BACKUP_HORIZON_TEST_TARGET_REFUSED"],
      [environment, prodProject, "tibotattle-test-primary-future", "BACKUP_HORIZON_TEST_TARGET_REFUSED"],
      [environment, "tibotattle-test-project-future", prodInstance, "BACKUP_HORIZON_TEST_TARGET_REFUSED"],
    ]),
  ];
  for (const [environment, project, instance, code] of cases) {
    const label = `${environment}/${project}/${instance}`;
    const gcloud = fakeGcloud();
    const config = { environment, project, primaryInstance: instance, region: REGION };
    const argv = ["audit", `--environment=${environment}`, `--project=${project}`, `--primary-instance=${instance}`];
    assert.throws(() => parseBackupHorizonArgs(argv), { code }, label);
    const createArgs = ["create-on-demand", `--environment=${environment}`, `--project=${project}`,
      `--instance=${instance}`, "--instance-role=primary", "--purpose=pre-migration",
      "--expires-in-days=7", `--region=${REGION}`, `--authorize=create-on-demand:${environment}:primary`];
    assert.throws(() => parseBackupHorizonArgs(createArgs), { code }, label);
    assert.throws(() => runBackupHorizonAudit(config, { spawn: gcloud.spawn, now: () => NOW }), { code }, label);
    const request = createRequest({ environment, project, instance });
    assert.throws(() => validateCreateOnDemandRequest(request), { code }, label);
    assert.throws(() => createOnDemandBackup({ spawn: gcloud.spawn, now: () => NOW }, request), { code }, label);
    const empty = auditReceipt({ primaryRuns: [] });
    const receipt = redigest({ ...empty, environment, project,
      roles: { primary: { ...empty.roles.primary, instance } } });
    await assert.rejects(pruneOnDemandBackups({ environment, receiptPath: "/synthetic/receipt.json", authorize: receipt.digest },
      { spawn: gcloud.spawn, now: () => NOW, readReceipt: async () => receipt }), { code }, label);
    assert.equal(gcloud.calls.length, 0, label);
  }
});
