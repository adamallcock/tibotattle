import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./postgres-test-dispatch.mjs";
import {
  POSTGRES_COMMUNITY_DAILY_TEST_JOB,
  POSTGRES_COMMUNITY_DAILY_TEST_PROJECTION_SCOPE,
} from "./postgres-community-daily-contract.mjs";
import { runPostgresCommunityDailyLiveSmoke } from "./dist/postgres-community-daily-live-smoke.mjs";

const DAY = "2026-09-24";
const TOKEN = "synthetic-id-token-placeholder";

test("each daily bundle runs only its own CLI guard", () => {
  const cases = [
    {
      entry: "postgres-community-daily-publish-test",
      args: ["--invalid"],
      expected: {
        schemaVersion: "postgres-community-daily-test-v1",
        status: "failed",
        code: "CLOUD_RUN_COMMUNITY_DAILY_TEST_ARGUMENT_INVALID",
        phase: "configuration",
      },
    },
    {
      entry: "postgres-community-daily-live-smoke",
      args: [],
      expected: {
        schemaVersion: "postgres-community-daily-live-smoke-v1",
        status: "failed",
        code: "POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_ARGUMENT_INVALID",
      },
    },
  ];
  for (const { entry, args, expected } of cases) {
    const bundle = fileURLToPath(new URL(`./dist/${entry}.mjs`, import.meta.url));
    const result = spawnSync(process.execPath, [bundle, ...args], {
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(result.error, undefined, `${entry} should start successfully`);
    assert.equal(result.status, 1, `${entry} should reject the invalid CLI invocation`);
    assert.equal(result.stdout, "", `${entry} should not emit a success receipt`);
    assert.deepEqual(
      result.stderr.trim().split(/\r?\n/u).map((line) => JSON.parse(line)),
      [expected],
      `${entry} should emit only its own failure receipt`,
    );
  }
});

function jobReceipt(usageEvents = 0) {
  return {
    schemaVersion: "postgres-community-daily-test-v1",
    status: "ok",
    job: POSTGRES_COMMUNITY_DAILY_TEST_JOB,
    project: CLOUD_RUN_IAM_TEST_TARGET.project,
    execution: "tibotattle-community-daily-publish-test-00001-abc",
    day: DAY,
    publicationState: "published",
    revision: 4,
    readback: "exact_revision_verified",
    projectionScope: POSTGRES_COMMUNITY_DAILY_TEST_PROJECTION_SCOPE,
    activityState: usageEvents === 0 ? "empty" : "partial_v1_v1_1_only",
    usageEvents,
    allowanceState: "updating",
  };
}

function dailyResponse(receipt, overrides = {}) {
  const payload = {
    schemaVersion: "community-daily-aggregate-v1.0",
    day: receipt.day,
    revision: receipt.revision,
    totals: { usageEvents: receipt.usageEvents },
  };
  return {
    schemaVersion: "community-daily-read-v1.0",
    from: receipt.day,
    to: receipt.day,
    allowanceState: "updating",
    allowanceReadState: "confirmed",
    days: [{
      day: receipt.day,
      revision: receipt.revision,
      releasedAt: "2026-09-25T12:00:00.000Z",
      payload,
    }],
    ...overrides,
  };
}

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

test("live smoke GET asserts exact empty daily day/revision and returns no source identity", async () => {
  const receipt = jobReceipt(0);
  const calls = [];
  const result = await runPostgresCommunityDailyLiveSmoke({
    receipt,
    dependencies: {
      getIdToken: async (audience) => {
        assert.equal(audience, CLOUD_RUN_IAM_TEST_TARGET.origin);
        return TOKEN;
      },
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        return response(dailyResponse(receipt));
      },
    },
  });
  assert.deepEqual(result, {
    schemaVersion: "postgres-community-daily-live-smoke-v1",
    status: "ok",
    project: "tibotattle",
    service: "tibotattle-test-app",
    route: "private_http_get",
    readback: "exact_day_revision_verified",
    projectionScope: POSTGRES_COMMUNITY_DAILY_TEST_PROJECTION_SCOPE,
    activityState: "empty",
    allowanceReadState: "confirmed",
    allowanceState: "updating",
    day: DAY,
    revision: 4,
    usageEvents: 0,
  });
  const call = calls[0];
  const url = new URL(call.url);
  assert.equal(url.origin, CLOUD_RUN_IAM_TEST_TARGET.origin);
  assert.equal(url.pathname, "/api/v1/community/daily");
  assert.deepEqual([...url.searchParams], [["from", DAY], ["to", DAY]]);
  assert.equal(call.options.method, "GET");
  assert.equal(call.options.redirect, "manual");
  assert.equal(call.options.headers["x-serverless-authorization"], `Bearer ${TOKEN}`);
  assert.equal(call.options.headers.authorization, undefined);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes("synthetic-community"), false);
});

