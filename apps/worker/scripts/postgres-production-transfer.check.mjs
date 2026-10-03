// DB-free check for E-PT8 (PT-8-lite): the coverage and policy module, the
// identity-link pin, the parity-sample selection, the authorization tokens,
// the finalize order, the inputs contract and the CLI boundary. The
// PostgreSQL behaviour (preflight, run, kill and resume, finalize to live and
// every refusal on a real target) is postgres-test/postgres-production-transfer.spec.mjs.
//
// Synthetic, content-free fixtures only.
//
//   node --test scripts/postgres-production-transfer.check.mjs

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { identityLinkFingerprint as w2SealFingerprint } from "../postgres-test/fixtures/w2-seal/synthetic-sources.mjs";
import {
  COMPLETE_TRIGGER_POLICY,
  DISPOSITIONS,
  KEPT_SESSION_AUTHORITY_TABLES,
  OWNER_FLAGS,
  OWNER_FLAG_PERFORMANCE_ROUTES_RETIRED,
  RETIRED_SOCIAL_CHAIN_TABLES,
  SOURCE_ROLES,
  STAGE_PLAN,
  WAIVABLE,
  assertWaiverAllowed,
  dispositionPolicySha256,
  evaluateSealedCoverage,
  stagePrerequisites,
  stageWaiverSha256,
} from "./postgres-transfer-coverage.mjs";
import {
  IDENTITY_LINK_FINGERPRINT_DOMAIN,
  assertPinMatchesMount,
  assertPinMatchesSealed,
  buildIdentityLinkPin,
  identityLinkSecretFingerprint,
  readSecretFromStream,
  validateIdentityLinkPin,
} from "./postgres-identity-link-pin.mjs";
import { PARITY_CLASSES, selectParitySample } from "./postgres-transfer-parity-sample.mjs";
import {
  DESIRED_STATE_SCHEMA,
  FINALIZE_ORDER,
  MIGRATION_FENCE_LOCK_PREFIX,
  PRODUCTION_TRANSFER_ERROR_CODES,
  PRODUCTION_TRANSFER_INPUTS_SCHEMA,
  PRODUCTION_DESIRED_STATE_FILE,
  PROTECTED_STEPS,
  ProductionTransferError,
  REQUIRED_SCHEDULED_TRIGGERS,
  SCHEDULER_EVIDENCE_MAXIMUM_AGE_MILLISECONDS,
  SCHEDULER_PROBE_SCHEMA,
  assertStepOrder,
  authorizationToken,
  cliErrorLine,
  connectionOptions,
  parseTransferArguments,
  readProductionDeployment,
  validateSchedulerEvidence,
  validateTransferInputs,
} from "./postgres-production-transfer.mjs";
import { TRANSFER_STAGES } from "./postgres-transfer-target.mjs";
import { TELEMETRY_PRODUCTION_DISPOSITIONS } from "./postgres-production-telemetry-modes.mjs";
import { LEGACY_TRANSFER_DISPOSITIONS } from "./postgres-legacy-contribution-transfer.mjs";
import { IDENTITY_AUTHORITY_COLUMN_MAP } from "./postgres-identity-authority-transfer.mjs";

const scratch = await mkdtemp(join(tmpdir(), "tibotattle-ept8-check-"));
after(() => rm(scratch, { recursive: true, force: true }));

const SEAL_ID = "a".repeat(64);
const SECRET = "ept8-check-synthetic-identity-link-secret-000";
const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return "RESOLVED";
};

/** An in-memory catalog: one single-column table per disposition of `role`. */
function catalog(role, { omit = [], extra = [], rows = {} } = {}) {
  const database = new DatabaseSync(":memory:");
  for (const item of DISPOSITIONS.filter(entry => entry.role === role)) {
    if (omit.includes(item.table)) continue;
    const columns = item.table === "storage_erasure_jobs" ? "(x INTEGER, state TEXT)" : "(x INTEGER)";
    database.exec(`CREATE TABLE "${item.table}" ${columns}`);
  }
  for (const name of extra) database.exec(`CREATE TABLE "${name}" (x INTEGER)`);
  for (const [name, values] of Object.entries(rows)) {
    for (const value of values) {
      if (name === "storage_erasure_jobs") database.prepare(`INSERT INTO "${name}" (x, state) VALUES (1, ?)`).run(value);
      else database.prepare(`INSERT INTO "${name}" (x) VALUES (?)`).run(value);
    }
  }
  return database;
}

function databases(options = {}) {
  return { ingestion: catalog("ingestion", options.ingestion), "deletion-ledger": catalog("deletion-ledger", options.ledger) };
}

// ---------------------------------------------------------------------------
// Coverage and policy (PT8-A).

