import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AUTOMATED_RETAINED_BACKUPS,
  BACKUP_HORIZON_AUDIT_SCHEMA,
  BACKUP_HORIZON_CODES,
  BACKUP_HORIZON_CONSTANTS,
  BACKUP_HORIZON_COVERAGE,
  BACKUP_HORIZON_MAX_DAYS,
  DESCRIPTION_PATTERN,
  FINAL_BACKUP_MAX_DAYS,
  HORIZON_MARGIN_DAYS,
  LAST_AUTOMATED_SUCCESS_MAX_HOURS,
  ON_DEMAND_CRITICAL_DAYS,
  ON_DEMAND_MAX_DAYS,
  ON_DEMAND_PURPOSES,
  PITR_LOG_RETENTION_DAYS,
  RESTORE_SLACK_DAYS,
  RESTORE_SUPPRESSION_TOMBSTONE_DAYS,
  assertBackupHorizonInvariant,
  assessBackupRuns,
  classifyBackupRun,
  desiredBackupConfiguration,
  formatOnDemandDescription,
  onDemandExpiresOn,
  parseOnDemandDescription,
  verifyBackupHorizonReceipt,
} from "./ops-backup-horizon.mjs";

const CLOUD_RUN_ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(CLOUD_RUN_ROOT, "..");
const RETENTION_SOURCE = join(WORKER_ROOT, "src", "retention.ts");
const LEDGER_AUTHORITY_SOURCE = join(WORKER_ROOT, "src", "postgres-ledger-authority.ts");

// Synthetic, content-free identifiers; none of them names a real resource.
const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1_000;
const HOUR = 60 * 60 * 1_000;
const PROJECT = "synthetic-horizon-prod";
const REGION = "us-east1";
const PRIMARY = "synthetic-primary-a";
const LEDGER = "synthetic-ledger-a";

/** Shaped like `gcloud sql instances describe --format=json` for a compliant instance. */
function describeInstance(name, { config = {}, settings = {} } = {}) {
  return {
    kind: "sql#instance",
    name,
    project: PROJECT,
    region: REGION,
    databaseVersion: "POSTGRES_17",
    state: "RUNNABLE",
    settings: {
      kind: "sql#settings",
      tier: "db-custom-2-7680",
      deletionProtectionEnabled: true,
      backupConfiguration: {
        kind: "sql#backupConfiguration",
        enabled: true,
        startTime: "07:00",
        location: REGION,
        pointInTimeRecoveryEnabled: true,
        replicationLogArchivingEnabled: true,
        transactionLogRetentionDays: 7,
        transactionalLogStorageState: "CLOUD_STORAGE",
        backupTier: "STANDARD",
        backupRetentionSettings: { retentionUnit: "COUNT", retainedBackups: 30 },
        ...config,
      },
      finalBackupConfig: { enabled: true, retentionDays: 30 },
      ...settings,
    },
  };
}

let nextId = 1_790_000_000_000;

/** Shaped like one `gcloud sql backups list --instance=<name> --format=json` item. */
function backupRun(instance, { ageMs, type = "AUTOMATED", status = "SUCCESSFUL", description, extra = {} }) {
  nextId += 1;
  const start = new Date(NOW - ageMs).toISOString();
  return {
    kind: "sql#backupRun",
    id: String(nextId),
    instance,
    type,
    status,
    backupKind: "SNAPSHOT",
    location: REGION,
    enqueuedTime: start,
    startTime: start,
    endTime: new Date(NOW - ageMs + 5 * 60 * 1_000).toISOString(),
    windowStartTime: start,
    selfLink: `https://sqladmin.googleapis.com/sql/v1beta4/projects/${PROJECT}/instances/${instance}/backupRuns/${nextId}`,
    ...(description === undefined ? {} : { description }),
    ...extra,
  };
}

function automatedSeries(instance, { count = 30, newestAgeMs = 10 * HOUR } = {}) {
  return Array.from({ length: count }, (_, index) => backupRun(instance, { ageMs: newestAgeMs + index * DAY }));
}

function labelFor(ageMs, days, purpose = "pre-migration") {
  return formatOnDemandDescription({ expiresOn: onDemandExpiresOn(NOW - ageMs, days), purpose });
}

function input({ primary = {}, ledger = {}, region = REGION } = {}) {
  return {
    environment: "production",
    nowMs: NOW,
    project: PROJECT,
    region,
    instances: [
      {
        role: "primary",
        instance: PRIMARY,
        settings: primary.settings ?? describeInstance(PRIMARY),
        backupRuns: primary.backupRuns ?? automatedSeries(PRIMARY),
      },
      {
        role: "ledger",
        instance: LEDGER,
        settings: ledger.settings ?? describeInstance(LEDGER),
        backupRuns: ledger.backupRuns ?? automatedSeries(LEDGER),
      },
    ],
  };
}

function assertVerdict(receipt, verdict, codes) {
  assert.equal(receipt.verdict, verdict);
  assert.deepEqual([...receipt.codes], codes);
}

/** Independent canonical serialisation, so the digest check does not trust the module's own. */
function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])]));
  }
  return value;
}

/**
 * The two 400-day tombstone literals that restore replay depends on. Either
 * drifting away from RESTORE_SUPPRESSION_TOMBSTONE_DAYS breaks the horizon
 * arithmetic, so both are pinned here.
 */
async function assertTombstoneLiteralsPinned({ retentionPath, ledgerAuthorityPath }) {
  const retention = await readFile(retentionPath, "utf8");
  const ledgerAuthority = await readFile(ledgerAuthorityPath, "utf8");
  const days = String(RESTORE_SUPPRESSION_TOMBSTONE_DAYS);
  const dayLines = [...retention.matchAll(/^const DAY_MILLISECONDS = 24 \* 60 \* 60 \* 1_000;$/gmu)];
  const workerLines = [...retention.matchAll(
    /^export const DELETION_TOMBSTONE_RETENTION_MILLISECONDS = (\d+) \* DAY_MILLISECONDS;$/gmu,
  )];
  const ledgerLines = [...ledgerAuthority.matchAll(
    /^const TOMBSTONE_RETENTION_MILLISECONDS = (\d+) \* 24 \* 60 \* 60 \* 1_000;$/gmu,
  )];
  if (dayLines.length !== 1 || workerLines.length !== 1 || workerLines[0][1] !== days) {
    throw new Error("BACKUP_HORIZON_TOMBSTONE_DRIFT: src/retention.ts");
  }
  if (ledgerLines.length !== 1 || ledgerLines[0][1] !== days) {
    throw new Error("BACKUP_HORIZON_TOMBSTONE_DRIFT: src/postgres-ledger-authority.ts");
  }
}

