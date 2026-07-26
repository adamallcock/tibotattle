import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_COMPANION_SCHEMA_VERSION,
} from "../../src/local-companion-data.js";
import { startLocalCompanionServer } from "./server.js";

function fakeStore() {
  let reloads = 0;
  return {
    async initialize() {},
    async reload() {
      reloads += 1;
    },
    getOverview() {
      return {
        schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
        mode: "real_local_evidence",
        evidenceStatus: "available",
      };
    },
    getGradient() {
      return { status: "available", datasets: { rolling: [{ quota_change_pp: 3 }] } };
    },
    getWeekly() {
      return { status: "available", datasets: { summary: [{ median_weekly_value_usd: 100 }] } };
    },
    getQuality() {
      return { status: "available", datasets: { summary: [{ known_speed_fraction: 0.8 }] } };
    },
    getReports() {
      return { schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION, reports: [] };
    },
    get reloads() {
      return reloads;
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "local-companion-server-"));
  const staticRoot = join(root, "public");
  await mkdir(staticRoot);
  await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>Usage Monitor</title>");
  await writeFile(join(staticRoot, "app.js"), "export const app = true;");
  await writeFile(join(staticRoot, "data-client.js"), "export const client = true;");
  await writeFile(join(staticRoot, "lib.js"), "export const lib = true;");
  await writeFile(join(staticRoot, "styles.css"), "body { color: black; }");
  await writeFile(
    join(root, "2026-07-24-simple-quota-gradient-report.html"),
    "<!doctype html><title>Gradient detail</title>",
  );
  return { root, staticRoot };
}

function rawRequest({ port, path, method = "GET", headers = {}, body = "" }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolveRequest({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", rejectRequest);
    request.end(body);
  });
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("condition was not reached");
}

