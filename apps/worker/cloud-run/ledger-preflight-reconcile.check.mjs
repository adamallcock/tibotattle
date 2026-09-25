#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  LEDGER_PREFLIGHT_RECONCILE_IAM_USER,
  LEDGER_PREFLIGHT_RECONCILE_JOB,
  LEDGER_PREFLIGHT_RECONCILE_MIGRATION_ROOT,
  LEDGER_PREFLIGHT_RECONCILE_PROJECT,
  LEDGER_PREFLIGHT_RECONCILE_SERVICE_ACCOUNT,
  LEDGER_PREFLIGHT_RECONCILE_TARGETS,
  parseLedgerPreflightReconcileConfig,
  readAttachedLedgerReconcileServiceAccount,
  reconcileUnprovenCompleteLedgerJobs,
  runLedgerPreflightReconcile,
} from "./ledger-preflight-reconcile.mjs";

const JOB_COUNT = 15;
const EXECUTION = "tibotattle-test-ledger-preflight-reconcile-00001-abc";
const SOURCE_ID = "synthetic:test-source";
const SOURCE_NAMESPACE = "synthetic-test-namespace";
const SOURCE_PIN_SHA256 = createHash("sha256")
  .update(JSON.stringify({ sourceId: SOURCE_ID, namespace: SOURCE_NAMESPACE })).digest("hex");
const TEST_SCHEMAS = Object.freeze({
  primarySchema: "synthetic_reconcile_primary",
  ledgerSchema: "synthetic_reconcile_ledger",
  expectedSourcePinSha256: SOURCE_PIN_SHA256,
});

function validEnv(overrides = {}) {
  return {
    CLOUD_RUN_JOB: LEDGER_PREFLIGHT_RECONCILE_JOB,
    CLOUD_RUN_EXECUTION: EXECUTION,
    CLOUD_RUN_TASK_INDEX: "0",
    CLOUD_RUN_TASK_COUNT: "1",
    CLOUD_RUN_TASK_ATTEMPT: "0",
    GOOGLE_CLOUD_PROJECT: LEDGER_PREFLIGHT_RECONCILE_PROJECT,
    LEDGER_RECONCILE_MODE: "inspect",
    POSTGRES_MIGRATOR_IAM_USER: LEDGER_PREFLIGHT_RECONCILE_IAM_USER,
    PRIMARY_INSTANCE_CONNECTION_NAME: LEDGER_PREFLIGHT_RECONCILE_TARGETS.primary.instanceConnectionName,
    PRIMARY_DATABASE: LEDGER_PREFLIGHT_RECONCILE_TARGETS.primary.database,
    PRIMARY_SCHEMA: LEDGER_PREFLIGHT_RECONCILE_TARGETS.primary.schema,
    LEDGER_INSTANCE_CONNECTION_NAME: LEDGER_PREFLIGHT_RECONCILE_TARGETS.ledger.instanceConnectionName,
    LEDGER_DATABASE: LEDGER_PREFLIGHT_RECONCILE_TARGETS.ledger.database,
    LEDGER_SCHEMA: LEDGER_PREFLIGHT_RECONCILE_TARGETS.ledger.schema,
    ...overrides,
  };
}