test("shipped constants are the approved horizons and are frozen", () => {
  assert.equal(RESTORE_SUPPRESSION_TOMBSTONE_DAYS, 400);
  assert.equal(BACKUP_HORIZON_MAX_DAYS, 365);
  assert.equal(HORIZON_MARGIN_DAYS, 35);
  assert.equal(RESTORE_SLACK_DAYS, 7);
  assert.equal(AUTOMATED_RETAINED_BACKUPS, 30);
  assert.equal(PITR_LOG_RETENTION_DAYS, 7);
  assert.equal(ON_DEMAND_MAX_DAYS, 90);
  assert.equal(ON_DEMAND_CRITICAL_DAYS, 300);
  assert.equal(FINAL_BACKUP_MAX_DAYS, 30);
  assert.equal(LAST_AUTOMATED_SUCCESS_MAX_HOURS, 36);
  assert.deepEqual([...ON_DEMAND_PURPOSES], ["pre-migration", "pre-cutover", "pre-restore", "rehearsal"]);
  for (const frozen of [BACKUP_HORIZON_CONSTANTS, ON_DEMAND_PURPOSES, BACKUP_HORIZON_CODES, DESCRIPTION_PATTERN]) {
    assert.equal(Object.isFrozen(frozen), true);
  }
  assert.throws(() => { BACKUP_HORIZON_CONSTANTS.ON_DEMAND_MAX_DAYS = 360; }, TypeError);
  assert.equal(BACKUP_HORIZON_CODES.length, 13);
});

test("the invariant passes the shipped constants and fails each doctored horizon", () => {
  assert.equal(assertBackupHorizonInvariant(), true);
  assert.equal(assertBackupHorizonInvariant({ constants: { ...BACKUP_HORIZON_CONSTANTS } }), true);
  for (const doctored of [
    { ON_DEMAND_MAX_DAYS: 360 },
    { BACKUP_HORIZON_MAX_DAYS: 366 },
    { ON_DEMAND_CRITICAL_DAYS: 365 },
    { AUTOMATED_RETAINED_BACKUPS: 359 },
    { PITR_LOG_RETENTION_DAYS: 359 },
    { FINAL_BACKUP_MAX_DAYS: 359 },
    { HORIZON_MARGIN_DAYS: 36 },
    { RESTORE_SUPPRESSION_TOMBSTONE_DAYS: 399 },
    { ON_DEMAND_MAX_DAYS: 300 },
    { RESTORE_SLACK_DAYS: 0 },
    { ON_DEMAND_MAX_DAYS: "90" },
  ]) {
    assert.throws(
      () => assertBackupHorizonInvariant({ constants: { ...BACKUP_HORIZON_CONSTANTS, ...doctored } }),
      (error) => error.code === "BACKUP_HORIZON_INVARIANT_BROKEN",
      JSON.stringify(doctored),
    );
  }
});