test("live smoke labels positive usage partial because v1.2 is explicitly excluded", async () => {
  const receipt = jobReceipt(2);
  const result = await runPostgresCommunityDailyLiveSmoke({
    receipt,
    dependencies: {
      getIdToken: async () => TOKEN,
      fetchImpl: async () => response(dailyResponse(receipt)),
    },
  });
  assert.equal(result.activityState, "partial_v1_v1_1_only");
  assert.equal(result.projectionScope, "v1_v1_1_only_v1_2_excluded");
  assert.equal(result.usageEvents, 2);
});

test("live smoke rejects a mismatched revision, empty day, private fields, and non-ready allowance claims", async () => {
  const receipt = jobReceipt(0);
  const changed = dailyResponse(receipt);
  changed.days[0].revision += 1;
  await assert.rejects(runPostgresCommunityDailyLiveSmoke({
    receipt,
    dependencies: {
      getIdToken: async () => TOKEN,
      fetchImpl: async () => response(changed),
    },
  }), /POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_READBACK_INVALID/);

  for (const body of [
    { ...dailyResponse(receipt), days: [] },
    { ...dailyResponse(receipt), allowanceState: "ready" },
    {
      ...dailyResponse(receipt),
      days: [{ ...dailyResponse(receipt).days[0], payload: {
        ...dailyResponse(receipt).days[0].payload,
        sourceNamespace: "must-not-cross",
      } }],
    },
    {
      ...dailyResponse(receipt),
      days: [{ ...dailyResponse(receipt).days[0], payload: {
        ...dailyResponse(receipt).days[0].payload,
        allowance: { fitCount: 1 },
      } }],
    },
  ]) {
    await assert.rejects(runPostgresCommunityDailyLiveSmoke({
      receipt,
      dependencies: {
        getIdToken: async () => TOKEN,
        fetchImpl: async () => response(body),
      },
    }), /POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_READBACK_INVALID/);
  }
  await assert.rejects(runPostgresCommunityDailyLiveSmoke({
    receipt: { ...receipt, usageEvents: 1 },
    dependencies: { getIdToken: async () => TOKEN, fetchImpl: async () => response(dailyResponse(receipt)) },
  }), /POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_RECEIPT_INVALID/);
});

test("live smoke rejects redirects, unsafe response headers, and failed service responses", async () => {
  const receipt = jobReceipt();
  for (const result of [
    response({}, 302, { location: "https://attacker.invalid" }),
    response(dailyResponse(receipt), 401),
    response(dailyResponse(receipt), 200, { "cache-control": "public, max-age=60" }),
  ]) {
    await assert.rejects(runPostgresCommunityDailyLiveSmoke({
      receipt,
      dependencies: { getIdToken: async () => TOKEN, fetchImpl: async () => result },
    }), /POSTGRES_COMMUNITY_DAILY_LIVE_SMOKE_RESPONSE_INVALID/);
  }
});