test("one disposition per sealed table: every importer's tokens are taken verbatim and the set is closed", () => {
  const ingestion = DISPOSITIONS.filter(item => item.role === "ingestion");
  assert.equal(ingestion.length, 163, "the d43c8f92 catalog: 162 tables plus d1_storage_migrations");
  assert.equal(DISPOSITIONS.filter(item => item.role === "deletion-ledger").length, 5);
  for (const item of TELEMETRY_PRODUCTION_DISPOSITIONS) {
    assert.deepEqual(DISPOSITIONS.find(entry => entry.role === "ingestion" && entry.table === item.table),
      { role: "ingestion", table: item.table, token: item.token, stage: item.stage, writer: "runner", rule: "any", optional: false });
  }
  for (const [tableName, item] of Object.entries(LEGACY_TRANSFER_DISPOSITIONS)) {
    const entry = DISPOSITIONS.find(candidate => candidate.role === "ingestion" && candidate.table === tableName);
    assert.equal(entry.token, item.token, tableName);
    assert.equal(entry.stage, item.stage, tableName);
  }
  for (const [tableName, map] of Object.entries(IDENTITY_AUTHORITY_COLUMN_MAP)) {
    const entry = DISPOSITIONS.find(candidate => candidate.role === "ingestion" && candidate.table === tableName);
    assert.equal(entry.token, map.mode === "insert" ? "imported:identity-authority" : "mapped:identity-authority", tableName);
  }
  assert.ok(Object.isFrozen(DISPOSITIONS));
  assert.ok(DISPOSITIONS.every(item => SOURCE_ROLES.includes(item.role) && TRANSFER_STAGES.includes(item.stage)));
  // Round 5: admin history mapped, exclusions imported (no longer runtime-reset / must-be-empty).
  const token = name => DISPOSITIONS.find(item => item.role === "ingestion" && item.table === name).token;
  assert.equal(token("admin_metric_snapshots"), "mapped:admin-metrics-history");
  assert.equal(token("community_aggregate_exclusions"), "imported:community-aggregate-exclusions");
});

test("round 12: the kept session routes' tables stay PT-3 imports; the retired social chain is still carried inertly", () => {
  for (const tableName of [...KEPT_SESSION_AUTHORITY_TABLES, ...RETIRED_SOCIAL_CHAIN_TABLES]) {
    const entry = DISPOSITIONS.find(item => item.role === "ingestion" && item.table === tableName);
    assert.equal(entry.token, "imported:identity-authority", tableName);
    assert.equal(entry.writer, "runner", tableName);
  }
});

test("catalog equality in both directions, with optional ledgers", () => {
  const report = evaluateSealedCoverage(databases(), { ownerFlags: [] });
  assert.equal(report.roles.ingestion.tables, 163);
  assert.equal(report.policySha256, dispositionPolicySha256());
  assert.equal(evaluateSealedCoverage(databases({ ledger: { omit: ["d1_storage_migrations"] } })).roles["deletion-ledger"].tables, 4);
  assert.equal(codeOf(() => evaluateSealedCoverage(databases({ ingestion: { extra: ["zz_unknown"] } }))),
    "CUTOVER_COVERAGE_TABLE_UNKNOWN");
  assert.equal(codeOf(() => evaluateSealedCoverage(databases({ ingestion: { omit: ["storage_raw_copy_pages"] } }))),
    "CUTOVER_COVERAGE_TABLE_MISSING");
  assert.equal(codeOf(() => evaluateSealedCoverage(databases({ ledger: { omit: ["deletion_tombstones"] } }))),
    "CUTOVER_COVERAGE_TABLE_MISSING");
  // D1 provider tables are excluded by the seal's own predicate.
  const withProvider = databases();
  withProvider.ingestion.exec("CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID");
  assert.equal(evaluateSealedCoverage(withProvider).roles.ingestion.tables, 163);
});

test("the emptiness, flag and erasure-job rules refuse with a table name and a count only", () => {
  for (const tableName of ["accountless_public_history_retention", "storage_legacy_event_sources",
    "storage_legacy_revision_requests", "storage_v11_head_requests", "storage_v12_head_requests"]) {
    let error;
    try {
      evaluateSealedCoverage(databases({ ingestion: { rows: { [tableName]: [1, 2] } } }));
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, "CUTOVER_COVERAGE_NOT_EMPTY", tableName);
    assert.equal(error.table, tableName);
    assert.equal(error.count, 2);
  }
  const performance = databases({ ingestion: { rows: { telemetry_performance_runtime: [1] } } });
  assert.equal(codeOf(() => evaluateSealedCoverage(performance)), "CUTOVER_COVERAGE_DECISION_MISSING");
  assert.equal(evaluateSealedCoverage(databases({ ingestion: { rows: { telemetry_performance_runtime: [1] } } }),
    { ownerFlags: [OWNER_FLAG_PERFORMANCE_ROUTES_RETIRED] }).roles.ingestion.ruledRows.telemetry_performance_runtime, 1);
  assert.equal(codeOf(() => evaluateSealedCoverage(databases({ ledger: { rows: { storage_erasure_jobs: ["pending"] } } }))),
    "CUTOVER_PARTICIPANT_ERASURE_PENDING");
  assert.doesNotThrow(() => evaluateSealedCoverage(databases({ ledger: { rows: { storage_erasure_jobs: ["complete"] } } })));
  assert.equal(codeOf(() => evaluateSealedCoverage(databases(), { ownerFlags: ["not-a-flag"] })), "CUTOVER_COVERAGE_ARGUMENT_INVALID");
  assert.equal(codeOf(() => evaluateSealedCoverage(databases(), { ownerFlags: [OWNER_FLAGS[0], OWNER_FLAGS[0]] })),
    "CUTOVER_COVERAGE_ARGUMENT_INVALID");
});