test("both 400-day tombstone literals are pinned and a 401 in either copy fails", async () => {
  await assertTombstoneLiteralsPinned({
    retentionPath: RETENTION_SOURCE,
    ledgerAuthorityPath: LEDGER_AUTHORITY_SOURCE,
  });
  const directory = await mkdtemp(join(tmpdir(), "ops-backup-horizon-drift-"));
  try {
    const retention = await readFile(RETENTION_SOURCE, "utf8");
    const ledgerAuthority = await readFile(LEDGER_AUTHORITY_SOURCE, "utf8");
    const retentionCopy = join(directory, "retention.ts");
    const ledgerCopy = join(directory, "postgres-ledger-authority.ts");
    const retentionDrift = join(directory, "retention-drift.ts");
    const ledgerDrift = join(directory, "postgres-ledger-authority-drift.ts");
    await writeFile(retentionCopy, retention);
    await writeFile(ledgerCopy, ledgerAuthority);
    const driftedRetention = retention.replace(
      "DELETION_TOMBSTONE_RETENTION_MILLISECONDS = 400 * DAY_MILLISECONDS",
      "DELETION_TOMBSTONE_RETENTION_MILLISECONDS = 401 * DAY_MILLISECONDS",
    );
    const driftedLedger = ledgerAuthority.replace(
      "TOMBSTONE_RETENTION_MILLISECONDS = 400 * 24 * 60 * 60 * 1_000",
      "TOMBSTONE_RETENTION_MILLISECONDS = 401 * 24 * 60 * 60 * 1_000",
    );
    assert.notEqual(driftedRetention, retention);
    assert.notEqual(driftedLedger, ledgerAuthority);
    await writeFile(retentionDrift, driftedRetention);
    await writeFile(ledgerDrift, driftedLedger);
    await assertTombstoneLiteralsPinned({ retentionPath: retentionCopy, ledgerAuthorityPath: ledgerCopy });
    await assert.rejects(
      assertTombstoneLiteralsPinned({ retentionPath: retentionDrift, ledgerAuthorityPath: ledgerCopy }),
      /BACKUP_HORIZON_TOMBSTONE_DRIFT: src\/retention\.ts/u,
    );
    await assert.rejects(
      assertTombstoneLiteralsPinned({ retentionPath: retentionCopy, ledgerAuthorityPath: ledgerDrift }),
      /BACKUP_HORIZON_TOMBSTONE_DRIFT: src\/postgres-ledger-authority\.ts/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the core module stays runtime-neutral", async () => {
  const source = await readFile(join(CLOUD_RUN_ROOT, "ops-backup-horizon.mjs"), "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gmu)].map((match) => match[1]);
  assert.deepEqual(imports.sort(), ["../src/canonical-json.ts", "node:crypto"]);
  assert.doesNotMatch(source, /\bprocess\.|child_process|node:fs|\bfetch\(/u);
});

test("the description grammar is exact and matches the purpose enum", () => {
  assert.equal(
    DESCRIPTION_PATTERN.source,
    `^tibotattle-expires-on=(\\d{4}-\\d{2}-\\d{2});purpose=(${ON_DEMAND_PURPOSES.join("|")})$`,
  );
  assert.deepEqual(
    parseOnDemandDescription("tibotattle-expires-on=2026-12-24;purpose=pre-cutover"),
    { expiresOn: "2026-12-24", purpose: "pre-cutover" },
  );
  for (const unlabelled of [
    undefined,
    "",
    "tibotattle-expires-on=2026-12-24;purpose=pre-cutover;note",
    " tibotattle-expires-on=2026-12-24;purpose=pre-cutover",
    "tibotattle-expires-on=2026-12-24;purpose=manual",
    "tibotattle-expires-on=2026-02-30;purpose=rehearsal",
    "tibotattle-expires-on=2026-13-01;purpose=rehearsal",
    "tibotattle-expires-on=26-12-24;purpose=rehearsal",
  ]) {
    assert.equal(parseOnDemandDescription(unlabelled), null, String(unlabelled));
  }
  assert.equal(onDemandExpiresOn(NOW, 90), "2026-12-25");
  assert.equal(onDemandExpiresOn(NOW, 1), "2026-09-27");
  for (const days of [0, 91, 1.5, "30"]) {
    assert.throws(() => onDemandExpiresOn(NOW, days), (error) => error.code === "BACKUP_ON_DEMAND_EXPIRY_INVALID");
  }
  assert.throws(() => formatOnDemandDescription({ expiresOn: "2026-12-25", purpose: "manual" }),
    (error) => error.code === "BACKUP_ON_DEMAND_LABEL_INVALID");
});

test("a compliant estate is ok with a closed, content-free receipt", () => {
  const receipt = assessBackupRuns(input({
    primary: {
      backupRuns: [
        ...automatedSeries(PRIMARY),
        backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: 5 * DAY, description: labelFor(5 * DAY, 30) }),
      ],
    },
  }));
  assertVerdict(receipt, "ok", []);
  assert.equal(receipt.schema, BACKUP_HORIZON_AUDIT_SCHEMA);
  assert.deepEqual(Object.keys(receipt).sort(), [
    "codes", "coverage", "digest", "environment", "generatedAt", "project", "region", "roles", "schema", "verdict",
  ]);
  // An ok receipt speaks only for the instances' listed backup runs.
  assert.equal(BACKUP_HORIZON_COVERAGE, "instance-backup-runs-only");
  assert.equal(receipt.coverage, BACKUP_HORIZON_COVERAGE);
  assert.equal(receipt.generatedAt, "2026-09-26T12:00:00.000Z");
  assert.deepEqual(receipt.roles.primary.settings, {
    recognized: true,
    backupsEnabled: true,
    pointInTimeRecoveryEnabled: true,
    automatedRetentionCompliant: true,
    transactionLogRetentionCompliant: true,
    finalBackupCompliant: true,
    finalBackupConfigReported: true,
    locationCompliant: true,
  });
  assert.equal(receipt.roles.primary.automatedCount, 30);
  assert.equal(receipt.roles.primary.oldestAutomatedAgeDays, 29);
  assert.equal(receipt.roles.primary.lastSuccessfulAutomatedAgeHours, 10);
  assert.equal(receipt.roles.primary.onDemand.length, 1);
  assert.deepEqual(Object.keys(receipt.roles.primary.onDemand[0]).sort(),
    ["ageDays", "expiresOn", "id", "purpose", "status", "windowStartTime"]);
  assert.equal(receipt.roles.primary.onDemand[0].status, "ok");
  assert.equal(receipt.roles.primary.onDemand[0].purpose, "pre-migration");
  assert.equal(receipt.roles.primary.onDemand[0].ageDays, 5);
  assert.equal(Object.isFrozen(receipt.roles.primary.onDemand[0]), true);
  assert.deepEqual(verifyBackupHorizonReceipt(JSON.parse(JSON.stringify(receipt))), receipt);
});

test("the verdict matrix is exact", () => {
  const cases = [
    {
      name: "31 retained automated backups",
      primary: { settings: describeInstance(PRIMARY, { config: {
        backupRetentionSettings: { retentionUnit: "COUNT", retainedBackups: 31 },
      } }) },
      verdict: "breach",
      codes: ["AUTOMATED_RETENTION_EXCEEDED"],
    },
    {
      name: "unspecified retention unit",
      primary: { settings: describeInstance(PRIMARY, { config: {
        backupRetentionSettings: { retentionUnit: "RETENTION_UNIT_UNSPECIFIED", retainedBackups: 7 },
      } }) },
      verdict: "breach",
      codes: ["AUTOMATED_RETENTION_EXCEEDED"],
    },
    {
      name: "unknown retention unit",
      primary: { settings: describeInstance(PRIMARY, { config: {
        backupRetentionSettings: { retentionUnit: "DAYS", retainedBackups: 30 },
      } }) },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "PITR log retention 8 days",
      ledger: { settings: describeInstance(LEDGER, { config: { transactionLogRetentionDays: 8 } }) },
      verdict: "breach",
      codes: ["PITR_RETENTION_EXCEEDED"],
    },
    {
      name: "PITR disabled",
      ledger: { settings: describeInstance(LEDGER, { config: {
        pointInTimeRecoveryEnabled: false,
        transactionLogRetentionDays: undefined,
      } }) },
      verdict: "warn",
      codes: ["PITR_DISABLED"],
    },
    {
      name: "backups disabled",
      primary: { settings: describeInstance(PRIMARY, { config: { enabled: false } }) },
      verdict: "breach",
      codes: ["BACKUP_DISABLED"],
    },
    {
      name: "backups flag absent",
      primary: { settings: describeInstance(PRIMARY, { config: { enabled: undefined } }) },
      verdict: "breach",
      codes: ["BACKUP_DISABLED"],
    },
    {
      name: "backup location outside the region",
      primary: { settings: describeInstance(PRIMARY, { config: { location: "us" } }) },
      verdict: "breach",
      codes: ["BACKUP_LOCATION_MISMATCH"],
    },
    {
      name: "default multi-region location",
      primary: { settings: describeInstance(PRIMARY, { config: { location: undefined } }) },
      verdict: "breach",
      codes: ["BACKUP_LOCATION_MISMATCH"],
    },
    {
      name: "final backup kept 31 days",
      primary: { settings: describeInstance(PRIMARY, { settings: {
        finalBackupConfig: { enabled: true, retentionDays: 31 },
      } }) },
      verdict: "breach",
      codes: ["FINAL_BACKUP_RETENTION_EXCEEDED"],
    },
    {
      name: "backups retained after instance deletion",
      ledger: { settings: describeInstance(LEDGER, { settings: { retainBackupsOnDelete: true } }) },
      verdict: "breach",
      codes: ["FINAL_BACKUP_RETENTION_EXCEEDED"],
    },
    {
      name: "last automated success 40 h ago",
      primary: { backupRuns: automatedSeries(PRIMARY, { newestAgeMs: 40 * HOUR }) },
      verdict: "warn",
      codes: ["AUTOMATED_BACKUP_STALE"],
    },
    {
      name: "no successful automated backup",
      primary: { backupRuns: [backupRun(PRIMARY, { ageMs: 2 * HOUR, status: "FAILED" })] },
      verdict: "warn",
      codes: ["AUTOMATED_BACKUP_STALE"],
    },
    {
      name: "labelled on-demand past its expiry date",
      primary: { backupRuns: [
        ...automatedSeries(PRIMARY),
        backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: 10 * DAY, description: labelFor(10 * DAY, 9) }),
      ] },
      verdict: "warn",
      codes: ["ON_DEMAND_DUE"],
    },
    {
      name: "labelled on-demand 91 days old",
      primary: { backupRuns: [
        ...automatedSeries(PRIMARY),
        backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: 91 * DAY, description: labelFor(91 * DAY, 90) }),
      ] },
      verdict: "warn",
      codes: ["ON_DEMAND_OVERDUE"],
    },
    {
      name: "labelled on-demand 301 days old",
      primary: { backupRuns: [
        ...automatedSeries(PRIMARY),
        backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: 301 * DAY, description: labelFor(301 * DAY, 90) }),
      ] },
      verdict: "warn",
      codes: ["ON_DEMAND_CRITICAL"],
    },
    {
      name: "labelled on-demand 366 days old",
      primary: { backupRuns: [
        ...automatedSeries(PRIMARY),
        backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: 366 * DAY, description: labelFor(366 * DAY, 90) }),
      ] },
      verdict: "breach",
      codes: ["ON_DEMAND_CRITICAL", "BACKUP_OLDER_THAN_HORIZON"],
    },
    {
      name: "automated backup 366 days old",
      ledger: { backupRuns: [...automatedSeries(LEDGER), backupRun(LEDGER, { ageMs: 366 * DAY })] },
      verdict: "breach",
      codes: ["BACKUP_OLDER_THAN_HORIZON"],
    },
    {
      name: "a copy whose deletion failed still counts toward the horizon",
      ledger: { backupRuns: [
        ...automatedSeries(LEDGER),
        backupRun(LEDGER, { ageMs: 366 * DAY, status: "DELETION_FAILED" }),
      ] },
      verdict: "breach",
      codes: ["BACKUP_OLDER_THAN_HORIZON"],
    },
    {
      name: "a failed backup run is not a restorable copy",
      ledger: { backupRuns: [
        ...automatedSeries(LEDGER),
        backupRun(LEDGER, { ageMs: 366 * DAY, status: "FAILED" }),
      ] },
      verdict: "ok",
      codes: [],
    },
    {
      name: "final backup copy older than 30 days",
      ledger: { backupRuns: [
        ...automatedSeries(LEDGER),
        backupRun(LEDGER, { ageMs: 31 * DAY, type: "FINAL" }),
      ] },
      verdict: "breach",
      codes: ["FINAL_BACKUP_RETENTION_EXCEEDED"],
    },
    {
      name: "unlabelled on-demand",
      primary: { backupRuns: [
        ...automatedSeries(PRIMARY),
        backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: 3 * DAY }),
      ] },
      verdict: "warn",
      codes: ["ON_DEMAND_UNLABELLED"],
    },
    {
      name: "unlabelled on-demand 95 days old",
      primary: { backupRuns: [
        ...automatedSeries(PRIMARY),
        backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: 95 * DAY, description: "manual copy" }),
      ] },
      verdict: "warn",
      codes: ["ON_DEMAND_UNLABELLED", "ON_DEMAND_OVERDUE"],
    },
    {
      name: "unknown backup configuration field",
      primary: { settings: describeInstance(PRIMARY, { config: { managementConfig: {
        backupdrTransactionLogRetentionDays: 7,
      } } }) },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "enhanced backup tier",
      primary: { settings: describeInstance(PRIMARY, { config: { backupTier: "ENHANCED" } }) },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "PITR on with no stated log retention",
      primary: { settings: describeInstance(PRIMARY, { config: { transactionLogRetentionDays: undefined } }) },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "unparseable retained backup count",
      primary: { settings: describeInstance(PRIMARY, { config: {
        backupRetentionSettings: { retentionUnit: "COUNT", retainedBackups: "30" },
      } }) },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "unknown final-backup field",
      primary: { settings: describeInstance(PRIMARY, { settings: {
        finalBackupConfig: { enabled: true, retentionDays: 30, retentionUnit: "DAYS" },
      } }) },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "describe for a different instance",
      primary: { settings: describeInstance("synthetic-other") },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "unknown backup run field",
      primary: { backupRuns: [
        ...automatedSeries(PRIMARY),
        backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: DAY, description: labelFor(DAY, 30),
          extra: { expiryTime: "2027-09-26T12:00:00Z" } }),
      ] },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "unknown backup run status",
      primary: { backupRuns: [...automatedSeries(PRIMARY), backupRun(PRIMARY, { ageMs: DAY, status: "ARCHIVED" })] },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "unparseable backup window",
      primary: { backupRuns: [
        ...automatedSeries(PRIMARY),
        { ...backupRun(PRIMARY, { ageMs: DAY }), windowStartTime: "yesterday" },
      ] },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "id beyond exact JSON integers",
      primary: { backupRuns: [
        ...automatedSeries(PRIMARY),
        { ...backupRun(PRIMARY, { ageMs: DAY }), id: 2 ** 60 },
      ] },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      // Staleness is an inference from absence, so it is not raised when the list is unreadable.
      name: "backup list is not an array",
      ledger: { backupRuns: { items: [] } },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    // Every fail-closed branch of the describe reader.
    {
      name: "unknown retention settings field",
      primary: { settings: describeInstance(PRIMARY, { config: {
        backupRetentionSettings: { retentionUnit: "COUNT", retainedBackups: 30, retentionDays: 7 },
      } }) },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "final backups enabled with no retention days",
      primary: { settings: describeInstance(PRIMARY, { settings: { finalBackupConfig: { enabled: true } } }) },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "string final-backup flag",
      primary: { settings: describeInstance(PRIMARY, { settings: {
        finalBackupConfig: { enabled: "true", retentionDays: 30 },
      } }) },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "string retain-on-delete flag",
      primary: { settings: describeInstance(PRIMARY, { settings: { retainBackupsOnDelete: "false" } }) },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "string PITR flag is unrecognized, not a PITR_DISABLED warning",
      primary: { settings: describeInstance(PRIMARY, { config: { pointInTimeRecoveryEnabled: "true" } }) },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "string backups-enabled flag",
      primary: { settings: describeInstance(PRIMARY, { config: { enabled: "true" } }) },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "unknown backup configuration kind",
      primary: { settings: describeInstance(PRIMARY, { config: { kind: "sql#backupPolicy" } }) },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "unparseable configured backup location",
      primary: { settings: describeInstance(PRIMARY, { config: { location: "US East" } }) },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "unparseable backup start time",
      primary: { settings: describeInstance(PRIMARY, { config: { startTime: "7:00" } }) },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "unknown transaction log storage state",
      primary: { settings: describeInstance(PRIMARY, { config: { transactionalLogStorageState: "TAPE" } }) },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    // Every fail-closed branch of the run reader.
    {
      name: "a run listed for another instance",
      primary: { backupRuns: [...automatedSeries(PRIMARY), backupRun("synthetic-other", { ageMs: DAY })] },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "a run of another resource kind",
      primary: { backupRuns: [
        ...automatedSeries(PRIMARY),
        backupRun(PRIMARY, { ageMs: DAY, extra: { kind: "sql#backup" } }),
      ] },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "a duplicated run id",
      primary: { backupRuns: (() => {
        const series = automatedSeries(PRIMARY);
        return [...series, { ...series[3] }];
      })() },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      // Counted as fresh, a future window would hide the stale automated series.
      name: "a window more than an hour in the future",
      primary: { backupRuns: [
        ...automatedSeries(PRIMARY, { newestAgeMs: 40 * HOUR }),
        backupRun(PRIMARY, { ageMs: -(HOUR + 60_000) }),
      ] },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "a window within the clock tolerance counts as fresh",
      primary: { backupRuns: [
        ...automatedSeries(PRIMARY, { newestAgeMs: 40 * HOUR }),
        backupRun(PRIMARY, { ageMs: -30 * 60_000 }),
      ] },
      verdict: "ok",
      codes: [],
    },
    {
      name: "an out-of-range timezone offset",
      primary: { backupRuns: [
        ...automatedSeries(PRIMARY),
        { ...backupRun(PRIMARY, { ageMs: DAY }), windowStartTime: "2026-09-25T12:00:00+24:00" },
      ] },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    {
      name: "an unparseable run location",
      primary: { backupRuns: [
        ...automatedSeries(PRIMARY),
        backupRun(PRIMARY, { ageMs: DAY, extra: { location: "US East" } }),
      ] },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    // Where each restorable copy is stored, when a region is supplied.
    {
      name: "an on-demand copy in the default multi-region",
      primary: { backupRuns: [
        ...automatedSeries(PRIMARY),
        backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: 2 * DAY, description: labelFor(2 * DAY, 30),
          extra: { location: "us" } }),
      ] },
      verdict: "breach",
      codes: ["BACKUP_LOCATION_MISMATCH"],
    },
    {
      name: "an automated copy left in an earlier location",
      ledger: { backupRuns: [
        ...automatedSeries(LEDGER),
        backupRun(LEDGER, { ageMs: 20 * DAY, extra: { location: "asia" } }),
      ] },
      verdict: "breach",
      codes: ["BACKUP_LOCATION_MISMATCH"],
    },
    {
      name: "a copy whose deletion failed still has to be in the region",
      ledger: { backupRuns: [
        ...automatedSeries(LEDGER),
        backupRun(LEDGER, { ageMs: 20 * DAY, status: "DELETION_FAILED", extra: { location: "asia" } }),
      ] },
      verdict: "breach",
      codes: ["BACKUP_LOCATION_MISMATCH"],
    },
    {
      name: "a failed run elsewhere holds no copy",
      ledger: { backupRuns: [
        ...automatedSeries(LEDGER),
        backupRun(LEDGER, { ageMs: 20 * DAY, status: "FAILED", extra: { location: "asia" } }),
      ] },
      verdict: "ok",
      codes: [],
    },
    {
      name: "a restorable copy with no stated location",
      ledger: { backupRuns: [
        ...automatedSeries(LEDGER),
        (() => {
          const run = backupRun(LEDGER, { ageMs: 20 * DAY });
          delete run.location;
          return run;
        })(),
      ] },
      verdict: "breach",
      codes: ["BACKUP_SETTINGS_UNRECOGNIZED"],
    },
    // Retry path: a labelled copy whose deletion failed stays listed and prunable.
    {
      name: "an overdue on-demand copy whose deletion failed",
      primary: { backupRuns: [
        ...automatedSeries(PRIMARY),
        backupRun(PRIMARY, { type: "ON_DEMAND", status: "DELETION_FAILED", ageMs: 95 * DAY,
          description: labelFor(95 * DAY, 90) }),
      ] },
      verdict: "warn",
      codes: ["ON_DEMAND_OVERDUE"],
    },
    {
      name: "a copy pending deletion still counts toward the horizon",
      primary: { backupRuns: [
        ...automatedSeries(PRIMARY),
        backupRun(PRIMARY, { ageMs: 366 * DAY, status: "DELETION_PENDING" }),
      ] },
      verdict: "breach",
      codes: ["BACKUP_OLDER_THAN_HORIZON"],
    },
  ];
  for (const testCase of cases) {
    const receipt = assessBackupRuns(input({ primary: testCase.primary, ledger: testCase.ledger }));
    assert.equal(receipt.verdict, testCase.verdict, testCase.name);
    assert.deepEqual([...receipt.codes], testCase.codes, testCase.name);
  }
});

