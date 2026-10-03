#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";
import { readPostgresMigrations, POSTGRES_MIGRATION_ROOT } from "./postgres-migrations.mjs";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./cloud-run-iam-test-target.mjs";
import {
  parseTestActivationConfig,
  runTestActivation,
  activationErrorReceipt,
  TEST_ACTIVATION_IAM_USER,
  TEST_ACTIVATION_JOB,
  TEST_ACTIVATION_SERVICE_ACCOUNT,
  TEST_ACTIVATION_TARGET,
} from "./test-activation.mjs";

const EXECUTION = "tibotattle-v12-test-activate-20260924-abc12";

function validEnv(overrides = {}) {
  return {
    CLOUD_RUN_JOB: TEST_ACTIVATION_JOB,
    CLOUD_RUN_EXECUTION: EXECUTION,
    CLOUD_RUN_TASK_INDEX: "0",
    CLOUD_RUN_TASK_COUNT: "1",
    CLOUD_RUN_TASK_ATTEMPT: "0",
    GOOGLE_CLOUD_PROJECT: CLOUD_RUN_IAM_TEST_TARGET.project,
    POSTGRES_MIGRATOR_IAM_USER: TEST_ACTIVATION_IAM_USER,
    PRIMARY_INSTANCE_CONNECTION_NAME: TEST_ACTIVATION_TARGET.instanceConnectionName,
    PRIMARY_DATABASE: TEST_ACTIVATION_TARGET.database,
    PRIMARY_SCHEMA: TEST_ACTIVATION_TARGET.schema,
    ...overrides,
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

function initialState() {
  return {
    legacy: { id: 1, state: "staged", revision: 0 },
    typed: {
      id: 1,
      schema_version: "telemetry-contribution-v1.2",
      envelope_schema_version: "telemetry-envelope-v1.2",
      field_dictionary_version: "telemetry-v1.2-registry-2026-09-20.1",
      privacy_contract_version: "ongoing-privacy-safe-telemetry-v1.2",
      state: "staged",
      policy_revision: 1,
      max_day_chunks: 4096,
      max_chunk_records: 200,
      max_day_bytes: 64_000_000,
    },
    controls: {
      singleton: 1,
      revision: 1,
      control_state: "contained",
      enrollment_enabled: false,
      upload_registration_enabled: false,
      processing_enabled: false,
      publication_enabled: false,
      reason_code: null,
    },
  };
}

function activeState() {
  return {
    legacy: { id: 1, state: "active", revision: 1 },
    typed: {
      ...initialState().typed,
      state: "active",
    },
    controls: {
      singleton: 1,
      revision: 2,
      control_state: "degraded",
      enrollment_enabled: false,
      upload_registration_enabled: true,
      processing_enabled: true,
      publication_enabled: false,
      reason_code: "synthetic_v12_test_upload_only",
    },
  };
}

function legacyActiveOperationalState() {
  return {
    legacy: { id: 1, state: "active", revision: 1 },
    typed: { ...initialState().typed, state: "staged" },
    controls: {
      singleton: 1,
      revision: 14,
      control_state: "operational",
      enrollment_enabled: true,
      upload_registration_enabled: true,
      processing_enabled: true,
      publication_enabled: true,
      reason_code: "drill_restore",
    },
  };
}

function activeRevision15State() {
  return {
    ...activeState(),
    controls: {
      ...activeState().controls,
      revision: 15,
    },
  };
}

function makeHarness({ start = initialState(), badReceipt = false } = {}) {
  const state = structuredClone(start);
  const events = [];
  const migrations = awaitableMigrations;
  let connectorCount = 0;
  let poolCount = 0;
  let cleanupCount = 0;
  let updateCount = 0;
  let transactionSnapshot;
  const client = {
    async query(sql) {
      events.push(sql);
      if (sql === "BEGIN") {
        transactionSnapshot = structuredClone(state);
        return { rows: [], rowCount: 0 };
      }
      if (sql === "COMMIT") return { rows: [], rowCount: 0 };
      if (sql === "ROLLBACK") {
        Object.assign(state, structuredClone(transactionSnapshot));
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SET LOCAL")) return { rows: [], rowCount: 0 };
      if (sql.includes("current_setting('server_version_num')")) {
        return { rows: [{ server_version_num: 170000 }], rowCount: 1 };
      }
      if (sql.includes("_tibotattle_migration_history")) {
        const rows = migrations.map(({ version, name, sha256 }) => ({
          version,
          name,
          checksum_sha256: badReceipt && version === 1 ? "f".repeat(64) : sha256,
        }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes(`FROM "${TEST_ACTIVATION_TARGET.schema}"."telemetry_v12_runtime"`)) {
        return { rows: [{ ...state.legacy }], rowCount: 1 };
      }
      if (sql.includes(`FROM "${TEST_ACTIVATION_TARGET.schema}"."telemetry_v12_typed_runtime"`)) {
        return { rows: [{ ...state.typed }], rowCount: 1 };
      }
      if (sql.includes(`FROM "${TEST_ACTIVATION_TARGET.schema}"."collection_controls"`)) {
        return { rows: [{ ...state.controls }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE ") && sql.includes("telemetry_v12_runtime")) {
        state.legacy = { ...state.legacy, state: "active", revision: 1 };
        updateCount += 1;
        return { rows: [{ id: 1 }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE ") && sql.includes("telemetry_v12_typed_runtime")) {
        state.typed = { ...state.typed, state: "active" };
        updateCount += 1;
        return { rows: [{ id: 1 }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE ") && sql.includes("collection_controls")) {
        state.controls = {
          singleton: 1,
          revision: sql.includes("revision=14") ? 15 : 2,
          control_state: "degraded",
          enrollment_enabled: false,
          upload_registration_enabled: true,
          processing_enabled: true,
          publication_enabled: false,
          reason_code: "synthetic_v12_test_upload_only",
        };
        updateCount += 1;
        return { rows: [{ singleton: 1 }], rowCount: 1 };
      }
      throw Object.assign(new Error("unexpected test query"), { code: "unexpected" });
    },
    async release(discard = false) { events.push(`RELEASE:${discard}`); },
  };
  const pool = {
    async connect() { events.push("CONNECT"); return client; },
  };
  return {
    state,
    events,
    dependencies: {
      async readServiceAccountEmail() { return TEST_ACTIVATION_SERVICE_ACCOUNT; },
      async readPrimaryMigrations({ role, rootDirectory }) {
        assert.equal(role, "primary");
        assert.equal(rootDirectory, "/app/apps/worker/postgres/migrations");
        return migrations;
      },
      createConnector() { connectorCount += 1; return { testConnector: true }; },
      async createIamPool(options) {
        poolCount += 1;
        assert.equal(options.instanceConnectionName, TEST_ACTIVATION_TARGET.instanceConnectionName);
        assert.equal(options.database, TEST_ACTIVATION_TARGET.database);
        assert.equal(options.user, TEST_ACTIVATION_IAM_USER);
        assert.equal(options.max, 1);
        assert.equal(options.applicationName, "tibotattle-test-v12-activation");
        return pool;
      },
      async closeResources({ pools, connector }) {
        cleanupCount += 1;
        assert.deepEqual(pools, [pool]);
        assert.equal(connector?.testConnector, true);
      },
    },
    get connectorCount() { return connectorCount; },
    get poolCount() { return poolCount; },
    get cleanupCount() { return cleanupCount; },
    get updateCount() { return updateCount; },
  };
}

let awaitableMigrations;
awaitableMigrations = await readPostgresMigrations({
  role: "primary",
  rootDirectory: POSTGRES_MIGRATION_ROOT,
});

test("configuration pins the activation job, one-task execution, migrator, and primary target", () => {
  const parsed = parseTestActivationConfig(validEnv(), TEST_ACTIVATION_SERVICE_ACCOUNT);
  assert.equal(parsed.job, TEST_ACTIVATION_JOB);
  assert.equal(parsed.project, CLOUD_RUN_IAM_TEST_TARGET.project);
  assert.equal(parsed.iamUser, TEST_ACTIVATION_IAM_USER);
  assert.equal(awaitableMigrations.length, 68);
  for (const overrides of [
    { CLOUD_RUN_JOB: "another-job" },
    { CLOUD_RUN_EXECUTION: "" },
    { CLOUD_RUN_TASK_INDEX: "1" },
    { CLOUD_RUN_TASK_COUNT: "2" },
    { CLOUD_RUN_TASK_ATTEMPT: "1" },
    { GOOGLE_CLOUD_PROJECT: "another-project" },
    { K_SERVICE: "tibotattle-test-app" },
    { POSTGRES_MIGRATOR_IAM_USER: "other@other.iam" },
    { PRIMARY_INSTANCE_CONNECTION_NAME: "another-project:us-east1:db" },
    { PRIMARY_DATABASE: "production" },
    { PRIMARY_SCHEMA: "public" },
  ]) {
    assert.throws(() => parseTestActivationConfig(validEnv(overrides), TEST_ACTIVATION_SERVICE_ACCOUNT));
  }
  expectCode(
    () => parseTestActivationConfig(validEnv(), "other@tibotattle.iam.gserviceaccount.com"),
    "CLOUD_RUN_TEST_ACTIVATION_SERVICE_ACCOUNT_INVALID",
  );
});

test("wrong config or attached service identity stops before connector and PostgreSQL", async () => {
  const invalid = makeHarness();
  await assert.rejects(
    runTestActivation({ env: validEnv({ PRIMARY_DATABASE: "production" }), dependencies: invalid.dependencies }),
    { code: "POSTGRES_TEST_ACTIVATION_TARGET_CONFIGURATION_INVALID" },
  );
  assert.equal(invalid.connectorCount, 0);
  assert.equal(invalid.events.length, 0);

  const wrongIdentity = makeHarness();
  wrongIdentity.dependencies.readServiceAccountEmail = async () => "other@tibotattle.iam.gserviceaccount.com";
  await assert.rejects(
    runTestActivation({ env: validEnv(), dependencies: wrongIdentity.dependencies }),
    { code: "CLOUD_RUN_TEST_ACTIVATION_SERVICE_ACCOUNT_INVALID" },
  );
  assert.equal(wrongIdentity.connectorCount, 0);
  assert.equal(wrongIdentity.events.length, 0);
});

test("activation atomically changes both runtime rows and only the narrow v1.2 controls", async () => {
  const harness = makeHarness();
  const receipt = await runTestActivation({ env: validEnv(), dependencies: harness.dependencies });
  assert.deepEqual(receipt, {
    status: "ok",
    mode: "activate_v12_test",
    job: TEST_ACTIVATION_JOB,
    migrationReceipt: { primaryVersion: 68 },
    changed: true,
    runtimes: { legacy: "active", typed: "active" },
    collectionControls: {
      state: "degraded",
      revision: 2,
      enrollment: false,
      uploadRegistration: true,
      processing: true,
      publication: false,
    },
  });
  assert.deepEqual(harness.state, activeState());
  assert.equal(harness.updateCount, 3);
  assert.equal(harness.cleanupCount, 1);
  assert.equal(harness.events.filter((sql) => sql === "COMMIT").length, 1);
  assert.equal(harness.events.filter((sql) => sql.includes("UPDATE ")).length, 3);
  assert.equal(harness.events.some((sql) => sql.includes("telemetry_transport_formats")), false);
  assert.equal(JSON.stringify(receipt).includes(TEST_ACTIVATION_IAM_USER), false);
});

test("already activated exact revision-2 and revision-15 states are idempotent", async () => {
  const active = makeHarness({ start: activeState() });
  const receipt = await runTestActivation({ env: validEnv(), dependencies: active.dependencies });
  assert.equal(receipt.changed, false);
  assert.equal(active.updateCount, 0);

  const active15 = makeHarness({ start: activeRevision15State() });
  const receipt15 = await runTestActivation({ env: validEnv(), dependencies: active15.dependencies });
  assert.equal(receipt15.changed, false);
  assert.equal(receipt15.collectionControls.revision, 15);
  assert.equal(active15.updateCount, 0);
});

test("legacy active revision 1 with exact operational revision 14 recovers atomically to revision 15", async () => {
  const start = legacyActiveOperationalState();
  start.controls.reason_code = "maintenance";
  const harness = makeHarness({ start });
  const receipt = await runTestActivation({ env: validEnv(), dependencies: harness.dependencies });
  assert.equal(receipt.changed, true);
  assert.equal(receipt.collectionControls.revision, 15);
  assert.deepEqual(harness.state, activeRevision15State());
  assert.equal(harness.updateCount, 2);
  assert.equal(harness.events.filter((sql) => sql.includes("UPDATE ")).length, 2);
  assert.equal(harness.events.some((sql) => sql.startsWith("UPDATE ")
    && sql.includes('"telemetry_v12_runtime"')), false);
  assert.equal(harness.events.some((sql) => sql.includes("reason_code='maintenance'")), true);
  assert.equal(harness.events.filter((sql) => sql === "COMMIT").length, 1);

  const retry = await runTestActivation({ env: validEnv(), dependencies: harness.dependencies });
  assert.equal(retry.changed, false);
  assert.equal(retry.collectionControls.revision, 15);
  assert.equal(harness.updateCount, 2);
  assert.equal(harness.events.filter((sql) => sql === "COMMIT").length, 2);
});

test("nearby recovery drift and maintenance fence roll back before any update", async () => {
  const mismatches = [
    { ...legacyActiveOperationalState(), controls: { ...legacyActiveOperationalState().controls, revision: 13, reason_code: "maintenance" } },
    { ...legacyActiveOperationalState(), controls: { ...legacyActiveOperationalState().controls, publication_enabled: false, reason_code: "maintenance" } },
    { ...legacyActiveOperationalState(), controls: { ...legacyActiveOperationalState().controls, reason_code: "drill_restore" } },
    { ...legacyActiveOperationalState(), typed: { ...legacyActiveOperationalState().typed, policy_revision: 2 } },
    { ...initialState(), controls: { ...initialState().controls, reason_code: "maintenance" } },
  ];
  for (const start of mismatches) {
    const harness = makeHarness({ start });
    await assert.rejects(
      runTestActivation({ env: validEnv(), dependencies: harness.dependencies }),
      { code: "POSTGRES_TEST_ACTIVATION_STATE_UNEXPECTED" },
    );
    assert.equal(harness.updateCount, 0);
    assert.equal(harness.events.includes("COMMIT"), false);
    assert.equal(harness.events.includes("ROLLBACK"), true);
    assert.equal(harness.cleanupCount, 1);
  }
});

test("other partial and unexpected initial states never update", async () => {

  const invalidStates = [
    { ...initialState(), controls: { ...initialState().controls, revision: 0 } },
    { ...initialState(), controls: { ...initialState().controls, control_state: "degraded" } },
    { ...initialState(), legacy: { id: 1, state: "active", revision: 1 } },
    { ...initialState(), typed: { ...initialState().typed, policy_revision: 2 } },
    { ...activeState(), controls: { ...activeState().controls, enrollment_enabled: true } },
    { ...legacyActiveOperationalState(), controls: { ...legacyActiveOperationalState().controls, revision: 16 } },
  ];
  for (const start of invalidStates) {
    const harness = makeHarness({ start });
    await assert.rejects(
      runTestActivation({ env: validEnv(), dependencies: harness.dependencies }),
      { code: "POSTGRES_TEST_ACTIVATION_STATE_UNEXPECTED" },
    );
    assert.equal(harness.updateCount, 0);
    assert.equal(harness.cleanupCount, 1);
    assert.equal(harness.events.includes("COMMIT"), false);
  }
});

test("unexpected singleton state reports only safe, allowlisted field names", async () => {
  const harness = makeHarness({
    start: {
      ...activeRevision15State(),
      controls: { ...activeRevision15State().controls, reason_code: "maintenance" },
    },
  });
  await assert.rejects(
    runTestActivation({ env: validEnv(), dependencies: harness.dependencies }),
    (error) => {
      assert.equal(error.code, "POSTGRES_TEST_ACTIVATION_STATE_UNEXPECTED");
      assert.deepEqual(error.stateMismatchFields, ["controls.reason_code"]);
      const receipt = activationErrorReceipt(error);
      assert.deepEqual(receipt, {
        status: "error",
        code: "POSTGRES_TEST_ACTIVATION_STATE_UNEXPECTED",
        stateMismatchFields: ["controls.reason_code"],
        stateSnapshot: {
          legacy: { state: "active", revision: "1" },
          typed: { state: "active" },
          controls: {
          control_state: "degraded",
          revision: "15",
          enrollment_enabled: false,
          upload_registration_enabled: true,
          processing_enabled: true,
          publication_enabled: false,
          },
        },
      });
      assert.equal(JSON.stringify(receipt).includes("telemetry-v1.2-registry"), false);
      assert.equal(JSON.stringify(receipt).includes("maintenance"), false);
      return true;
    },
  );
  assert.equal(harness.updateCount, 0);
  assert.equal(harness.events.includes("COMMIT"), false);

  assert.deepEqual(activationErrorReceipt({
    code: "POSTGRES_TEST_ACTIVATION_STATE_UNEXPECTED",
    stateMismatchFields: ["typed.policy_revision", "secret-value"],
  }), {
    status: "error",
    code: "POSTGRES_TEST_ACTIVATION_STATE_UNEXPECTED",
  });

  const invalidStateReceipt = activationErrorReceipt({
    code: "POSTGRES_TEST_ACTIVATION_STATE_UNEXPECTED",
    stateMismatchFields: ["typed.state"],
    stateSnapshot: {
      legacy: { state: "private-identity", revision: "1" },
      typed: { state: "staged" },
      controls: {
        control_state: "operational",
        revision: "7",
        enrollment_enabled: true,
        upload_registration_enabled: true,
        processing_enabled: true,
        publication_enabled: true,
      },
    },
  });
  assert.equal(Object.hasOwn(invalidStateReceipt, "stateSnapshot"), false);
});

test("migration receipt drift refuses activation and rolls back", async () => {
  const harness = makeHarness({ badReceipt: true });
  await assert.rejects(
    runTestActivation({ env: validEnv(), dependencies: harness.dependencies }),
    { code: "POSTGRES_TEST_ACTIVATION_MIGRATION_RECEIPT_MISMATCH" },
  );
  assert.equal(harness.updateCount, 0);
  assert.equal(harness.events.includes("ROLLBACK"), true);
  assert.equal(harness.events.includes("COMMIT"), false);
  assert.equal(harness.cleanupCount, 1);
});