test("the stage plan covers PT-1's stages once, in dependency order; waivers are closed", () => {
  assert.deepEqual([...STAGE_PLAN.map(entry => entry.stage)].sort(), [...TRANSFER_STAGES].sort());
  assert.equal(STAGE_PLAN[0].stage, "identity-authority");
  assert.equal(STAGE_PLAN.at(-1).stage, "post-import");
  assert.deepEqual(stagePrerequisites("identity-authority"), []);
  assert.deepEqual(stagePrerequisites("pending-registrations").slice(0, 4),
    ["identity-authority", "legacy-contributions", "telemetry-v1-v11", "typed-legacy"]);
  assert.equal(stagePrerequisites("post-import").length, TRANSFER_STAGES.length - 1);
  assert.deepEqual(Object.keys(WAIVABLE).sort(), ["accountless-retention", "analytics-community-history", "analytics-expectation",
    "analytics-history", "objects", "performance"]);
  for (const [stage, [reason]] of Object.entries(WAIVABLE)) assert.doesNotThrow(() => assertWaiverAllowed(stage, reason));
  assert.equal(codeOf(() => assertWaiverAllowed("performance", "another-reason")), "CUTOVER_STAGE_WAIVER_REFUSED");
  // A stage with an imported or mapped table is never waivable.
  for (const stage of ["identity-authority", "legacy-contributions", "pending-registrations", "telemetry-v12"]) {
    assert.equal(codeOf(() => assertWaiverAllowed(stage, "analytics-recomputed:d3")), "CUTOVER_STAGE_WAIVER_REFUSED", stage);
  }
  const waiver = stageWaiverSha256({ sealId: SEAL_ID, stage: "objects", reason: "deferred-post-flip:pt-7" });
  assert.match(waiver, /^[0-9a-f]{64}$/u);
  assert.notEqual(waiver, stageWaiverSha256({ sealId: "b".repeat(64), stage: "objects", reason: "deferred-post-flip:pt-7" }));
});

test("the merged trigger policy covers every importer and the disposition policy digest is pinned", () => {
  for (const tableName of ["participants", "telemetry_v11_chunks", "telemetry_contributions", "pending_objects",
    "community_aggregate_exclusions", "collection_controls"]) {
    assert.ok(Object.hasOwn(COMPLETE_TRIGGER_POLICY, tableName), tableName);
  }
  assert.equal(dispositionPolicySha256(), "003240c669857e38f80f8f369322d68ed1f31b14d0d337f8f73f51023c7ec6bc",
    "a reviewed change to dispositions, rules, flags, the stage plan or the trigger policy must update this pin");
});

// ---------------------------------------------------------------------------
// Identity-link pin (PT8-C).

