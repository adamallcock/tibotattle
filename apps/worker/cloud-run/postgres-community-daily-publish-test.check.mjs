import assert from "node:assert/strict";
import test from "node:test";
import {
  POSTGRES_COMMUNITY_DAILY_TEST_IAM_USER,
  POSTGRES_COMMUNITY_DAILY_TEST_JOB,
  POSTGRES_COMMUNITY_DAILY_TEST_PROJECTION_SCOPE,
  POSTGRES_COMMUNITY_DAILY_TEST_SERVICE_ACCOUNT,
  POSTGRES_COMMUNITY_DAILY_TEST_TARGET,
  parsePostgresCommunityDailyTestConfig,
  readPostgresCommunityDailyTestPreflight,
  readAttachedPostgresCommunityDailyTestServiceAccount,
  runPostgresCommunityDailyTest,
} from "./dist/postgres-community-daily-publish-test.mjs";

const EXECUTION = "tibotattle-community-daily-publish-test-00001-abc";
const DAY = "2026-09-24";
const READY_PREFLIGHT = {
  status: "ready",
  blockers: [],
  projectionScope: POSTGRES_COMMUNITY_DAILY_TEST_PROJECTION_SCOPE,
};

function validEnv(overrides = {}) {
  return {
    CLOUD_RUN_JOB: POSTGRES_COMMUNITY_DAILY_TEST_JOB,
    CLOUD_RUN_EXECUTION: EXECUTION,
    CLOUD_RUN_TASK_INDEX: "0",
    CLOUD_RUN_TASK_COUNT: "1",
    CLOUD_RUN_TASK_ATTEMPT: "0",
    GOOGLE_CLOUD_PROJECT: "tibotattle",
    CLOUD_RUN_TEST_SERVICE: "tibotattle-test-app",
    HOST_ORIGIN: "https://tibotattle-test-app-5t5mehqi7a-ue.a.run.app",
    POSTGRES_IAM_USER: POSTGRES_COMMUNITY_DAILY_TEST_IAM_USER,
    PRIMARY_INSTANCE_CONNECTION_NAME: POSTGRES_COMMUNITY_DAILY_TEST_TARGET.instanceConnectionName,
    PRIMARY_DATABASE: POSTGRES_COMMUNITY_DAILY_TEST_TARGET.database,
    PRIMARY_SCHEMA: POSTGRES_COMMUNITY_DAILY_TEST_TARGET.schema,
    POSTGRES_SOURCE_ID: "synthetic-community-source",
    POSTGRES_SOURCE_NAMESPACE: "synthetic-community-namespace",
    COMMUNITY_DAILY_SYNTHETIC_DAY: DAY,
    ...overrides,
  };
}

test("daily publisher Job accepts only its private single-task A2 target and one UTC day", () => {
  const config = parsePostgresCommunityDailyTestConfig(validEnv(), POSTGRES_COMMUNITY_DAILY_TEST_SERVICE_ACCOUNT);
  assert.deepEqual(config, {
    job: POSTGRES_COMMUNITY_DAILY_TEST_JOB,
    project: "tibotattle",
    execution: EXECUTION,
    service: "tibotattle-test-app",
    origin: "https://tibotattle-test-app-5t5mehqi7a-ue.a.run.app",
    instanceConnectionName: POSTGRES_COMMUNITY_DAILY_TEST_TARGET.instanceConnectionName,
    database: POSTGRES_COMMUNITY_DAILY_TEST_TARGET.database,
    schema: POSTGRES_COMMUNITY_DAILY_TEST_TARGET.schema,
    iamUser: POSTGRES_COMMUNITY_DAILY_TEST_IAM_USER,
    sourceId: "synthetic-community-source",
    sourceNamespace: "synthetic-community-namespace",
    day: DAY,
  });
  for (const overrides of [
    { CLOUD_RUN_JOB: "other-job" },
    { CLOUD_RUN_TASK_COUNT: "2" },
    { CLOUD_RUN_TASK_ATTEMPT: "1" },
    { GOOGLE_CLOUD_PROJECT: "production" },
    { K_SERVICE: "tibotattle-test-app" },
    { CLOUD_RUN_TEST_SERVICE: "other-service" },
    { PRIMARY_SCHEMA: "tibotattle" },
    { POSTGRES_IAM_USER: "other@tibotattle.iam" },
    { COMMUNITY_DAILY_SYNTHETIC_DAY: "2026-02-30" },
    { COMMUNITY_DAILY_SYNTHETIC_DAY: "2026-09-24..2026-09-25" },
    { POSTGRES_SOURCE_ID: "account@example.com" },
  ]) {
    assert.throws(
      () => parsePostgresCommunityDailyTestConfig(
        validEnv(overrides), POSTGRES_COMMUNITY_DAILY_TEST_SERVICE_ACCOUNT,
      ),
    );
  }
  assert.throws(() => parsePostgresCommunityDailyTestConfig(
    validEnv(), "tibotattle-test-migrator@tibotattle.iam.gserviceaccount.com",
  ), /CLOUD_RUN_COMMUNITY_DAILY_TEST_SERVICE_ACCOUNT_INVALID/);
});

