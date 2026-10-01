import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { applyPostgresMigrations, readPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import {
  parsePostgresCommunityDailyActivationConfig,
  isPostgresCommunityDailyRetryActivationInvocation,
  preparePostgresCommunityDailyRetryTestActivation,
  preparePostgresCommunityDailyTestActivation,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_DAY,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_IAM_USER,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_JOBS,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_SERVICE_ACCOUNT,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_SOURCE_ID,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_SOURCE_NAMESPACE,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_TARGET,
  preparePostgresCommunityDailyRetryActivationInDisposableSchema,
  preparePostgresCommunityDailyActivationInDisposableSchema,
  readPostgresCommunityDailyDaySourceEligibility,
} from "./dist/postgres-community-daily-prepare-test.mjs";
import {
  restorePostgresCommunityDailyRetryActivationInDisposableSchema,
  restorePostgresCommunityDailyRetryTestActivation,
  restorePostgresCommunityDailyActivationInDisposableSchema,
  restorePostgresCommunityDailyTestActivation,
} from "./dist/postgres-community-daily-restore-test.mjs";
import {
  publishPostgresCommunityDailyDay,
  readPostgresPublishedCommunityDaily,
} from "./dist/postgres-community-daily-publish-test.mjs";

const BASELINE = Object.freeze({
  singleton: 1,
  revision: 2,
  control_state: "degraded",
  enrollment_enabled: false,
  upload_registration_enabled: true,
  processing_enabled: true,
  publication_enabled: false,
  reason_code: "synthetic_v12_test_upload_only",
});
const ACTIVE = Object.freeze({
  ...BASELINE,
  revision: 3,
  control_state: "operational",
  publication_enabled: true,
  reason_code: "synthetic_daily_publication_test",
});
const RESTORED = Object.freeze({ ...BASELINE, revision: 4 });
const RETRY_ACTIVE = Object.freeze({
  ...BASELINE,
  revision: 5,
  control_state: "operational",
  publication_enabled: true,
  reason_code: "synthetic_daily_publication_test",
});
const RETRY_RESTORED = Object.freeze({ ...BASELINE, revision: 6 });
const OCCURRENCE_ID = `event:v2:${"a".repeat(64)}`;
const RETAINED_PAYLOAD = JSON.stringify({
  schemaVersion: "community-daily-aggregate-v1.0",
  aggregateId: `community-daily:${POSTGRES_COMMUNITY_DAILY_ACTIVATION_DAY}:r1`,
  day: POSTGRES_COMMUNITY_DAILY_ACTIVATION_DAY,
  revision: 1,
  immutableRevision: true,
  totals: {
    contributingParticipants: 1, contributingDevices: 1, usageEvents: 1,
    quotaObservations: 0, sessionDimensions: 0, inputUncachedTokens: 100,
    inputCacheReadTokens: 900, inputCacheWriteTokens: 0, outputTextTokens: 50,
    outputReasoningTokens: 25, outputCombinedTokens: 75,
  },
  cells: [{
    provider: "openai_codex", modelId: "gpt-5.6-sol", usageEvents: 1,
    inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0,
    outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: 75,
  }],
});
const RETAINED_PUBLICATION = Object.freeze({
  source_namespace: POSTGRES_COMMUNITY_DAILY_ACTIVATION_SOURCE_NAMESPACE,
  day: POSTGRES_COMMUNITY_DAILY_ACTIVATION_DAY,
  revision: 1,
  payload_json: RETAINED_PAYLOAD,
  payload_sha256: createHash("sha256").update(RETAINED_PAYLOAD, "utf8").digest("hex"),
  source_authority_epoch: "0",
  source_cursor_sequence: "0",
  policy_revision: "1",
  collection_revision: "3",
  release_state: "published",
  not_withdrawn: true,
});
const RETRY_FENCE = Object.freeze({
  source_id: POSTGRES_COMMUNITY_DAILY_ACTIVATION_SOURCE_ID,
  source_epoch: "0",
  cursor_sequence: "0",
  cursor_epoch: "0",
  policy_singleton: 1,
  publication_state: "ready",
  policy_revision: "1",
  latest_sequence: "0",
  terminal_sequence: "0",
});
const REAL_PG_HOST = process.env.A2_DAILY_ACTIVATION_TEST_HOST;
const REAL_PG_PORT = Number(process.env.A2_DAILY_ACTIVATION_TEST_PORT);
const REAL_PG_ENABLED = REAL_PG_HOST === "127.0.0.1"
  && Number.isSafeInteger(REAL_PG_PORT) && REAL_PG_PORT > 0 && REAL_PG_PORT <= 65_535;

function validEnv(mode, overrides = {}) {
  const target = POSTGRES_COMMUNITY_DAILY_ACTIVATION_TARGET;
  return {
    CLOUD_RUN_JOB: POSTGRES_COMMUNITY_DAILY_ACTIVATION_JOBS[mode],
    CLOUD_RUN_EXECUTION: `tibotattle-community-daily-${mode}-test-00001-abc`,
    CLOUD_RUN_TASK_INDEX: "0",
    CLOUD_RUN_TASK_COUNT: "1",
    CLOUD_RUN_TASK_ATTEMPT: "0",
    GOOGLE_CLOUD_PROJECT: "tibotattle",
    CLOUD_RUN_TEST_SERVICE: "tibotattle-test-app",
    HOST_ORIGIN: "https://tibotattle-test-app-5t5mehqi7a-ue.a.run.app",
    POSTGRES_IAM_USER: POSTGRES_COMMUNITY_DAILY_ACTIVATION_IAM_USER,
    PRIMARY_INSTANCE_CONNECTION_NAME: target.instanceConnectionName,
    PRIMARY_DATABASE: target.database,
    PRIMARY_SCHEMA: target.schema,
    POSTGRES_SOURCE_ID: POSTGRES_COMMUNITY_DAILY_ACTIVATION_SOURCE_ID,
    POSTGRES_SOURCE_NAMESPACE: POSTGRES_COMMUNITY_DAILY_ACTIVATION_SOURCE_NAMESPACE,
    COMMUNITY_DAILY_SYNTHETIC_DAY: POSTGRES_COMMUNITY_DAILY_ACTIVATION_DAY,
    ...overrides,
  };
}

function migrationFixtures() {
  return Array.from({ length: 62 }, (_, index) => ({
    role: "primary",
    version: index + 1,
    name: `${String(index + 1).padStart(4, "0")}_${index === 38
      ? "analytics_applied_projection_v1" : index === 39
        ? "historical_transport_headers" : index === 40
          ? "accountless_history_retention" : index === 41
            ? "accountless_history_retention_import" : index === 42
              ? "accountless_history_d1_import" : index === 43
                ? "accountless_import_claim_erasure" : index === 44
                  ? "accountless_v12_history_retention" : index === 45
                    ? "owner_journal_authority" : index === 57
                      ? "owner_journal_emitter_head_precheck" : index === 58
                        ? "analytics_v2" : index === 59
                          ? "telemetry_v11_live_admission" : index === 60
                            ? "legacy_contribution_admission" : index === 61
                              ? "telemetry_contribution_trigger_search_path" : `synthetic_migration_${index + 1}`}.sql`,
    sql: `-- migration ${index + 1}\n`,
    bytes: Buffer.byteLength(`-- migration ${index + 1}\n`),
    sha256: String(index + 1).padStart(64, "0"),
  }));
}

function mockSyntheticRecord() {
  return {
    schemaVersion: "usage-event-v1.0",
    eventId: OCCURRENCE_ID,
    eventTime: `${POSTGRES_COMMUNITY_DAILY_ACTIVATION_DAY}T12:05:00.000Z`,
    sessionUuid: "00000000-0000-4000-8000-000000000001",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    speedMode: "fast",
    apiServiceTier: "priority",
    surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription",
    reasoningEffort: "xhigh",
    agentScope: "root",
    outcome: "completed",
    totalInputContextTokens: null,
    components: {
      inputUncachedTokens: 100,
      inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0,
      outputTextTokens: 50,
      outputReasoningTokens: 25,
      outputCombinedTokens: null,
    },
  };
}

function harness({
  controls = BASELINE,
  conflict = false,
  migrationLock = true,
  prepared = false,
  publicationCount = 0,
  retainedPublication = RETAINED_PUBLICATION,
  retryFence = RETRY_FENCE,
  selectedDay = { v1_selected_records_present: false, v11_selected_records_present: false },
  policy = { singleton: 1, publication_state: "ready", policy_revision: 1 },
} = {}) {
  const state = {
    controls: structuredClone(controls),
    insertCount: 0,
    prepared,
    publicationCount,
    retainedPublication,
    retryFence,
    selectedDay,
    conflict,
    migrationLock,
    policy,
    recordJson: prepared ? mockSyntheticRecord() : undefined,
  };
  const events = [];
  const migrations = migrationFixtures();
  const client = {
    async query(sql, params = []) {
      events.push({ sql, params });
      if (sql.startsWith("BEGIN TRANSACTION")) return { rows: [], rowCount: 0 };
      if (sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ acquired: state.migrationLock }], rowCount: 1 };
      }
      if (sql.includes("current_setting('server_version_num')")) {
        return { rows: [{ server_version_num: 170006 }], rowCount: 1 };
      }
      if (sql.includes("_tibotattle_migration_history")) {
        return {
          rows: migrations.map(({ version, name, sha256 }) => ({
            version, name, checksum_sha256: sha256,
          })),
          rowCount: migrations.length,
        };
      }
      if (sql.includes("AS source_epoch") && sql.includes("AS latest_sequence")) {
        return { rows: [state.retryFence], rowCount: 1 };
      }
      if (sql.includes("FROM \"tibotattle_v12_a2_20260925\".community_daily_aggregates")
          && sql.includes("AS not_withdrawn")) {
        const rows = state.retainedPublication === null ? []
          : Array.isArray(state.retainedPublication) ? state.retainedPublication
            : [state.retainedPublication];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("AS source_state_absent")) {
        const values = {
          source_state_absent: true,
          cursor_absent: true,
          journal_empty: true,
          applied_events_empty: true,
          v1_admission_absent: true,
          v11_admission_absent: true,
          namespace_absent: true,
          owner_absent: true,
          session_absent: true,
          pairing_absent: true,
          device_absent: true,
          authorization_absent: true,
          pending_object_absent: true,
          chunk_absent: true,
          record_absent: true,
          publication_absent: true,
        };
        if (state.conflict) values.source_state_absent = false;
        return { rows: [values], rowCount: 1 };
      }
      if (sql.includes("FROM \"tibotattle_v12_a2_20260925\".publication_state")) {
        if (state.policy === null) return { rows: [], rowCount: 0 };
        return { rows: [state.policy], rowCount: 1 };
      }
      if (sql.startsWith("WITH public_owners AS (")) {
        return {
          rows: [state.prepared
            ? { v1_selected_records_present: true, v11_selected_records_present: false }
            : state.selectedDay],
          rowCount: 1,
        };
      }
      if (sql.includes("AS namespace_count")) {
        const one = state.prepared ? "1" : "0";
        return { rows: [{
          namespace_count: one,
          v1_admission_count: one,
          v11_admission_count: one,
          source_state_count: one,
          cursor_count: one,
          owner_count: one,
          session_count: one,
          pairing_count: one,
          device_count: one,
          authorization_count: one,
          pending_object_count: one,
          chunk_count: one,
          record_count: one,
          publication_count: String(state.publicationCount),
        }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT record_json")) {
        return { rows: [{ record_json: state.recordJson }], rowCount: 1 };
      }
      if (sql.includes("FROM \"tibotattle_v12_a2_20260925\".collection_controls")) {
        return { rows: [structuredClone(state.controls)], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO ")) {
        state.insertCount += 1;
        if (sql.includes("telemetry_v1_records")) state.recordJson = JSON.parse(params.at(-1));
        if (state.insertCount === 13) state.prepared = true;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE \"tibotattle_v12_a2_20260925\".collection_controls")
          && sql.includes("SET revision=3")) {
        state.controls = structuredClone(ACTIVE);
        return { rows: [{ singleton: 1 }], rowCount: 1 };
      }
      if (sql.includes("UPDATE \"tibotattle_v12_a2_20260925\".collection_controls")
          && sql.includes("SET revision=4")) {
        state.controls = structuredClone(RESTORED);
        return { rows: [{ singleton: 1 }], rowCount: 1 };
      }
      if (sql.includes("UPDATE \"tibotattle_v12_a2_20260925\".collection_controls")
          && sql.includes("SET revision=5")) {
        state.controls = structuredClone(RETRY_ACTIVE);
        return { rows: [{ singleton: 1 }], rowCount: 1 };
      }
      if (sql.includes("UPDATE \"tibotattle_v12_a2_20260925\".collection_controls")
          && sql.includes("SET revision=6")) {
        state.controls = structuredClone(RETRY_RESTORED);
        return { rows: [{ singleton: 1 }], rowCount: 1 };
      }
      throw Object.assign(new Error("unexpected mock query"), { code: "unexpected" });
    },
    async release() { events.push({ sql: "RELEASE" }); },
  };
  const pool = {
    async connect() { events.push({ sql: "CONNECT" }); return client; },
  };
  const connector = { synthetic: true };
  const dependencies = {
    migrationRoot: "/fixture/migrations",
    async readServiceAccountEmail() { return POSTGRES_COMMUNITY_DAILY_ACTIVATION_SERVICE_ACCOUNT; },
    async readMigrations({ role, rootDirectory }) {
      assert.equal(role, "primary");
      assert.equal(rootDirectory, "/fixture/migrations");
      return migrations;
    },
    createConnector() { return connector; },
    async createPool(options) {
      assert.equal(options.connector, connector);
      assert.equal(options.instanceConnectionName, POSTGRES_COMMUNITY_DAILY_ACTIVATION_TARGET.instanceConnectionName);
      assert.equal(options.database, POSTGRES_COMMUNITY_DAILY_ACTIVATION_TARGET.database);
      assert.equal(options.user, POSTGRES_COMMUNITY_DAILY_ACTIVATION_IAM_USER);
      assert.equal(options.max, 1);
      assert.equal(options.applicationName, "tibotattle-community-daily-test-activation");
      return pool;
    },
    async closeResources({ pools, connector: closingConnector }) {
      assert.deepEqual(pools, [pool]);
      assert.equal(closingConnector, connector);
    },
  };
  return { state, events, dependencies };
}

