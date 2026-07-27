import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  LOCAL_COMPANION_SCHEMA_VERSION,
} from "../../src/local-companion-data.js";
import {
  LocalContributionPreparationError,
} from "../../src/local-contribution-preparation.js";
import {
  buildTelemetryContributionsFromBundle,
} from "../../src/telemetry-contribution-builder.js";
import { startLocalCompanionServer } from "./server.js";

const DEVELOPMENT_COVERAGE = Object.freeze({
  startAt: "2026-07-24T21:00:00.000Z",
  endAt: "2026-07-24T23:02:00.000Z",
});
const REVIEW_JOB_ID = "11111111-1111-4111-8111-111111111111";
const REVIEW_SHA256 = "a".repeat(64);

function exactReviewContribution() {
  return buildTelemetryContributionsFromBundle({
    schemaVersion: "usage-metadata-bundle-v0.1",
    createdAt: "2026-07-26T12:10:00.000Z",
    coveredAt: {
      startAt: "2026-07-26T12:00:00.000Z",
      endAt: "2026-07-26T12:10:00.000Z",
    },
    clientPlatform: "macos",
    records: {
      usageEvents: [{
        schemaVersion: "usage-event-v0.1",
        eventTime: "2026-07-26T12:05:00.000Z",
        provider: "openai_codex",
        modelId: "gpt-5.6-sol",
        modelRecognition: "recognized",
        modelFingerprint: null,
        billingSurface: "chatgpt_subscription",
        speedMode: "standard",
        apiServiceTier: "unknown",
        reasoningEffort: "unknown",
        components: {
          inputUncachedTokens: 100,
          inputCacheReadTokens: 200,
          inputCacheWriteTokens: 0,
          outputTextTokens: 5,
          outputReasoningTokens: 2,
        },
        totalInputContextTokens: 300,
        surface: "extension_or_ide",
        agentScope: "root",
        lineageDisposition: "standalone",
        toolClassCounts: {
          webSearch: 0,
          fileSearch: 0,
          codeInterpreter: 0,
          hostedShell: 0,
          computerUse: 0,
          mcp: 0,
          applyPatch: 0,
          localShell: 0,
          subagent: 0,
          toolGateway: 0,
          other: 0,
          unknown: 0,
        },
        outcome: "unknown",
        eventId: `event:v2:${"a".repeat(64)}`,
        sessionScopeId: `session:v1:${"b".repeat(64)}`,
        accountScopeId: "unattributed",
      }],
      quotaSnapshots: [],
      activityMarkers: [],
    },
  })[0];
}

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
      contributionPreparation: true,
      contributionPreparationIdentityMode: "production_keychain",
      contributionSyncStatus: true,
      contributionSyncNext: true,
      contributionSyncExactReview: true,
      contributionSyncActions: false,
      centralServiceProxy: false,
      centralParticipantRelay: false,
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