test("metadata identity requires Google's marker and the exact runtime service account", async () => {
  const email = await readAttachedPostgresCommunityDailyTestServiceAccount({
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email");
      assert.equal(options.headers["Metadata-Flavor"], "Google");
      return new Response(POSTGRES_COMMUNITY_DAILY_TEST_SERVICE_ACCOUNT, {
        status: 200,
        headers: { "Metadata-Flavor": "Google" },
      });
    },
  });
  assert.equal(email, POSTGRES_COMMUNITY_DAILY_TEST_SERVICE_ACCOUNT);
  await assert.rejects(readAttachedPostgresCommunityDailyTestServiceAccount({
    fetchImpl: async () => new Response(POSTGRES_COMMUNITY_DAILY_TEST_SERVICE_ACCOUNT, { status: 200 }),
  }), /CLOUD_RUN_COMMUNITY_DAILY_TEST_METADATA_UNAVAILABLE/);
});

test("publisher preflight uses a read-only snapshot and reports disabled controls and cursor lag", async () => {
  const calls = [];
  let serverVersionNum = 170006;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith("SELECT current_setting")) {
        return { rows: [{
          server_version_num: serverVersionNum,
          source_id: "synthetic-community-source",
          source_authority_epoch: "0",
          cursor_sequence: "4",
          cursor_authority_epoch: "0",
          v1_source_namespace: "synthetic-community-namespace",
          v1_runtime_contract_version: 1,
          v11_source_namespace: "synthetic-community-namespace",
          v11_runtime_contract_version: 1,
          policy_revision: 1,
          collection_revision: 2,
          control_state: "disabled",
          publication_enabled: false,
          latest_sequence: "7",
          terminal_sequence: "6",
        }] };
      }
      return { rows: [] };
    },
    release() { calls.push({ sql: "release" }); },
  };
  const config = parsePostgresCommunityDailyTestConfig(
    validEnv(), POSTGRES_COMMUNITY_DAILY_TEST_SERVICE_ACCOUNT,
  );
  const result = await readPostgresCommunityDailyTestPreflight({ connect: async () => client }, config);
  assert.deepEqual(result, {
    status: "blocked",
    blockers: [
      "PUBLICATION_CONTROLS_DISABLED",
      "ANALYTICS_CURSOR_BEHIND_JOURNAL",
      "TERMINAL_EVENT_BEHIND_CURSOR",
    ],
    projectionScope: POSTGRES_COMMUNITY_DAILY_TEST_PROJECTION_SCOPE,
  });
  assert.match(calls[0].sql, /^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY$/u);
  assert.match(calls[1].sql, /^SELECT current_setting/u);
  assert.deepEqual(calls[1].params, ["synthetic-community-source"]);
  assert.equal(calls[1].sql.includes("v1.2"), false);
  assert.equal(calls.at(-2).sql, "COMMIT");
  assert.equal(calls.at(-1).sql, "release");
  assert.equal(JSON.stringify(result).includes("synthetic-community"), false);
  serverVersionNum = 160005;
  const oldMajor = await readPostgresCommunityDailyTestPreflight({ connect: async () => client }, config);
  assert.equal(oldMajor.blockers[0], "POSTGRES_MAJOR_VERSION_UNSUPPORTED");
});