function stableOperationId(participantDigest) {
  const source = participantDigest.slice(0, 32).split("");
  source[12] = "4";
  source[16] = ((Number.parseInt(source[16], 16) & 0x3) | 0x8).toString(16);
  const hex = source.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function expectedMigrations() {
  return Array.from({ length: 6 }, (_, index) => ({
    role: "ledger",
    version: index + 1,
    name: `${String(index + 1).padStart(4, "0")}_migration_${index + 1}.sql`,
    sha256: String(index + 1).repeat(64),
  }));
}

function makeState({ poststate = false } = {}) {
  const jobs = Array.from({ length: JOB_COUNT }, (_, index) => {
    const digest = (index + 1).toString(16).padStart(2, "0").repeat(32);
    const ownerDigest = (index + 32).toString(16).padStart(2, "0").repeat(32);
    return {
      participant_digest: digest,
      source_id: SOURCE_ID,
      owner_digest: ownerDigest,
      state: poststate ? "pending" : "complete",
      terminal_is_null: true,
      completed_at_utc: poststate ? null : `2026-09-25T00:00:${String(index).padStart(2, "0")}.000000Z`,
    };
  });
  const matchingReceipts = jobs.map((job) => ({
    participant_digest: job.participant_digest,
    operation_id: stableOperationId(job.participant_digest),
    outcome: "completed",
    details_json: JSON.stringify({
      schemaVersion: "postgres-synthetic-owner-erasure-v1",
      phase: "completed",
      ownerDigest: job.owner_digest,
      objectCount: 0,
    }),
    has_completion_time: true,
  }));
  return { jobs, receipts: [], matchingReceipts, updated: 0, rollbackCount: 0, unlockCount: 0 };
}

function result(rows) {
  return { rows, rowCount: rows.length };
}

function makePools(state, { badReceipt = false, sourceMismatch = false, invalidMetadata = false,
  unexpectedV1Admission = false, multipleNamespaces = false, missingPrimarySource = false } = {}) {
  const events = [];
  let primaryReleaseCount = 0;
  let ledgerReleaseCount = 0;
  const primaryPool = {
    async connect() {
      return {
        async query(sql) {
          events.push({ role: "primary", sql });
          if (sql.includes("AS source_pin_rows")) {
            return result([{
              source_pin_rows: missingPrimarySource ? "0" : "1",
              v1_admission_rows: unexpectedV1Admission ? "1" : "0",
              v11_admission_rows: "0",
              source_id: missingPrimarySource ? null : SOURCE_ID,
              server_version_num: 170006,
            }]);
          }
          return result([]);
        },
        release() { primaryReleaseCount += 1; },
      };
    },
  };
  const ledgerPool = {
    async connect() {
      return {
        async query(sql) {
          events.push({ role: "ledger", sql });
          if (sql.startsWith("SELECT pg_try_advisory_lock")) return result([{ acquired: true }]);
          if (sql.startsWith("SELECT pg_advisory_unlock")) {
            state.unlockCount += 1;
            return result([{ released: true }]);
          }
          if (sql.startsWith("SELECT current_setting")) return result([{ server_version_num: 170006 }]);
          if (sql.startsWith("SELECT version, name, checksum_sha256")) {
            const rows = expectedMigrations().slice(0, 5).map(({ version, name, sha256 }) => ({
              version,
              name,
              checksum_sha256: badReceipt && version === 3 ? "f".repeat(64) : sha256,
            }));
            return result(rows);
          }
          if (sql.includes("AS namespace_count")) {
            return result([{ namespace_count: multipleNamespaces ? "2" : "1", namespace: SOURCE_NAMESPACE }]);
          }
          if (sql.includes("AS mismatches")) return result([{ mismatches: sourceMismatch ? "1" : "0" }]);
          if (sql.includes("AS completed_at_utc")) return result(state.jobs.map((row) => ({ ...row })));
          if (sql.includes("AS has_completion_time")) return result(state.receipts.map((row) => ({ ...row })));
          if (sql.includes("AS invalid_state_timestamp")) {
            const completeUnproven = state.jobs.filter((row) => row.state === "complete"
              && row.terminal_is_null && row.completed_at_utc !== null).length;
            const pendingUnverified = state.jobs.filter((row) => row.state === "pending"
              && row.terminal_is_null && row.completed_at_utc === null).length;
            return result([{
              total_rows: String(state.jobs.length),
              complete_unproven: String(completeUnproven),
              pending_unverified: String(pendingUnverified),
              invalid_state_timestamp: "0",
              invalid_source_namespace: "0",
              invalid_source_id: "0",
              invalid_terminal_json: "0",
              missing_tombstone_parent: "0",
            }]);
          }
          if (sql.includes("AS invalid_tombstones")) {
            return result([{ invalid_tombstones: invalidMetadata ? "1" : "0", invalid_cooldowns: "0" }]);
          }
          if (sql.trimStart().startsWith("UPDATE ")) {
            state.updated = state.jobs.filter((row) => row.state === "complete" && row.terminal_is_null).length;
            for (const row of state.jobs) {
              row.state = "pending";
              row.completed_at_utc = null;
            }
            return result(Array.from({ length: state.updated }, () => ({ changed: 1 })));
          }
          if (sql === "ROLLBACK") state.rollbackCount += 1;
          return result([]);
        },
        release() { ledgerReleaseCount += 1; },
      };
    },
  };
  return {
    primaryPool,
    ledgerPool,
    events,
    get primaryReleaseCount() { return primaryReleaseCount; },
    get ledgerReleaseCount() { return ledgerReleaseCount; },
  };
}

function reconcile(state, overrides = {}) {
  const pools = makePools(state, overrides);
  return {
    state,
    pools,
    promise: reconcileUnprovenCompleteLedgerJobs({
      primaryPool: pools.primaryPool,
      ledgerPool: pools.ledgerPool,
      ...TEST_SCHEMAS,
      expectedLedgerMigrations: expectedMigrations(),
      mode: "apply",
    }),
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

test("configuration is restricted to the fixed single-task test databases and migrator", () => {
  const config = parseLedgerPreflightReconcileConfig(validEnv(), LEDGER_PREFLIGHT_RECONCILE_SERVICE_ACCOUNT);
  assert.equal(config.primary.database, "tibotattle");
  assert.equal(config.ledger.database, "tibotattle_ledger");
  for (const overrides of [
    { CLOUD_RUN_JOB: "another-job" },
    { GOOGLE_CLOUD_PROJECT: "production" },
    { CLOUD_RUN_TASK_COUNT: "2" },
    { CLOUD_RUN_TASK_ATTEMPT: "1" },
    { PRIMARY_DATABASE: "production" },
    { LEDGER_SCHEMA: "another_schema" },
    { LEDGER_INSTANCE_CONNECTION_NAME: "production:us-east1:db" },
    { POSTGRES_MIGRATOR_IAM_USER: "other@tibotattle.iam" },
    { K_SERVICE: "tibotattle-test-app" },
  ]) {
    assert.throws(() => parseLedgerPreflightReconcileConfig(validEnv(overrides),
      LEDGER_PREFLIGHT_RECONCILE_SERVICE_ACCOUNT));
  }
  expectCode(() => parseLedgerPreflightReconcileConfig(validEnv(), "other@tibotattle.iam.gserviceaccount.com"),
    "CLOUD_RUN_TEST_LEDGER_RECONCILE_SERVICE_ACCOUNT_INVALID");
});

test("metadata identity read requires Google's metadata marker", async () => {
  let request;
  const resultEmail = await readAttachedLedgerReconcileServiceAccount({
    async fetchImpl(url, options) {
      request = { url, options };
      return {
        status: 200,
        headers: { get: (name) => name === "Metadata-Flavor" ? "Google" : null },
        async text() { return LEDGER_PREFLIGHT_RECONCILE_SERVICE_ACCOUNT; },
      };
    },
  });
  assert.equal(resultEmail, LEDGER_PREFLIGHT_RECONCILE_SERVICE_ACCOUNT);
  assert.equal(request.options.headers["Metadata-Flavor"], "Google");
});

test("exact 15-row test-only prestate is reopened without creating proof or deleting tombstones", async () => {
  const state = makeState();
  const { pools, promise } = reconcile(state);
  const receipt = await promise;
  assert.equal(state.updated, JOB_COUNT);
  assert.equal(receipt.status, "pending_unverified");
  assert.equal(receipt.mode, "reconciled");
  assert.equal(receipt.jobsBefore, JOB_COUNT);
  assert.equal(receipt.jobsAfter, JOB_COUNT);
  assert.equal(receipt.jobsReopened, JOB_COUNT);
  assert.equal(receipt.jobsPendingUnverified, JOB_COUNT);
  assert.equal(receipt.tombstoneParentsPreserved, JOB_COUNT);
  assert.equal(receipt.ownerCompletionReceiptsMatched, 0);
  assert.equal(receipt.sourceIdNamespaceMatches, JOB_COUNT);
  assert.match(receipt.prestateSha256, /^[0-9a-f]{64}$/u);
  assert.match(receipt.poststateSha256, /^[0-9a-f]{64}$/u);
  assert.equal(receipt.sourcePinSha256, createHash("sha256")
    .update(JSON.stringify({ sourceId: SOURCE_ID, namespace: SOURCE_NAMESPACE })).digest("hex"));
  assert.notEqual(receipt.prestateSha256, receipt.poststateSha256);
  assert.equal(receipt.terminalProofCreated, false);
  assert.equal(receipt.terminalJsonChanged, false);
  assert.equal(receipt.tombstonesDeleted, 0);
  assert.equal(receipt.payloadDeletionAttempted, false);
  assert.equal(receipt.legacyAnalyticsCompletionClaimed, false);
  assert.ok(state.jobs.every((row) => row.state === "pending" && row.terminal_is_null
    && row.completed_at_utc === null));
  assert.equal(pools.primaryReleaseCount, 1);
  assert.equal(pools.ledgerReleaseCount, 1);
  assert.equal(state.unlockCount, 1);
  const json = JSON.stringify(receipt);
  assert.doesNotMatch(json, /participant_digest|owner_digest|source_id|synthetic:test-source/u);
});

test("read-only inspect applies the same guards and returns digests without issuing UPDATE", async () => {
  const state = makeState();
  const pools = makePools(state);
  const receipt = await reconcileUnprovenCompleteLedgerJobs({
    primaryPool: pools.primaryPool,
    ledgerPool: pools.ledgerPool,
    ...TEST_SCHEMAS,
    expectedLedgerMigrations: expectedMigrations(),
    mode: "inspect",
  });
  assert.equal(receipt.status, "inspection_only");
  assert.equal(receipt.action, "inspect");
  assert.equal(receipt.mode, "prestate_qualified");
  assert.equal(receipt.jobsBefore, JOB_COUNT);
  assert.equal(receipt.jobsAfter, JOB_COUNT);
  assert.equal(receipt.jobsReopened, 0);
  assert.equal(receipt.jobsThatWouldReopen, JOB_COUNT);
  assert.equal(receipt.prestateSha256, receipt.poststateSha256);
  assert.match(receipt.sourcePinSha256, /^[0-9a-f]{64}$/u);
  assert.equal(state.updated, 0);
  assert.ok(pools.events.some(({ sql }) => sql.includes("READ ONLY DEFERRABLE")));
  assert.ok(!pools.events.some(({ sql }) => sql.startsWith("UPDATE ")));
});

test("an exact poststate replay is idempotent and produces equal before/after digests", async () => {
  const state = makeState({ poststate: true });
  const { promise } = reconcile(state);
  const receipt = await promise;
  assert.equal(receipt.mode, "already_reconciled");
  assert.equal(receipt.jobsReopened, 0);
  assert.equal(receipt.prestateSha256, receipt.poststateSha256);
  assert.equal(state.updated, 0);
});

test("wrong checksum, source pin, unexpected owner proof, row drift, and metadata violations fail closed", async (t) => {
  const cases = [
    ["migration checksum drift", () => reconcile(makeState(), { badReceipt: true }),
      "POSTGRES_TEST_LEDGER_RECONCILE_MIGRATION_RECEIPTS_INVALID"],
    ["source pin mismatch", () => reconcile(makeState(), { sourceMismatch: true }),
      "POSTGRES_TEST_LEDGER_RECONCILE_SOURCE_PIN_INVALID"],
    ["multiple ledger namespaces", () => reconcile(makeState(), { multipleNamespaces: true }),
      "POSTGRES_TEST_LEDGER_RECONCILE_SOURCE_PIN_INVALID"],
    ["unexpected synthetic owner completion receipt", () => {
      const state = makeState();
      state.receipts.push(state.matchingReceipts[0]);
      return reconcile(state);
    }, "POSTGRES_TEST_LEDGER_RECONCILE_SYNTHETIC_COHORT_INVALID"],
    ["job count drift", () => {
      const state = makeState();
      state.jobs.pop();
      return reconcile(state);
    }, "POSTGRES_TEST_LEDGER_RECONCILE_SYNTHETIC_COHORT_INVALID"],
    ["unrelated 0006 metadata violation", () => reconcile(makeState(), { invalidMetadata: true }),
      "POSTGRES_TEST_LEDGER_RECONCILE_PRESTATE_UNEXPECTED"],
  ];
  for (const [name, make, code] of cases) {
    await t.test(name, async () => {
      const prepared = make();
      await assert.rejects(prepared.promise, (error) => {
        assert.equal(error?.code, code);
        if (name === "migration checksum drift") assert.equal(error.safeCounts?.migrationReceiptsMatched, 4);
        if (name === "unexpected synthetic owner completion receipt") assert.equal(error.safeCounts?.syntheticReceiptMatches, 1);
        if (name === "job count drift") assert.equal(error.safeCounts?.jobsTotal, 14);
        return true;
      });
      assert.equal(prepared.state.updated, 0);
      assert.equal(prepared.pools.ledgerReleaseCount, 1);
    });
  }
});

test("inspection refuses unexpected legacy admission state and reports safe counts", async () => {
  const state = makeState();
  const pools = makePools(state, { unexpectedV1Admission: true });
  await assert.rejects(reconcileUnprovenCompleteLedgerJobs({
    primaryPool: pools.primaryPool,
    ledgerPool: pools.ledgerPool,
    ...TEST_SCHEMAS,
    expectedLedgerMigrations: expectedMigrations(),
    mode: "inspect",
  }), (error) => {
    assert.equal(error?.code, "POSTGRES_TEST_LEDGER_RECONCILE_SOURCE_PIN_INVALID");
    assert.deepEqual({ ...error?.safeCounts }, { sourcePinRows: 1, v1AdmissionRows: 1, v11AdmissionRows: 0 });
    assert.doesNotMatch(JSON.stringify(error), /synthetic:test-source|synthetic-test-namespace/u);
    return true;
  });
  assert.equal(state.updated, 0);
});

test("inspection refuses a changed maintenance source fingerprint or missing primary source", async () => {
  const state = makeState();
  const pools = makePools(state);
  await assert.rejects(reconcileUnprovenCompleteLedgerJobs({
    primaryPool: pools.primaryPool,
    ledgerPool: pools.ledgerPool,
    ...TEST_SCHEMAS,
    expectedSourcePinSha256: "f".repeat(64),
    expectedLedgerMigrations: expectedMigrations(),
    mode: "inspect",
  }), (error) => error?.code === "POSTGRES_TEST_LEDGER_RECONCILE_SOURCE_PIN_INVALID"
    && error.safeCounts?.ledgerNamespaceCount === 1);
  assert.equal(state.updated, 0);

  const missing = makePools(makeState(), { missingPrimarySource: true });
  await assert.rejects(reconcileUnprovenCompleteLedgerJobs({
    primaryPool: missing.primaryPool,
    ledgerPool: missing.ledgerPool,
    ...TEST_SCHEMAS,
    expectedLedgerMigrations: expectedMigrations(),
    mode: "inspect",
  }), (error) => error?.code === "POSTGRES_TEST_LEDGER_RECONCILE_SOURCE_PIN_INVALID"
    && error.safeCounts?.sourcePinRows === 0);
});

test("runner rejects invalid job context before metadata or database access", async () => {
  let metadataCalls = 0;
  let connectorCalls = 0;
  await assert.rejects(runLedgerPreflightReconcile({
    env: validEnv({ LEDGER_DATABASE: "production" }),
    dependencies: {
      async readServiceAccountEmail() { metadataCalls += 1; return LEDGER_PREFLIGHT_RECONCILE_SERVICE_ACCOUNT; },
      createConnector() { connectorCalls += 1; return {}; },
    },
  }), (error) => error?.code === "POSTGRES_TEST_LEDGER_RECONCILE_TARGET_INVALID");
  assert.equal(metadataCalls, 0);
  assert.equal(connectorCalls, 0);
});

test("bundled entrypoint refuses to run outside the named one-task test job", () => {
  const built = spawnSync(process.execPath, ["./build.mjs"], {
    cwd: new URL(".", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(built.status, 0, built.stderr);
  const invoked = spawnSync(process.execPath, ["./dist/ledger-preflight-reconcile.mjs"], {
    cwd: new URL(".", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, CLOUD_RUN_JOB: "invalid-job" },
  });
  assert.equal(invoked.status, 1);
  const lines = invoked.stderr.trim().split("\n");
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{
    status: "error",
    code: "CLOUD_RUN_TEST_LEDGER_RECONCILE_JOB_CONTEXT_INVALID",
  }]);
});

test("bundled reconciliation manifest uses the pinned runtime migration directory", async () => {
  assert.equal(LEDGER_PREFLIGHT_RECONCILE_MIGRATION_ROOT, "/app/apps/worker/postgres/migrations");
  const bundled = await import(new URL("./dist/ledger-preflight-reconcile.mjs", import.meta.url));
  const workerMigrations = new URL("../postgres/migrations", import.meta.url).pathname;
  const manifest = await bundled.buildLedgerPreflightReconcileManifest({ rootDirectory: workerMigrations });
  assert.equal(manifest.roles.ledger.length, 6);
  assert.equal(manifest.roles.ledger[4]?.name, "0005_readiness_generation.sql");
});