test("unit and status details of the matrix", () => {
  const overdue = assessBackupRuns(input({ primary: { backupRuns: [
    ...automatedSeries(PRIMARY),
    backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: 91 * DAY, description: labelFor(91 * DAY, 90) }),
  ] } }));
  assert.equal(overdue.roles.primary.onDemand[0].status, "overdue");
  assert.equal(overdue.roles.primary.onDemand[0].ageDays, 91);

  const unknownUnit = assessBackupRuns(input({ primary: { settings: describeInstance(PRIMARY, { config: {
    backupRetentionSettings: { retentionUnit: "DAYS", retainedBackups: 30 },
  } }) } }));
  assert.equal(unknownUnit.roles.primary.settings.recognized, false);
  assert.equal(unknownUnit.roles.primary.settings.automatedRetentionCompliant, false);
  assert.deepEqual([...unknownUnit.roles.ledger.codes], []);

  const stale = assessBackupRuns(input({ primary: { backupRuns: [] } }));
  assert.equal(stale.roles.primary.lastSuccessfulAutomatedAgeHours, null);
  assert.equal(stale.roles.primary.oldestAutomatedAgeDays, null);

  const noRegion = assessBackupRuns(input({ region: null }));
  assertVerdict(noRegion, "ok", []);
  assert.equal(noRegion.roles.primary.settings.locationCompliant, null);

  const numericIds = automatedSeries(PRIMARY).map((run) => ({ ...run, id: Number(run.id) }));
  assertVerdict(assessBackupRuns(input({ primary: { backupRuns: numericIds } })), "ok", []);

  const noFinalConfig = describeInstance(PRIMARY);
  delete noFinalConfig.settings.finalBackupConfig;
  const unreported = assessBackupRuns(input({ primary: { settings: noFinalConfig } }));
  assertVerdict(unreported, "ok", []);
  assert.equal(unreported.roles.primary.settings.finalBackupConfigReported, false);

  const disabledFinal = assessBackupRuns(input({ primary: { settings: describeInstance(PRIMARY, { settings: {
    finalBackupConfig: { enabled: false, retentionDays: 90 },
  } }) } }));
  assertVerdict(disabledFinal, "ok", []);

  const pending = assessBackupRuns(input({ primary: { backupRuns: [
    ...automatedSeries(PRIMARY),
    backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: 100 * DAY, status: "DELETION_PENDING" }),
  ] } }));
  assertVerdict(pending, "ok", []);
  assert.equal(pending.roles.primary.onDemand.length, 0);

  const deletionFailed = assessBackupRuns(input({ primary: { backupRuns: [
    ...automatedSeries(PRIMARY),
    backupRun(PRIMARY, { type: "ON_DEMAND", status: "DELETION_FAILED", ageMs: 95 * DAY,
      description: labelFor(95 * DAY, 90) }),
  ] } }));
  assert.deepEqual(deletionFailed.roles.primary.onDemand.map(({ status, ageDays }) => [status, ageDays]),
    [["overdue", 95]]);

  const elsewhereNoRegion = assessBackupRuns(input({
    region: null,
    primary: { backupRuns: [
      ...automatedSeries(PRIMARY),
      backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: 2 * DAY, description: labelFor(2 * DAY, 30),
        extra: { location: "us" } }),
    ] },
  }));
  assertVerdict(elsewhereNoRegion, "ok", []);

  const elsewhere = assessBackupRuns(input({ ledger: { backupRuns: [
    ...automatedSeries(LEDGER),
    backupRun(LEDGER, { ageMs: 20 * DAY, extra: { location: "asia" } }),
  ] } }));
  assert.equal(elsewhere.roles.ledger.settings.locationCompliant, false);
  assert.equal(elsewhere.roles.primary.settings.locationCompliant, true);
});