test("the pin equals the Worker's fingerprint, refuses short secrets and 'latest', and reads stdin only", async () => {
  // The W2-SEAL vectors and the Worker's own domain literal (src/identity-link-configuration.ts).
  assert.equal(identityLinkSecretFingerprint(SECRET), w2SealFingerprint(SECRET));
  const worker = await readFile(new URL("../src/identity-link-configuration.ts", import.meta.url), "utf8");
  assert.ok(worker.includes('"app-usagemonitor/identity-link-secret-fingerprint/v1\\0"'));
  assert.ok(worker.includes("value.length < 32"));
  assert.equal(identityLinkSecretFingerprint(SECRET),
    createHmac("sha256", SECRET).update("app-usagemonitor/identity-link-secret-fingerprint/v1\0").digest("hex"));
  assert.equal(IDENTITY_LINK_FINGERPRINT_DOMAIN, "app-usagemonitor/identity-link-secret-fingerprint/v1\0");
  assert.throws(() => identityLinkSecretFingerprint("x".repeat(31)), { code: "CUTOVER_IDENTITY_LINK_SECRET_INVALID" });
  // The service hashes the mounted value as it is: configuredIdentityLinkSecret never trims.
  const configured = worker.slice(worker.indexOf("function configuredIdentityLinkSecret("),
    worker.indexOf("function configuredIdentityLinkSecretVersion("));
  assert.ok(configured.includes("return value;") && !configured.includes("trim"), "the Worker keeps the exact secret bytes");
  // So the pin hashes the exact stdin bytes: nothing is stripped.
  assert.equal(await readSecretFromStream(Readable.from([SECRET])), SECRET);
  assert.equal(await readSecretFromStream(Readable.from([SECRET.slice(0, 10), Buffer.from(SECRET.slice(10), "utf8")])), SECRET);
  assert.equal(await readSecretFromStream(Readable.from([`\uFEFF${SECRET}`])), `\uFEFF${SECRET}`, "a byte-order mark is kept");
  assert.equal(await readSecretFromStream(Readable.from([` ${SECRET} `])), ` ${SECRET} `, "spaces are part of the secret");
  // A trailing line feed or carriage return is refused, never stripped: a
  // version stored with one loads WITH it, so a stripped pin would equal the
  // sealed fingerprint (P8 passes) while the service computes another one.
  assert.notEqual(identityLinkSecretFingerprint(`${SECRET}\n`), identityLinkSecretFingerprint(SECRET));
  for (const ending of ["\n", "\r\n", "\r", "\n\n"]) {
    await assert.rejects(readSecretFromStream(Readable.from([`${SECRET}${ending}`])),
      { code: "CUTOVER_IDENTITY_LINK_SECRET_INVALID" }, JSON.stringify(ending));
  }
  await assert.rejects(readSecretFromStream(Readable.from([Buffer.from([0x61, 0xff, 0x62])])),
    { code: "CUTOVER_IDENTITY_LINK_SECRET_INVALID" }, "not UTF-8");
  await assert.rejects(readSecretFromStream(Readable.from([Buffer.alloc(5000, 0x61)])), { code: "CUTOVER_IDENTITY_LINK_SECRET_INVALID" });
  const base = { secret: SECRET, keyVersion: "prod-v1", secretName: "identity-link", secretVersion: "3",
    computedAt: "2026-10-02T00:00:00.000Z" };
  const pin = buildIdentityLinkPin(base);
  assert.equal(JSON.stringify(pin).includes(SECRET), false, "the secret never enters the pin");
  assert.throws(() => buildIdentityLinkPin({ ...base, secretVersion: "latest" }), { code: "CUTOVER_IDENTITY_PIN_INVALID" });
  assert.deepEqual(validateIdentityLinkPin({ ...pin }), pin);
  assert.throws(() => validateIdentityLinkPin({ ...pin, extra: 1 }), { code: "CUTOVER_IDENTITY_PIN_INVALID" });
  const sealed = [{ key_version: "prod-v1", secret_fingerprint: pin.secretFingerprint }];
  assert.deepEqual(assertPinMatchesSealed(pin, sealed, { expectedKeyVersion: "prod-v1" }),
    { keyVersion: "prod-v1", secretFingerprint: pin.secretFingerprint });
  assert.throws(() => assertPinMatchesSealed(pin, sealed, { expectedKeyVersion: "prod-v2" }),
    { code: "CUTOVER_IDENTITY_LINK_VERSION_MISMATCH" });
  assert.throws(() => assertPinMatchesSealed(pin, [{ ...sealed[0], secret_fingerprint: "0".repeat(64) }],
    { expectedKeyVersion: "prod-v1" }), { code: "CUTOVER_IDENTITY_LINK_SECRET_MISMATCH" });
  assert.throws(() => assertPinMatchesSealed(pin, [], { expectedKeyVersion: "prod-v1" }),
    { code: "CUTOVER_IDENTITY_LINK_SECRET_MISMATCH" });
});

test("P8 binds the pin to the secret and numeric version the production service mounts", () => {
  const pin = buildIdentityLinkPin({ secret: SECRET, keyVersion: "prod-v1", secretName: "IDENTITY_LINK_SECRET",
    secretVersion: "3", computedAt: "2026-10-02T00:00:00.000Z" });
  assert.deepEqual(assertPinMatchesMount(pin, { secretName: "IDENTITY_LINK_SECRET", version: "3" }),
    { secretName: "IDENTITY_LINK_SECRET", secretVersion: "3" });
  for (const version of [null, "latest", "0", "03", 3, ""]) {
    assert.throws(() => assertPinMatchesMount(pin, { secretName: "IDENTITY_LINK_SECRET", version }),
      { code: "CUTOVER_IDENTITY_LINK_MOUNT_UNPINNED" }, String(version));
  }
  assert.throws(() => assertPinMatchesMount(pin, null), { code: "CUTOVER_IDENTITY_LINK_MOUNT_UNPINNED" });
  assert.throws(() => assertPinMatchesMount(pin, { secretName: "IDENTITY_LINK_SECRET", version: "4" }),
    { code: "CUTOVER_IDENTITY_LINK_MOUNT_MISMATCH" }, "another version than the template mounts");
  assert.throws(() => assertPinMatchesMount(pin, { secretName: "tibotattle-identity-link", version: "3" }),
    { code: "CUTOVER_IDENTITY_LINK_MOUNT_MISMATCH" }, "another secret than the template mounts");
});