test("loopback central relay supports only the participant lifecycle with exact forwarding", async () => {
  const files = await fixture();
  const forwarded = [];
  const validSetCookie =
    "__Host-usage_monitor_session=um_session_00000000-0000-4000-8000-000000000000.secret; Path=/; Max-Age=1800; Secure; HttpOnly; SameSite=Strict";
  const app = await startLocalCompanionServer({
    root: files.root,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    centralOrigin: "http://127.0.0.1:8792",
    centralFetch: async (url, options) => {
      forwarded.push({
        url,
        method: options.method,
        headers: { ...options.headers },
        body: options.body?.toString("utf8") ?? null,
      });
      const headers = {
        "Content-Type": "application/json",
        Vary: "Cookie",
      };
      if (url.endsWith("/api/v1/enroll")) headers["Set-Cookie"] = validSetCookie;
      const responseBody = url.endsWith("/api/v1/me/export")
        ? JSON.stringify({ payload: "x".repeat(5 * 1024 * 1024) })
        : JSON.stringify({ status: "ok" });
      return new Response(responseBody, {
        status: url.endsWith("/api/v1/enroll") ? 201 : 200,
        headers,
      });
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const health = await fetch(`${base}/api/local/health`).then((response) => response.json());
    assert.equal(health.capabilities.centralParticipantRelay, true);

    const enrolled = await fetch(`${base}/api/v1/enroll`, {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        Cookie: "unrelated=must-not-pass",
      },
      body: '{"consentVersion":"privacy-safe-telemetry-v0.1","syntheticOnly":false}',
    });
    assert.equal(enrolled.status, 201);
    assert.equal(enrolled.headers.get("set-cookie"), validSetCookie);

    const sessionCookie =
      "__Host-usage_monitor_session=um_session_00000000-0000-4000-8000-000000000000.secret";
    assert.equal((await fetch(`${base}/api/v1/me/stats`, {
      headers: { Cookie: `${sessionCookie}; unrelated=must-not-pass` },
    })).status, 200);
    assert.equal((await fetch(`${base}/api/v1/me/upload-authorizations`, {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        Cookie: `${sessionCookie}; unrelated=must-not-pass`,
        "X-Usage-Monitor-CSRF": "csrf_token",
      },
      body: '{"envelopeDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","contentLengthBytes":100,"contentType":"application/json"}',
    })).status, 200);
    const uploadAuthorization =
      "Upload um_upload_00000000-0000-4000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    assert.equal((await fetch(`${base}/api/v1/contributions`, {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        Authorization: uploadAuthorization,
      },
      body: '{"schemaVersion":"telemetry-envelope-v0.1"}',
    })).status, 200);
    assert.equal((await fetch(`${base}/api/v1/me`, {
      method: "DELETE",
      headers: {
        Origin: base,
        Cookie: sessionCookie,
        "X-Usage-Monitor-CSRF": "csrf_token",
      },
    })).status, 200);
    const exported = await fetch(`${base}/api/v1/me/export`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(exported.status, 200);
    assert.equal((await exported.arrayBuffer()).byteLength > 4 * 1024 * 1024, true);

    assert.equal(forwarded[0].url, "http://127.0.0.1:8792/api/v1/enroll");
    assert.equal(forwarded[0].headers.Origin, "http://127.0.0.1:8792");
    assert.equal(Object.hasOwn(forwarded[0].headers, "Cookie"), false);
    assert.deepEqual(forwarded[1].headers, {
      Accept: "application/json",
      Origin: "http://127.0.0.1:8792",
      Cookie: sessionCookie,
    });
    assert.equal(forwarded[2].headers.Cookie, sessionCookie);
    assert.equal(forwarded[2].headers["X-Usage-Monitor-CSRF"], "csrf_token");
    assert.equal(forwarded[2].body.includes("envelopeDigest"), true);
    assert.equal(forwarded[3].headers.Authorization, uploadAuthorization);
    assert.equal(Object.hasOwn(forwarded[3].headers, "Cookie"), false);
    assert.equal(forwarded[4].method, "DELETE");
    assert.equal(forwarded[4].body, null);
    assert.equal(forwarded[5].url, "http://127.0.0.1:8792/api/v1/me/export");
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("loopback participant relay blocks unknown authority routes and fails closed", async () => {
  const files = await fixture();
  let mode = "ok";
  let forwarded = 0;
  const app = await startLocalCompanionServer({
    root: files.root,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    centralOrigin: "http://localhost:8792",
    centralFetch: async () => {
      forwarded += 1;
      if (mode === "throw") throw new Error("private upstream detail");
      if (mode === "html") {
        return new Response("<h1>not json</h1>", {
          headers: { "Content-Type": "text/html" },
        });
      }
      if (mode === "cookie") {
        return Response.json({ status: "ok" }, {
          headers: { "Set-Cookie": "attacker=value; Path=/" },
        });
      }
      return Response.json({ status: "ok" });
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    for (const path of [
      "/api/v1/admin",
      "/api/v1/device-pairings/claim",
      "/api/v1/device/upload-authorizations",
      "/api/v1/contributions/contribution:00000000-0000-4000-8000-000000000000",
    ]) {
      assert.equal((await fetch(`${base}${path}`)).status, 404);
    }
    assert.equal(forwarded, 0);
    assert.equal((await fetch(`${base}/api/v1/me/stats`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: "{}",
    })).status, 405);
    assert.equal(forwarded, 0);
    assert.equal((await fetch(`${base}/api/v1/enroll`, {
      method: "POST",
      headers: {
        Origin: "http://attacker.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    })).status, 403);
    assert.equal(forwarded, 0);
    assert.equal((await fetch(`${base}/api/v1/me/stats`, {
      headers: { Authorization: "Bearer must-not-pass" },
    })).status, 400);
    assert.equal(forwarded, 0);

    mode = "throw";
    assert.equal((await fetch(`${base}/api/v1/session`)).status, 502);
    mode = "html";
    assert.equal((await fetch(`${base}/api/v1/session`)).status, 502);
    mode = "cookie";
    assert.equal((await fetch(`${base}/api/v1/session`)).status, 502);
    assert.equal(forwarded, 3);
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

test("development file override drives the real default preparation runner without Keychain", async () => {
  const files = await fixture();
  const privateCanary = "private-session-that-must-not-leak";
  const secretCanary = Buffer.alloc(32, 37).toString("base64url");
  const secretFile = join(files.root, "development-export-identity");
  const codexHome = join(files.root, "codex-home");
  const sessionDirectory = join(codexHome, "sessions");
  const preparedDirectory = join(files.root, "prepared");
  const reviewDirectory = join(files.root, "reviews");
  const queueFile = join(files.root, "queue.sqlite3");
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  await writeFile(secretFile, `${secretCanary}\n`, { mode: 0o600 });
  const tokenUsage = {
    input_tokens: 100,
    cached_input_tokens: 40,
    cache_write_input_tokens: 0,
    output_tokens: 20,
    reasoning_output_tokens: 8,
    total_tokens: 120,
  };
  const rows = [
    {
      timestamp: "2026-07-24T23:00:00.000Z",
      type: "session_meta",
      payload: {
        id: privateCanary,
        source: "user",
      },
    },
    {
      timestamp: "2026-07-24T23:00:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    },
    {
      timestamp: "2026-07-24T23:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: tokenUsage,
          last_token_usage: tokenUsage,
        },
        rate_limits: {
          limit_id: "codex",
          plan_type: "pro",
          primary: {
            used_percent: 20,
            window_minutes: 10_080,
            resets_at: 1_785_438_000,
          },
        },
      },
    },
  ];
  await writeFile(
    join(sessionDirectory, "rollout-current.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    { mode: 0o600 },
  );
  const store = fakeStore();
  store.getOverview = () => ({
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    mode: "real_local_evidence",
    evidenceStatus: "available",
    collector: {
      exportableCoveredAt: DEVELOPMENT_COVERAGE,
    },
  });
  let keychainConstructions = 0;
  const app = await startLocalCompanionServer({
    root: files.root,
    staticRoot: files.staticRoot,
    dataStore: store,
    refreshRunner: async () => ({}),
    environment: {
      USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE: secretFile,
      USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY: "1",
    },
    contributionQueueFile: queueFile,
    preparedContributionDirectory: preparedDirectory,
    contributionPreparationCreateKeychainBackend() {
      keychainConstructions += 1;
      throw new Error("Keychain must not be constructed");
    },
    contributionPreparationOptions: {
      codexHome,
      activityFile: join(files.root, "missing-activity-markers.jsonl"),
      reviewArchiveDirectory: reviewDirectory,
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const health = await fetch(`${base}/api/local/health`)
      .then((response) => response.json());
    assert.equal(
      health.capabilities.contributionPreparationIdentityMode,
      "development_file_override",
    );
    assert.equal(JSON.stringify(health).includes(secretFile), false);
    assert.equal(JSON.stringify(health).includes(secretCanary), false);

    const prepared = await fetch(
      `${base}/api/local/contribution/prepare`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Usage-Monitor-Local": "1",
          Origin: base,
        },
        body: "{}",
      },
    );
    assert.equal(prepared.status, 200);
    const result = await prepared.json();
    assert.equal(result.status, "prepared");
    assert.equal(result.prepared.batchCount, 1);
    assert.equal(result.networkActivity, false);
    assert.equal(JSON.stringify(result).includes(files.root), false);
    assert.equal(JSON.stringify(result).includes(privateCanary), false);
    assert.equal(JSON.stringify(result).includes(secretCanary), false);
    assert.equal(keychainConstructions, 0);

    const next = await fetch(
      `${base}/api/local/contribution/sync-next`,
    ).then((response) => response.json());
    assert.equal(next.status, "available");
    assert.equal(next.state, "ready");
    assert.equal(next.networkActivity, false);

    const unauthorizedReview = await fetch(
      `${base}/api/local/contribution/sync-inspect-exact`,
      { method: "POST" },
    );
    assert.equal(unauthorizedReview.status, 403);
    const exactReviewResponse = await fetch(
      `${base}/api/local/contribution/sync-inspect-exact`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Usage-Monitor-Local": "1",
          Origin: base,
        },
        body: "{}",
      },
    );
    assert.equal(exactReviewResponse.status, 200);
    const exactReview = await exactReviewResponse.json();
    assert.equal(exactReview.status, "available");
    assert.equal(exactReview.state, "ready");
    assert.equal(exactReview.networkActivity, false);
    assert.equal(exactReview.includesExactRetainedFields, true);
    assert.equal(exactReview.includesRawContent, false);
    assert.equal(exactReview.includesPaths, false);
    assert.equal(exactReview.includesDirectIdentifiers, false);
    assert.equal(exactReview.includesCredentials, false);
    assert.equal(exactReview.payload.schemaVersion, "telemetry-contribution-v0.1");
    assert.ok(exactReview.payload.usageEvents.length > 0);
    assert.ok(exactReview.payloadBytes > 0);
    assert.match(exactReview.reviewToken, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(JSON.stringify(exactReview).includes(files.root), false);
    assert.equal(JSON.stringify(exactReview).includes(privateCanary), false);
    assert.equal(JSON.stringify(exactReview).includes(secretCanary), false);
    assert.equal(
      (await fetch(
        `${base}/api/local/contribution/sync-inspect-exact`,
      )).status,
      405,
    );
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("development identity configuration fails before listen without disclosing its path", async () => {
  const files = await fixture();
  const secretFile = join(files.root, "development-export-identity");
  const secretLink = join(files.root, "development-export-identity-link");
  const directory = join(files.root, "identity-directory");
  await writeFile(
    secretFile,
    `${Buffer.alloc(32, 41).toString("base64url")}\n`,
    { mode: 0o600 },
  );
  await symlink(secretFile, secretLink);
  await mkdir(directory, { mode: 0o700 });

  const assertInvalid = async (options) => {
    await assert.rejects(
      startLocalCompanionServer({
        root: files.root,
        staticRoot: files.staticRoot,
        dataStore: fakeStore(),
        refreshRunner: async () => ({}),
        environment: {},
        port: 0,
        ...options,
      }),
      (error) => error?.code
          === "USAGE_MONITOR_DEVELOPMENT_IDENTITY_INVALID"
        && error.message
          === "Development identity override configuration is invalid"
        && !error.message.includes(files.root)
        && !JSON.stringify(error).includes(files.root),
    );
  };

  try {
    await assertInvalid({
      environment: {
        USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE: secretFile,
      },
    });
    await assertInvalid({
      environment: {
        USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY: "1",
      },
    });
    await assertInvalid({
      environment: {
        USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE:
          "relative-export-identity",
        USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY: "1",
      },
    });
    await assertInvalid({
      environment: {
        USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE: directory,
        USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY: "1",
      },
    });
    await assertInvalid({
      environment: {
        USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE: secretLink,
        USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY: "1",
      },
    });

    await chmod(secretFile, 0o644);
    await assertInvalid({
      environment: {
        USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE: secretFile,
        USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY: "1",
      },
    });
    await chmod(secretFile, 0o600);
    await assertInvalid({
      environment: {
        USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE: secretFile,
        USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY: "1",
        APP_USAGEMONITOR_EXPORT_SECRET: "must-not-be-read",
      },
    });
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("contribution preparation is an explicit, bounded, local-only action", async () => {
  const files = await fixture();
  let preparationCalls = 0;
  let releasePreparation;
  const preparationGate = new Promise((resolvePreparation) => {
    releasePreparation = resolvePreparation;
  });
  const privateCanary = "/Users/private/source/session.jsonl";
  const app = await startLocalCompanionServer({
    root: files.root,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionPreparationRunner: async (...args) => {
      preparationCalls += 1;
      assert.equal(args.length, 0);
      await preparationGate;
      return {
        schemaVersion: "local-contribution-preparation-result-v0.1",
        status: "prepared",
        coveredAt: {
          startAt: "2026-07-26T12:00:00.000Z",
          endAt: "2026-07-26T12:30:00.000Z",
        },
        recordCounts: {
          usageEvents: 2,
          quotaSnapshots: 1,
          activityMarkers: 0,
        },
        privacy: {
          verdict: "passed",
          checksPassed: 6,
          checksFailed: 0,
          sourceTransportReady: false,
          provenanceRetained: true,
        },
        prepared: {
          schemaVersion: "prepared-contribution-set-v0.1",
          eligibleSchemaVersion: "telemetry-contribution-v0.1",
          batchCount: 1,
          bytes: 4_096,
          privatePath: privateCanary,
        },
        networkActivity: false,
        includesContent: false,
        includesPaths: false,
        includesIdentifiers: false,
        includesCredentials: false,
        privateContent: "must not cross the loopback boundary",
      };
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const authorizedHeaders = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };

    assert.equal((await fetch(`${base}/api/local/contribution/prepare`)).status, 405);
    assert.equal((await fetch(`${base}/api/local/contribution/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })).status, 403);
    assert.equal((await fetch(`${base}/api/local/contribution/prepare`, {
      method: "POST",
      headers: authorizedHeaders,
      body: '{"reason":"user_request"}',
    })).status, 400);
    assert.equal((await fetch(`${base}/api/local/contribution/prepare`, {
      method: "POST",
      headers: authorizedHeaders,
      body: '{"path":"/Users/private"}',
    })).status, 400);
    const oversized = await rawRequest({
      port: app.port,
      path: "/api/local/contribution/prepare",
      method: "POST",
      headers: {
        ...authorizedHeaders,
        "Content-Length": 1_025,
      },
      body: " ".repeat(1_025),
    });
    assert.equal(oversized.status, 413);
    assert.equal(preparationCalls, 0);

    const first = fetch(`${base}/api/local/contribution/prepare`, {
      method: "POST",
      headers: authorizedHeaders,
      body: "{}",
    });
    await waitFor(() => preparationCalls === 1);
    const overlap = await fetch(`${base}/api/local/contribution/prepare`, {
      method: "POST",
      headers: authorizedHeaders,
      body: "{}",
    });
    assert.equal(overlap.status, 409);
    assert.deepEqual(await overlap.json(), {
      schemaVersion: "local-contribution-preparation-error-v0.1",
      status: "failed",
      errorCode: "preparation_in_progress",
      networkActivity: false,
      includesContent: false,
      includesPaths: false,
      includesIdentifiers: false,
      includesCredentials: false,
    });

    releasePreparation();
    const response = await first;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      schemaVersion: "local-contribution-preparation-result-v0.1",
      status: "prepared",
      coveredAt: {
        startAt: "2026-07-26T12:00:00.000Z",
        endAt: "2026-07-26T12:30:00.000Z",
      },
      recordCounts: {
        usageEvents: 2,
        quotaSnapshots: 1,
        activityMarkers: 0,
      },
      privacy: {
        verdict: "passed",
        checksPassed: 6,
        checksFailed: 0,
        sourceTransportReady: false,
        provenanceRetained: true,
      },
      prepared: {
        schemaVersion: "prepared-contribution-set-v0.1",
        eligibleSchemaVersion: "telemetry-contribution-v0.1",
        batchCount: 1,
        bytes: 4_096,
      },
      networkActivity: false,
      includesContent: false,
      includesPaths: false,
      includesIdentifiers: false,
      includesCredentials: false,
    });
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("contribution preparation failures expose only fixed safe projections", async () => {
  const files = await fixture();
  let mode = "known_error";
  const privateCanary = "/Users/private/source/session.jsonl";
  const app = await startLocalCompanionServer({
    root: files.root,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionPreparationRunner: async () => {
      if (mode === "known_error") {
        const error = new LocalContributionPreparationError(
          "export_too_large",
        );
        error.privatePath = privateCanary;
        throw error;
      }
      return {
        schemaVersion: "local-contribution-preparation-result-v0.1",
        status: "prepared",
        coveredAt: {
          startAt: "2026-07-26T12:00:00.000Z",
          endAt: "2026-07-26T12:30:00.000Z",
        },
        recordCounts: {
          usageEvents: 2,
          quotaSnapshots: 1,
          activityMarkers: 0,
        },
        privacy: {
          verdict: "passed",
          checksPassed: 6,
          checksFailed: 0,
          sourceTransportReady: false,
          provenanceRetained: true,
        },
        prepared: {
          schemaVersion: "prepared-contribution-set-v0.1",
          eligibleSchemaVersion: "telemetry-contribution-v0.1",
          batchCount: 1,
          bytes: 4_096,
        },
        networkActivity: false,
        includesContent: false,
        includesPaths: true,
        includesIdentifiers: false,
        includesCredentials: false,
        privatePath: privateCanary,
      };
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const request = () => fetch(`${base}/api/local/contribution/prepare`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1",
        Origin: base,
      },
      body: "{}",
    });

    const knownError = await request();
    assert.equal(knownError.status, 413);
    assert.deepEqual(await knownError.json(), {
      schemaVersion: "local-contribution-preparation-error-v0.1",
      status: "failed",
      errorCode: "export_too_large",
      networkActivity: false,
      includesContent: false,
      includesPaths: false,
      includesIdentifiers: false,
      includesCredentials: false,
    });

    mode = "invalid_result";
    const invalidResult = await request();
    assert.equal(invalidResult.status, 500);
    const projected = await invalidResult.json();
    assert.equal(projected.errorCode, "preparation_failed");
    assert.equal(projected.includesPaths, false);
    assert.equal(JSON.stringify(projected).includes(privateCanary), false);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("contribution sync status exposes bounded queue counts only", async () => {
  const files = await fixture();
  const privatePath = "/Users/private/prepared-set";
  const app = await startLocalCompanionServer({
    root: files.root,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionSyncStatusProvider: async () => ({
      schemaVersion: "contribution-sync-status-v0.1",
      paused: false,
      counts: {
        pending: 2,
        in_flight: 1,
        accepted: 9,
        retryable: 3,
        rejected: 4,
      },
      dueNow: 2,
      nextAttemptAt: "2026-07-26T13:00:00.000Z",
      lastAcceptedAt: "2026-07-26T12:00:00.000Z",
      queuePath: privatePath,
      credential: "um_device_private",
    }),
    port: 0,
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${app.port}/api/local/contribution/sync-status`,
    );
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.deepEqual(value.counts, {
      pending: 2,
      inFlight: 1,
      accepted: 9,
      retryable: 3,
      rejected: 4,
    });
    assert.equal(value.includesContent, false);
    assert.equal(value.includesPaths, false);
    assert.equal(value.includesCredentials, false);
    assert.equal(JSON.stringify(value).includes(privatePath), false);
    assert.equal(JSON.stringify(value).includes("um_device_"), false);
    assert.equal(
      (await fetch(
        `http://127.0.0.1:${app.port}/api/local/contribution/sync-status`,
        { method: "POST" },
      )).status,
      405,
    );
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("next inspection and foreground actions use fixed same-origin routes", async () => {
  const files = await fixture();
  const privateCanary = "/Users/private/prepared/telemetry-secret.json";
  const queueStatus = (paused = false) => ({
    schemaVersion: "contribution-sync-status-v0.1",
    paused,
    counts: {
      pending: paused ? 1 : 0,
      in_flight: 0,
      accepted: paused ? 0 : 1,
      retryable: 0,
      rejected: 0,
    },
    dueNow: paused ? 1 : 0,
    nextAttemptAt: paused ? "2026-07-26T13:00:00.000Z" : null,
    lastAcceptedAt: paused ? null : "2026-07-26T13:00:00.000Z",
  });
  let previewCalls = 0;
  let previewValid = true;
  let runCalls = 0;
  let pausedState = false;
  let releaseRun;
  const reviewedPayload = exactReviewContribution();
  const runGate = new Promise((resolve) => {
    releaseRun = resolve;
  });
  const app = await startLocalCompanionServer({
    root: files.root,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionSyncStatusProvider: async () => queueStatus(pausedState),
    contributionSyncNextProvider: async () => {
      previewCalls += 1;
      if (!previewValid) throw new Error("prepared set invalid");
      return {
        schemaVersion: "contribution-sync-preview-v0.1",
        state: "ready",
        networkActivity: false,
        discoveredSets: 1,
        enqueued: 1,
        item: {
          schemaVersion: "telemetry-contribution-v0.1",
          clientPlatform: "macos",
          providerPolicyEpoch: "openai_agentic_pool_2026_07_09",
          coveredAt: {
            startAt: "2026-07-26T12:00:00.000Z",
            endAt: "2026-07-26T12:30:00.000Z",
          },
          recordCounts: {
            usageEvents: 2,
            quotaSnapshots: 1,
            activityMarkers: 0,
            total: 3,
          },
          accounting: {
            estimatedApiCostUsd: "1.250000",
            pricedEventCoveragePercent: 100,
            unknownModelEventCount: 0,
            unknownBillableUnits: 0,
            priceBasis: "current_api_prices",
            verification: "client_declared_unverified",
          },
          preparedBytes: 4_096,
          reservedUploadBytes: 16_384,
          attemptCount: 0,
          nextAttemptAt: "2026-07-26T13:00:00.000Z",
          privatePath: privateCanary,
        },
      };
    },
    contributionSyncExactReviewProvider: async () => ({
      schemaVersion: "contribution-sync-exact-review-v0.1",
      state: "ready",
      networkActivity: false,
      discoveredSets: 1,
      enqueued: 0,
      payloadBytes: Buffer.byteLength(JSON.stringify(reviewedPayload), "utf8"),
      payload: reviewedPayload,
      reviewBinding: {
        jobId: REVIEW_JOB_ID,
        contributionSha256: REVIEW_SHA256,
      },
    }),
    contributionSyncOnceRunner: async ({ signal, reviewedJob }) => {
      runCalls += 1;
      assert.equal(signal instanceof AbortSignal, true);
      assert.deepEqual(reviewedJob, {
        jobId: REVIEW_JOB_ID,
        contributionSha256: REVIEW_SHA256,
      });
      await runGate;
      return {
        status: "completed",
        discoveredSets: 1,
        enqueued: 0,
        processed: 1,
        accepted: 1,
        retryable: 0,
        rejected: 0,
        reservedUploadBytes: 16_384,
        bandwidthLimited: false,
        queue: queueStatus(false),
        privatePath: privateCanary,
      };
    },
    contributionSyncPauseSetter: async ({ paused }) => {
      pausedState = paused;
      return queueStatus(paused);
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const health = await fetch(`${base}/api/local/health`)
      .then((response) => response.json());
    assert.equal(health.capabilities.contributionSyncNext, true);
    assert.equal(health.capabilities.contributionSyncActions, true);

    const inspected = await fetch(
      `${base}/api/local/contribution/sync-next`,
    ).then((response) => response.json());
    assert.equal(previewCalls, 1);
    assert.equal(runCalls, 0);
    assert.equal(inspected.status, "available");
    assert.equal(inspected.deliveryConfigured, true);
    assert.equal(inspected.item.recordCounts.total, 3);
    assert.equal(inspected.networkActivity, false);
    assert.equal(JSON.stringify(inspected).includes(privateCanary), false);
    previewValid = false;
    const invalidPreview = await fetch(
      `${base}/api/local/contribution/sync-next`,
    ).then((response) => response.json());
    assert.equal(invalidPreview.status, "unavailable");
    previewValid = true;

    const unauthorized = await fetch(
      `${base}/api/local/contribution/sync-once`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(unauthorized.status, 403);
    assert.equal(runCalls, 0);

    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const missingReview = await fetch(
      `${base}/api/local/contribution/sync-once`,
      { method: "POST", headers, body: "{}" },
    );
    assert.equal(missingReview.status, 400);
    assert.equal(runCalls, 0);
    const review = await fetch(
      `${base}/api/local/contribution/sync-inspect-exact`,
      { method: "POST", headers, body: "{}" },
    ).then((response) => response.json());
    assert.match(review.reviewToken, /^[A-Za-z0-9_-]{43}$/u);
    const firstRun = fetch(`${base}/api/local/contribution/sync-once`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reviewToken: review.reviewToken }),
    });
    await waitFor(() => runCalls === 1);
    const overlapReview = await fetch(
      `${base}/api/local/contribution/sync-inspect-exact`,
      { method: "POST", headers, body: "{}" },
    ).then((response) => response.json());
    const overlap = await fetch(
      `${base}/api/local/contribution/sync-once`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ reviewToken: overlapReview.reviewToken }),
      },
    );
    assert.equal(overlap.status, 409);
    releaseRun();
    const runResponse = await firstRun;
    assert.equal(runResponse.status, 200);
    const runResult = await runResponse.json();
    assert.equal(runResult.accepted, 1);
    assert.equal(runResult.reservedUploadBytes, 16_384);
    assert.equal(JSON.stringify(runResult).includes(privateCanary), false);

    const paused = await fetch(
      `${base}/api/local/contribution/sync-pause`,
      { method: "POST", headers, body: "{}" },
    ).then((response) => response.json());
    assert.equal(paused.paused, true);
    const resumed = await fetch(
      `${base}/api/local/contribution/sync-resume`,
      { method: "POST", headers, body: "{}" },
    ).then((response) => response.json());
    assert.equal(resumed.paused, false);
    assert.equal(
      (await fetch(`${base}/api/local/contribution/sync-next`, {
        method: "POST",
        headers,
        body: "{}",
      })).status,
      405,
    );
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
          "Set-Cookie": "__Host-usage_monitor_session=must-not-pass; Secure; HttpOnly",
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
        Cookie: "__Host-usage_monitor_session=must-not-pass",
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
      { path: "/api/v1/me/devices/revoke", method: "POST" },
      { path: "/api/v1/me/contributions/read", method: "POST" },
      { path: "/api/v1/me/contributions/delete", method: "POST" },
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
          Cookie: "__Host-usage_monitor_session=must-not-pass",
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

test("CLI shutdown does not hang on loopback connections", async () => {
  const childEnvironment = {
    ...process.env,
    USAGE_MONITOR_PORT: "0",
  };
  delete childEnvironment.USAGE_MONITOR_CENTRAL_ORIGIN;
  const child = spawn(process.execPath, [resolve("apps/local/server.js")], {
    cwd: process.cwd(),
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  try {
    await waitFor(() => output.includes("Usage Monitor is available"), 15_000);
    child.kill("SIGINT");
    const [code, signal] = await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("local companion did not exit after SIGINT")),
          2_000,
        );
      }),
    ]);
    assert.ok(code === 0 || signal === "SIGINT");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
});