test("offset timestamps are read as the instant they name", () => {
  const offsetRun = (windowStartTime) => ({ ...backupRun(PRIMARY, { ageMs: DAY }), windowStartTime });
  // 12:00Z less 3 h, written in +02:00 and -05:30.
  for (const windowStartTime of ["2026-09-26T11:00:00+02:00", "2026-09-26T03:30:00.000-05:30"]) {
    const receipt = assessBackupRuns(input({ primary: { backupRuns: [
      ...automatedSeries(PRIMARY),
      offsetRun(windowStartTime),
    ] } }));
    assertVerdict(receipt, "ok", []);
    assert.equal(receipt.roles.primary.lastSuccessfulAutomatedAgeHours, 3, windowStartTime);
  }
  const onDemand = classifyBackupRun({
    ...backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: DAY, description: labelFor(DAY, 30) }),
    windowStartTime: "2026-09-26T13:00:00.5+01:00",
  }, { instance: PRIMARY, nowMs: NOW });
  assert.equal(onDemand.windowStartTime, "2026-09-26T12:00:00.500Z");
  assert.equal(onDemand.ageMs, 0);
});

test("unreadable run evidence is reported unavailable, never as zero", () => {
  const unknownField = automatedSeries(PRIMARY).map((run) => ({ ...run, expiryTime: "2027-01-01T00:00:00Z" }));
  const perRun = assessBackupRuns(input({ primary: { backupRuns: unknownField } }));
  const notArray = assessBackupRuns(input({ ledger: { backupRuns: "nope" } }));
  for (const [receipt, role] of [[perRun, "primary"], [notArray, "ledger"]]) {
    assertVerdict(receipt, "breach", ["BACKUP_SETTINGS_UNRECOGNIZED"]);
    const assessed = receipt.roles[role];
    assert.equal(assessed.settings.recognized, false, role);
    assert.equal(assessed.automatedCount, null, role);
    assert.equal(assessed.oldestAutomatedAgeDays, null, role);
    assert.equal(assessed.lastSuccessfulAutomatedAgeHours, null, role);
    assert.equal(assessed.onDemand, null, role);
    assert.deepEqual(verifyBackupHorizonReceipt(JSON.parse(JSON.stringify(receipt))), receipt);
  }
  assert.equal(perRun.roles.ledger.automatedCount, 30);

  // Codes proven by the runs that were read still stand beside the unavailable evidence.
  const partial = assessBackupRuns(input({ primary: { backupRuns: [
    ...automatedSeries(PRIMARY),
    backupRun(PRIMARY, { ageMs: 366 * DAY }),
    backupRun(PRIMARY, { ageMs: DAY, status: "ARCHIVED" }),
  ] } }));
  assertVerdict(partial, "breach", ["BACKUP_OLDER_THAN_HORIZON", "BACKUP_SETTINGS_UNRECOGNIZED"]);
  assert.equal(partial.roles.primary.onDemand, null);

  // A describe-only problem leaves the run evidence available.
  const describeOnly = assessBackupRuns(input({ primary: { settings: describeInstance(PRIMARY, { config: {
    backupTier: "ENHANCED",
  } }) } }));
  assert.equal(describeOnly.roles.primary.settings.recognized, false);
  assert.equal(describeOnly.roles.primary.automatedCount, 30);
  assert.deepEqual([...describeOnly.roles.primary.onDemand], []);
});