test("activation jobs accept only the pinned one-task A2 runtime identity and one day", () => {
  const config = parsePostgresCommunityDailyActivationConfig(
    validEnv("prepare"), POSTGRES_COMMUNITY_DAILY_ACTIVATION_SERVICE_ACCOUNT, "prepare",
  );
  assert.equal(config.schema, POSTGRES_COMMUNITY_DAILY_ACTIVATION_TARGET.schema);
  assert.equal(config.day, POSTGRES_COMMUNITY_DAILY_ACTIVATION_DAY);
  for (const overrides of [
    { CLOUD_RUN_JOB: "tibotattle-community-daily-publish-test" },
    { CLOUD_RUN_TASK_COUNT: "2" },
    { CLOUD_RUN_TASK_ATTEMPT: "1" },
    { GOOGLE_CLOUD_PROJECT: "production" },
    { K_SERVICE: "tibotattle-test-app" },
    { PRIMARY_SCHEMA: "public" },
    { POSTGRES_SOURCE_ID: "another-source" },
    { COMMUNITY_DAILY_SYNTHETIC_DAY: "2026-09-26" },
  ]) {
    assert.throws(() => parsePostgresCommunityDailyActivationConfig(
      validEnv("prepare", overrides), POSTGRES_COMMUNITY_DAILY_ACTIVATION_SERVICE_ACCOUNT, "prepare",
    ));
  }
  assert.throws(() => parsePostgresCommunityDailyActivationConfig(
    validEnv("restore"), "other@tibotattle.iam.gserviceaccount.com", "restore",
  ), /SERVICE_ACCOUNT_INVALID/);
  const retry = parsePostgresCommunityDailyActivationConfig(
    validEnv("prepare"), POSTGRES_COMMUNITY_DAILY_ACTIVATION_SERVICE_ACCOUNT, "retry-prepare",
  );
  assert.equal(retry.retry, true);
  assert.equal(retry.action, "prepare");
  assert.equal(retry.job, POSTGRES_COMMUNITY_DAILY_ACTIVATION_JOBS.prepare);
  assert.equal(isPostgresCommunityDailyRetryActivationInvocation([]), false);
  assert.equal(isPostgresCommunityDailyRetryActivationInvocation([
    "--retry-retained-a2-publication",
  ]), true);
  assert.throws(() => isPostgresCommunityDailyRetryActivationInvocation([
    "--retry-retained-a2-publication", "--anything-else",
  ]), /ARGUMENTS_INVALID/u);
});

