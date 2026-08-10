import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
  claimContributionDevicePairing,
} from "../../src/contribution-device-client.js";
import {
  LocalCompanionClient,
} from "../web/public/data-client.js";
import {
  createDiagnosticReference,
  diagnosticErrorCode,
  diagnosticSurface,
  serviceRequestId,
} from "../web/public/lib.js";
import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "../../src/platform/export-identity-keychain.js";
import {
  buildTelemetryContributionsFromBundle,
} from "../../src/telemetry-contribution-builder.js";
import {
  PRODUCT_BRAND,
  SEMANTIC_OPEN_TARGET_PLACEHOLDER,
} from "../../config/product-brand.js";
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
  const resourceRoot = join(root, "resources");
  const stateRoot = join(root, "state");
  const codexHome = join(root, "home", ".codex");
  const staticRoot = join(resourceRoot, "public");
  await mkdir(staticRoot, { recursive: true });
  await mkdir(join(codexHome, "sessions"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(codexHome, "archived_sessions"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    join(codexHome, "sessions", "rollout-fixture.jsonl"),
    `${JSON.stringify({ type: "session_meta" })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(staticRoot, "index.html"),
    `<!doctype html><meta name="usage-monitor-semantic-open-target" content="${SEMANTIC_OPEN_TARGET_PLACEHOLDER}"><title>TiboTattle</title>`,
  );
  await writeFile(join(staticRoot, "app.js"), "export const app = true;");
  await writeFile(join(staticRoot, "data-client.js"), "export const client = true;");
  await writeFile(join(staticRoot, "lib.js"), "export const lib = true;");
  await writeFile(
    join(staticRoot, "localization.js"),
    "export const localization = true;",
  );
  await writeFile(
    join(staticRoot, "telemetry-shared.generated.js"),
    "export const telemetry = true;",
  );
  await writeFile(
    join(staticRoot, "telemetry-envelope.js"),
    "export const envelope = true;",
  );
  await writeFile(join(staticRoot, "styles.css"), "body { color: black; }");
  await writeFile(
    join(staticRoot, "tibotattle-icon.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  );
  await writeFile(
    join(resourceRoot, "2026-07-24-simple-quota-gradient-report.html"),
    "<!doctype html><title>Gradient detail</title>",
  );
  return { root, resourceRoot, stateRoot, codexHome, staticRoot };
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

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function processIsRunning(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

const WATCHDOG_PARENT_SCRIPT = `
const { spawn } = require("node:child_process");
const { writeSync } = require("node:fs");
const child = spawn(
  process.execPath,
  [process.env.WATCHDOG_SERVER_PATH],
  {
    cwd: process.env.USAGE_MONITOR_RESOURCE_ROOT,
    env: {
      ...process.env,
      USAGE_MONITOR_PARENT_PID: String(process.pid),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
writeSync(1, \`WATCHDOG_CHILD_PID=\${child.pid}\\n\`);
let pending = "";
let ready = false;
child.stdout.on("data", (chunk) => {
  writeSync(1, chunk);
  pending += chunk.toString("utf8");
  if (!ready && pending.includes("USAGE_MONITOR_READY")) {
    ready = true;
    setTimeout(() => process.exit(0), 25);
  }
});
child.stderr.on("data", (chunk) => writeSync(2, chunk));
child.once("exit", () => {
  if (!ready) process.exit(2);
});
setTimeout(() => process.exit(3), 15_000);
`;

test("loopback server exposes only fixed API, static, and report routes", async () => {
  const files = await fixture();
  const store = fakeStore();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
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
      contributionDevicePairing: false,
      contributionDeviceDisconnect: false,
      contributionSyncExactReview: true,
      contributionSyncActions: false,
      incrementalContributionSync: false,
      centralServiceProxy: false,
      centralParticipantRelay: false,
      arbitraryPathAccess: false,
      remoteProxy: false,
    });
    assert.equal(health.headers.get("access-control-allow-origin"), null);
    assert.match(health.headers.get("content-security-policy"), /default-src 'none'/);

    const onboarding = await fetch(`${base}/api/local/onboarding`);
    assert.equal(onboarding.status, 200);
    assert.deepEqual(await onboarding.json(), {
      schemaVersion: "local-onboarding-v0.2",
      status: "ready",
      source: {
        status: "ready",
        sessionsReadable: true,
        archivedSessionsReadable: true,
        rolloutFilesPresent: true,
        rolloutFilesObserved: 1,
        rolloutFilesObservedCapped: false,
      },
      state: {
        status: "ready",
        writable: true,
      },
      capabilities: {
        explicitRefresh: true,
        customCodexHomeConfigured: false,
        rawContentExposed: false,
        arbitraryPathAccess: false,
      },
    });
    assert.equal((await fetch(`${base}/api/local/onboarding`, {
      method: "POST",
    })).status, 405);

    const overview = await fetch(`${base}/api/local/overview`);
    assert.equal(overview.status, 200);
    assert.equal((await overview.json()).mode, "real_local_evidence");

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const pageBody = await page.text();
    assert.match(pageBody, /TiboTattle/);
    assert.match(
      pageBody,
      new RegExp(
        `content="${PRODUCT_BRAND.appOpenURL.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`,
        "u",
      ),
    );
    assert.doesNotMatch(pageBody, new RegExp(SEMANTIC_OPEN_TARGET_PLACEHOLDER, "u"));
    assert.equal((await fetch(`${base}/data-client.js`)).status, 200);
    assert.equal((await fetch(`${base}/localization.js`)).status, 200);
    assert.equal(
      (await fetch(`${base}/telemetry-shared.generated.js`)).status,
      200,
    );
    const telemetryEnvelope = await fetch(`${base}/telemetry-envelope.js`);
    assert.equal(telemetryEnvelope.status, 200);
    assert.equal(
      await telemetryEnvelope.text(),
      "export const envelope = true;",
    );
    const brandIcon = await fetch(`${base}/tibotattle-icon.png`);
    assert.equal(brandIcon.status, 200);
    assert.equal(brandIcon.headers.get("content-type"), "image/png");

    const report = await fetch(`${base}/reports/gradient`);
    assert.equal(report.status, 200);
    assert.match(await report.text(), /Gradient detail/);
    const privateReportDirectory = join(
      files.resourceRoot,
      ".usage-monitor",
      "legacy-reports",
    );
    await mkdir(privateReportDirectory, { recursive: true });
    await writeFile(
      join(privateReportDirectory, "2026-07-24-simple-quota-gradient-report.html"),
      "<!doctype html><title>Canonical gradient detail</title>",
      { mode: 0o600 },
    );
    const canonicalReport = await fetch(`${base}/reports/gradient`);
    assert.equal(canonicalReport.status, 200);
    assert.match(await canonicalReport.text(), /Canonical gradient detail/);

    assert.equal((await fetch(`${base}/reports/not-allowed`)).status, 404);
    assert.equal((await fetch(`${base}/api/local/not-allowed`)).status, 404);
    assert.equal((await fetch(`${base}/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/api/local/overview?path=/Users/private`)).status, 400);

    await writeFile(
      join(files.staticRoot, "index.html"),
      "<!doctype html><title>Unstamped</title>",
    );
    assert.equal((await fetch(`${base}/index.html`)).status, 404);
    await writeFile(
      join(files.staticRoot, "index.html"),
      `<meta content="${SEMANTIC_OPEN_TARGET_PLACEHOLDER}"><meta content="${SEMANTIC_OPEN_TARGET_PLACEHOLDER}">`,
    );
    assert.equal((await fetch(`${base}/index.html`)).status, 404);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("window-breakdown route bounds its range and returns a per-model/speed shape", async () => {
  const files = await fixture();
  const requests = [];
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    // Injected so the route's validation and shaping are exercised without a
    // real unified index on disk. A caller asking for an inverted range is
    // rejected by the reader with a typed code the route maps to 400.
    windowBreakdownProvider: async ({ fromMs, toMs }) => {
      requests.push({ fromMs, toMs });
      if (toMs <= fromMs) {
        const error = new Error("window range is invalid");
        error.code = "window_range_invalid";
        throw error;
      }
      return {
        status: "available",
        errorCode: null,
        schemaVersion: "local-window-breakdown-v0.1",
        from: fromMs,
        to: toMs,
        events: 12,
        unpricedEvents: 0,
        unpricedShare: 0,
        costUsd: 34.5,
        tokens: 6_000,
        fastCostUsd: 0,
        fastEvents: 0,
        byModel: [
          { model: "gpt-5.6-sol", costUsd: 34.5, tokens: 6_000, events: 12, unpricedEvents: 0, unpricedShare: 0, fastModeFamily: "gpt-5.6", fastModeMultiplier: 2.5 },
        ],
        bySpeed: { standard: { speed: "standard", costUsd: 34.5, tokens: 6_000, events: 12, unpricedEvents: 0, unpricedShare: 0 } },
        spark: { events: 0, costUsd: 0 },
      };
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const route = `${base}/api/local/timeline/window-breakdown`;

    // A well-formed bounded window returns the breakdown, and the exact integer
    // parameters reach the provider.
    const ok = await fetch(`${route}?from=1000&to=2000`);
    assert.equal(ok.status, 200);
    const payload = await ok.json();
    assert.equal(payload.schemaVersion, LOCAL_COMPANION_SCHEMA_VERSION);
    assert.equal(payload.breakdown.status, "available");
    assert.equal(payload.breakdown.byModel[0].model, "gpt-5.6-sol");
    assert.deepEqual(requests.at(-1), { fromMs: 1000, toMs: 2000 });

    // Missing, non-integer, and float parameters never reach the provider.
    const before = requests.length;
    assert.equal((await fetch(route)).status, 400);
    assert.equal((await fetch(`${route}?from=1000`)).status, 400);
    assert.equal((await fetch(`${route}?from=1.5&to=2000`)).status, 400);
    assert.equal((await fetch(`${route}?from=abc&to=2000`)).status, 400);
    // An unexpected extra parameter is refused rather than ignored.
    assert.equal((await fetch(`${route}?from=1000&to=2000&path=/x`)).status, 400);
    assert.equal(requests.length, before);

    // A provider that rejects an inverted range maps to a 400 with its code.
    const bad = await fetch(`${route}?from=2000&to=1000`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "window_range_invalid");

    // The route is GET-only.
    assert.equal((await fetch(route, { method: "POST" })).status, 405);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("local companion remains usable before Codex is installed", async () => {
  const files = await fixture();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: join(files.root, "no-codex-home-yet"),
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    port: 0,
  });
  try {
    const onboarding = await fetch(
      `http://127.0.0.1:${app.port}/api/local/onboarding`,
    );
    assert.equal(onboarding.status, 200);
    assert.deepEqual(await onboarding.json(), {
      schemaVersion: "local-onboarding-v0.2",
      status: "needs_attention",
      source: {
        status: "codex_home_missing",
        sessionsReadable: false,
        archivedSessionsReadable: false,
        rolloutFilesPresent: false,
        rolloutFilesObserved: 0,
        rolloutFilesObservedCapped: false,
      },
      state: {
        status: "ready",
        writable: true,
      },
      capabilities: {
        explicitRefresh: true,
        customCodexHomeConfigured: false,
        rawContentExposed: false,
        arbitraryPathAccess: false,
      },
    });
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("automatic contribution endpoints require exact consent and remain foreground-only", async () => {
  const files = await fixture();
  let now = Date.parse("2026-07-29T12:00:00.000Z");
  let preparations = 0;
  const preparationRequests = [];
  const retirementRequests = [];
  let uploads = 0;
  let manualRuns = 0;
  let networkCalls = 0;
  let nextTimer = 1;
  const timers = new Map();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    centralOrigin: "http://127.0.0.1:8792",
    centralFetch: async () => {
      networkCalls += 1;
      throw new Error("automatic contribution test must not use fetch");
    },
    contributionPreparationRunner: async (request) => {
      preparations += 1;
      preparationRequests.push(request);
      const { lookbackHours } = request;
      assert.equal(lookbackHours, 24);
      const coveredAt = {
        startAt: "2026-07-29T11:00:00.000Z",
        endAt: "2026-07-29T18:00:00.000Z",
      };
      await request.beforePreparedPublish({
        preparedSetId: "a".repeat(64),
        coveredAt,
      });
      return {
        schemaVersion: "local-contribution-preparation-result-v0.1",
        status: "prepared",
        prepared: { preparedSetId: "a".repeat(64) },
        coveredAt,
        networkActivity: false,
      };
    },
    contributionSyncExactReviewProvider: async () => ({
      schemaVersion: "contribution-sync-exact-review-v0.1",
      state: "ready",
      networkActivity: false,
      discoveredSets: 1,
      enqueued: 0,
      payloadBytes: Buffer.byteLength(
        JSON.stringify(exactReviewContribution()),
        "utf8",
      ),
      payload: exactReviewContribution(),
      reviewBinding: {
        jobId: REVIEW_JOB_ID,
        contributionSha256: REVIEW_SHA256,
      },
    }),
    contributionSyncOnceRunner: async ({
      signal,
      reviewedJob,
      preparedSetId,
      maximumJobs,
      maximumReservedUploadBytes,
    }) => {
      uploads += 1;
      assert.ok(signal instanceof AbortSignal);
      if (reviewedJob !== undefined) {
        manualRuns += 1;
        assert.deepEqual(reviewedJob, {
          jobId: REVIEW_JOB_ID,
          contributionSha256: REVIEW_SHA256,
        });
        return {
          status: "completed",
          discoveredSets: 1,
          enqueued: 0,
          processed: 1,
          accepted: manualRuns === 1 ? 0 : 1,
          retryable: manualRuns === 1 ? 1 : 0,
          rejected: 0,
          reservedUploadBytes: 1024,
          bandwidthLimited: false,
          queue: { paused: false },
          preparedSet: {
            preparedSetId: "a".repeat(64),
            coveredAt: {
              startAt: "2026-07-29T11:00:00.000Z",
              endAt: "2026-07-29T12:00:00.000Z",
            },
            totalJobs: 1,
            acceptedJobs: manualRuns === 1 ? 0 : 1,
            pendingJobs: 0,
            retryableJobs: manualRuns === 1 ? 1 : 0,
            inFlightJobs: 0,
            rejectedJobs: 0,
            completeAccepted: manualRuns !== 1,
          },
        };
      }
      assert.equal(preparedSetId, "a".repeat(64));
      assert.equal(maximumJobs, 100);
      assert.equal(maximumReservedUploadBytes, 64 * 1024 * 1024);
      return {
        status: "completed",
        discoveredSets: 1,
        enqueued: 1,
        processed: 1,
        accepted: 1,
        retryable: 0,
        rejected: 0,
        reservedUploadBytes: 1024,
        bandwidthLimited: false,
        queue: { paused: false },
        preparedSet: {
          preparedSetId: "a".repeat(64),
          coveredAt: {
            startAt: "2026-07-29T11:00:00.000Z",
            endAt: "2026-07-29T18:00:00.000Z",
          },
          totalJobs: 1,
          acceptedJobs: 1,
          pendingJobs: 0,
          retryableJobs: 0,
          inFlightJobs: 0,
          rejectedJobs: 0,
          completeAccepted: true,
        },
      };
    },
    automaticContributionRetirementRunner: async (request) => {
      retirementRequests.push(request);
      return {
        retiredSets: 0,
        retiredJobs: 0,
        interrupted: false,
        networkActivity: false,
      };
    },
    automaticContributionOptions: {
      now: () => new Date(now),
      ditherRandom: () => 0,
      setTimeoutImpl(callback, delay) {
        const id = nextTimer;
        nextTimer += 1;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeoutImpl(id) {
        timers.delete(id);
      },
    },
    port: 0,
  });
  try {
    const origin = `http://127.0.0.1:${app.port}`;
    const settingsResponse = await fetch(
      `${origin}/api/local/contribution/automatic-settings`,
    );
    assert.equal(settingsResponse.status, 200);
    const settings = await settingsResponse.json();
    assert.equal(settings.schemaVersion, "automatic-contribution-status-v0.1");
    assert.equal(settings.status, "first_review_required");
    assert.equal(settings.enabled, false);
    assert.equal(settings.firstReviewComplete, false);
    assert.equal(settings.intervalHours, 6);
    assert.equal(settings.requiredConsent.destinationOrigin,
      "http://127.0.0.1:8792");
    assert.equal(settings.foregroundOnly, true);
    assert.equal(settings.daemonInstalled, false);
    assert.equal(preparations, 0);
    assert.equal(uploads, 0);
    assert.equal(networkCalls, 0);

    const enableBody = JSON.stringify({
      intervalHours: 6,
      consent: settings.requiredConsent,
    });
    const unauthorized = await rawRequest({
      port: app.port,
      path: "/api/local/contribution/automatic-enable",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: enableBody,
    });
    assert.equal(unauthorized.status, 403);

    const mismatched = await rawRequest({
      port: app.port,
      path: "/api/local/contribution/automatic-enable",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-Usage-Monitor-Local": "1",
      },
      body: JSON.stringify({
        intervalHours: 6,
        consent: {
          ...settings.requiredConsent,
          privacyContractVersion: "changed-contract",
        },
      }),
    });
    assert.equal(mismatched.status, 409);
    assert.equal(
      JSON.parse(mismatched.body).error.code,
      "automatic_contribution_first_review_required",
    );
    assert.equal(timers.size, 0);
    assert.equal(uploads, 0);
    const contributionHeaders = {
      "Content-Type": "application/json",
      Origin: origin,
      "X-Usage-Monitor-Local": "1",
    };
    const runReviewedContribution = async () => {
      const review = await fetch(
        `${origin}/api/local/contribution/sync-inspect-exact`,
        {
          method: "POST",
          headers: contributionHeaders,
          body: "{}",
        },
      ).then((response) => response.json());
      return fetch(`${origin}/api/local/contribution/sync-once`, {
        method: "POST",
        headers: contributionHeaders,
        body: JSON.stringify({ reviewToken: review.reviewToken }),
      });
    };
    const unsuccessful = await runReviewedContribution();
    assert.equal(unsuccessful.status, 200);
    assert.equal((await unsuccessful.json()).accepted, 0);
    assert.equal(
      (await fetch(
        `${origin}/api/local/contribution/automatic-settings`,
      ).then((response) => response.json())).status,
      "first_review_required",
    );
    const stillLocked = await rawRequest({
      port: app.port,
      path: "/api/local/contribution/automatic-enable",
      method: "POST",
      headers: contributionHeaders,
      body: enableBody,
    });
    assert.equal(stillLocked.status, 409);
    assert.equal(timers.size, 0);

    const successful = await runReviewedContribution();
    assert.equal(successful.status, 200);
    assert.equal((await successful.json()).accepted, 1);
    const reviewedSettings = await fetch(
      `${origin}/api/local/contribution/automatic-settings`,
    ).then((response) => response.json());
    assert.equal(reviewedSettings.status, "disabled");
    assert.equal(reviewedSettings.firstReviewComplete, true);
    assert.equal(
      reviewedSettings.firstReviewedAcceptedAt,
      "2026-07-29T12:00:00.000Z",
    );

    const mismatchAfterReview = await rawRequest({
      port: app.port,
      path: "/api/local/contribution/automatic-enable",
      method: "POST",
      headers: contributionHeaders,
      body: JSON.stringify({
        intervalHours: 6,
        consent: {
          ...settings.requiredConsent,
          privacyContractVersion: "changed-contract",
        },
      }),
    });
    assert.equal(mismatchAfterReview.status, 409);
    assert.equal(
      JSON.parse(mismatchAfterReview.body).error.code,
      "automatic_contribution_consent_binding_mismatch",
    );

    const enabled = await rawRequest({
      port: app.port,
      path: "/api/local/contribution/automatic-enable",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-Usage-Monitor-Local": "1",
      },
      body: enableBody,
    });
    assert.equal(enabled.status, 200);
    const enabledStatus = JSON.parse(enabled.body);
    assert.equal(enabledStatus.status, "scheduled");
    assert.equal(enabledStatus.nextAttemptAt, "2026-07-29T18:00:00.000Z");
    assert.equal(preparations, 0);
    assert.equal(uploads, 2);
    assert.equal(networkCalls, 0);

    now += 6 * 60 * 60 * 1_000;
    const completed = await app.automaticContribution.runDue();
    assert.equal(completed.status, "scheduled");
    assert.deepEqual(completed.lastOutcome, {
      status: "succeeded",
      code: "accepted",
      at: "2026-07-29T18:00:00.000Z",
    });
    assert.equal(preparations, 1);
    assert.equal(
      preparationRequests[0].acceptedThroughAt,
      "2026-07-29T12:00:00.000Z",
    );
    assert.equal(preparationRequests[0].replayOverlapHours, 1);
    assert.deepEqual(
      preparationRequests[0].protectedPreparedSetIds,
      ["a".repeat(64)],
    );
    assert.equal(retirementRequests.length, 1);
    assert.equal(uploads, 3);
    assert.equal(networkCalls, 0);

    const disabled = await rawRequest({
      port: app.port,
      path: "/api/local/contribution/automatic-disable",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-Usage-Monitor-Local": "1",
      },
      body: JSON.stringify({ reason: "user_request" }),
    });
    assert.equal(disabled.status, 200);
    assert.equal(JSON.parse(disabled.body).status, "disabled");
    assert.equal(JSON.parse(disabled.body).consentedAt, null);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("one state root cannot run concurrent automatic schedulers", async () => {
  const files = await fixture();
  let first;
  let restarted;
  const options = {
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    port: 0,
  };
  try {
    first = await startLocalCompanionServer(options);
    await assert.rejects(
      startLocalCompanionServer({
        ...options,
        dataStore: fakeStore(),
      }),
      (error) => error?.code === "automatic_contribution_instance_active",
    );
    await first.close();
    first = null;
    await assert.rejects(
      lstat(join(
        files.stateRoot,
        "private",
        "automatic-contribution-v0.1.lock",
      )),
      (error) => error?.code === "ENOENT",
    );
    restarted = await startLocalCompanionServer({
      ...options,
      dataStore: fakeStore(),
    });
    assert.equal(
      (await fetch(
        `http://127.0.0.1:${restarted.port}/api/local/health`,
      )).status,
      200,
    );
  } finally {
    await restarted?.close();
    await first?.close();
    await rm(files.root, { recursive: true });
  }
});

test("shutdown retains the automatic-contribution lock until an aborted run finishes cleanup", async () => {
  const files = await fixture();
  const preparationStarted = deferred();
  const abortObserved = deferred();
  const cleanupBarrier = deferred();
  let first;
  let restarted;
  let activeRun;
  let closePromise;
  let now = Date.parse("2026-07-29T12:00:00.000Z");
  const options = {
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    centralOrigin: "http://127.0.0.1:8792",
    contributionPreparationRunner: async ({ signal }) => {
      preparationStarted.resolve();
      if (!signal.aborted) {
        await new Promise((resolveAbort) => {
          signal.addEventListener("abort", resolveAbort, { once: true });
        });
      }
      abortObserved.resolve();
      await cleanupBarrier.promise;
      throw new LocalContributionPreparationError("preparation_aborted");
    },
    contributionSyncOnceRunner: async () => {
      throw new Error("shutdown test must not reach upload");
    },
    automaticContributionRetirementRunner: async () => ({
      retiredSets: 0,
      retiredJobs: 0,
      interrupted: false,
      networkActivity: false,
    }),
    automaticContributionOptions: {
      now: () => new Date(now),
      ditherRandom: () => 0,
    },
    port: 0,
  };
  try {
    first = await startLocalCompanionServer(options);
    const reviewedAt = {
      startAt: "2026-07-29T11:00:00.000Z",
      endAt: "2026-07-29T12:00:00.000Z",
    };
    await first.automaticContribution.recordReviewedManualAcceptance({
      status: "completed",
      accepted: 1,
      preparedSet: {
        preparedSetId: "d".repeat(64),
        coveredAt: reviewedAt,
        totalJobs: 1,
        acceptedJobs: 1,
        pendingJobs: 0,
        retryableJobs: 0,
        inFlightJobs: 0,
        rejectedJobs: 0,
        completeAccepted: true,
      },
    });
    const disabled = await first.automaticContribution.inspect();
    await first.automaticContribution.enable({
      intervalHours: 6,
      consent: disabled.requiredConsent,
    });
    now += 6 * 60 * 60 * 1_000;
    activeRun = first.automaticContribution.runDue();
    await preparationStarted.promise;

    let closeSettled = false;
    closePromise = first.close().then(() => {
      closeSettled = true;
    });
    await abortObserved.promise;
    assert.equal(closeSettled, false);
    let explicitShutdownSettled = false;
    const explicitShutdown = first.shutdownAutomaticContribution().then(() => {
      explicitShutdownSettled = true;
    });
    await Promise.resolve();
    assert.equal(explicitShutdownSettled, false);

    await assert.rejects(
      startLocalCompanionServer({
        ...options,
        dataStore: fakeStore(),
      }),
      (error) => error?.code === "automatic_contribution_instance_active",
    );
    assert.equal(closeSettled, false);

    cleanupBarrier.resolve();
    await Promise.all([activeRun, closePromise, explicitShutdown]);
    assert.equal(explicitShutdownSettled, true);
    activeRun = null;
    closePromise = null;
    first = null;
    await assert.rejects(
      lstat(join(
        files.stateRoot,
        "private",
        "automatic-contribution-v0.1.lock",
      )),
      (error) => error?.code === "ENOENT",
    );

    restarted = await startLocalCompanionServer({
      ...options,
      dataStore: fakeStore(),
    });
    assert.equal(
      (await fetch(
        `http://127.0.0.1:${restarted.port}/api/local/health`,
      )).status,
      200,
    );
  } finally {
    cleanupBarrier.resolve();
    await Promise.allSettled([
      activeRun,
      closePromise,
      restarted?.close(),
      first?.close(),
    ].filter(Boolean));
    await rm(files.root, { recursive: true });
  }
});

test("initialization failure retains the lock until idempotent automatic shutdown finishes", async () => {
  const files = await fixture();
  const stopStarted = deferred();
  const cleanupBarrier = deferred();
  const initializationError = new Error("simulated initialization failure");
  let stopCalls = 0;
  let restarted;
  let failedStart;
  let observedFailure;
  const automaticContributionController = {
    async start() {
      throw new Error("automatic controller must not start after data init fails");
    },
    async stop() {
      stopCalls += 1;
      stopStarted.resolve();
      await cleanupBarrier.promise;
    },
    async inspect() {
      return {};
    },
    async enable() {
      return {};
    },
    async disable() {
      return {};
    },
    async recordReviewedManualAcceptance() {
      return {};
    },
  };
  const baseOptions = {
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    refreshRunner: async () => ({}),
    port: 0,
  };
  try {
    // The snapshot build now runs behind an already-open port, so a build that
    // fails is surfaced on `snapshotReady` instead of on the start call. Every
    // consequence of that failure is unchanged: automatic contribution stops
    // exactly once, the instance lock is held until that cleanup finishes, and
    // no second instance may start in the meantime.
    failedStart = await startLocalCompanionServer({
      ...baseOptions,
      dataStore: {
        ...fakeStore(),
        async initialize() {
          throw initializationError;
        },
      },
      automaticContributionController,
    });
    observedFailure = assert.rejects(
      failedStart.snapshotReady,
      (error) => error === initializationError,
    );
    await stopStarted.promise;
    assert.equal(stopCalls, 1);

    // The port is open, so the failure has to be readable rather than silent:
    // readiness names it, and every route that would have to project the
    // missing snapshot refuses instead of answering with an empty one.
    const failedHealth = await fetch(
      `http://127.0.0.1:${failedStart.port}/api/local/health`,
    ).then((response) => response.json());
    assert.equal(failedHealth.status, "ready");
    assert.equal(failedHealth.snapshot.status, "failed");
    const failedOverview = await fetch(
      `http://127.0.0.1:${failedStart.port}/api/local/overview`,
    );
    assert.equal(failedOverview.status, 503);
    assert.equal((await failedOverview.json()).error.code, "snapshot_unavailable");

    await assert.rejects(
      startLocalCompanionServer({
        ...baseOptions,
        dataStore: fakeStore(),
      }),
      (error) => error?.code === "automatic_contribution_instance_active",
    );
    assert.equal(stopCalls, 1);

    cleanupBarrier.resolve();
    await observedFailure;
    observedFailure = null;
    assert.equal(stopCalls, 1);
    await failedStart.close();
    failedStart = null;
    await assert.rejects(
      lstat(join(
        files.stateRoot,
        "private",
        "automatic-contribution-v0.1.lock",
      )),
      (error) => error?.code === "ENOENT",
    );

    restarted = await startLocalCompanionServer({
      ...baseOptions,
      dataStore: fakeStore(),
    });
    assert.equal(
      (await fetch(
        `http://127.0.0.1:${restarted.port}/api/local/health`,
      )).status,
      200,
    );
  } finally {
    cleanupBarrier.resolve();
    await Promise.allSettled([
      observedFailure,
      failedStart?.close(),
      restarted?.close(),
    ].filter(Boolean));
    await rm(files.root, { recursive: true });
  }
});

test("the port and readiness answer before the first snapshot is built", async () => {
  const files = await fixture();
  const buildStarted = deferred();
  const buildBarrier = deferred();
  const store = fakeStore();
  let app;
  try {
    const startedAt = Date.now();
    app = await startLocalCompanionServer({
      resourceRoot: files.resourceRoot,
      stateRoot: files.stateRoot,
      codexHome: files.codexHome,
      staticRoot: files.staticRoot,
      dataStore: {
        ...store,
        async initialize() {
          buildStarted.resolve();
          await buildBarrier.promise;
        },
      },
      refreshRunner: async () => ({}),
      port: 0,
    });
    const base = `http://127.0.0.1:${app.port}`;
    await buildStarted.promise;

    // Listening, and honest about what is not ready yet. Before the port moved
    // ahead of the build this request could not even be sent: a real install
    // spends seconds here, and a rejected accounting cache spends long enough
    // to exceed the launcher's own startup budget and have the companion
    // killed before it could finish.
    const health = await fetch(`${base}/api/local/health`)
      .then((response) => response.json());
    assert.equal(health.status, "ready");
    assert.deepEqual(health.snapshot, { status: "building", errorCode: null });
    assert.ok(
      Date.now() - startedAt < 5_000,
      "readiness must answer without waiting for the snapshot build",
    );
    assert.equal((await fetch(`${base}/`)).status, 200);

    // A route that reads the snapshot waits for the build rather than
    // projecting a half-built one.
    let overviewSettled = false;
    const overview = fetch(`${base}/api/local/overview`)
      .then((response) => {
        overviewSettled = true;
        return response;
      });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(overviewSettled, false);

    buildBarrier.resolve();
    assert.equal((await overview).status, 200);
    await app.snapshotReady;
    assert.deepEqual(
      (await fetch(`${base}/api/local/health`)
        .then((response) => response.json())).snapshot,
      { status: "ready", errorCode: null },
    );
  } finally {
    buildBarrier.resolve();
    await app?.close();
    await rm(files.root, { recursive: true });
  }
});

test("participant relay supports explicit loopback development with exact forwarding", async () => {
  const files = await fixture();
  const forwarded = [];
  const validSetCookie =
    "__Host-usage_monitor_session=um_session_00000000-0000-4000-8000-000000000000.secret; Path=/; Max-Age=1800; Secure; HttpOnly; SameSite=Strict";
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
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
        redirect: options.redirect,
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
    // Hosted sign-in crosses this relay as a start and a polled result only.
    // Neither carries a code, a verifier, or a redirect: the contribution
    // service owns all three.
    assert.equal((await fetch(`${base}/api/v1/identity/google/start`, {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
      },
      body: "{}",
    })).status, 200);
    assert.equal((await fetch(`${base}/api/v1/identity/google/result`, {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state: "S".repeat(64) }),
    })).status, 200);
    // The provider callback is never relayed: it is delivered straight to the
    // contribution service over HTTPS.
    assert.equal((await fetch(`${base}/api/v1/identity/google/callback`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: "{}",
    })).status, 404);

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
    assert.equal(
      forwarded[6].url,
      "http://127.0.0.1:8792/api/v1/identity/google/start",
    );
    assert.equal(Object.hasOwn(forwarded[6].headers, "Cookie"), false);
    assert.equal(forwarded[6].body, "{}");
    assert.equal(
      forwarded[7].url,
      "http://127.0.0.1:8792/api/v1/identity/google/result",
    );
    assert.equal(Object.hasOwn(forwarded[7].headers, "Cookie"), false);
    assert.equal(forwarded[7].body.includes("SSSS"), true);
    assert.equal(forwarded.length, 8);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("participant relay accepts one pinned production HTTPS origin without forwarding ambient authority", async () => {
  const files = await fixture();
  const forwarded = [];
  const centralOrigin = "https://usage-monitor.example";
  const validSetCookie =
    "__Host-usage_monitor_session=um_session_00000000-0000-4000-8000-000000000000.secret; Path=/; Max-Age=1800; Secure; HttpOnly; SameSite=Strict";
  const sessionCookie =
    "__Host-usage_monitor_session=um_session_00000000-0000-4000-8000-000000000000.secret";
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    centralOrigin,
    centralFetch: async (url, options) => {
      forwarded.push({
        url,
        method: options.method,
        headers: { ...options.headers },
        body: options.body?.toString("utf8") ?? null,
        redirect: options.redirect,
      });
      return Response.json({ status: "ok" }, {
        status: url.endsWith("/api/v1/enroll") ? 201 : 200,
        headers: url.endsWith("/api/v1/enroll")
          ? { "Set-Cookie": validSetCookie }
          : {},
      });
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const health = await fetch(`${base}/api/local/health`)
      .then((response) => response.json());
    assert.equal(health.capabilities.centralParticipantRelay, true);

    const enrollmentBody =
      '{"consentVersion":"privacy-safe-telemetry-v0.1","syntheticOnly":false}';
    const enrolled = await fetch(`${base}/api/v1/enroll`, {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        Cookie: "ambient=must-not-pass",
        "X-Ambient-Authority": "must-not-pass",
      },
      body: enrollmentBody,
    });
    assert.equal(enrolled.status, 201);
    assert.equal(enrolled.headers.get("set-cookie"), validSetCookie);

    const stats = await fetch(`${base}/api/v1/me/stats`, {
      headers: {
        Cookie: `${sessionCookie}; ambient=must-not-pass`,
        "X-Ambient-Authority": "must-not-pass",
      },
    });
    assert.equal(stats.status, 200);
    assert.deepEqual(forwarded, [
      {
        url: `${centralOrigin}/api/v1/enroll`,
        method: "POST",
        headers: {
          Accept: "application/json",
          Origin: centralOrigin,
          "Content-Type": "application/json",
        },
        body: enrollmentBody,
        redirect: "error",
      },
      {
        url: `${centralOrigin}/api/v1/me/stats`,
        method: "GET",
        headers: {
          Accept: "application/json",
          Origin: centralOrigin,
          Cookie: sessionCookie,
        },
        body: null,
        redirect: "error",
      },
    ]);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("participant relay blocks unknown authority routes and fails closed", async () => {
  const files = await fixture();
  let mode = "ok";
  let forwarded = 0;
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    centralOrigin: "http://127.0.0.1:8792",
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

test("participant relay never follows an upstream redirect", async () => {
  const files = await fixture();
  const upstreamRequests = [];
  const upstream = createHttpServer((request, response) => {
    upstreamRequests.push(request.url);
    response.writeHead(302, {
      Location: "/redirected",
      "Content-Type": "application/json",
    });
    response.end('{"status":"redirect"}');
  });
  await new Promise((resolveListen, rejectListen) => {
    upstream.once("error", rejectListen);
    upstream.listen(0, "127.0.0.1", resolveListen);
  });
  const address = upstream.address();
  assert.equal(typeof address, "object");
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    centralOrigin: `http://127.0.0.1:${address.port}`,
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const response = await fetch(`${base}/api/v1/session`);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      error: { code: "central_participant_service_unavailable" },
    });
    assert.deepEqual(upstreamRequests, ["/api/v1/session"]);
  } finally {
    await app.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
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
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
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
    const startedPayload = await started.json();
    assert.equal(startedPayload.refresh.status, "running");
    assert.match(
      startedPayload.refresh.refreshId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    const duplicate = await fetch(`${base}/api/local/refresh`, {
      method: "POST",
      headers: authorizedHeaders,
      body: "{}",
    });
    assert.equal(duplicate.status, 409);
    const duplicatePayload = await duplicate.json();
    assert.equal(
      duplicatePayload.refresh.refreshId,
      startedPayload.refresh.refreshId,
    );
    resolveRefresh();
    await waitFor(async () => {
      const status = await fetch(`${base}/api/local/refresh`).then((response) => response.json());
      return status.refresh.status === "succeeded";
    });
    const completed = await fetch(`${base}/api/local/refresh`).then((response) => response.json());
    assert.equal(completed.refresh.refreshId, startedPayload.refresh.refreshId);
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

test("server exposes an authorized bounded refresh cancellation", async () => {
  const files = await fixture();
  const store = fakeStore();
  let observedAbort = false;
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: store,
    refreshRunner: ({ signal, onProgress }) => new Promise((resolve) => {
      onProgress({
        mode: "recent_7d",
        status: "recent_7d_indexing",
        phase: "rollout_index",
        boundedBy: "modified_at_and_collection_start",
        filesDiscovered: 3,
        filesSelected: 3,
        filesProcessed: 1,
        recordsWritten: 2,
        coveredAt: {
          startAt: "2026-07-16T12:00:00.000Z",
          endAt: null,
        },
      });
      signal.addEventListener("abort", () => {
        observedAbort = true;
        resolve({
          rolloutRecordsWritten: 2,
          filesDiscovered: 3,
          indexing: {
            mode: "recent_7d",
            status: "bounded_pause",
            phase: "paused",
            boundedBy: "modified_at_and_collection_start",
            filesDiscovered: 3,
            filesSelected: 3,
            filesProcessed: 1,
            recordsWritten: 2,
            coveredAt: {
              startAt: "2026-07-16T12:00:00.000Z",
              endAt: null,
            },
          },
        });
      }, { once: true });
    }),
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const authorizedHeaders = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const started = await fetch(`${base}/api/local/refresh`, {
      method: "POST",
      headers: authorizedHeaders,
      body: "{}",
    });
    assert.equal(started.status, 202);

    const unauthorizedCancel = await fetch(
      `${base}/api/local/refresh/cancel`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(unauthorizedCancel.status, 403);

    const cancelled = await fetch(`${base}/api/local/refresh/cancel`, {
      method: "POST",
      headers: authorizedHeaders,
      body: "{}",
    });
    assert.equal(cancelled.status, 202);
    assert.equal((await cancelled.json()).refresh.status, "cancelling");

    await waitFor(async () => {
      const status = await fetch(`${base}/api/local/refresh`)
        .then((response) => response.json());
      return status.refresh.status === "cancelled";
    });
    const status = await fetch(`${base}/api/local/refresh`)
      .then((response) => response.json());
    assert.equal(observedAbort, true);
    assert.equal(status.refresh.errorCode, "refresh_cancelled");
    assert.equal(status.refresh.progress.status, "bounded_pause");
    assert.equal(store.reloads, 1);

    const duplicateCancel = await fetch(`${base}/api/local/refresh/cancel`, {
      method: "POST",
      headers: authorizedHeaders,
      body: "{}",
    });
    assert.equal(duplicateCancel.status, 409);
    assert.equal(
      (await duplicateCancel.json()).error.code,
      "refresh_not_running",
    );
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("contribution preview returns counts and accounting only", async () => {
  const files = await fixture();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
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
  const preparedDirectory = join(files.stateRoot, "prepared");
  const reviewDirectory = join(files.stateRoot, "reviews");
  const queueFile = join(files.stateRoot, "queue.sqlite3");
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
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
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
      activityFile: join(
        files.stateRoot,
        "missing-activity-markers.jsonl",
      ),
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
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Usage-Monitor-Local": "1",
          Origin: base,
        },
        body: "{}",
      },
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
        resourceRoot: files.resourceRoot,
        stateRoot: files.stateRoot,
        codexHome: files.codexHome,
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
  const preparationRequests = [];
  let releasePreparation;
  const preparationGate = new Promise((resolvePreparation) => {
    releasePreparation = resolvePreparation;
  });
  const privateCanary = "/Users/private/source/session.jsonl";
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionPreparationRunner: async (preparationRequest) => {
      preparationCalls += 1;
      preparationRequests.push(preparationRequest);
      await preparationGate;
      return {
        schemaVersion: "local-contribution-preparation-result-v0.1",
        status: "prepared",
        coveredAt: preparationRequest.lookbackHours === 7 * 24
          ? {
            startAt: "2026-07-20T12:30:00.000Z",
            endAt: "2026-07-26T12:30:00.000Z",
          }
          : {
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
    assert.equal((await fetch(`${base}/api/local/contribution/prepare`, {
      method: "POST",
      headers: authorizedHeaders,
      body: '{"lookbackHours":2}',
    })).status, 400);
    assert.equal((await fetch(`${base}/api/local/contribution/prepare`, {
      method: "POST",
      headers: authorizedHeaders,
      body: '{"lookbackHours":24,"path":"/Users/private"}',
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
    assert.deepEqual(preparationRequests, [{ lookbackHours: 24 }]);
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

    const sevenDayResponse = await fetch(
      `${base}/api/local/contribution/prepare`,
      {
        method: "POST",
        headers: authorizedHeaders,
        body: '{"lookbackHours":168}',
      },
    );
    assert.equal(sevenDayResponse.status, 200);
    assert.deepEqual(
      (await sevenDayResponse.json()).coveredAt,
      {
        startAt: "2026-07-20T12:30:00.000Z",
        endAt: "2026-07-26T12:30:00.000Z",
      },
    );
    assert.deepEqual(
      preparationRequests,
      [{ lookbackHours: 24 }, { lookbackHours: 7 * 24 }],
    );
    const oneHourResponse = await fetch(
      `${base}/api/local/contribution/prepare`,
      {
        method: "POST",
        headers: authorizedHeaders,
        body: '{"lookbackHours":1}',
      },
    );
    assert.equal(oneHourResponse.status, 200);
    assert.deepEqual(
      preparationRequests,
      [
        { lookbackHours: 24 },
        { lookbackHours: 7 * 24 },
        { lookbackHours: 1 },
      ],
    );
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
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
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
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
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
  let pairedCode = null;
  let releaseRun;
  const reviewedPayload = exactReviewContribution();
  const runGate = new Promise((resolve) => {
    releaseRun = resolve;
  });
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionSyncStatusProvider: async () => queueStatus(pausedState),
    contributionDevicePairingProvider: async ({ pairingCode }) => {
      pairedCode = pairingCode;
      return {
        status: "paired",
        scope: "upload_registration",
        expiresAt: "2026-07-26T14:00:00.000Z",
        deviceId: "00000000-0000-4000-8000-000000000000",
        origin: "https://private.example",
      };
    },
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
    assert.equal(health.capabilities.contributionDevicePairing, true);

    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const unauthorizedPreview = await fetch(
      `${base}/api/local/contribution/sync-next`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(unauthorizedPreview.status, 403);
    assert.equal(previewCalls, 0);
    const pairingCode =
      "um_pair_00000000-0000-4000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    // Pause the queue the way a device_unavailable sync outcome would. A
    // refused pairing must leave it paused; a successful pairing is the cure
    // and must resume it without a separate dashboard action.
    pausedState = true;
    const unauthorizedPairing = await fetch(
      `${base}/api/local/contribution/device-pair`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairingCode }),
      },
    );
    assert.equal(unauthorizedPairing.status, 403);
    assert.equal(pairedCode, null);
    assert.equal(pausedState, true);
    const paired = await fetch(
      `${base}/api/local/contribution/device-pair`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ pairingCode }),
      },
    ).then((response) => response.json());
    assert.equal(pairedCode, pairingCode);
    assert.equal(pausedState, false);
    assert.deepEqual(paired, {
      schemaVersion: "local-contribution-device-pairing-v0.1",
      status: "paired",
      scope: "upload_registration",
      expiresAt: "2026-07-26T14:00:00.000Z",
      includesCredentials: false,
      includesIdentifiers: false,
    });
    assert.equal(JSON.stringify(paired).includes("00000000"), false);
    assert.equal(JSON.stringify(paired).includes("private.example"), false);
    const inspected = await fetch(
      `${base}/api/local/contribution/sync-next`,
      { method: "POST", headers, body: "{}" },
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
      { method: "POST", headers, body: "{}" },
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
        method: "GET",
      })).status,
      405,
    );
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("stale contribution-device credentials return fixed recovery guidance without mutation", async () => {
  const files = await fixture();
  const privateCanary =
    "DO-NOT-LEAK-stale-device-credential-conflict";
  const stateFile = join(
    files.stateRoot,
    "missing-device-binding-v1.json",
  );
  let reads = 0;
  let creates = 0;
  let deletes = 0;
  let networkRequests = 0;
  const backend = {
    async read() {
      reads += 1;
      return Buffer.alloc(32, 77);
    },
    async createIfMissing() {
      creates += 1;
      return "created";
    },
    async deleteExact() {
      deletes += 1;
      return "deleted";
    },
  };
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionDevicePairingProvider: ({ pairingCode }) =>
      claimContributionDevicePairing({
        origin: "https://central.example",
        pairingCode,
        capabilityOptions: { backend, stateFile },
        fetchImpl: async () => {
          networkRequests += 1;
          throw new Error(privateCanary);
        },
      }),
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const pairingCode =
      "um_pair_00000000-0000-4000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const client = new LocalCompanionClient({
      fetchImpl: (url, options = {}) => fetch(`${base}${url}`, {
        ...options,
        headers: {
          ...options.headers,
          Origin: base,
        },
      }),
    });
    await assert.rejects(
      client.pairContributionDevice(pairingCode),
      (error) => error?.status === 409
        && error?.code === "contribution_device_recovery_required",
    );

    // The browser client preserves only the fixed recovery code. The raw
    // route still carries the same minimal payload, with no credential value
    // or provider failure detail.
    const response = await fetch(
      `${base}/api/local/contribution/device-pair`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ pairingCode }),
      },
    );
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.deepEqual(payload, {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      error: {
        code: "contribution_device_recovery_required",
      },
    });
    assert.equal(JSON.stringify(payload).includes(privateCanary), false);

    // Integrated rendered-state contract: this exact client error reaches the
    // narrow recovery renderer, which offers reset and never generic fallback.
    const appSource = await readFile(
      new URL("../web/public/app.js", import.meta.url),
      "utf8",
    );
    const htmlSource = await readFile(
      new URL("../web/public/index.html", import.meta.url),
      "utf8",
    );
    // Re-pinned 2026-08-08 (owner-directed one-step flow): the pairing steps
    // live inside the merged Review-and-approve ceremony now, and they report
    // on the merged surface's own status line — the separate connect card and
    // its #community-connect-status are gone.
    const connectSource = appSource.match(
      /async function approveIncrementalContribution\(\) \{([\s\S]*?)\n\}\n/u,
    )?.[1] ?? "";
    // Failure handling was centralized: every connect failure routes through
    // reportContributionConnectFailure, and the recovery contract lives there.
    const reportFailureSource = appSource.match(
      /async function reportContributionConnectFailure\([\s\S]*?\) \{([\s\S]*?)\n\}\n/u,
    )?.[1] ?? "";
    const recoverySource = appSource.match(
      /async function renderContributionDeviceRecovery\(status, \{ error \} = \{\}\) \{([\s\S]*?)\n\}\n\nconst DEVICE_CREDENTIAL_RESET_CONFIRMATION/u,
    )?.[1] ?? "";
    assert.doesNotMatch(htmlSource, /id="community-connect-status"/u);
    assert.match(htmlSource, /id="incremental-consent-status"/u);
    assert.match(htmlSource, /id="community"[^>]*data-dashboard-page="community"/u);
    assert.doesNotMatch(htmlSource, /id="data"[^>]*data-dashboard-page/u);
    assert.doesNotMatch(htmlSource, /data-nav="data"/u);
    assert.match(connectSource, /reportContributionConnectFailure\(status, error/u);
    assert.match(reportFailureSource, /if \(contributionDeviceRecoveryIsRequired\(error\)\) \{\s*\n\s*await renderContributionDeviceRecovery\(status, \{ error \}\);/u);
    assert.match(recoverySource, /id = "reset-device-credential"/u);
    assert.match(recoverySource, /leftover contribution-device credential/u);
    assert.doesNotMatch(recoverySource, /showFailure\(/u);
    assert.doesNotMatch(appSource, /DO-NOT-LEAK-stale-device-credential-conflict/u);
    assert.equal(reads, 2);
    assert.equal(creates, 0);
    assert.equal(deletes, 0);
    assert.equal(networkRequests, 0);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("optional HTTPS central proxy exposes public reads without leaking authority headers", async () => {
  const files = await fixture();
  const forwarded = [];
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
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
      const readiness = url.endsWith("/api/ready");
      return new Response(JSON.stringify(readiness ? {
        status: "not_ready",
        checks: {
          lifecycle: "running",
          lifecycleFresh: false,
          quarantineRetentionComplete: false,
          restoreReplayComplete: false,
          aggregateRebuildComplete: false,
          quarantineReconciliation: "running",
          quarantineReconciliationComplete: false,
        },
        policy: { lifecycleStaleAfterMilliseconds: 3_600_000 },
      } : {
        status: "ok",
        suppressed: true,
      }), {
        status: readiness ? 503 : 200,
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
    assert.equal(health.capabilities.centralParticipantRelay, true);

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
    const readiness = await fetch(`${base}/api/ready`);
    assert.equal(readiness.status, 503);
    assert.equal((await readiness.json()).status, "not_ready");
    assert.deepEqual(forwarded[1], {
      url: "https://central.example/api/ready",
      method: "GET",
      headers: { Accept: "application/json" },
      body: null,
    });

    assert.equal((await fetch(`${base}/api/v1/stats/aggregate?next=https://attacker.example`)).status, 400);
    assert.equal((await fetch(`${base}/api/v1/admin`)).status, 404);
    assert.equal(forwarded.length, 2);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("production root environment keeps writable queue state outside resources", async () => {
  const files = await fixture();
  const environment = {
    HOME: join(files.root, "home"),
    USAGE_MONITOR_RESOURCE_ROOT: files.resourceRoot,
    USAGE_MONITOR_STATE_ROOT: files.stateRoot,
  };
  const resourceEntriesBefore = await readdir(files.resourceRoot);
  const app = await startLocalCompanionServer({
    environment,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    assert.equal(
      (await fetch(
        `${base}/api/local/contribution/sync-status`,
      )).status,
      200,
    );
    assert.deepEqual(
      await readdir(files.resourceRoot),
      resourceEntriesBefore,
    );
    assert.deepEqual(
      await readdir(join(files.stateRoot, "private")),
      [
        "automatic-contribution-v0.1.lock",
        "contribution-sync-v0.1.sqlite3",
      ],
    );
    if (process.platform !== "win32") {
      assert.equal((await lstat(files.stateRoot)).mode & 0o777, 0o700);
    }
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("production root environment rejects unsafe roots before listen", async () => {
  const files = await fixture();
  const resourceLink = join(files.root, "resource-link");
  const stateTarget = join(files.root, "state-target");
  const stateLink = join(files.root, "state-link");
  await symlink(files.resourceRoot, resourceLink);
  await mkdir(stateTarget, { mode: 0o700 });
  await symlink(stateTarget, stateLink);
  const assertInvalid = async (environment) => {
    await assert.rejects(
      startLocalCompanionServer({
        environment,
        dataStore: fakeStore(),
        refreshRunner: async () => ({}),
        port: 0,
      }),
      (error) => error?.code
          === "USAGE_MONITOR_LOCAL_INSTALLATION_INVALID"
        && error.message
          === "Local installation configuration is invalid"
        && !error.message.includes(files.root)
        && !JSON.stringify(error).includes(files.root),
    );
  };
  try {
    await assertInvalid({
      HOME: join(files.root, "home"),
      USAGE_MONITOR_RESOURCE_ROOT: "relative-resource",
      USAGE_MONITOR_STATE_ROOT: files.stateRoot,
    });
    await assertInvalid({
      HOME: join(files.root, "home"),
      USAGE_MONITOR_RESOURCE_ROOT: files.resourceRoot,
      USAGE_MONITOR_STATE_ROOT: "relative-state",
    });
    await assertInvalid({
      HOME: join(files.root, "home"),
      USAGE_MONITOR_RESOURCE_ROOT: resourceLink,
      USAGE_MONITOR_STATE_ROOT: files.stateRoot,
    });
    await assertInvalid({
      HOME: join(files.root, "home"),
      USAGE_MONITOR_RESOURCE_ROOT: files.resourceRoot,
      USAGE_MONITOR_STATE_ROOT: stateLink,
    });
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("parent watchdog accepts only the exact live parent PID", async () => {
  const files = await fixture();
  const invalidValues = [
    "",
    "0",
    "1",
    "01",
    "+2",
    ` ${process.ppid}`,
    `${process.ppid} `,
    "2147483648",
    String(process.pid),
    null,
    123,
  ];
  try {
    for (const [index, value] of invalidValues.entries()) {
      const stateRoot = join(files.root, `invalid-parent-${index}`);
      await assert.rejects(
        startLocalCompanionServer({
          environment: {
            HOME: join(files.root, "home"),
            USAGE_MONITOR_RESOURCE_ROOT: files.resourceRoot,
            USAGE_MONITOR_STATE_ROOT: stateRoot,
            USAGE_MONITOR_PARENT_PID: value,
          },
          codexHome: files.codexHome,
          staticRoot: files.staticRoot,
          dataStore: fakeStore(),
          refreshRunner: async () => ({}),
          port: 0,
        }),
        (error) => error?.code === "USAGE_MONITOR_PARENT_PID_INVALID"
          && error.message === "Parent watchdog configuration is invalid"
          && (String(value).length === 0
            || (!error.message.includes(String(value))
              && !JSON.stringify(error).includes(String(value)))),
      );
      await assert.rejects(lstat(stateRoot));
    }

    const app = await startLocalCompanionServer({
      environment: {
        HOME: join(files.root, "home"),
        USAGE_MONITOR_RESOURCE_ROOT: files.resourceRoot,
        USAGE_MONITOR_STATE_ROOT: files.stateRoot,
        USAGE_MONITOR_PARENT_PID: String(process.ppid),
      },
      codexHome: files.codexHome,
      staticRoot: files.staticRoot,
      dataStore: fakeStore(),
      refreshRunner: async () => ({}),
      port: 0,
    });
    try {
      const healthUrl =
        `http://127.0.0.1:${app.port}/api/local/health`;
      assert.equal((await fetch(healthUrl)).status, 200);
      await new Promise((resolveWait) => setTimeout(resolveWait, 400));
      assert.equal((await fetch(healthUrl)).status, 200);
    } finally {
      await app.close();
    }
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("configured CLI exits after its declared parent disappears", async () => {
  const files = await fixture();
  const parentEnvironment = {
    ...process.env,
    WATCHDOG_SERVER_PATH: resolve("apps/local/server.js"),
    USAGE_MONITOR_PORT: "0",
    USAGE_MONITOR_RESOURCE_ROOT: process.cwd(),
    USAGE_MONITOR_STATE_ROOT: files.stateRoot,
    HOME: join(files.root, "home"),
    CODEX_HOME: files.codexHome,
  };
  delete parentEnvironment.USAGE_MONITOR_CENTRAL_ORIGIN;
  delete parentEnvironment.USAGE_MONITOR_PARENT_PID;
  const parent = spawn(
    process.execPath,
    ["--input-type=commonjs", "-e", WATCHDOG_PARENT_SCRIPT],
    {
      cwd: files.root,
      env: parentEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let errors = "";
  let childPid = null;
  parent.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
    const observed = Number(
      output.match(/WATCHDOG_CHILD_PID=([1-9][0-9]*)/u)?.[1],
    );
    if (Number.isSafeInteger(observed)) childPid = observed;
  });
  parent.stderr.on("data", (chunk) => {
    errors += chunk.toString("utf8");
  });
  try {
    const [code, signal] = await once(parent, "exit");
    assert.equal(signal, null);
    assert.equal(code, 0, errors);
    assert.equal(Number.isSafeInteger(childPid), true);
    const url = output.match(
      /USAGE_MONITOR_READY (http:\/\/127\.0\.0\.1:\d+\/)/u,
    )?.[1];
    assert.ok(url);
    await waitFor(() => !processIsRunning(childPid), 5_000);
    await assert.rejects(fetch(url, {
      signal: AbortSignal.timeout(1_000),
    }));
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) {
      parent.kill("SIGKILL");
      await once(parent, "exit");
    }
    if (Number.isSafeInteger(childPid) && processIsRunning(childPid)) {
      process.kill(childPid, "SIGKILL");
    }
    await rm(files.root, { recursive: true });
  }
});

// Hosted sign-in used to redirect back to a loopback callback served here,
// which handed the one-time code to the dashboard through localStorage. Both
// providers now redirect to the contribution service's own callback, so this
// origin must receive no provider redirect at all: the route is gone, and the
// blanket refusal of query strings — which that route was the sole exception
// to — covers every path again.
test("no provider redirect can land on the loopback companion", async () => {
  const files = await fixture();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const carrying = await fetch(
      `${base}/oauth/google/callback?code=CANARY-code&state=CANARY-state`,
    );
    assert.equal(carrying.status, 400);
    assert.equal((await carrying.text()).includes("CANARY"), false);
    assert.equal(
      (await fetch(`${base}/oauth/google/callback`)).status,
      404,
    );
    assert.equal((await fetch(`${base}/oauth/google/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })).status, 404);
    assert.equal(
      (await fetch(`${base}/oauth/google/callback/extra`)).status,
      404,
    );
    assert.equal(
      (await fetch(`${base}/api/v1/identity/google/callback?code=CANARY-code`))
        .status,
      400,
    );
    assert.equal((await fetch(`${base}/?code=CANARY-code`)).status, 400);
    assert.equal(
      (await fetch(`${base}/api/local/health?code=CANARY-code`)).status,
      400,
    );

    // Nothing served by this companion mentions the retired localStorage relay
    // key, so no page here can complete a sign-in out of browser storage.
    const source = await readFile(
      new URL("./server.js", import.meta.url),
      "utf8",
    );
    assert.equal(source.includes("tibotattle-google-oauth-result"), false);
    assert.equal(source.includes("/oauth/google/callback"), false);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("CLI port zero prints its actual ready URL and honors explicit roots", async () => {
  const files = await fixture();
  const childEnvironment = {
    ...process.env,
    USAGE_MONITOR_PORT: "0",
    USAGE_MONITOR_RESOURCE_ROOT: process.cwd(),
    USAGE_MONITOR_STATE_ROOT: files.stateRoot,
    HOME: join(files.root, "home"),
    CODEX_HOME: files.codexHome,
  };
  delete childEnvironment.USAGE_MONITOR_CENTRAL_ORIGIN;
  delete childEnvironment.USAGE_MONITOR_PARENT_PID;
  const child = spawn(process.execPath, [resolve("apps/local/server.js")], {
    cwd: files.root,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  try {
    await waitFor(() => output.includes("USAGE_MONITOR_READY"), 15_000);
    const url = output.match(
      /USAGE_MONITOR_READY (http:\/\/127\.0\.0\.1:\d+\/)/u,
    )?.[1];
    assert.ok(url);
    assert.notEqual(new URL(url).port, "0");
    const health = await fetch(new URL("/api/local/health", url));
    assert.equal(health.status, 200);
    const onboarding = await fetch(
      new URL("/api/local/onboarding", url),
    ).then((response) => response.json());
    assert.equal(onboarding.status, "ready");
    assert.equal(JSON.stringify(onboarding).includes(files.root), false);
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
    await rm(files.root, { recursive: true });
  }
});

test("diagnostic notes are bounded, fixed-vocabulary, and land in a local log", async () => {
  const files = await fixture();
  const diagnosticsLogFile = join(files.stateRoot, "diagnostics-v0.1.log");
  let now = Date.parse("2026-08-01T09:00:00.000Z");
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    diagnosticsLogFile,
    clock: () => now,
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const note = {
      reference: "TT-7QF3K2",
      surface: "contribution_connect",
      code: "contribution_device_recovery_required",
      requestId: "",
    };

    // Loopback alone is not authority: the dashboard header and same origin
    // are both required before anything is written.
    const unauthorized = await fetch(`${base}/api/local/diagnostics/note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(note),
    });
    assert.equal(unauthorized.status, 403);
    assert.deepEqual(await unauthorized.json(), {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      error: { code: "diagnostic_note_not_authorized" },
    });
    assert.equal((await fetch(`${base}/api/local/diagnostics/note`)).status, 405);

    const recorded = await fetch(`${base}/api/local/diagnostics/note`, {
      method: "POST",
      headers,
      body: JSON.stringify(note),
    });
    assert.equal(recorded.status, 200);
    assert.deepEqual(await recorded.json(), {
      schemaVersion: "local-diagnostic-note-v0.1",
      status: "recorded",
      reference: "TT-7QF3K2",
    });

    now = Date.parse("2026-08-01T09:05:00.000Z");
    await fetch(`${base}/api/local/diagnostics/note`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        reference: "TT-ZZ0011",
        surface: "contribution_send",
        code: "INTERNAL_ERROR",
        requestId: "0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b",
      }),
    });

    const lines = (await readFile(diagnosticsLogFile, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(lines, [
      {
        schemaVersion: "local-diagnostic-note-v0.1",
        recordedAt: "2026-08-01T09:00:00.000Z",
        reference: "TT-7QF3K2",
        surface: "contribution_connect",
        code: "contribution_device_recovery_required",
        requestId: "",
      },
      {
        schemaVersion: "local-diagnostic-note-v0.1",
        recordedAt: "2026-08-01T09:05:00.000Z",
        reference: "TT-ZZ0011",
        surface: "contribution_send",
        code: "INTERNAL_ERROR",
        requestId: "0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b",
      },
    ]);
    assert.equal((await lstat(diagnosticsLogFile)).mode & 0o777, 0o600);

    // Only the fixed vocabulary is accepted, so a free-form label, a sentence
    // masquerading as a code, or an extra member can never be logged.
    for (const invalid of [
      { ...note, surface: "arbitrary_journey" },
      { ...note, reference: "TT-ILLEGAL" },
      { ...note, reference: "not-a-reference" },
      { ...note, code: "Failed reading /Users/private/state.json" },
      { ...note, requestId: "not-a-uuid" },
      { ...note, extra: "unexpected" },
    ]) {
      const rejected = await fetch(`${base}/api/local/diagnostics/note`, {
        method: "POST",
        headers,
        body: JSON.stringify(invalid),
      });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).error.code, "invalid_request");
    }
    const oversized = await fetch(`${base}/api/local/diagnostics/note`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...note, code: "a".repeat(4_096) }),
    });
    assert.equal(oversized.status, 413);
    const recordedText = await readFile(diagnosticsLogFile, "utf8");
    assert.equal(recordedText.includes("/Users/private"), false);
    assert.equal(recordedText.includes("arbitrary_journey"), false);
    assert.equal(recordedText.split("\n").filter(Boolean).length, 2);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("the dashboard's own sign-in failure note lands in the diagnostics log", async () => {
  const files = await fixture();
  const diagnosticsLogFile = join(files.stateRoot, "diagnostics-v0.1.log");
  let now = Date.parse("2026-08-07T10:00:00.000Z");
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    diagnosticsLogFile,
    clock: () => now,
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    // Browser-faithful fetch: receiver-sensitive exactly like Window.fetch
    // (Blink throws "Illegal invocation", WebKit "Can only call Window.fetch
    // on instances of Window" when it is invoked as a property of anything),
    // resolving the dashboard's relative route against this server and
    // stamping the Origin header a browser adds to every same-origin POST.
    // A client that regresses to calling its stored fetch as a method fails
    // here before any request is made — exactly as it would on a real page.
    function browserFetch(url, options = {}) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return fetch(`${base}${url}`, {
        ...options,
        headers: {
          ...options.headers,
          Origin: base,
        },
      });
    }
    const client = new LocalCompanionClient({ fetchImpl: browserFetch });

    // The exact note describeFailure files for a failed hosted sign-in whose
    // error never got a service answer: a page-minted reference, the fixed
    // hosted_identity surface, and empty validated code and request id (the
    // client replaces the empty code with its fixed "unknown").
    const offlineReference = createDiagnosticReference();
    const offline = await client.recordDiagnosticNote({
      reference: offlineReference,
      surface: diagnosticSurface("hosted_identity"),
      code: diagnosticErrorCode(undefined),
      requestId: serviceRequestId(undefined),
    });
    assert.deepEqual(offline, {
      status: "recorded",
      reference: offlineReference,
    });

    // The same journey when the service answered with its fixed error shape:
    // the code and request id travel exactly as validated from that answer.
    now = Date.parse("2026-08-07T10:01:00.000Z");
    const answeredReference = createDiagnosticReference();
    const answered = await client.recordDiagnosticNote({
      reference: answeredReference,
      surface: diagnosticSurface("hosted_identity"),
      code: diagnosticErrorCode("INTERNAL_ERROR"),
      requestId: serviceRequestId("0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b"),
    });
    assert.deepEqual(answered, {
      status: "recorded",
      reference: answeredReference,
    });

    const lines = (await readFile(diagnosticsLogFile, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(lines, [
      {
        schemaVersion: "local-diagnostic-note-v0.1",
        recordedAt: "2026-08-07T10:00:00.000Z",
        reference: offlineReference,
        surface: "hosted_identity",
        code: "unknown",
        requestId: "",
      },
      {
        schemaVersion: "local-diagnostic-note-v0.1",
        recordedAt: "2026-08-07T10:01:00.000Z",
        reference: answeredReference,
        surface: "hosted_identity",
        code: "INTERNAL_ERROR",
        requestId: "0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b",
      },
    ]);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("failed diagnostic note writes return a fixed error without leaking recorder details", async () => {
  const files = await fixture();
  let calls = 0;
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    diagnosticsLogFile: join(files.stateRoot, "diagnostics-v0.1.log"),
    diagnosticNoteRecorder: async () => {
      calls += 1;
      throw new Error("private diagnostic recorder detail");
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const response = await fetch(`${base}/api/local/diagnostics/note`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1",
        Origin: base,
      },
      body: JSON.stringify({
        reference: "TT-7QF3K2",
        surface: "contribution_connect",
        code: "contribution_device_recovery_required",
        requestId: "",
      }),
    });
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.deepEqual(payload, {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      error: { code: "diagnostic_note_not_recorded" },
    });
    assert.equal(JSON.stringify(payload).includes("private diagnostic recorder detail"), false);
    assert.equal(calls, 1);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("the diagnostics log is bounded and keeps one previous generation", async () => {
  const files = await fixture();
  const diagnosticsLogFile = join(files.stateRoot, "diagnostics-v0.1.log");
  await mkdir(files.stateRoot, { recursive: true, mode: 0o700 });
  await writeFile(diagnosticsLogFile, "x".repeat(256 * 1024), { mode: 0o600 });
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    diagnosticsLogFile,
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const recorded = await fetch(`${base}/api/local/diagnostics/note`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1",
        Origin: base,
      },
      body: JSON.stringify({
        reference: "TT-ABCDEF",
        surface: "local_refresh",
        code: "refresh_in_progress",
        requestId: "",
      }),
    });
    assert.equal(recorded.status, 200);
    const rotated = await lstat(`${diagnosticsLogFile}.previous`);
    assert.equal(rotated.size, 256 * 1024);
    const current = await readFile(diagnosticsLogFile, "utf8");
    assert.equal(current.split("\n").filter(Boolean).length, 1);
    assert.equal(JSON.parse(current).reference, "TT-ABCDEF");
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("device credential reset removes only the contribution-device entry and its binding", async () => {
  const files = await fixture();
  const stateFile = join(files.stateRoot, "contribution-device-binding-v1.json");
  const unrelatedFile = join(files.stateRoot, "export-participant-secret");
  await mkdir(files.stateRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    stateFile,
    `${JSON.stringify({
      schemaVersion: "contribution-device-binding-v1",
      origin: "https://contribute.example.test",
      deviceId: "00000000-0000-4000-8000-000000000000",
      createdAt: "2026-07-30T10:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(unrelatedFile, "unrelated-local-secret", { mode: 0o600 });
  const capabilities = [];
  let stored = Buffer.alloc(32, 7);
  const backend = {
    async read(capability) {
      capabilities.push(capability);
      return stored === null ? null : Buffer.from(stored);
    },
    async createIfMissing() {
      return "existing";
    },
    async deleteExact(capability, expected) {
      capabilities.push(capability);
      if (stored === null) return "missing";
      if (!stored.equals(expected)) return "conflict";
      stored = null;
      return "deleted";
    },
    async describe() {
      return { backend: "test", status: "available" };
    },
  };
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionDeviceBackendFactory: () => backend,
    port: 0,
  });
  const path = "/api/local/contribution/device-credential-reset";
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const body = JSON.stringify({ confirm: "reset_device_credential" });

    const unauthorized = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.equal(unauthorized.status, 403);
    assert.equal(
      (await unauthorized.json()).error.code,
      "device_credential_reset_not_authorized",
    );
    assert.equal((await fetch(`${base}${path}`)).status, 405);

    // The repair is destructive, so it runs only for the one fixed
    // confirmation; an empty or differently shaped body changes nothing.
    for (const invalid of ["{}", JSON.stringify({ confirm: "yes" })]) {
      const rejected = await fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body: invalid,
      });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).error.code, "invalid_request");
    }
    assert.notEqual(stored, null);

    const reset = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body,
    });
    assert.equal(reset.status, 200);
    assert.deepEqual(await reset.json(), {
      schemaVersion: "local-contribution-device-reset-v0.1",
      status: "reset",
      credential: "deleted",
      binding: "removed",
      hostedDataDeleted: false,
      includesIdentifiers: false,
    });
    assert.equal(stored, null);
    // Exactly one Keychain capability is ever touched.
    assert.equal(capabilities.length, 2);
    for (const capability of capabilities) {
      assert.equal(
        capability,
        EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice,
      );
      assert.equal(capability.service, "app-usagemonitor.contribution-device.v1");
      assert.equal(capability.account, "installation");
    }
    await assert.rejects(lstat(stateFile), { code: "ENOENT" });
    assert.equal(await readFile(unrelatedFile, "utf8"), "unrelated-local-secret");

    // Repeating the repair is safe and says plainly that nothing was left.
    const repeated = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body,
    });
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), {
      schemaVersion: "local-contribution-device-reset-v0.1",
      status: "already_absent",
      credential: "already_missing",
      binding: "already_missing",
      hostedDataDeleted: false,
      includesIdentifiers: false,
    });
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("a failed device credential reset reports one fixed code and deletes nothing", async () => {
  const files = await fixture();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionDeviceCredentialResetRunner: async () => {
      const error = new Error("/Users/private/keychain denied for adamallcock");
      error.code = "export_identity_keychain_denied";
      throw error;
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const failed = await fetch(
      `${base}/api/local/contribution/device-credential-reset`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Usage-Monitor-Local": "1",
          Origin: base,
        },
        body: JSON.stringify({ confirm: "reset_device_credential" }),
      },
    );
    assert.equal(failed.status, 500);
    const payload = await failed.text();
    assert.deepEqual(JSON.parse(payload), {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      error: { code: "device_credential_reset_failed" },
    });
    assert.equal(payload.includes("/Users/private"), false);
    assert.equal(payload.includes("adamallcock"), false);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("disconnecting this Mac requires a local confirmation and returns no device identifier", async () => {
  const files = await fixture();
  let calls = 0;
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionDeviceDisconnectRunner: async () => {
      calls += 1;
      return {
        status: "disconnected",
        deliveryPaused: true,
        localCredential: "deleted",
        localBinding: "removed",
      };
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const path = "/api/local/contribution/device-disconnect";
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const health = await fetch(`${base}/api/local/health`).then((response) => response.json());
    assert.equal(health.capabilities.contributionDeviceDisconnect, true);

    const unauthorized = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "disconnect_this_mac" }),
    });
    assert.equal(unauthorized.status, 403);
    assert.equal((await unauthorized.json()).error.code, "contribution_device_disconnect_not_authorized");

    for (const body of ["{}", JSON.stringify({ confirm: "yes" })]) {
      const rejected = await fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body,
      });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).error.code, "invalid_request");
    }
    assert.equal(calls, 0);

    const disconnected = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ confirm: "disconnect_this_mac" }),
    });
    assert.equal(disconnected.status, 200);
    const body = await disconnected.text();
    assert.deepEqual(JSON.parse(body), {
      schemaVersion: "local-contribution-device-disconnect-v0.1",
      status: "disconnected",
      deliveryPaused: true,
      localCredential: "deleted",
      localBinding: "removed",
      includesIdentifiers: false,
      includesCredentials: false,
      hostedDataDeleted: false,
    });
    assert.equal(calls, 1);
    assert.equal(body.includes("00000000-0000"), false);
    assert.equal((await fetch(`${base}${path}`)).status, 405);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("disconnect serializes delivery-affecting mutations before remote revocation completes", async () => {
  const files = await fixture();
  const disconnectStarted = deferred();
  const releaseDisconnect = deferred();
  let disconnectCalls = 0;
  let syncCalls = 0;
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionDeviceDisconnectRunner: async () => {
      disconnectCalls += 1;
      disconnectStarted.resolve();
      await releaseDisconnect.promise;
      return {
        status: "disconnected",
        deliveryPaused: true,
        localCredential: "deleted",
        localBinding: "removed",
      };
    },
    contributionSyncExactReviewProvider: async () => ({
      schemaVersion: "contribution-sync-exact-review-v0.1",
      state: "ready",
      networkActivity: false,
      discoveredSets: 1,
      enqueued: 0,
      payloadBytes: 16,
      payload: exactReviewContribution(),
      reviewBinding: {
        jobId: REVIEW_JOB_ID,
        contributionSha256: REVIEW_SHA256,
      },
    }),
    contributionSyncOnceRunner: async () => {
      syncCalls += 1;
      throw new Error("sync must not start while disconnect is pending");
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const review = await fetch(
      `${base}/api/local/contribution/sync-inspect-exact`,
      { method: "POST", headers, body: "{}" },
    ).then((response) => response.json());
    const disconnect = fetch(
      `${base}/api/local/contribution/device-disconnect`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ confirm: "disconnect_this_mac" }),
      },
    );
    await disconnectStarted.promise;

    const blockedSync = await fetch(
      `${base}/api/local/contribution/sync-once`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ reviewToken: review.reviewToken }),
      },
    );
    assert.equal(blockedSync.status, 409);
    assert.deepEqual(await blockedSync.json(), {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      error: { code: "sync_in_progress" },
    });
    assert.equal(syncCalls, 0);

    const duplicate = await fetch(
      `${base}/api/local/contribution/device-disconnect`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ confirm: "disconnect_this_mac" }),
      },
    );
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      error: { code: "sync_in_progress" },
    });
    assert.equal(disconnectCalls, 1);

    releaseDisconnect.resolve();
    assert.equal((await disconnect).status, 200);
  } finally {
    releaseDisconnect.resolve();
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("a leftover device credential stops delivery with its own code, not a generic failure", async () => {
  const files = await fixture();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    contributionSyncExactReviewProvider: async () => ({
      schemaVersion: "contribution-sync-exact-review-v0.1",
      state: "ready",
      networkActivity: false,
      discoveredSets: 1,
      enqueued: 0,
      payloadBytes: 16,
      payload: exactReviewContribution(),
      reviewBinding: {
        jobId: REVIEW_JOB_ID,
        contributionSha256: REVIEW_SHA256,
      },
    }),
    contributionSyncOnceRunner: async () => {
      const error = new Error("contribution device capability failed");
      error.code = "contribution_device_credential_conflict";
      throw error;
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const review = await fetch(
      `${base}/api/local/contribution/sync-inspect-exact`,
      { method: "POST", headers, body: "{}" },
    ).then((response) => response.json());
    assert.equal(review.state, "ready");
    const run = await fetch(`${base}/api/local/contribution/sync-once`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reviewToken: review.reviewToken }),
    });
    // The cause is precisely known and has its own in-page repair, so it must
    // not be flattened into the generic delivery failure.
    assert.equal(run.status, 409);
    assert.deepEqual(await run.json(), {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      error: { code: "contribution_device_recovery_required" },
    });
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("the Fast-mode preference is owner-only, fixed-valued, and rebuilds the accounting snapshot", async () => {
  const files = await fixture();
  const store = fakeStore();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: store,
    refreshRunner: async () => ({}),
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };

    // Nothing stated yet: the Standard default is reported as a default, and
    // the published rates travel with it so the page never restates them.
    const initial = await fetch(
      `${base}/api/local/accounting/fast-mode-preference`,
    ).then((response) => response.json());
    assert.equal(initial.schemaVersion, "fast-mode-preference-v0.1");
    assert.equal(initial.mode, "standard");
    assert.equal(initial.source, "default");
    assert.equal(initial.appliesTo, "turns_with_no_observed_tier_only");
    assert.equal(initial.logObservability.sessionBaselineRecorded, false);
    assert.deepEqual(initial.availableModes, [
      "standard",
      "fast",
      "mixed_unknown",
    ]);
    assert.deepEqual(initial.multipliers, {
      "gpt-5.6": 2.5,
      "gpt-5.5": 2.5,
      "gpt-5.4": 2,
    });

    // Cross-origin or non-dashboard requests never reach the stored state.
    const unauthorized = await fetch(
      `${base}/api/local/accounting/fast-mode-preference`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "fast" }),
      },
    );
    assert.equal(unauthorized.status, 403);
    assert.deepEqual(await unauthorized.json(), {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      error: { code: "fast_mode_preference_not_authorized" },
    });

    // Only the three fixed values are accepted, and only that exact key set.
    for (const body of [
      JSON.stringify({ mode: "turbo" }),
      JSON.stringify({ mode: "fast", extra: 1 }),
      "{}",
    ]) {
      const rejected = await fetch(
        `${base}/api/local/accounting/fast-mode-preference`,
        { method: "POST", headers, body },
      );
      assert.equal(rejected.status, 400);
      assert.deepEqual(await rejected.json(), {
        schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
        error: { code: "invalid_request" },
      });
    }

    const reloadsBefore = store.reloads;
    const stated = await fetch(
      `${base}/api/local/accounting/fast-mode-preference`,
      { method: "POST", headers, body: JSON.stringify({ mode: "fast" }) },
    );
    assert.equal(stated.status, 200);
    const storedProjection = await stated.json();
    assert.equal(storedProjection.mode, "fast");
    assert.equal(storedProjection.source, "stated");
    // The accounting projection is derived from this statement, so the cached
    // snapshot is rebuilt before the response is acknowledged.
    assert.equal(store.reloads > reloadsBefore, true);

    const persisted = await fetch(
      `${base}/api/local/accounting/fast-mode-preference`,
    ).then((response) => response.json());
    assert.equal(persisted.mode, "fast");
    assert.equal(persisted.source, "stated");

    const settingsFile = join(
      files.stateRoot,
      "private",
      "fast-mode-preference-v0.1.json",
    );
    const metadata = await lstat(settingsFile);
    assert.equal(metadata.mode & 0o077, 0);
    const document = JSON.parse(await readFile(settingsFile, "utf8"));
    assert.deepEqual(Object.keys(document).sort(), [
      "mode",
      "recordedAt",
      "schemaVersion",
    ]);
    // Content-free: a stated speed mode and when it was stated, nothing else.
    assert.equal(JSON.stringify(document).includes(files.stateRoot), false);
    assert.equal(JSON.stringify(document).includes(files.codexHome), false);

    assert.equal(
      (await fetch(`${base}/api/local/accounting/fast-mode-preference`, {
        method: "DELETE",
        headers,
      })).status,
      405,
    );
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});