test("every threshold is pinned on both sides of its boundary", () => {
  const MS = 1;
  const onDemandAt = (ageMs, days) => [
    ...automatedSeries(PRIMARY),
    backupRun(PRIMARY, { type: "ON_DEMAND", ageMs, description: labelFor(ageMs, days) }),
  ];
  const cases = [
    { name: "90-day label just under 90 days", runs: onDemandAt(90 * DAY - MS, 90), status: "ok", codes: [] },
    { name: "90-day label at exactly 90 days", runs: onDemandAt(90 * DAY, 90), status: "ok", codes: [] },
    { name: "90-day label just over 90 days", runs: onDemandAt(90 * DAY + MS, 90), status: "overdue",
      codes: ["ON_DEMAND_OVERDUE"] },
    { name: "90-day label at 60 days", runs: onDemandAt(60 * DAY, 90), status: "ok", codes: [] },
    { name: "30-day label a day before it expires", runs: onDemandAt(29 * DAY, 30), status: "ok", codes: [] },
    { name: "at exactly 300 days", runs: onDemandAt(300 * DAY, 90), status: "overdue",
      codes: ["ON_DEMAND_OVERDUE"] },
    { name: "just over 300 days", runs: onDemandAt(300 * DAY + MS, 90), status: "critical",
      codes: ["ON_DEMAND_CRITICAL"] },
    { name: "at exactly 365 days", runs: onDemandAt(365 * DAY, 90), status: "critical",
      codes: ["ON_DEMAND_CRITICAL"] },
    { name: "just over 365 days", runs: onDemandAt(365 * DAY + MS, 90), status: "critical",
      codes: ["ON_DEMAND_CRITICAL", "BACKUP_OLDER_THAN_HORIZON"] },
  ];
  for (const testCase of cases) {
    const receipt = assessBackupRuns(input({ primary: { backupRuns: testCase.runs } }));
    assert.deepEqual([...receipt.codes], testCase.codes, testCase.name);
    assert.equal(receipt.roles.primary.onDemand[0].status, testCase.status, testCase.name);
  }

  const codesFor = (primary) => [...assessBackupRuns(input({ primary })).codes];
  assert.deepEqual(codesFor({ backupRuns: [...automatedSeries(PRIMARY), backupRun(PRIMARY, { ageMs: 365 * DAY })] }), []);
  assert.deepEqual(codesFor({ backupRuns: [...automatedSeries(PRIMARY), backupRun(PRIMARY, { ageMs: 365 * DAY + MS })] }),
    ["BACKUP_OLDER_THAN_HORIZON"]);
  assert.deepEqual(codesFor({ backupRuns: automatedSeries(PRIMARY, { newestAgeMs: 36 * HOUR }) }), []);
  assert.deepEqual(codesFor({ backupRuns: automatedSeries(PRIMARY, { newestAgeMs: 36 * HOUR + MS }) }),
    ["AUTOMATED_BACKUP_STALE"]);
  assert.deepEqual(codesFor({ backupRuns: [
    ...automatedSeries(PRIMARY),
    backupRun(PRIMARY, { type: "FINAL", ageMs: 30 * DAY }),
  ] }), []);
  assert.deepEqual(codesFor({ backupRuns: [
    ...automatedSeries(PRIMARY),
    backupRun(PRIMARY, { type: "FINAL", ageMs: 30 * DAY + MS }),
  ] }), ["FINAL_BACKUP_RETENTION_EXCEEDED"]);
});