test("prepare inserts the reviewed content-free fixture and opens only revision 3 in one transaction", async () => {
  const h = harness();
  const receipt = await preparePostgresCommunityDailyTestActivation({
    env: validEnv("prepare"), dependencies: h.dependencies,
  });
  assert.deepEqual(receipt, {
    schemaVersion: "postgres-community-daily-activation-v1",
    status: "prepared",
    project: "tibotattle",
    schema: POSTGRES_COMMUNITY_DAILY_ACTIVATION_TARGET.schema,
    day: POSTGRES_COMMUNITY_DAILY_ACTIVATION_DAY,
    collectionControlsRevision: 3,
    fixture: "one_content_free_social_v1_usage_event",
  });
  assert.equal(h.state.insertCount, 13);
  assert.deepEqual(h.state.controls, ACTIVE);
  assert.equal(h.state.recordJson.schemaVersion, "usage-event-v1.0");
  assert.equal(h.state.recordJson.eventId, OCCURRENCE_ID);
  assert.equal(Object.hasOwn(h.state.recordJson, "prompt"), false);
  assert.equal(Object.hasOwn(h.state.recordJson, "response"), false);
  assert.equal(Object.hasOwn(h.state.recordJson, "command"), false);
  const tx = h.events.filter(({ sql }) => sql.startsWith("BEGIN TRANSACTION"));
  assert.equal(tx.length, 1);
  assert.match(tx[0].sql, /SERIALIZABLE/u);
  assert.equal(h.events.filter(({ sql }) => sql === "COMMIT").length, 1);
  assert.equal(h.events.filter(({ sql }) => sql === "ROLLBACK").length, 0);
  assert.equal(h.events.filter(({ sql }) => sql.startsWith("INSERT INTO ")).length, 13);
  assert.equal(h.events.some(({ sql }) => /storage\.googleapis|gcs|r2\.put/iu.test(sql)), false);
  const migrationLock = h.events.find(({ sql }) => sql.includes("pg_try_advisory_xact_lock"));
  assert.deepEqual(migrationLock?.params, [
    `tibotattle:primary:${POSTGRES_COMMUNITY_DAILY_ACTIVATION_TARGET.schema}`,
  ]);
  const migrationReceipt = h.events.find(({ sql }) => sql.includes("_tibotattle_migration_history"));
  assert.doesNotMatch(migrationReceipt?.sql ?? "", /FOR SHARE/u);
  assert.ok(h.events.indexOf(migrationLock) < h.events.indexOf(migrationReceipt));
  assert.ok(h.events.some(({ sql }) => sql.startsWith("WITH public_owners AS (") && sql.includes("$1")));
  assert.ok(h.events.some(({ sql }) => sql.includes(
    "SELECT singleton,publication_state,policy_revision",
  ) && sql.includes("WHERE singleton=1 FOR SHARE")));
  assert.ok(h.events.some(({ sql }) => sql.includes("SET revision=3")
    && sql.includes("enrollment_enabled=false") && sql.includes("publication_enabled=true")));
});