test("the committed production desired state is read as data: schema, environment, project, the scheduler set and the closed mount", async () => {
  const committed = JSON.parse(await readFile(new URL(`../${PRODUCTION_DESIRED_STATE_FILE}`, import.meta.url), "utf8"));
  assert.equal(committed.schemaVersion, DESIRED_STATE_SCHEMA);
  assert.equal(committed.environment, "production");
  assert.deepEqual(Object.keys(committed.secrets.IDENTITY_LINK_SECRET).sort(), ["secretName", "version"]);
  const write = async (name, value) => {
    const path = join(scratch, name);
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    return path;
  };
  const filled = { ...committed, project: "tibotattle-synthetic-prod",
    secrets: { ...committed.secrets, IDENTITY_LINK_SECRET: { secretName: "IDENTITY_LINK_SECRET", version: "7" } } };
  assert.deepEqual(await readProductionDeployment(await write("filled.json", filled)),
    { project: "tibotattle-synthetic-prod", scheduledTriggers: Object.keys(committed.scheduler).sort(),
      identityLinkMount: { secretName: "IDENTITY_LINK_SECRET", version: "7" } });
  // P11's managed set follows the scheduler map, so a trigger C-INFRA adds
  // (maintenance on the fast-path final line) is required without a code change.
  const withMaintenance = { ...filled, scheduler: { ...filled.scheduler,
    maintenance: { name: "tibotattle-maintenance-trigger", schedule: "* * * * *", state: "PAUSED" } } };
  assert.deepEqual((await readProductionDeployment(await write("maintenance.json", withMaintenance))).scheduledTriggers,
    ["analytics-refresh", "maintenance"]);
  // An unpinned mount reads, and P8 refuses it (above); an unfilled project refuses here.
  const unpinned = { ...filled, secrets: { ...filled.secrets, IDENTITY_LINK_SECRET: { secretName: "IDENTITY_LINK_SECRET",
    version: null } } };
  assert.equal((await readProductionDeployment(await write("unpinned.json", unpinned))).identityLinkMount.version, null);
  for (const [name, bad] of [["placeholder", { ...filled, project: null }], ["staging", { ...filled, environment: "staging" }],
    ["schema", { ...filled, schemaVersion: "tibotattle-gcp-ops-infra-desired-state-v1" }],
    ["mount-keys", { ...filled, secrets: { ...filled.secrets, IDENTITY_LINK_SECRET: { secretName: "IDENTITY_LINK_SECRET",
      version: "7", value: "x" } } }],
    ["no-mount", { ...filled, secrets: {} }],
    ["no-scheduler", { ...filled, scheduler: undefined }],
    ["no-refresh-trigger", { ...filled, scheduler: { maintenance: withMaintenance.scheduler.maintenance } }],
    ["scheduler-list", { ...filled, scheduler: ["analytics-refresh"] }],
    ["scheduler-name", { ...filled, scheduler: { ...filled.scheduler, "Not A Job": {} } }]]) {
    await assert.rejects(readProductionDeployment(await write(`${name}.json`, bad)), { code: "CUTOVER_DESIRED_STATE_INVALID" }, name);
  }
  await assert.rejects(readProductionDeployment(join(scratch, "absent.json")), { code: "CUTOVER_DESIRED_STATE_INVALID" });
});

test("P11 accepts only the producer's shape: the managed trigger set, paused, no alert, this project, fresh and strict", () => {
  const appliedMs = Date.parse("2026-10-02T00:00:00.000Z");
  const nowMs = Date.parse("2026-10-02T02:00:00.000Z");
  // probeScheduler's output (gcp-ops-infra-operations.mjs) for the paused production plane.
  const pausedEntry = job => ({ job, name: `tibotattle-${job}-trigger`, desiredState: "PAUSED", liveState: "PAUSED",
    quietMinutes: null, verdict: "paused_as_desired", alert: false });
  const probe = (overrides = {}, managed = REQUIRED_SCHEDULED_TRIGGERS) => ({
    schema: SCHEDULER_PROBE_SCHEMA, environment: "production", project: "tibotattle-synthetic-prod",
    checkedAt: "2026-10-02T00:30:00.000Z", thresholdHours: 6, triggers: managed.map(pausedEntry),
    alert: false, signal: null, ...overrides,
  });
  const bind = { project: "tibotattle-synthetic-prod", managed: [...REQUIRED_SCHEDULED_TRIGGERS], appliedMs, nowMs };
  assert.equal(validateSchedulerEvidence(probe(), bind), REQUIRED_SCHEDULED_TRIGGERS.length);
  // The fast-path final line's set: every managed trigger must be reported, in any order.
  const both = ["analytics-refresh", "maintenance"];
  assert.equal(validateSchedulerEvidence(probe({}, [...both].reverse()), { ...bind, managed: both }), 2);
  for (const [label, value] of Object.entries({
    "maintenance missing": probe({}, ["analytics-refresh"]),
    "maintenance running": probe({ triggers: [pausedEntry("analytics-refresh"),
      { ...pausedEntry("maintenance"), liveState: "ENABLED", verdict: "running" }] }, both),
  })) {
    assert.throws(() => validateSchedulerEvidence(value, { ...bind, managed: both }), { code: "CUTOVER_SCHEDULER_NOT_PAUSED" }, label);
  }
  // The managed set itself must be a set of job names that includes the refresh.
  for (const managed of [undefined, [], ["maintenance"], ["analytics-refresh", "analytics-refresh"], ["Analytics Refresh"]]) {
    assert.throws(() => validateSchedulerEvidence(probe({}, managed ?? []), { ...bind, managed }),
      { code: "CUTOVER_SCHEDULER_NOT_PAUSED" }, JSON.stringify(managed));
  }
  const paused = probe().triggers[0];
  const refusals = {
    "an unmanaged extra trigger": probe({ triggers: [...probe().triggers, { ...paused, job: "synthetic-unmanaged" }] }),
    "a duplicated trigger": probe({ triggers: [paused, paused] }),
    "another trigger in its place": probe({ triggers: [{ ...paused, job: "synthetic-unmanaged" }] }),
    "a missing trigger": probe({ triggers: [] }),
    "a running trigger": probe({ triggers: [{ ...paused, liveState: "ENABLED", verdict: "running" }] }),
    "an absent trigger": probe({ triggers: [{ ...paused, liveState: null, verdict: "absent_not_created" }] }),
    "an alert": probe({ alert: true, signal: "SCHEDULER_TRIGGER_PAUSED_TOO_LONG" }),
    "another project": probe({ project: "tibotattle-other" }),
    "another environment": probe({ environment: "staging" }),
    "another schema": probe({ schema: "tibotattle-gcp-ops-infra-scheduler-probe-v0" }),
    "a lenient instant": probe({ checkedAt: "2026-10-02T00:30:00Z" }),
    "an instant before the fence": probe({ checkedAt: "2026-10-01T23:59:59.999Z" }),
    "an instant in the future": probe({ checkedAt: "2026-10-02T02:00:00.001Z" }),
  };
  for (const [label, value] of Object.entries(refusals)) {
    assert.throws(() => validateSchedulerEvidence(value, bind), { code: "CUTOVER_SCHEDULER_NOT_PAUSED" }, label);
  }
  assert.throws(() => validateSchedulerEvidence(probe(), { ...bind, nowMs: Date.parse("2026-10-02T00:30:00.000Z")
    + SCHEDULER_EVIDENCE_MAXIMUM_AGE_MILLISECONDS + 1 }), { code: "CUTOVER_SCHEDULER_NOT_PAUSED" }, "older than 6 h");
  assert.throws(() => validateSchedulerEvidence(probe(), { ...bind, project: undefined }), { code: "CUTOVER_SCHEDULER_NOT_PAUSED" });
});

