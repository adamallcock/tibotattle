import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORK_USAGE_SCHEMA,
  createWorkUsageAccumulator,
} from "../../src/reporting/index.js";
import { startLocalCompanionServer } from "./server.js";

function event({ project, tokens, thread = `thread-${project}` }) {
  return {
    thread,
    project,
    worktree: `${project}-worktree`,
    model: "gpt-5.6-sol",
    at: 1_000,
    components: {
      input_uncached_tokens: null,
      input_cache_read_tokens: null,
      input_cache_write_tokens: null,
      output_text_tokens: tokens,
      output_reasoning_tokens: 0,
      output_combined_tokens: null,
    },
    price: { amount: "0", status: "fully_priced" },
  };
}

function reportFrom(events) {
  const accumulator = createWorkUsageAccumulator();
  for (const item of events) accumulator.add(item);
  return { cells: accumulator.finish() };
}

function buildResult(events, generation = 1) {
  return {
    status: "available",
    generation,
    scope: "device",
    scopes: ["device"],
    metadata: {},
    models: ["gpt-5.6-sol"],
    threadLookup: {},
    ...reportFrom(events),
  };
}

function rawRequest({
  port,
  method = "POST",
  host = `127.0.0.1:${port}`,
  path = "/api/local/work-usage/query",
  headers = {},
  body = "",
}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method, headers: { Host: host, ...headers } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function jsonRequest(options) {
  const response = await rawRequest(options);
  let json = null;
  try {
    json = JSON.parse(response.body);
  } catch {
    // A malformed response is asserted by the caller when it matters.
  }
  return { ...response, json };
}

function requestBody(overrides = {}) {
  return JSON.stringify({ schemaVersion: WORK_USAGE_SCHEMA, ...overrides });
}

function localHeaders(overrides = {}) {
  return { "X-Usage-Monitor-Local": "1", "Content-Type": "application/json", ...overrides };
}

function fakeStore() {
  return {
    async initialize() {},
    async reload() {},
    getOverview() { return { schemaVersion: "local-companion-v0.1" }; },
    getGradient() { return { status: "unavailable" }; },
    getWeekly() { return { status: "unavailable" }; },
    getWeeklyPaceOutlook() { return { status: "unavailable" }; },
    getQuality() { return { status: "unavailable" }; },
    getReports() { return { schemaVersion: "local-companion-v0.1", reports: [] }; },
  };
}

async function serverFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "work-usage-route-"));
  const resourceRoot = join(root, "resources");
  const staticRoot = join(resourceRoot, "public");
  const stateRoot = join(root, "state");
  const codexHome = join(root, "codex");
  await mkdir(staticRoot, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  const app = await startLocalCompanionServer({
    resourceRoot,
    staticRoot,
    stateRoot,
    codexHome,
    environment: { HOME: root },
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionServiceOrigin: null,
    preparedContributionDirectory: null,
    legacyContributionDeviceStateFile: null,
    automaticContributionRetirementStateRunner: async () => ({ status: "retired" }),
    automaticContributionRetirementLockAcquirer: async () => ({ release: async () => {} }),
    ...options,
    port: 0,
  });
  await app.snapshotReady;
  return { app, root };
}

async function closeFixture(fixture) {
  await fixture.app.close();
  await rm(fixture.root, { recursive: true, force: true });
}

test("work-usage route rejects foreign origin/host, method, media, oversize, and unknown fields before build", async () => {
  let builds = 0;
  const fixture = await serverFixture({
    workUsageBuild: async () => {
      builds += 1;
      return buildResult([event({ project: "repo-a", tokens: 1 })]);
    },
    workUsageEnrich: async () => ({}),
  });
  try {
    const { app } = fixture;
    const valid = requestBody({ period: "7d", grouping: "project", sort: "tokens" });
    const cases = [
      {
        name: "foreign origin",
        request: { headers: localHeaders({ Origin: "http://attacker.invalid" }), body: valid },
        status: 403,
      },
      {
        name: "foreign host",
        request: { host: `127.0.0.1:${app.port + 1}`, headers: localHeaders(), body: valid },
        status: 403,
      },
      {
        name: "wrong method",
        request: { method: "GET", headers: { "X-Usage-Monitor-Local": "1" } },
        status: 405,
      },
      {
        name: "unsupported media",
        request: { headers: { "X-Usage-Monitor-Local": "1", "Content-Type": "text/plain" }, body: valid },
        status: 415,
      },
      {
        name: "oversize",
        request: {
          headers: localHeaders({ "Content-Length": "4097" }),
          body: "x".repeat(4097),
        },
        status: 413,
      },
      {
        name: "unknown field",
        request: { headers: localHeaders(), body: requestBody({ unknown: true }) },
        status: 400,
      },
    ];
    for (const item of cases) {
      const response = await jsonRequest({ port: app.port, ...item.request });
      assert.equal(response.status, item.status, item.name);
      assert.ok(response.json?.error?.code, item.name);
    }
    assert.equal(builds, 0);
  } finally {
    await closeFixture(fixture);
  }
});