test("retry prepare reuses only the exact retained fixture and revision-1 aggregate before opening revision 5", async () => {
  const h = harness({
    controls: RESTORED,
    prepared: true,
    publicationCount: 1,
  });
  const receipt = await preparePostgresCommunityDailyRetryTestActivation({
    env: validEnv("prepare"), dependencies: h.dependencies,
  });
  assert.deepEqual(receipt, {
    schemaVersion: "postgres-community-daily-retry-activation-v1",
    status: "retry_prepared",
    project: "tibotattle",
    schema: POSTGRES_COMMUNITY_DAILY_ACTIVATION_TARGET.schema,
    day: POSTGRES_COMMUNITY_DAILY_ACTIVATION_DAY,
    collectionControlsRevision: 5,
    retainedPublicationRevision: 1,
    fixtureInserted: false,
  });
  assert.equal(h.state.insertCount, 0);
  assert.deepEqual(h.state.controls, RETRY_ACTIVE);
  assert.equal(h.events.some(({ sql }) => sql.startsWith("INSERT INTO ")), false);
  assert.equal(h.events.some(({ sql }) => sql.includes("AS source_epoch")
    && sql.includes("FOR SHARE OF source,cursor,policy")), true);
  assert.equal(h.events.some(({ sql }) => sql.includes("AS not_withdrawn")
    && sql.includes("FOR SHARE")), true);
  assert.equal(h.events.some(({ sql }) => sql.includes("SET revision=5")
    && sql.includes("revision=4") && sql.includes("publication_enabled=true")), true);
  assert.equal(h.events.filter(({ sql }) => sql === "COMMIT").length, 1);
});

test("retry prepare refuses a changed retained publication before enabling controls", async () => {
  const h = harness({
    controls: RESTORED,
    prepared: true,
    publicationCount: 1,
    retainedPublication: { ...RETAINED_PUBLICATION, revision: 2 },
  });
  await assert.rejects(preparePostgresCommunityDailyRetryTestActivation({
    env: validEnv("prepare"), dependencies: h.dependencies,
  }), /RETRY_PUBLICATION_INVALID/u);
  assert.equal(h.state.insertCount, 0);
  assert.deepEqual(h.state.controls, RESTORED);
  assert.equal(h.events.some(({ sql }) => sql.includes("SET revision=5")), false);
  assert.equal(h.events.filter(({ sql }) => sql === "ROLLBACK").length, 1);
});

test("retry prepare refuses controls outside exact revision 4 without fixture or control writes", async () => {
  const h = harness({
    controls: { ...RESTORED, upload_registration_enabled: false },
    prepared: true,
    publicationCount: 1,
  });
  await assert.rejects(preparePostgresCommunityDailyRetryTestActivation({
    env: validEnv("prepare"), dependencies: h.dependencies,
  }), /RETRY_CONTROLS_BASELINE_MISMATCH/u);
  assert.equal(h.state.insertCount, 0);
  assert.equal(h.events.some(({ sql }) => sql.includes("AS source_epoch")), false);
  assert.equal(h.events.some(({ sql }) => sql.startsWith("INSERT INTO ")), false);
  assert.equal(h.events.filter(({ sql }) => sql === "ROLLBACK").length, 1);
});

test("retry prepare refuses any changed retained event before enabling controls", async () => {
  const h = harness({ controls: RESTORED, prepared: false, publicationCount: 1 });
  await assert.rejects(preparePostgresCommunityDailyRetryTestActivation({
    env: validEnv("prepare"), dependencies: h.dependencies,
  }), /READBACK_INVALID/u);
  assert.equal(h.state.insertCount, 0);
  assert.deepEqual(h.state.controls, RESTORED);
  assert.equal(h.events.some(({ sql }) => sql.includes("SET revision=5")), false);
  assert.equal(h.events.filter(({ sql }) => sql === "ROLLBACK").length, 1);
});

test("retry prepare still accepts a pre-retirement updating policy row in the retry fence and refuses any other fence", async () => {
  // The A2 test deployment predates the upload-path retirement and holds
  // publication_state='updating'; a retry there must keep working.
  const accepted = harness({
    controls: RESTORED,
    prepared: true,
    publicationCount: 1,
    retryFence: { ...RETRY_FENCE, publication_state: "updating" },
  });
  const receipt = await preparePostgresCommunityDailyRetryTestActivation({
    env: validEnv("prepare"), dependencies: accepted.dependencies,
  });
  assert.equal(receipt.status, "retry_prepared");
  assert.equal(receipt.collectionControlsRevision, 5);
  assert.deepEqual(accepted.state.controls, RETRY_ACTIVE);

  for (const retryFence of [
    { ...RETRY_FENCE, publication_state: "contained" },
    { ...RETRY_FENCE, policy_revision: "2" },
  ]) {
    const h = harness({ controls: RESTORED, prepared: true, publicationCount: 1, retryFence });
    await assert.rejects(preparePostgresCommunityDailyRetryTestActivation({
      env: validEnv("prepare"), dependencies: h.dependencies,
    }), /RETRY_FENCE_INVALID/u);
    assert.equal(h.state.insertCount, 0);
    assert.deepEqual(h.state.controls, RESTORED);
    assert.equal(h.events.some(({ sql }) => sql.includes("SET revision=5")), false);
    assert.equal(h.events.filter(({ sql }) => sql === "ROLLBACK").length, 1);
  }
});

test("prepare still accepts a pre-retirement updating policy row at the exact singleton and revision", async () => {
  const h = harness({
    policy: { singleton: 1, publication_state: "updating", policy_revision: 1 },
  });
  const receipt = await preparePostgresCommunityDailyTestActivation({
    env: validEnv("prepare"), dependencies: h.dependencies,
  });
  assert.equal(receipt.status, "prepared");
  assert.equal(receipt.collectionControlsRevision, 3);
  assert.equal(h.state.insertCount, 13);
});