test("publisher calls one day, reads back that exact revision, and returns no source identity", async () => {
  const calls = [];
  const pool = { async end() {} };
  const connector = {};
  const receipt = await runPostgresCommunityDailyTest({
    env: validEnv(),
    dependencies: {
      attachedServiceAccountEmail: POSTGRES_COMMUNITY_DAILY_TEST_SERVICE_ACCOUNT,
      preflight: async () => READY_PREFLIGHT,
      createConnector: () => connector,
      createIamPool: async (options) => {
        calls.push(["connect", options]);
        return pool;
      },
      publish: async (actualPool, options) => {
        calls.push(["publish", actualPool, options]);
        return { state: "published", day: DAY, revision: 3 };
      },
      readPublished: async (actualPool, options) => {
        calls.push(["read", actualPool, options]);
        return {
          rows: [{
            day: DAY,
            revision: 3,
            payload_json: JSON.stringify({ day: DAY, revision: 3, totals: { usageEvents: 0 } }),
          }],
        };
      },
      closeResources: async (resources) => {
        assert.deepEqual(resources, { pools: [pool], connector });
        calls.push(["close"]);
      },
    },
  });
  assert.deepEqual(receipt, {
    schemaVersion: "postgres-community-daily-test-v1",
    status: "ok",
    job: POSTGRES_COMMUNITY_DAILY_TEST_JOB,
    project: "tibotattle",
    execution: EXECUTION,
    day: DAY,
    publicationState: "published",
    revision: 3,
    readback: "exact_revision_verified",
    projectionScope: POSTGRES_COMMUNITY_DAILY_TEST_PROJECTION_SCOPE,
    activityState: "empty",
    usageEvents: 0,
    allowanceState: "updating",
  });
  assert.equal(JSON.stringify(receipt).includes("synthetic-community"), false);
  assert.equal(calls[0][1].max, 1);
  assert.deepEqual(calls[1][2], {
    sourceId: "synthetic-community-source",
    sourceNamespace: "synthetic-community-namespace",
    day: DAY,
    schema: { primarySchema: POSTGRES_COMMUNITY_DAILY_TEST_TARGET.schema },
  });
  assert.deepEqual(calls[2][2], {
    sourceId: "synthetic-community-source",
    sourceNamespace: "synthetic-community-namespace",
    fromDay: DAY,
    throughDay: DAY,
    schema: { primarySchema: POSTGRES_COMMUNITY_DAILY_TEST_TARGET.schema },
  });
  assert.deepEqual(calls.at(-1), ["close"]);
});

test("publisher fails closed and closes the pool when exact-day readback does not match", async () => {
  let closeCalls = 0;
  await assert.rejects(runPostgresCommunityDailyTest({
    env: validEnv(),
    dependencies: {
      attachedServiceAccountEmail: POSTGRES_COMMUNITY_DAILY_TEST_SERVICE_ACCOUNT,
      preflight: async () => READY_PREFLIGHT,
      createConnector: () => ({}),
      createIamPool: async () => ({}),
      publish: async () => ({ state: "unchanged", day: DAY, revision: 3 }),
      readPublished: async () => ({ rows: [] }),
      closeResources: async () => { closeCalls += 1; },
    },
  }), /POSTGRES_COMMUNITY_DAILY_TEST_READBACK_INVALID/);
  assert.equal(closeCalls, 1);
});

test("blocked preflight makes no publication or readback call and can return a safe checklist", async () => {
  const calls = [];
  const blocked = {
    status: "blocked",
    blockers: ["PUBLICATION_CONTROLS_DISABLED", "ANALYTICS_CURSOR_BEHIND_JOURNAL"],
    projectionScope: POSTGRES_COMMUNITY_DAILY_TEST_PROJECTION_SCOPE,
  };
  const dependencies = {
    attachedServiceAccountEmail: POSTGRES_COMMUNITY_DAILY_TEST_SERVICE_ACCOUNT,
    createConnector: () => ({}),
    createIamPool: async () => ({ end: async () => {} }),
    preflight: async () => blocked,
    publish: async () => { calls.push("publish"); throw new Error("must not publish"); },
    readPublished: async () => { calls.push("read"); throw new Error("must not read"); },
    closeResources: async () => {},
  };
  const env = validEnv();
  await assert.rejects(runPostgresCommunityDailyTest({ env, dependencies }),
    (error) => error.code === "POSTGRES_COMMUNITY_DAILY_TEST_PREFLIGHT_BLOCKED"
      && error.preflightBlockers === blocked.blockers);
  const receipt = await runPostgresCommunityDailyTest({
    env, dependencies, preflightOnly: true,
  });
  assert.deepEqual(receipt, {
    schemaVersion: "postgres-community-daily-test-preflight-v1",
    status: "blocked",
    job: POSTGRES_COMMUNITY_DAILY_TEST_JOB,
    project: "tibotattle",
    execution: EXECUTION,
    day: DAY,
    readOnly: true,
    projectionScope: POSTGRES_COMMUNITY_DAILY_TEST_PROJECTION_SCOPE,
    blockers: blocked.blockers,
  });
  assert.deepEqual(calls, []);
});

test("invalid Job targets fail before metadata or database access", async () => {
  let metadataCalls = 0;
  let connectionCalls = 0;
  await assert.rejects(runPostgresCommunityDailyTest({
    env: validEnv({ GOOGLE_CLOUD_PROJECT: "production" }),
    dependencies: {
      readAttachedServiceAccount: async () => { metadataCalls += 1; return POSTGRES_COMMUNITY_DAILY_TEST_SERVICE_ACCOUNT; },
      createIamPool: async () => { connectionCalls += 1; return {}; },
      closeResources: async () => {},
    },
  }), /CLOUD_RUN_COMMUNITY_DAILY_TEST_JOB_CONTEXT_INVALID/);
  assert.equal(metadataCalls, 0);
  assert.equal(connectionCalls, 0);
});