test("a labelled backup is due only after its expires-on date has fully passed", () => {
  const statusAt = (createdMs, days, nowMs) => {
    const run = {
      ...backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: 0 }),
      windowStartTime: new Date(createdMs).toISOString(),
      description: formatOnDemandDescription({ expiresOn: onDemandExpiresOn(createdMs, days), purpose: "pre-migration" }),
    };
    return classifyBackupRun(run, { instance: PRIMARY, nowMs }).onDemandStatus;
  };
  // Created 30 minutes before UTC midnight with one day asked.
  const lateEvening = Date.parse("2026-09-26T23:30:00.000Z");
  assert.equal(onDemandExpiresOn(lateEvening, 1), "2026-09-27");
  assert.equal(statusAt(lateEvening, 1, lateEvening + 10 * 60_000), "ok");
  assert.equal(statusAt(lateEvening, 1, lateEvening + 31 * 60_000), "ok");
  assert.equal(statusAt(lateEvening, 1, lateEvening + DAY), "ok");
  assert.equal(statusAt(lateEvening, 1, Date.parse("2026-09-28T00:00:00.000Z") - 1), "ok");
  assert.equal(statusAt(lateEvening, 1, Date.parse("2026-09-28T00:00:00.000Z")), "due");

  // For every allowed length and any time of day: kept at least N days, due by N + 1.
  for (const days of [1, 7, 30, 89, 90]) {
    for (const time of ["00:00:00.000", "00:00:00.001", "11:59:59.999", "23:59:59.999"]) {
      const createdMs = Date.parse(`2026-09-26T${time}Z`);
      assert.equal(statusAt(createdMs, days, createdMs + days * DAY), "ok", `${days} days from ${time}`);
      assert.notEqual(statusAt(createdMs, days, createdMs + (days + 1) * DAY), "ok", `${days} days from ${time}`);
    }
  }
});

test("receipts carry no description text beyond the parsed purpose and expiry", () => {
  const marker = "MARKER-3c1f9e";
  const receipt = assessBackupRuns(input({ primary: { backupRuns: [
    ...automatedSeries(PRIMARY),
    backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: 2 * DAY, description: `${labelFor(2 * DAY, 30)};${marker}` }),
    backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: 3 * DAY, description: `free text ${marker}` }),
    backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: 4 * DAY, description: labelFor(4 * DAY, 30, "rehearsal") }),
  ] } }));
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes("free text"), false);
  assert.equal(serialized.includes("tibotattle-expires-on"), false);
  assertVerdict(receipt, "warn", ["ON_DEMAND_UNLABELLED"]);
  assert.deepEqual(receipt.roles.primary.onDemand.map((entry) => [entry.status, entry.purpose]), [
    ["ok", "rehearsal"],
    ["unlabelled", null],
    ["unlabelled", null],
  ]);
  const classified = classifyBackupRun(
    backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: DAY, description: marker }),
    { instance: PRIMARY, nowMs: NOW },
  );
  assert.equal(JSON.stringify(classified).includes(marker), false);
});

test("the digest is sha256 of canonical JSON and stable under key reordering", () => {
  const source = input({ primary: { backupRuns: [
    ...automatedSeries(PRIMARY),
    backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: 20 * DAY, description: labelFor(20 * DAY, 10) }),
  ] } });
  const receipt = assessBackupRuns(source);
  const reordered = assessBackupRuns(reverseKeys(source));
  assert.equal(reordered.digest, receipt.digest);
  assert.deepEqual(reordered, receipt);
  const { digest, ...body } = receipt;
  assert.equal(digest, createHash("sha256").update(sortedJson(body)).digest("hex"));
  assert.equal(digest, createHash("sha256").update(sortedJson(reverseKeys(body))).digest("hex"));
  assert.notEqual(assessBackupRuns({ ...source, nowMs: NOW + 1 }).digest, digest);
});