test("prepare refuses missing or invalid publication policy before fixture inserts", async () => {
  const cases = [
    { policy: null, code: "POLICY_READ_FAILED" },
    {
      policy: { singleton: 2, publication_state: "ready", policy_revision: 1 },
      code: "POLICY_INVALID",
    },
    {
      policy: { singleton: 1, publication_state: "ready", policy_revision: 2 },
      code: "POLICY_INVALID",
    },
    {
      policy: { singleton: 1, publication_state: "contained", policy_revision: 1 },
      code: "POLICY_INVALID",
    },
  ];
  for (const { policy, code } of cases) {
    const h = harness({ policy });
    await assert.rejects(preparePostgresCommunityDailyTestActivation({
      env: validEnv("prepare"), dependencies: h.dependencies,
    }), new RegExp(code, "u"));
    assert.equal(h.state.insertCount, 0);
    assert.deepEqual(h.state.controls, BASELINE);
    assert.equal(h.events.filter(({ sql }) => sql === "ROLLBACK").length, 1);
    assert.equal(h.events.some(({ sql }) => sql === "COMMIT"), false);
  }
});

test("prepare fails closed before fixture inserts when an A2 source-state precondition conflicts", async () => {
  const h = harness({ conflict: true });
  await assert.rejects(preparePostgresCommunityDailyTestActivation({
    env: validEnv("prepare"), dependencies: h.dependencies,
  }), /FIXTURE_CONFLICT/u);
  assert.equal(h.state.insertCount, 0);
  assert.deepEqual(h.state.controls, BASELINE);
  assert.equal(h.events.filter(({ sql }) => sql === "ROLLBACK").length, 1);
  assert.equal(h.events.some(({ sql }) => sql === "COMMIT"), false);
});

test("prepare refuses without writes while the canonical migrator lock is held", async () => {
  const h = harness({ migrationLock: false });
  await assert.rejects(preparePostgresCommunityDailyTestActivation({
    env: validEnv("prepare"), dependencies: h.dependencies,
  }), /MIGRATION_BUSY/u);
  assert.equal(h.state.insertCount, 0);
  assert.deepEqual(h.state.controls, BASELINE);
  assert.equal(h.events.filter(({ sql }) => sql === "ROLLBACK").length, 1);
  assert.equal(h.events.some(({ sql }) => sql.includes("_tibotattle_migration_history")), false);
});

test("prepare fails closed if the selected day contains v1 or v1.1 eligible records", async () => {
  const h = harness({ selectedDay: { v1_selected_records_present: true, v11_selected_records_present: false } });
  await assert.rejects(preparePostgresCommunityDailyTestActivation({
    env: validEnv("prepare"), dependencies: h.dependencies,
  }), /SELECTED_DAY_CONFLICT/u);
  assert.equal(h.state.insertCount, 0);
  assert.deepEqual(h.state.controls, BASELINE);
  assert.equal(h.events.filter(({ sql }) => sql === "ROLLBACK").length, 1);
});

test("restore is independently invokable and changes only the exact revision-3 test gate", async () => {
  const h = harness({ controls: ACTIVE });
  const receipt = await restorePostgresCommunityDailyTestActivation({
    env: validEnv("restore"), dependencies: h.dependencies,
  });
  assert.deepEqual(receipt, {
    schemaVersion: "postgres-community-daily-activation-v1",
    status: "restored",
    project: "tibotattle",
    schema: POSTGRES_COMMUNITY_DAILY_ACTIVATION_TARGET.schema,
    collectionControlsRevision: 4,
    publicationEnabled: false,
    enrollmentEnabled: false,
    fixtureRetained: true,
  });
  assert.deepEqual(h.state.controls, RESTORED);
  assert.equal(h.state.insertCount, 0);
  const updates = h.events.filter(({ sql }) => sql.startsWith("UPDATE "));
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /SET revision=4/u);
  assert.ok(updates[0].sql.includes("revision=3"));
  assert.equal(h.events.filter(({ sql }) => sql === "COMMIT").length, 1);
});

test("restore is safely idempotent after full revision-4 readback", async () => {
  const h = harness({ controls: RESTORED });
  const receipt = await restorePostgresCommunityDailyTestActivation({
    env: validEnv("restore"), dependencies: h.dependencies,
  });
  assert.equal(receipt.status, "already_restored");
  assert.deepEqual(h.state.controls, RESTORED);
  assert.equal(h.events.some(({ sql }) => sql.startsWith("UPDATE ")), false);
  assert.equal(h.events.filter(({ sql }) => sql === "COMMIT").length, 1);
});

test("restore refuses any revision or field state outside the exact temporary gate", async () => {
  const h = harness({ controls: { ...ACTIVE, enrollment_enabled: true } });
  await assert.rejects(restorePostgresCommunityDailyTestActivation({
    env: validEnv("restore"), dependencies: h.dependencies,
  }), /RESTORE_STATE_MISMATCH/u);
  assert.equal(h.events.some(({ sql }) => sql.startsWith("UPDATE ")), false);
  assert.equal(h.events.filter(({ sql }) => sql === "ROLLBACK").length, 1);
});

test("retry restore independently closes only revision 5 to revision 6 and retains the fixture", async () => {
  const h = harness({ controls: RETRY_ACTIVE, prepared: true, publicationCount: 2 });
  const receipt = await restorePostgresCommunityDailyRetryTestActivation({
    env: validEnv("restore"), dependencies: h.dependencies,
  });
  assert.deepEqual(receipt, {
    schemaVersion: "postgres-community-daily-retry-activation-v1",
    status: "restored",
    project: "tibotattle",
    schema: POSTGRES_COMMUNITY_DAILY_ACTIVATION_TARGET.schema,
    collectionControlsRevision: 6,
    publicationEnabled: false,
    enrollmentEnabled: false,
    fixtureRetained: true,
  });
  assert.deepEqual(h.state.controls, RETRY_RESTORED);
  assert.equal(h.state.insertCount, 0);
  const updates = h.events.filter(({ sql }) => sql.startsWith("UPDATE "));
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /SET revision=6/u);
  assert.ok(updates[0].sql.includes("revision=5"));
  assert.ok(updates[0].sql.includes("publication_enabled=false"));
  assert.equal(h.events.filter(({ sql }) => sql === "COMMIT").length, 1);
});