// ---------------------------------------------------------------------------
// Parity sample (PT8-E): the selection.

test("the parity sample is deterministic, bounded and forces the densest owner and every family present", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE participants (id TEXT PRIMARY KEY);
    CREATE TABLE telemetry_v1_chunks (participant_id TEXT); CREATE TABLE telemetry_v11_chunks (participant_id TEXT);
    CREATE TABLE telemetry_v12_chunks (participant_id TEXT); CREATE TABLE telemetry_contributions (participant_id TEXT);
    CREATE TABLE storage_v11_owner_links (participant_id TEXT, state TEXT);`);
  for (let index = 0; index < 120; index += 1) database.prepare("INSERT INTO participants VALUES (?)").run(`p-${index}`);
  for (let index = 0; index < 50; index += 1) database.prepare("INSERT INTO telemetry_v11_chunks VALUES ('p-7')").run();
  database.exec(`INSERT INTO telemetry_v12_chunks VALUES ('p-8'); INSERT INTO telemetry_v1_chunks VALUES ('p-9');
    INSERT INTO telemetry_contributions VALUES ('p-10'); INSERT INTO telemetry_contributions VALUES ('p-11');
    INSERT INTO telemetry_v12_chunks VALUES ('p-11'); INSERT INTO storage_v11_owner_links VALUES ('p-12', 'withdrawn');`);
  const first = selectParitySample(database, { sealId: SEAL_ID });
  assert.deepEqual(selectParitySample(database, { sealId: SEAL_ID }), first);
  assert.ok(first.owners.length >= 64 && first.owners.length <= 64 + 7);
  for (const forced of ["p-7", "p-8", "p-9", "p-10", "p-11", "p-12"]) assert.ok(first.owners.includes(forced), forced);
  assert.deepEqual(first.familiesCovered, { "v1.2": true, "v1.1": true, v1: true, "v0.2": true, mixed: true });
  assert.equal(first.inactiveLinkCovered, true);
  assert.notDeepEqual(selectParitySample(database, { sealId: "b".repeat(64) }).owners, first.owners);
  assert.deepEqual(PARITY_CLASSES, ["M1", "M2", "H1", "H2", "E1", "E2"]);
  assert.throws(() => selectParitySample(database, { sealId: "nope" }), { code: "CUTOVER_PARITY_SAMPLE_ARGUMENT_INVALID" });
});

// ---------------------------------------------------------------------------
// Authorization tokens and the finalize order.

test("each protected step has its own exact token, bound to the seal, contract, inputs and its evidence", () => {
  const bindings = { sealId: SEAL_ID, contractId: "prod-target-1", inputsSha256: "c".repeat(64) };
  const tokens = PROTECTED_STEPS.map(step => authorizationToken(step, { ...bindings, evidence: "d".repeat(64) }));
  assert.equal(new Set(tokens).size, PROTECTED_STEPS.length, "a token authorizes one step only");
  const run = authorizationToken("run", { ...bindings, preflightSha256: "e".repeat(64) });
  for (const changed of [{ sealId: "f".repeat(64) }, { contractId: "prod-target-2" }, { inputsSha256: "0".repeat(64) },
    { preflightSha256: "1".repeat(64) }]) {
    assert.notEqual(authorizationToken("run", { ...bindings, preflightSha256: "e".repeat(64), ...changed }), run);
  }
  assert.throws(() => authorizationToken("preflight", bindings), { code: "CUTOVER_ARGUMENT_INVALID" });
  assert.throws(() => authorizationToken("run", { ...bindings, sealId: "x" }), { code: "CUTOVER_ARGUMENT_INVALID" });
});

test("the finalize order refuses every out-of-order step", () => {
  assert.deepEqual(FINALIZE_ORDER, ["preflight", "run", "flip-1", "release-controls", "flip-2", "flip-gate", "mark-live",
    "post-live-check", "report"]);
  const states = [null, "preflight", "importing", "verifying", "verified", "live", "abandoned"];
  const allowed = {
    run: ({ runState, preflight }) => preflight && !["live", "abandoned"].includes(runState),
    "release-controls": ({ runState }) => runState === "verified",
    "flip-gate": ({ runState, released }) => runState === "verified" && released,
    "mark-live": ({ runState, released, flipGate }) => ["verified", "live"].includes(runState) && released && flipGate,
    "post-live-check": ({ runState }) => runState === "live",
    report: ({ runState }) => runState === "live",
    abandon: ({ runState }) => runState !== null && !["live", "abandoned"].includes(runState),
  };
  let cases = 0;
  for (const [step, rule] of Object.entries(allowed)) {
    for (const runState of states) {
      for (const preflight of [false, true]) {
        for (const released of [false, true]) {
          for (const flipGate of [false, true]) {
            const observed = { runState, preflight, released, flipGate };
            const code = codeOf(() => assertStepOrder(step, observed));
            assert.equal(code, rule(observed) ? "RESOLVED" : "CUTOVER_STEP_ORDER_VIOLATION", `${step} ${JSON.stringify(observed)}`);
            cases += 1;
          }
        }
      }
    }
  }
  assert.equal(cases, 7 * 7 * 8);
  assert.equal(codeOf(() => assertStepOrder("unknown", {})), "CUTOVER_ARGUMENT_INVALID");
});

// ---------------------------------------------------------------------------
// The inputs contract and the CLI boundary.

function inputs(overrides = {}) {
  return {
    schema: PRODUCTION_TRANSFER_INPUTS_SCHEMA,
    contractId: "prod-target-1",
    sealId: SEAL_ID,
    sealManifestPath: "/owner/seal/seal-manifest.json",
    expectedSourceCommit: "1".repeat(40),
    fenceReceiptSha256: "2".repeat(64),
    expectedIdentityKeyVersion: "prod-v1",
    deletionDigestProjection: { path: "/owner/deletion-digests.txt", sha256: "3".repeat(64) },
    interimPublicRead: { exportPath: "/owner/own4.json", sha256: "4".repeat(64), capturedAt: "2026-10-01T23:30:00.000Z",
      sourceCommit: "1".repeat(40), evidenceDate: "2026-10-01" },
    schedulerEvidencePath: "/owner/scheduler.json",
    ownerFlags: [OWNER_FLAG_PERFORMANCE_ROUTES_RETIRED],
    allowedRoleMembers: [],
    ...overrides,
  };
}

test("pt8-inputs.json is a closed contract", () => {
  assert.equal(validateTransferInputs(inputs()).contractId, "prod-target-1");
  for (const bad of [{ extra: 1 }, { sealId: "x" }, { sealManifestPath: "relative/path" }, { ownerFlags: ["unknown"] },
    { expectedSourceCommit: "short" }, { allowedRoleMembers: ["a", "a"] },
    { interimPublicRead: { ...inputs().interimPublicRead, capturedAt: "2026-10-01" } },
    { deletionDigestProjection: { path: "/x", sha256: "nope" } }]) {
    assert.throws(() => validateTransferInputs(inputs(bad)), { code: "CUTOVER_INPUTS_INVALID" }, JSON.stringify(bad));
  }
  const missing = inputs();
  delete missing.schedulerEvidencePath;
  assert.throws(() => validateTransferInputs(missing), { code: "CUTOVER_INPUTS_INVALID" });
});

test("the CLI is dry by default: --execute needs --confirm, --confirm needs --execute, flags are closed", async () => {
  assert.equal(parseTransferArguments(["run", "--owner-dir", "/o"])["--execute"], undefined);
  assert.throws(() => parseTransferArguments(["run", "--owner-dir", "/o", "--execute"]), { code: "CUTOVER_AUTHORIZATION_MISMATCH" });
  assert.throws(() => parseTransferArguments(["run", "--owner-dir", "/o", "--confirm", "a"]), { code: "CUTOVER_EXECUTE_REQUIRED" });
  assert.throws(() => parseTransferArguments(["preflight", "--owner-dir", "/o", "--execute"]), { code: "CUTOVER_ARGUMENT_INVALID" });
  assert.throws(() => parseTransferArguments(["run"]), { code: "CUTOVER_ARGUMENT_INVALID" });
  assert.throws(() => parseTransferArguments(["run", "--owner-dir", "/o", "--owner-dir", "/p"]), { code: "CUTOVER_ARGUMENT_INVALID" });
  assert.throws(() => parseTransferArguments(["identity-pin", "--owner-dir", "/o", "--secret", "x"]), { code: "CUTOVER_ARGUMENT_INVALID" });
  assert.throws(() => parseTransferArguments(["release-controls", "--owner-dir", "/o"]), { code: "CUTOVER_ARGUMENT_INVALID" });
  assert.throws(() => parseTransferArguments(["mark-live", "--owner-dir", "/o"]), { code: "CUTOVER_ARGUMENT_INVALID" });
  assert.throws(() => parseTransferArguments(["seal", "--owner-dir", "/o"]), { code: "CUTOVER_ARGUMENT_INVALID" });
  for (const host of ["127.0.0.1", "db.example.invalid", "relative/socket"]) {
    await assert.rejects(connectionOptions({ "--pg-socket": host, "--pg-port": "5432", "--pg-user": "u", "--pg-database": "d" }),
      { code: "CUTOVER_CONNECTION_INVALID" }, host);
  }
  const socket = join(scratch, "socket");
  await mkdir(socket, { mode: 0o700 });
  const ok = await connectionOptions({ "--pg-socket": socket, "--pg-port": "5432", "--pg-user": "u", "--pg-database": "d" });
  assert.equal(ok.port, 5432);
  await chmod(socket, 0o755);
  await assert.rejects(connectionOptions({ "--pg-socket": socket, "--pg-port": "5432", "--pg-user": "u", "--pg-database": "d" }),
    { code: "CUTOVER_CONNECTION_INVALID" }, "a group- or world-readable socket directory");
});

test("errors are closed and content-free on the CLI", () => {
  assert.ok(PRODUCTION_TRANSFER_ERROR_CODES.every(code => /^CUTOVER_[A-Z0-9_]+$/u.test(code)));
  const error = new ProductionTransferError("CUTOVER_STEP_ORDER_VIOLATION", { step: "mark-live", table: "participants",
    secret: SECRET, value: "/Users/someone/private" });
  assert.equal(error.message, "CUTOVER_STEP_ORDER_VIOLATION [step=mark-live table=participants]");
  assert.equal(cliErrorLine(error), JSON.stringify({ error: error.message }));
  assert.equal(cliErrorLine(new Error(`connect failed for ${SECRET} at /Users/someone`)), JSON.stringify({ error: "CUTOVER_ORCHESTRATOR_FAILED" }));
  assert.equal(new ProductionTransferError("NOT_A_CODE").code, "CUTOVER_ARGUMENT_INVALID");
});

test("pinned literals equal their owners: the scheduler probe, the desired state and C-MAINT's migration fence prefix", async () => {
  const probe = await readFile(new URL("./gcp-ops-infra-operations.mjs", import.meta.url), "utf8");
  assert.ok(probe.includes(`GCP_OPS_INFRA_SCHEDULER_PROBE_SCHEMA = "${SCHEDULER_PROBE_SCHEMA}"`));
  // The producer emits one entry per managed trigger, with the plane's project and an alert flag.
  for (const fragment of ["const results = SCHEDULED_JOB_NAMES.map((job) => {", "project: desired.project,",
    "checkedAt: new Date(nowMs).toISOString(),", "alert: results.some((entry) => entry.alert),"]) {
    assert.ok(probe.includes(fragment), fragment);
  }
  const manifest = await readFile(new URL("./gcp-ops-infra-manifest.mjs", import.meta.url), "utf8");
  // P11's managed set is the committed production scheduler map, which must be
  // exactly C-INFRA's SCHEDULED_JOB_NAMES (the set probeScheduler reports).
  const literal = /export const SCHEDULED_JOB_NAMES = Object\.freeze\((\[[^\]]*\])\);/u.exec(manifest);
  assert.ok(literal, "C-INFRA's SCHEDULED_JOB_NAMES literal");
  const scheduledJobNames = JSON.parse(literal[1]);
  const committed = JSON.parse(await readFile(new URL(`../${PRODUCTION_DESIRED_STATE_FILE}`, import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(committed.scheduler).sort(), [...scheduledJobNames].sort(),
    "the committed production scheduler map names exactly C-INFRA's SCHEDULED_JOB_NAMES");
  for (const job of REQUIRED_SCHEDULED_TRIGGERS) assert.ok(scheduledJobNames.includes(job), job);
  assert.ok(manifest.includes(`GCP_OPS_INFRA_DESIRED_STATE_SCHEMA = "${DESIRED_STATE_SCHEMA}"`));
  assert.ok(manifest.includes(`production: "${PRODUCTION_DESIRED_STATE_FILE}"`));
  const lifecycle = await readFile(new URL("../src/postgres-lifecycle-pass.ts", import.meta.url), "utf8");
  assert.ok(lifecycle.includes(`POSTGRES_LIFECYCLE_PASS_MIGRATION_LOCK_PREFIX = "${MIGRATION_FENCE_LOCK_PREFIX}"`));
});