test("receipt verification is closed and recomputes the digest", () => {
  const receipt = JSON.parse(JSON.stringify(assessBackupRuns(input({ primary: { backupRuns: [
    ...automatedSeries(PRIMARY),
    backupRun(PRIMARY, { type: "ON_DEMAND", ageMs: 20 * DAY, description: labelFor(20 * DAY, 10) }),
  ] } }))));
  assert.equal(verifyBackupHorizonReceipt(structuredClone(receipt)).digest, receipt.digest);
  const redigest = (value) => {
    const { digest: _ignored, ...body } = value;
    return { ...value, digest: createHash("sha256").update(sortedJson(body)).digest("hex") };
  };
  const doctored = [
    { ...receipt, note: "x" },
    { ...receipt, digest: "0".repeat(64) },
    redigest({ ...receipt, verdict: "ok" }),
    redigest({ ...receipt, codes: [] }),
    redigest({ ...receipt, schema: "tibotattle-backup-horizon-audit-v2" }),
    redigest({ ...receipt, roles: { ...receipt.roles, primary: {
      ...receipt.roles.primary,
      onDemand: [{ ...receipt.roles.primary.onDemand[0], description: "x" }],
    } } }),
    redigest({ ...receipt, roles: { ...receipt.roles, primary: {
      ...receipt.roles.primary,
      onDemand: [{ ...receipt.roles.primary.onDemand[0], status: "ok", purpose: null, expiresOn: null }],
    } } }),
    redigest({ ...receipt, roles: { ...receipt.roles, ledger: { ...receipt.roles.ledger, instance: PRIMARY } } }),
    // Coverage is fixed: a receipt cannot claim project-wide scope.
    redigest({ ...receipt, coverage: "project-backups" }),
    redigest((({ coverage: _dropped, ...rest }) => rest)(receipt)),
    // Top-level codes must be exactly the roles' codes, even when the verdict agrees.
    redigest({ ...receipt, codes: [], verdict: "ok" }),
    // A listed due entry needs its code, and a code needs a listed entry.
    redigest({
      ...receipt,
      codes: [],
      verdict: "ok",
      roles: { ...receipt.roles, primary: { ...receipt.roles.primary, codes: [] } },
    }),
    redigest({ ...receipt, roles: { ...receipt.roles, primary: { ...receipt.roles.primary, onDemand: [] } } }),
    // Unavailable run evidence is all-null, unrecognized and never stale.
    redigest({ ...receipt, roles: { ...receipt.roles, ledger: { ...receipt.roles.ledger, onDemand: null } } }),
    redigest({ ...receipt, roles: { ...receipt.roles, ledger: {
      ...receipt.roles.ledger,
      onDemand: [],
      automatedCount: null,
    } } }),
  ];
  for (const value of doctored) {
    assert.throws(() => verifyBackupHorizonReceipt(value),
      (error) => error.code === "BACKUP_HORIZON_RECEIPT_INVALID");
  }

  const unavailable = JSON.parse(JSON.stringify(assessBackupRuns(input({ ledger: { backupRuns: "nope" } }))));
  assert.equal(verifyBackupHorizonReceipt(structuredClone(unavailable)).digest, unavailable.digest);
  for (const value of [
    redigest({ ...unavailable, roles: { ...unavailable.roles, ledger: {
      ...unavailable.roles.ledger, automatedCount: 0,
    } } }),
    redigest({ ...unavailable, roles: { ...unavailable.roles, ledger: {
      ...unavailable.roles.ledger, settings: { ...unavailable.roles.ledger.settings, recognized: true },
    } } }),
    redigest({
      ...unavailable,
      codes: ["AUTOMATED_BACKUP_STALE", "BACKUP_SETTINGS_UNRECOGNIZED"],
      roles: { ...unavailable.roles, ledger: {
        ...unavailable.roles.ledger, codes: ["AUTOMATED_BACKUP_STALE", "BACKUP_SETTINGS_UNRECOGNIZED"],
      } },
    }),
  ]) {
    assert.throws(() => verifyBackupHorizonReceipt(value),
      (error) => error.code === "BACKUP_HORIZON_RECEIPT_INVALID");
  }
});

test("the invariant runs when the module loads", async () => {
  const source = await readFile(join(CLOUD_RUN_ROOT, "ops-backup-horizon.mjs"), "utf8");
  const canonicalJsonUrl = pathToFileURL(join(WORKER_ROOT, "src", "canonical-json.ts")).href;
  const relocated = source.replace('from "../src/canonical-json.ts";', `from ${JSON.stringify(canonicalJsonUrl)};`);
  assert.notEqual(relocated, source);
  const doctored = relocated.replace("export const ON_DEMAND_MAX_DAYS = 90;", "export const ON_DEMAND_MAX_DAYS = 360;");
  assert.notEqual(doctored, relocated);
  const directory = await mkdtemp(join(tmpdir(), "ops-backup-horizon-load-"));
  try {
    const intactPath = join(directory, "intact.mjs");
    const doctoredPath = join(directory, "doctored.mjs");
    await writeFile(intactPath, relocated);
    await writeFile(doctoredPath, doctored);
    const intact = await import(pathToFileURL(intactPath).href);
    assert.equal(intact.ON_DEMAND_MAX_DAYS, 90);
    await assert.rejects(import(pathToFileURL(doctoredPath).href),
      (error) => error.code === "BACKUP_HORIZON_INVARIANT_BROKEN");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("caller mistakes throw instead of producing a receipt", () => {
  for (const bad of [
    { ...input(), environment: "test" },
    { ...input(), nowMs: -1 },
    { ...input(), project: "Bad Project" },
    { ...input(), region: "us" },
    { ...input(), instances: input().instances.slice(0, 1) },
    { ...input(), instances: [input().instances[0], input().instances[0]] },
    { ...input(), instances: [input().instances[0], { ...input().instances[1], instance: PRIMARY }] },
    { ...input(), instances: [input().instances[0], { ...input().instances[1], instance: "p:r:ledger" }] },
  ]) {
    assert.throws(() => assessBackupRuns(bad), (error) => error.code === "BACKUP_HORIZON_INPUT_INVALID");
  }
});

test("the desired configuration renders the approved flags and reads back clean", () => {
  const desired = desiredBackupConfiguration({ region: REGION, backupStartTime: "07:00" });
  assert.deepEqual([...desired.flags], [
    "--backup-start-time=07:00",
    "--retained-backups-count=30",
    "--retained-transaction-log-days=7",
    "--enable-point-in-time-recovery",
    "--backup-location=us-east1",
  ]);
  assert.deepEqual([...desired.finalBackupFlags], [
    "--final-backup",
    "--final-backup-retention-days=30",
    "--no-retain-backups-on-delete",
  ]);
  assert.equal(Object.isFrozen(desired.expectedSettings.backupConfiguration), true);
  const readback = (name) => ({
    kind: "sql#instance",
    name,
    settings: JSON.parse(JSON.stringify(desired.expectedSettings)),
  });
  assertVerdict(assessBackupRuns(input({
    primary: { settings: readback(PRIMARY) },
    ledger: { settings: readback(LEDGER) },
  })), "ok", []);
  for (const bad of [{ region: "us", backupStartTime: "07:00" }, { region: REGION, backupStartTime: "7:00" }, {}]) {
    assert.throws(() => desiredBackupConfiguration(bad),
      (error) => error.code === "BACKUP_CONFIGURATION_INPUT_INVALID");
  }
});