test("retry restore is idempotent after full revision-6 readback", async () => {
  const h = harness({ controls: RETRY_RESTORED, prepared: true, publicationCount: 2 });
  const receipt = await restorePostgresCommunityDailyRetryTestActivation({
    env: validEnv("restore"), dependencies: h.dependencies,
  });
  assert.equal(receipt.status, "already_restored");
  assert.deepEqual(h.state.controls, RETRY_RESTORED);
  assert.equal(h.events.some(({ sql }) => sql.startsWith("UPDATE ")), false);
  assert.equal(h.events.filter(({ sql }) => sql === "COMMIT").length, 1);
});

test("retry restore refuses controls outside exact revision 5 without writes", async () => {
  const h = harness({
    controls: { ...RETRY_ACTIVE, enrollment_enabled: true },
    prepared: true,
    publicationCount: 2,
  });
  await assert.rejects(restorePostgresCommunityDailyRetryTestActivation({
    env: validEnv("restore"), dependencies: h.dependencies,
  }), /RETRY_RESTORE_STATE_MISMATCH/u);
  assert.equal(h.events.some(({ sql }) => sql.startsWith("UPDATE ")), false);
  assert.equal(h.events.filter(({ sql }) => sql === "ROLLBACK").length, 1);
});

async function createDisposableSchema(pool, migrationRoot, { policyState = "ready" } = {}) {
  assert.ok(policyState === "ready" || policyState === "updating");
  const schema = `a2_daily_activation_${randomBytes(6).toString("hex")}`;
  const runtimeRole = `${schema}_runtime`;
  const quoted = `"${schema}"`;
  const quotedRuntimeRole = `"${runtimeRole}"`;
  await pool.query(`CREATE SCHEMA ${quoted}`);
  let roleCreated = false;
  try {
    await applyPostgresMigrations({ role: "primary", schema, pool, rootDirectory: migrationRoot });
    await pool.query(`CREATE ROLE ${quotedRuntimeRole} NOLOGIN`);
    roleCreated = true;
    await pool.query(`GRANT USAGE ON SCHEMA ${quoted} TO ${quotedRuntimeRole}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quoted}
      TO ${quotedRuntimeRole}`);
    await pool.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${quoted}
      TO ${quotedRuntimeRole}`);
    await pool.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON ${quoted}._tibotattle_migration_history FROM ${quotedRuntimeRole}`);
    await pool.query(`GRANT EXECUTE ON FUNCTION ${quoted}.insert_telemetry_v1_contribution(jsonb)
      TO ${quotedRuntimeRole}`);
    const seedControls = await pool.query(`UPDATE ${quoted}.collection_controls
      SET revision=2,control_state='degraded',enrollment_enabled=false,
          upload_registration_enabled=true,processing_enabled=true,
          publication_enabled=false,reason_code='synthetic_v12_test_upload_only',
          updated_at=clock_timestamp()
      WHERE singleton=1 AND revision=1 AND control_state='contained'
        AND enrollment_enabled=false AND upload_registration_enabled=false
        AND processing_enabled=false AND publication_enabled=false AND reason_code IS NULL
      RETURNING singleton`);
    assert.equal(seedControls.rowCount, 1, "fresh migrations must match the exact contained baseline");
    assert.deepEqual(seedControls.rows, [{ singleton: 1 }]);
    // publication_state is only the policy row: daily activation follows the
    // publisher's exact policy revision, control, and caught-up cursor fences
    // and never writes it. Fresh migrations leave it ready.
    const policy = await pool.query(`SELECT singleton,publication_state,policy_revision
      FROM ${quoted}.publication_state`);
    assert.equal(policy.rowCount, 1, "fresh migrations must have the singleton publication policy");
    assert.equal(Number(policy.rows[0]?.singleton), 1);
    assert.equal(policy.rows[0]?.publication_state, "ready");
    assert.equal(Number(policy.rows[0]?.policy_revision), 1);
    if (policyState === "updating") {
      // The pinned chain predates the upload-path retirement, and the A2 test
      // deployment it mirrors holds an `updating` row. Keep activation proven
      // against that row until the pins move past the promoted retirement,
      // whose policy guard then refuses this UPDATE.
      const seedPolicy = await pool.query(`UPDATE ${quoted}.publication_state
        SET publication_state='updating' WHERE singleton=1 AND policy_revision=1
        RETURNING publication_state`);
      assert.deepEqual(seedPolicy.rows, [{ publication_state: "updating" }]);
    }
    const privileges = await pool.query(`SELECT
      has_table_privilege($1,$2::regclass,'SELECT') AS migration_select,
      has_table_privilege($1,$2::regclass,'UPDATE') AS migration_update,
      has_table_privilege($1,$3::regclass,'UPDATE') AS controls_update`, [
      runtimeRole,
      `${schema}._tibotattle_migration_history`,
      `${schema}.collection_controls`,
    ]);
    assert.deepEqual(privileges.rows[0], {
      migration_select: true,
      migration_update: false,
      controls_update: true,
    });
    return { schema, quoted, runtimeRole, quotedRuntimeRole };
  } catch (error) {
    await pool.query(`DROP SCHEMA ${quoted} CASCADE`);
    if (roleCreated) await pool.query(`DROP ROLE ${quotedRuntimeRole}`);
    throw error;
  }
}