test("loopback server exposes only fixed API, static, and report routes", async () => {
  const files = await fixture();
  const store = fakeStore();
  const app = await startLocalCompanionServer({
    root: files.root,
    staticRoot: files.staticRoot,
    dataStore: store,
    refreshRunner: async () => ({}),
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const health = await fetch(`${base}/api/local/health`);
    assert.equal(health.status, 200);
    assert.deepEqual((await health.json()).capabilities, {
      localDashboard: true,
      explicitRefresh: true,
      contributionPreview: true,
      centralServiceProxy: false,
      arbitraryPathAccess: false,
      remoteProxy: false,
    });
    assert.equal(health.headers.get("access-control-allow-origin"), null);
    assert.match(health.headers.get("content-security-policy"), /default-src 'none'/);

    const overview = await fetch(`${base}/api/local/overview`);
    assert.equal(overview.status, 200);
    assert.equal((await overview.json()).mode, "real_local_evidence");

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Usage Monitor/);
    assert.equal((await fetch(`${base}/data-client.js`)).status, 200);

    const report = await fetch(`${base}/reports/gradient`);
    assert.equal(report.status, 200);
    assert.match(await report.text(), /Gradient detail/);

    assert.equal((await fetch(`${base}/reports/not-allowed`)).status, 404);
    assert.equal((await fetch(`${base}/api/local/not-allowed`)).status, 404);
    assert.equal((await fetch(`${base}/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/api/local/overview?path=/Users/private`)).status, 400);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("server rejects forged hosts and requires same-origin refresh authorization", async () => {
  const files = await fixture();
  const store = fakeStore();
  let resolveRefresh;
  const refreshGate = new Promise((resolve) => {
    resolveRefresh = resolve;
  });
  const app = await startLocalCompanionServer({
    root: files.root,
    staticRoot: files.staticRoot,
    dataStore: store,
    refreshRunner: async () => {
      await refreshGate;
      return {
        rolloutRecordsWritten: 2,
        filesDiscovered: 3,
        privatePath: "/Users/private",
        quotaRefresh: { attempted: true, recordWritten: true },
      };
    },
    port: 0,
  });
  try {
    const forgedHost = await rawRequest({
      port: app.port,
      path: "/api/local/health",
      headers: { Host: "attacker.example" },
    });
    assert.equal(forgedHost.status, 403);
    assert.equal(JSON.parse(forgedHost.body).error.code, "host_not_allowed");

    const base = `http://127.0.0.1:${app.port}`;
    const unauthorized = await fetch(`${base}/api/local/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(unauthorized.status, 403);

    const authorizedHeaders = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const started = await fetch(`${base}/api/local/refresh`, {
      method: "POST",
      headers: authorizedHeaders,
      body: JSON.stringify({ reason: "user_request" }),
    });
    assert.equal(started.status, 202);
    assert.equal((await started.json()).refresh.status, "running");

    const duplicate = await fetch(`${base}/api/local/refresh`, {
      method: "POST",
      headers: authorizedHeaders,
      body: "{}",
    });
    assert.equal(duplicate.status, 409);
    resolveRefresh();
    await waitFor(async () => {
      const status = await fetch(`${base}/api/local/refresh`).then((response) => response.json());
      return status.refresh.status === "succeeded";
    });
    const completed = await fetch(`${base}/api/local/refresh`).then((response) => response.json());
    assert.deepEqual(completed.refresh.result, {
      rolloutRecordsWritten: 2,
      filesDiscovered: 3,
      quotaRefresh: { attempted: true, recordWritten: true, errorCode: null },
    });
    assert.equal(JSON.stringify(completed).includes("/Users/private"), false);
    assert.equal(store.reloads, 1);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("contribution preview returns counts and accounting only", async () => {
  const files = await fixture();
  const app = await startLocalCompanionServer({
    root: files.root,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionPreviewProvider: async () => ({
      status: "available",
      coveredAt: {
        startAt: "2026-07-24T00:00:00.000Z",
        endAt: "2026-07-25T00:00:00.000Z",
      },
      counts: { usageEvents: 20, quotaSnapshots: 4, activityMarkers: 2 },
      accounting: {
        basis: "api_price_equivalent_not_subscription_allowance",
        fullyPricedEvents: 18,
        partiallyPricedEvents: 1,
        unpricedEvents: 1,
      },
      usageEvents: [{ content: "private prompt" }],
      accountId: "private-account",
    }),
    port: 0,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/local/contribution/preview`);
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.schemaVersion, "telemetry-contribution-v0.1");
    assert.equal(value.counts.usageEvents, 20);
    assert.equal(value.includesFullRows, false);
    assert.equal(value.remoteSendEnabled, false);
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes("private prompt"), false);
    assert.equal(serialized.includes("private-account"), false);
    assert.equal(Object.hasOwn(value, "usageEvents"), false);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("optional central proxy exposes public reads and blocks every authenticated route", async () => {
  const files = await fixture();
  const forwarded = [];
  const app = await startLocalCompanionServer({
    root: files.root,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    centralOrigin: "https://central.example",
    centralFetch: async (url, options) => {
      forwarded.push({
        url,
        method: options.method,
        headers: { ...options.headers },
        body: options.body?.toString("utf8") ?? null,
      });
      return new Response(JSON.stringify({
        status: "ok",
        suppressed: true,
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Replayed": "true",
          "X-Private-Upstream": "must-not-pass",
          "Set-Cookie": "__Host-um_session=must-not-pass; Secure; HttpOnly",
        },
      });
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const health = await fetch(`${base}/api/local/health`).then((response) => response.json());
    assert.equal(health.capabilities.centralServiceProxy, true);

    const response = await fetch(`${base}/api/v1/stats/aggregate`, {
      headers: {
        Origin: base,
        Authorization: "Bearer must-not-pass",
        Cookie: "__Host-um_session=must-not-pass",
        "X-Usage-Monitor-CSRF": "must-not-pass",
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("idempotency-replayed"), "true");
    assert.equal(response.headers.get("x-private-upstream"), null);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(forwarded.length, 1);
    assert.deepEqual(forwarded[0], {
      url: "https://central.example/api/v1/stats/aggregate",
      method: "GET",
      headers: { Accept: "application/json" },
      body: null,
    });

    const blocked = [
      { path: "/api/v1/enroll", method: "POST" },
      { path: "/api/v1/recover", method: "POST" },
      { path: "/api/v1/session", method: "GET" },
      { path: "/api/v1/logout", method: "POST" },
      { path: "/api/v1/me", method: "GET" },
      { path: "/api/v1/me", method: "DELETE" },
      { path: "/api/v1/me/stats", method: "GET" },
      { path: "/api/v1/me/insights", method: "GET" },
      { path: "/api/v1/me/export", method: "GET" },
      { path: "/api/v1/me/security-reset", method: "POST" },
      { path: "/api/v1/me/upload-authorizations", method: "POST" },
      { path: "/api/v1/contributions", method: "POST" },
      {
        path: `/api/v1/contributions/${encodeURIComponent("contribution:00000000-0000-4000-8000-000000000000")}`,
        method: "GET",
      },
    ];
    for (const item of blocked) {
      const blockedResponse = await fetch(`${base}${item.path}`, {
        method: item.method,
        headers: {
          "Content-Type": "application/json",
          Origin: base,
          Authorization: "Bearer must-not-pass",
          Cookie: "__Host-um_session=must-not-pass",
          "X-Usage-Monitor-CSRF": "must-not-pass",
        },
        body: item.method === "POST" ? "{}" : undefined,
      });
      assert.equal(blockedResponse.status, 404, `${item.method} ${item.path}`);
    }
    assert.equal((await fetch(`${base}/api/v1/stats/aggregate?next=https://attacker.example`)).status, 400);
    assert.equal((await fetch(`${base}/api/v1/admin`)).status, 404);
    assert.equal(forwarded.length, 1);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});