test("work-usage route accepts no Origin with the local capability and keeps a stable snapshot across pagination", async () => {
  let builds = 0;
  let enrichments = 0;
  let sourceEvents = [
    event({ project: "repo-a", tokens: 30 }),
    event({ project: "repo-b", tokens: 20 }),
  ];
  const fixture = await serverFixture({
    workUsageBuild: async () => {
      builds += 1;
      return buildResult(sourceEvents, builds);
    },
    workUsageEnrich: async () => { enrichments += 1; return {}; },
  });
  try {
    const { app } = fixture;
    const headers = localHeaders();
    const request = requestBody({ period: "7d", grouping: "project", sort: "tokens", pageSize: 1 });
    const preparing = await jsonRequest({ port: app.port, headers, body: request });
    assert.equal(preparing.status, 200);
    assert.equal(preparing.json.status, "preparing");
    assert.equal(builds, 1);
    assert.match(preparing.json.snapshotId, /^[a-zA-Z0-9:_-]{1,200}$/u);

    let first;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      first = await jsonRequest({
        port: app.port,
        headers,
        body: requestBody({
          period: "7d",
          grouping: "project",
          sort: "tokens",
          pageSize: 1,
          snapshotId: preparing.json.snapshotId,
        }),
      });
      if (first.json?.status === "available") break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(first.status, 200);
    assert.equal(first.json.status, "available");
    assert.equal(first.json.rows[0].id, "repo-a");
    assert.ok(first.json.nextCursor);
    assert.equal(first.json.totals.tokens, 50);

    const enrichmentCount = enrichments;
    const touched = await jsonRequest({
      port: app.port, headers,
      body: requestBody({ action: "touch", snapshotId: first.json.snapshotId }),
    });
    assert.equal(touched.status, 200);
    assert.deepEqual(touched.json, {
      schemaVersion: WORK_USAGE_SCHEMA,
      status: "available",
      snapshotId: first.json.snapshotId,
      fromMs: first.json.fromMs,
      toMs: first.json.toMs,
      errorCode: null,
    });
    assert.equal(builds, 1);
    assert.equal(enrichments, enrichmentCount);
    const unknown = await jsonRequest({
      port: app.port, headers,
      body: requestBody({ action: "touch", snapshotId: "unknown-snapshot" }),
    });
    assert.equal(unknown.status, 409);
    assert.equal(unknown.json.error.code, "work_usage_snapshot_expired");
    const invalidTouch = await jsonRequest({
      port: app.port, headers,
      body: requestBody({ action: "touch", snapshotId: first.json.snapshotId, search: "not-a-query" }),
    });
    assert.equal(invalidTouch.status, 400);
    assert.equal(invalidTouch.json.error.code, "work_usage_query_invalid");

    sourceEvents = [event({ project: "repo-new", tokens: 100 }), ...sourceEvents];
    const second = await jsonRequest({
      port: app.port,
      headers,
      body: requestBody({
        period: "7d",
        grouping: "project",
        sort: "tokens",
        pageSize: 1,
        snapshotId: first.json.snapshotId,
        cursor: first.json.nextCursor,
      }),
    });
    assert.equal(second.status, 200);
    assert.equal(second.json.status, "available");
    assert.equal(second.json.rows[0].id, "repo-b");
    assert.equal(second.json.totals.tokens, 50);
    assert.equal(second.json.generation, 1);
    assert.equal(builds, 1);
  } finally {
    await closeFixture(fixture);
  }
});

test("work-usage route searches local saved task names through the real enrichment adapter", async () => {
  const uuid = "11111111-1111-4111-8111-111111111111";
  let builds = 0;
  const fixture = await serverFixture({
    workUsageBuild: async () => {
      builds++;
      return {
        ...buildResult([event({ project: "repo-a", tokens: 100 }), event({ project: "repo-b", thread: "needle", tokens: 10 })]),
        display: {
          projects: { "repo-a": { name: "Large project" }, "repo-b": { name: "Small project" } },
          threads: { needle: { uuid } }, worktrees: {},
        },
      };
    },
  });
  try {
    await writeFile(join(fixture.root, "codex", "session_index.jsonl"), JSON.stringify({ id: uuid, thread_name: "Review café interface", updated_at: "2026-09-09T00:00:00Z" }) + "\n", { mode: 0o600 });
    const request = overrides => jsonRequest({ port: fixture.app.port, headers: localHeaders(), body: requestBody(overrides) });
    const invalid = await request({ search: "x".repeat(101) });
    assert.equal(invalid.status, 400);
    assert.equal(builds, 0);
    const first = await request({ pageSize: 1 });
    let result;
    for (let attempt = 0; attempt < 20; attempt++) {
      result = await request({ snapshotId: first.json.snapshotId, pageSize: 1, search: " CAFE\u0301 " });
      if (result.json?.status === "available") break;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.equal(result.status, 200);
    assert.equal(result.json.status, "available");
    assert.equal(result.json.rows[0].id, "repo-b");
    assert.equal(result.json.rows[0].tokens, 10);
    assert.equal(result.json.totals.tokens, 110);
    assert.equal(Object.hasOwn(result.json, "search"), false);
    const children = await request({ snapshotId: first.json.snapshotId, grouping: "thread", project: "repo-b", search: "CAFÉ" });
    assert.equal(children.json.rows[0].id, "needle");
    assert.equal(children.json.display.needle.name, "Review café interface");
    assert.equal(builds, 1);
  } finally {
    await closeFixture(fixture);
  }
});