async function createPinnedMigrationRoot() {
  const current = await readPostgresMigrations({ role: "primary" });
  const pinned = current.filter(migration => migration.version <= 62);
  assert.equal(pinned.length, 62, "the A2 integration targets the current 62-migration manifest");
  assert.equal(pinned.at(-1)?.name, "0062_telemetry_contribution_trigger_search_path.sql");
  const root = await mkdtemp(join(tmpdir(), `a2-daily-activation-${randomBytes(6).toString("hex")}-`));
  try {
    const directory = join(root, "primary");
    await mkdir(directory, { mode: 0o700 });
    for (const migration of pinned) {
      await writeFile(join(directory, migration.name), migration.sql, { flag: "wx", mode: 0o600 });
    }
    return { root, migrations: await readPostgresMigrations({ role: "primary", rootDirectory: root }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function disposableConfig(schema) {
  return {
    project: "tibotattle",
    schema,
    day: POSTGRES_COMMUNITY_DAILY_ACTIVATION_DAY,
    sourceId: POSTGRES_COMMUNITY_DAILY_ACTIVATION_SOURCE_ID,
    sourceNamespace: POSTGRES_COMMUNITY_DAILY_ACTIVATION_SOURCE_NAMESPACE,
  };
}

async function runInClient(pool, fn, runtimeRole) {
  const client = await pool.connect();
  try {
    if (runtimeRole !== undefined) await client.query(`SET ROLE "${runtimeRole}"`);
    return await fn(client);
  } finally {
    if (runtimeRole !== undefined) await client.query("RESET ROLE");
    client.release();
  }
}

test("real disposable PostgreSQL 17 runs prepare, restore, conflict rollback, and repeat restore", {
  skip: REAL_PG_ENABLED ? false : "set A2_DAILY_ACTIVATION_TEST_HOST=127.0.0.1 and local PG17 port",
  timeout: 180_000,
}, async () => {
  const pool = new pg.Pool({
    host: REAL_PG_HOST,
    port: REAL_PG_PORT,
    user: "postgres",
    database: "postgres",
    ssl: false,
    max: 2,
    connectionTimeoutMillis: 5_000,
    application_name: "tibotattle-daily-activation-local-integration",
  });
  const created = [];
  let migrationRoot;
  try {
    const runtime = await pool.query(`SELECT current_database() AS database,
        inet_server_addr()::text AS server_address,
        current_setting('server_version_num')::integer AS server_version_num`);
    assert.equal(runtime.rows[0]?.database, "postgres");
    assert.ok(runtime.rows[0]?.server_address, "integration requires local loopback TCP, not a Unix socket");
    assert.equal(Math.floor(Number(runtime.rows[0]?.server_version_num) / 10_000), 17);
    const pinned = await createPinnedMigrationRoot();
    migrationRoot = pinned.root;
    const migrations = pinned.migrations;

    const preparedSchema = await createDisposableSchema(pool, migrationRoot, { policyState: "updating" });
    created.push(preparedSchema);
    const config = disposableConfig(preparedSchema.schema);
    const migrationLockClient = await pool.connect();
    const migrationLockKey = `tibotattle:primary:${preparedSchema.schema}`;
    try {
      await migrationLockClient.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [migrationLockKey]);
      await assert.rejects(runInClient(pool, client =>
        preparePostgresCommunityDailyActivationInDisposableSchema({ client, config, migrations }),
      preparedSchema.runtimeRole), error =>
        error?.code === "POSTGRES_COMMUNITY_DAILY_ACTIVATION_MIGRATION_BUSY");
    } finally {
      await migrationLockClient.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [migrationLockKey]);
      migrationLockClient.release();
    }
    const blockedReadback = await pool.query(`SELECT
      (SELECT revision::integer FROM ${preparedSchema.quoted}.collection_controls WHERE singleton=1) AS revision,
      (SELECT count(*) FROM ${preparedSchema.quoted}.participants WHERE id='synthetic-social-owner') AS owner_count,
      (SELECT count(*) FROM ${preparedSchema.quoted}.typed_telemetry_namespaces WHERE id=1) AS namespace_count`);
    assert.deepEqual(blockedReadback.rows[0], { revision: 2, owner_count: "0", namespace_count: "0" });
    const prep = await runInClient(pool, client =>
      preparePostgresCommunityDailyActivationInDisposableSchema({ client, config, migrations }),
    preparedSchema.runtimeRole);
    assert.equal(prep.status, "prepared");
    assert.equal(prep.collectionControlsRevision, 3);
    assert.deepEqual(await readPostgresCommunityDailyDaySourceEligibility(pool, {
      day: config.day,
      schema: { primarySchema: config.schema },
    }), { v1SelectedRecordsPresent: true, v11SelectedRecordsPresent: false });
    const preparedCounts = await pool.query(`SELECT
      (SELECT count(*) FROM ${preparedSchema.quoted}.participants WHERE id='synthetic-social-owner') AS owner_count,
      (SELECT count(*) FROM ${preparedSchema.quoted}.typed_v1_admission_state WHERE id=1) AS v1_admission_count,
      (SELECT count(*) FROM ${preparedSchema.quoted}.typed_v11_admission_state WHERE id=1) AS v11_admission_count,
      (SELECT count(*) FROM ${preparedSchema.quoted}.telemetry_v1_records
        WHERE occurrence_id=$1 AND observed_day=$2::date) AS record_count,
      (SELECT count(*) FROM ${preparedSchema.quoted}.community_daily_aggregates
        WHERE source_id=$3 AND day=$2::date) AS publication_count`,
    [OCCURRENCE_ID, config.day, config.sourceId]);
    assert.deepEqual(preparedCounts.rows[0], {
      owner_count: "1", v1_admission_count: "1", v11_admission_count: "1",
      record_count: "1", publication_count: "0",
    });
    const publishOptions = {
      sourceId: config.sourceId,
      sourceNamespace: config.sourceNamespace,
      day: config.day,
      schema: { primarySchema: config.schema },
    };
    const firstPublication = await publishPostgresCommunityDailyDay(pool, publishOptions);
    assert.deepEqual(firstPublication, { state: "published", day: config.day, revision: 1 });
    const firstVisible = await readPostgresPublishedCommunityDaily(pool, {
      sourceId: config.sourceId,
      sourceNamespace: config.sourceNamespace,
      fromDay: config.day,
      throughDay: config.day,
      schema: { primarySchema: config.schema },
    });
    assert.equal(firstVisible.rows.length, 1);
    assert.equal(firstVisible.rows[0]?.revision, 1);
    const firstAggregate = await pool.query(`SELECT revision::integer AS revision,
        source_authority_epoch::integer AS source_epoch,
        source_cursor_sequence::integer AS cursor_sequence,
        policy_revision::integer AS policy_revision,
        collection_revision::integer AS collection_revision,
        release_state,payload_sha256
      FROM ${preparedSchema.quoted}.community_daily_aggregates
      WHERE source_id=$1 AND day=$2::date ORDER BY revision`, [config.sourceId, config.day]);
    assert.deepEqual(firstAggregate.rows.map(({ revision, source_epoch, cursor_sequence,
      policy_revision, collection_revision, release_state }) => ({
      revision, source_epoch, cursor_sequence, policy_revision, collection_revision, release_state,
    })), [{
      revision: 1, source_epoch: 0, cursor_sequence: 0, policy_revision: 1,
      collection_revision: 3, release_state: "published",
    }]);
    const revisionOneDigest = firstAggregate.rows[0]?.payload_sha256;

    const restored = await runInClient(pool, client =>
      restorePostgresCommunityDailyActivationInDisposableSchema({ client, config, migrations }),
    preparedSchema.runtimeRole);
    assert.equal(restored.status, "restored");
    assert.equal(restored.collectionControlsRevision, 4);
    await assert.rejects(readPostgresPublishedCommunityDaily(pool, {
      sourceId: config.sourceId,
      sourceNamespace: config.sourceNamespace,
      fromDay: config.day,
      throughDay: config.day,
      schema: { primarySchema: config.schema },
    }), error => error?.code === "unavailable"
      && error?.operation === "community_daily.authority");
    const repeated = await runInClient(pool, client =>
      restorePostgresCommunityDailyActivationInDisposableSchema({ client, config, migrations }),
    preparedSchema.runtimeRole);
    assert.equal(repeated.status, "already_restored");

    const retryPrepared = await runInClient(pool, client =>
      preparePostgresCommunityDailyRetryActivationInDisposableSchema({ client, config, migrations }),
    preparedSchema.runtimeRole);
    assert.equal(retryPrepared.status, "retry_prepared");
    assert.equal(retryPrepared.collectionControlsRevision, 5);
    assert.equal(retryPrepared.retainedPublicationRevision, 1);
    assert.equal(retryPrepared.fixtureInserted, false);
    const secondPublication = await publishPostgresCommunityDailyDay(pool, publishOptions);
    assert.deepEqual(secondPublication, { state: "published", day: config.day, revision: 2 });
    const secondVisible = await readPostgresPublishedCommunityDaily(pool, {
      sourceId: config.sourceId,
      sourceNamespace: config.sourceNamespace,
      fromDay: config.day,
      throughDay: config.day,
      schema: { primarySchema: config.schema },
    });
    assert.equal(secondVisible.rows.length, 1);
    assert.equal(secondVisible.rows[0]?.revision, 2);
    const bothAggregates = await pool.query(`SELECT revision::integer AS revision,
        source_authority_epoch::integer AS source_epoch,
        source_cursor_sequence::integer AS cursor_sequence,
        policy_revision::integer AS policy_revision,
        collection_revision::integer AS collection_revision,
        release_state,payload_sha256
      FROM ${preparedSchema.quoted}.community_daily_aggregates
      WHERE source_id=$1 AND day=$2::date ORDER BY revision`, [config.sourceId, config.day]);
    assert.equal(bothAggregates.rowCount, 2);
    assert.deepEqual(bothAggregates.rows.map(({ revision, source_epoch, cursor_sequence,
      policy_revision, collection_revision, release_state }) => ({
      revision, source_epoch, cursor_sequence, policy_revision, collection_revision, release_state,
    })), [
      { revision: 1, source_epoch: 0, cursor_sequence: 0, policy_revision: 1,
        collection_revision: 3, release_state: "published" },
      { revision: 2, source_epoch: 0, cursor_sequence: 0, policy_revision: 1,
        collection_revision: 5, release_state: "published" },
    ]);
    assert.equal(bothAggregates.rows[0]?.payload_sha256, revisionOneDigest,
      "the first immutable revision must not change during retry");
    const retryRestored = await runInClient(pool, client =>
      restorePostgresCommunityDailyRetryActivationInDisposableSchema({ client, config, migrations }),
    preparedSchema.runtimeRole);
    assert.equal(retryRestored.status, "restored");
    assert.equal(retryRestored.collectionControlsRevision, 6);
    await assert.rejects(readPostgresPublishedCommunityDaily(pool, {
      sourceId: config.sourceId,
      sourceNamespace: config.sourceNamespace,
      fromDay: config.day,
      throughDay: config.day,
      schema: { primarySchema: config.schema },
    }), error => error?.code === "unavailable"
      && error?.operation === "community_daily.authority");
    const repeatedRetryRestore = await runInClient(pool, client =>
      restorePostgresCommunityDailyRetryActivationInDisposableSchema({ client, config, migrations }),
    preparedSchema.runtimeRole);
    assert.equal(repeatedRetryRestore.status, "already_restored");

    const restoredState = await pool.query(`SELECT singleton,revision::integer AS revision,
        control_state,enrollment_enabled,
        upload_registration_enabled,processing_enabled,publication_enabled,reason_code
      FROM ${preparedSchema.quoted}.collection_controls WHERE singleton=1`);
    assert.deepEqual(restoredState.rows[0], RETRY_RESTORED);
    const retained = await pool.query(`SELECT count(*) AS row_count
      FROM ${preparedSchema.quoted}.telemetry_v1_records
      WHERE occurrence_id=$1 AND observed_day=$2::date`, [OCCURRENCE_ID, config.day]);
    assert.equal(retained.rows[0]?.row_count, "1");

    const conflictSchema = await createDisposableSchema(pool, migrationRoot);
    created.push(conflictSchema);
    const conflictConfig = disposableConfig(conflictSchema.schema);
    await pool.query(`INSERT INTO ${conflictSchema.quoted}.analytics_source_cursors(
        source_id,sequence,authority_epoch) VALUES ($1,0,0)`, [conflictConfig.sourceId]);
    await assert.rejects(runInClient(pool, client =>
      preparePostgresCommunityDailyActivationInDisposableSchema({
        client, config: conflictConfig, migrations,
      }), conflictSchema.runtimeRole), error => error?.code === "POSTGRES_COMMUNITY_DAILY_ACTIVATION_FIXTURE_CONFLICT");
    const conflictReadback = await pool.query(`SELECT
      (SELECT revision FROM ${conflictSchema.quoted}.collection_controls WHERE singleton=1) AS revision,
      (SELECT count(*) FROM ${conflictSchema.quoted}.participants WHERE id='synthetic-social-owner') AS owner_count,
      (SELECT count(*) FROM ${conflictSchema.quoted}.storage_source_state WHERE singleton=1) AS source_state_count,
      (SELECT count(*) FROM ${conflictSchema.quoted}.typed_telemetry_namespaces WHERE id=1) AS namespace_count`);
    assert.deepEqual(conflictReadback.rows[0], {
      revision: "2", owner_count: "0", source_state_count: "0", namespace_count: "0",
    });
  } finally {
    for (const target of created.reverse()) {
      await pool.query(`DROP SCHEMA IF EXISTS ${target.quoted} CASCADE`);
      await pool.query(`DROP ROLE IF EXISTS ${target.quotedRuntimeRole}`);
    }
    if (migrationRoot !== undefined) await rm(migrationRoot, { recursive: true, force: true });
    await pool.end();
  }
});
