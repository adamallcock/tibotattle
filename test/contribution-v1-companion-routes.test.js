import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOCAL_COMPANION_SCHEMA_VERSION,
} from "../src/local-companion-data.js";
import {
  buildTelemetryContributionsFromBundle,
} from "../src/telemetry-contribution-builder.js";
import { startLocalCompanionServer } from "../apps/local/server.js";

const REVIEW_JOB_ID = "11111111-1111-4111-8111-111111111111";
const REVIEW_SHA256 = "a".repeat(64);
const PRIVATE_CANARY = "/Users/private/canary";

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
  return {
    async initialize() {},
    async reload() {},
    getOverview() {
      return {
        schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
        mode: "real_local_evidence",
        evidenceStatus: "available",
      };
    },
    getGradient() {
      return { status: "available" };
    },
    getWeekly() {
      return { status: "available" };
    },
    getQuality() {
      return { status: "available" };
    },
    getReports() {
      return { schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION, reports: [] };
    },
  };
}

function fakeIncrementalController() {
  const calls = {
    start: 0, stop: 0, approve: 0, resume: 0, inspect: 0, runDue: 0,
    approveOptions: null,
  };
  let approved = false;
  const projection = () => ({
    schemaVersion: "incremental-contribution-sync-status-v1.0",
    contractVersion: "telemetry-contribution-v1.0",
    configured: true,
    settingsAvailable: true,
    consent: {
      approved,
      current: approved,
      consentedAt: approved ? "2026-08-03T00:00:00.000Z" : null,
    },
    paused: false,
    pausedReason: null,
    running: false,
    progress: approved
      ? {
        daysTotal: 3,
        daysSynced: 1,
        daysPending: 2,
        chunksUploaded: 12,
        acknowledgedThroughDay: "2026-08-01",
      }
      : null,
    lastAttemptAt: null,
    nextAttemptAt: approved ? "2026-08-03T00:00:00.000Z" : null,
    lastOutcome: approved
      ? {
        at: "2026-08-03T00:00:00.000Z",
        code: "partial_progress",
        status: "partial",
        // The 0.1.2 recorded cause: the code must survive the projection so
        // the dashboard can name it, and the message must never leave the
        // companion — it is the canary the body assertions check for.
        detail: { code: "device_credential_unavailable", message: PRIVATE_CANARY },
      }
      : null,
    privatePath: PRIVATE_CANARY,
  });
  return {
    calls,
    async start() { calls.start += 1; },
    async stop() { calls.stop += 1; },
    async inspect() {
      calls.inspect += 1;
      return projection();
    },
    async approve(options) {
      calls.approve += 1;
      calls.approveOptions = options ?? null;
      approved = true;
      return projection();
    },
    async resume() {
      calls.resume += 1;
      return projection();
    },
    async runDue() {
      calls.runDue += 1;
      return projection();
    },
  };
}

// The immediate-first-pass kicks are fire-and-forget on the response path
// (2026-08-08), so give the event loop a few turns before counting them.
async function settleKicks() {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "incremental-companion-"));
  const resourceRoot = join(root, "resources");
  const stateRoot = join(root, "state");
  const codexHome = join(root, "home", ".codex");
  const staticRoot = join(resourceRoot, "public");
  await mkdir(staticRoot, { recursive: true });
  // The state root is deliberately NOT pre-created: the server prepares it
  // owner-only itself, and a pre-created 0o755 directory would be refused.
  await mkdir(join(codexHome, "sessions"), { recursive: true, mode: 0o700 });
  return { root, resourceRoot, stateRoot, codexHome, staticRoot };
}

async function startApp(files, overrides = {}) {
  return startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    port: 0,
    ...overrides,
  });
}

async function findAvailableLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : null;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  if (!Number.isSafeInteger(port)) throw new Error("loopback port unavailable");
  return port;
}

test("the hosted sign-in recovery handle survives a real companion restart on a new port", async () => {
  const files = await fixture();
  const state = "s".repeat(64);
  const verifier = "v".repeat(64);
  const startedAt = Date.parse("2026-08-19T12:00:00.000Z");
  let app = await startApp(files, { clock: () => startedAt });
  let firstPort;
  let secondPort;
  try {
    firstPort = app.port;
    const base = `http://127.0.0.1:${app.port}`;
    const unauthorized = await fetch(
      `${base}/api/local/identity/hosted-signin-handoff`,
    );
    assert.equal(unauthorized.status, 403);
    const stored = await fetch(
      `${base}/api/local/identity/hosted-signin-handoff`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Usage-Monitor-Local": "1",
          Origin: base,
        },
        body: JSON.stringify({
          action: "store",
          provider: "google",
          state,
          verifier,
        }),
      },
    );
    assert.equal(stored.status, 200);
    assert.deepEqual(await stored.json(), {
      schemaVersion: "local-hosted-signin-handoff-v1",
      status: "pending",
      provider: "google",
      state,
      verifier,
      startedAt,
      expiresAt: startedAt + 15 * 60 * 1_000,
    });
    if (process.platform !== "win32") {
      assert.equal(
        (await lstat(join(files.stateRoot, "private"))).mode & 0o777,
        0o700,
      );
      assert.equal(
        (await lstat(join(
          files.stateRoot,
          "private",
          "hosted-signin-handoff-v1.json",
        ))).mode & 0o777,
        0o600,
      );
    }
    secondPort = await findAvailableLoopbackPort();
  } finally {
    await app.close();
  }

  app = await startApp(files, {
    clock: () => startedAt + 30_000,
    port: secondPort,
  });
  try {
    assert.notEqual(app.port, firstPort, "the restarted app receives a fresh loopback port");
    const base = `http://127.0.0.1:${app.port}`;
    const recovered = await fetch(
      `${base}/api/local/identity/hosted-signin-handoff`,
      {
        headers: {
          "X-Usage-Monitor-Local": "1",
          Origin: base,
        },
      },
    );
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), {
      schemaVersion: "local-hosted-signin-handoff-v1",
      status: "pending",
      provider: "google",
      state,
      verifier,
      startedAt,
      expiresAt: startedAt + 15 * 60 * 1_000,
    });
    const cleared = await fetch(
      `${base}/api/local/identity/hosted-signin-handoff`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Usage-Monitor-Local": "1",
          Origin: base,
        },
        body: JSON.stringify({ action: "clear" }),
      },
    );
    assert.deepEqual(await cleared.json(), {
      schemaVersion: "local-hosted-signin-handoff-v1",
      status: "absent",
    });
    const tombstone = await readFile(join(
      files.stateRoot,
      "private",
      "hosted-signin-handoff-v1.json",
    ), "utf8");
    assert.equal(tombstone.includes(state), false);
    assert.equal(tombstone.includes(verifier), false);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("the dashboard's origin-less same-origin GET can read the recovery handle", async () => {
  // Per the Fetch specification a browser appends Origin only to non-GET/HEAD
  // or CORS-tainted requests, so the dashboard's own same-origin GET arrives
  // with NO Origin header. The packaged 0.1.13 (1011) build refused exactly
  // that read (403), which silently disabled restart recovery: the page's
  // resume saw "unavailable" and returned. The custom header remains the
  // cross-origin boundary — a foreign page cannot attach it without a CORS
  // preflight this server never grants.
  const files = await fixture();
  const state = "s".repeat(64);
  const verifier = "v".repeat(64);
  const startedAt = Date.parse("2026-08-19T12:00:00.000Z");
  const app = await startApp(files, { clock: () => startedAt });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    await fetch(`${base}/api/local/identity/hosted-signin-handoff`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1",
        Origin: base,
      },
      body: JSON.stringify({ action: "store", provider: "google", state, verifier }),
    });
    const originLess = await fetch(
      `${base}/api/local/identity/hosted-signin-handoff`,
      { headers: { "X-Usage-Monitor-Local": "1" } },
    );
    assert.equal(originLess.status, 200);
    assert.equal((await originLess.json()).status, "pending");
    const foreignOrigin = await fetch(
      `${base}/api/local/identity/hosted-signin-handoff`,
      {
        headers: {
          "X-Usage-Monitor-Local": "1",
          Origin: "http://evil.example",
        },
      },
    );
    assert.equal(foreignOrigin.status, 403);
    const headerless = await fetch(
      `${base}/api/local/identity/hosted-signin-handoff`,
      { headers: { Origin: base } },
    );
    assert.equal(headerless.status, 403);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("an expired hosted sign-in handle is discarded without exposing its bound values", async () => {
  const files = await fixture();
  const startedAt = Date.parse("2026-08-19T12:00:00.000Z");
  let now = startedAt;
  const state = "s".repeat(64);
  const verifier = "v".repeat(64);
  const app = await startApp(files, { clock: () => now });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const stored = await fetch(
      `${base}/api/local/identity/hosted-signin-handoff`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "store",
          provider: "apple",
          state,
          verifier,
        }),
      },
    );
    assert.equal(stored.status, 200);
    now += 15 * 60 * 1_000;
    const expired = await fetch(
      `${base}/api/local/identity/hosted-signin-handoff`,
      { headers },
    );
    assert.deepEqual(await expired.json(), {
      schemaVersion: "local-hosted-signin-handoff-v1",
      status: "expired",
      provider: "apple",
    });
    const absent = await fetch(
      `${base}/api/local/identity/hosted-signin-handoff`,
      { headers },
    );
    assert.deepEqual(await absent.json(), {
      schemaVersion: "local-hosted-signin-handoff-v1",
      status: "absent",
    });
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("the capability advertises the v1.0 contract only when configured with an existing index", async () => {
  const files = await fixture();
  // Not configured at all: no contribution service origin, no controller.
  let app = await startApp(files);
  try {
    const health = await fetch(
      `http://127.0.0.1:${app.port}/api/local/health`,
    ).then((response) => response.json());
    assert.equal(health.capabilities.incrementalContributionSync, false);
    const status = await fetch(
      `http://127.0.0.1:${app.port}/api/local/contribution/incremental-status`,
    ).then((response) => response.json());
    assert.equal(status.schemaVersion, "local-incremental-contribution-sync-v1.0");
    assert.equal(status.status, "not_configured");
  } finally {
    await app.close();
  }
  // Configured, but the unified index (the upload source) does not exist yet.
  // The controller starts inside the snapshot build, which runs behind the
  // already-open port; wait for it so the start is counted before close.
  const controller = fakeIncrementalController();
  app = await startApp(files, {
    incrementalContributionController: controller,
  });
  try {
    await app.snapshotReady;
    const health = await fetch(
      `http://127.0.0.1:${app.port}/api/local/health`,
    ).then((response) => response.json());
    assert.equal(health.capabilities.incrementalContributionSync, false);
  } finally {
    await app.close();
  }
  // Configured with an existing index: the exact contract string, which is
  // what unhides the dashboard's approve-once surface.
  await writeFile(
    join(files.stateRoot, "local-unified-index-v1.sqlite"),
    "stub",
    { mode: 0o600 },
  );
  app = await startApp(files, {
    incrementalContributionController: controller,
  });
  try {
    await app.snapshotReady;
    const health = await fetch(
      `http://127.0.0.1:${app.port}/api/local/health`,
    ).then((response) => response.json());
    assert.equal(
      health.capabilities.incrementalContributionSync,
      "telemetry-contribution-v1.0",
    );
    // The same injected controller served both configured servers, and each
    // started it beside the v0.1 scheduler. The start rides the lazy snapshot
    // build a health read kicks off without being awaited by the response, so
    // give the event loop the same settling turns the kick counters get —
    // asserting immediately raced it and failed roughly one run in four.
    await settleKicks();
    assert.equal(controller.calls.start, 2);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
  assert.equal(controller.calls.stop >= 1, true);
});

test("the status route reports bounded progress and never a path", async () => {
  const files = await fixture();
  const controller = fakeIncrementalController();
  const app = await startApp(files, {
    incrementalContributionController: controller,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    assert.equal(
      (await fetch(`${base}/api/local/contribution/incremental-status`, {
        method: "POST",
      })).status,
      405,
    );
    await controller.approve();
    const response = await fetch(
      `${base}/api/local/contribution/incremental-status`,
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes(PRIVATE_CANARY), false);
    const status = JSON.parse(body);
    assert.deepEqual(status, {
      schemaVersion: "local-incremental-contribution-sync-v1.0",
      status: "available",
      contractVersion: "telemetry-contribution-v1.0",
      // No broker announcement in this fixture's environment, so the surface
      // that can raise a Keychain dialog is still the pairing step.
      keychainPrompt: "pairing",
      consent: {
        approved: true,
        current: true,
        consentedAt: "2026-08-03T00:00:00.000Z",
      },
      paused: false,
      pausedReason: null,
      running: false,
      progress: {
        daysTotal: 3,
        daysSynced: 1,
        daysPending: 2,
        chunksUploaded: 12,
        acknowledgedThroughDay: "2026-08-01",
      },
      lastAttemptAt: null,
      nextAttemptAt: "2026-08-03T00:00:00.000Z",
      lastOutcome: {
        at: "2026-08-03T00:00:00.000Z",
        code: "partial_progress",
        status: "partial",
        detail: { code: "device_credential_unavailable" },
      },
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

test("approve-once requires the review token minted by an exact review, exactly once", async () => {
  const files = await fixture();
  const controller = fakeIncrementalController();
  const reviewedPayload = exactReviewContribution();
  const app = await startApp(files, {
    incrementalContributionController: controller,
    contributionSyncExactReviewProvider: async () => ({
      schemaVersion: "contribution-sync-exact-review-v0.1",
      state: "ready",
      networkActivity: false,
      discoveredSets: 1,
      enqueued: 0,
      payloadBytes: Buffer.byteLength(
        JSON.stringify(reviewedPayload),
        "utf8",
      ),
      payload: reviewedPayload,
      reviewBinding: {
        jobId: REVIEW_JOB_ID,
        contributionSha256: REVIEW_SHA256,
      },
    }),
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };

    // Foreign or headerless callers are refused before anything else.
    const foreign = await fetch(
      `${base}/api/local/contribution/incremental-approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewToken: "A".repeat(43) }),
      },
    );
    assert.equal(foreign.status, 403);

    // A token that never came from an exact review is refused.
    const unreviewed = await fetch(
      `${base}/api/local/contribution/incremental-approve`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ reviewToken: "A".repeat(43) }),
      },
    );
    assert.equal(unreviewed.status, 409);
    assert.equal(
      (await unreviewed.json()).error.code,
      "review_expired_or_changed",
    );
    assert.equal(controller.calls.approve, 0);

    // A malformed token never reaches the consent machinery.
    const malformed = await fetch(
      `${base}/api/local/contribution/incremental-approve`,
      { method: "POST", headers, body: JSON.stringify({ reviewToken: "x" }) },
    );
    assert.equal(malformed.status, 400);

    // The real flow: one verified instance on screen mints the token, and
    // the approval consumes it.
    const review = await fetch(
      `${base}/api/local/contribution/sync-inspect-exact`,
      { method: "POST", headers, body: "{}" },
    ).then((response) => response.json());
    assert.match(review.reviewToken, /^[A-Za-z0-9_-]{43}$/u);
    const approve = await fetch(
      `${base}/api/local/contribution/incremental-approve`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ reviewToken: review.reviewToken }),
      },
    );
    assert.equal(approve.status, 200);
    assert.deepEqual(await approve.json(), {
      schemaVersion: "local-incremental-contribution-consent-v1.0",
      status: "approved",
      contractVersion: "telemetry-contribution-v1.0",
      consentedAt: "2026-08-03T00:00:00.000Z",
      includesIdentifiers: false,
      includesCredentials: false,
    });
    assert.equal(controller.calls.approve, 1);
    // The ceremony's ordering fact travels with the approval (2026-08-19,
    // observed live on two fresh Macs): no credential binding exists on this
    // fresh state root, so the first pass belongs to the pairing step that
    // follows in the same interaction — an attempt at this instant could
    // only record a device_unavailable pause mid-ceremony.
    assert.deepEqual(controller.calls.approveOptions, {
      awaitingDevicePairing: true,
    });
    // 2026-08-08 (owner-directed immediate first pass): the approval must
    // become a running sync pass in this process tick, not a pending timer —
    // the route fires the controller's own due-run right after it answers.
    await settleKicks();
    assert.equal(controller.calls.runDue >= 1, true);

    // Single use: the same token cannot approve twice.
    const replay = await fetch(
      `${base}/api/local/contribution/incremental-approve`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ reviewToken: review.reviewToken }),
      },
    );
    assert.equal(replay.status, 409);
    assert.equal(controller.calls.approve, 1);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("an approval left open past ten minutes refreshes its local review authorization", async () => {
  const files = await fixture();
  const controller = fakeIncrementalController();
  const reviewedPayload = exactReviewContribution();
  let now = Date.parse("2026-08-03T12:00:00.000Z");
  const app = await startApp(files, {
    clock: () => now,
    incrementalContributionController: controller,
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
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const exactReview = () => fetch(
      `${base}/api/local/contribution/sync-inspect-exact`,
      { method: "POST", headers, body: "{}" },
    ).then((response) => response.json());
    const approve = (reviewToken) => fetch(
      `${base}/api/local/contribution/incremental-approve`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ reviewToken }),
      },
    );

    const stale = await exactReview();
    now += 10 * 60_000 + 1;
    const expired = await approve(stale.reviewToken);
    assert.equal(expired.status, 409);
    assert.equal((await expired.json()).error.code, "review_expired_or_changed");
    assert.equal(controller.calls.approve, 0, "expiry cannot mutate consent");

    const fresh = await exactReview();
    assert.notEqual(fresh.reviewToken, stale.reviewToken);
    const accepted = await approve(fresh.reviewToken);
    assert.equal(accepted.status, 200);
    assert.equal(controller.calls.approve, 1);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("retry-wait and paused payloads still mint local review tokens", async () => {
  for (const queueState of ["retry_wait", "paused"]) {
    const files = await fixture();
    const controller = fakeIncrementalController();
    const reviewedPayload = exactReviewContribution();
    const app = await startApp(files, {
      incrementalContributionController: controller,
      contributionSyncExactReviewProvider: async () => ({
        schemaVersion: "contribution-sync-exact-review-v0.1",
        state: queueState,
        networkActivity: false,
        discoveredSets: 1,
        enqueued: 0,
        payloadBytes: Buffer.byteLength(
          JSON.stringify(reviewedPayload),
          "utf8",
        ),
        payload: reviewedPayload,
        reviewBinding: {
          jobId: REVIEW_JOB_ID,
          contributionSha256: REVIEW_SHA256,
        },
      }),
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
      assert.equal(review.status, "available", queueState);
      assert.equal(review.state, queueState, queueState);
      assert.match(
        review.reviewToken,
        /^[A-Za-z0-9_-]{43}$/u,
        `${queueState} must not suppress a local-only review token`,
      );

      const approve = await fetch(
        `${base}/api/local/contribution/incremental-approve`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ reviewToken: review.reviewToken }),
        },
      );
      assert.equal(approve.status, 200, queueState);
      assert.equal(controller.calls.approve, 1, queueState);
    } finally {
      await app.close();
      await rm(files.root, { recursive: true });
    }
  }
});

test("contribution diagnostics are bounded, content-free, and include recent support references", async () => {
  const files = await fixture();
  const controller = fakeIncrementalController();
  await controller.approve();
  const diagnosticsLogFile = join(files.stateRoot, "diagnostics-v0.1.log");
  await mkdir(files.stateRoot, { recursive: true, mode: 0o700 });
  const notes = [
    {
      schemaVersion: "local-diagnostic-note-v0.1",
      recordedAt: "2026-08-19T13:00:00.000Z",
      reference: "TT-7QF3K2",
      surface: "contribution_connect",
      code: "IDENTITY_TOKEN_INVALID",
      requestId: "",
    },
    {
      schemaVersion: "local-diagnostic-note-v0.1",
      recordedAt: "2026-08-19T13:01:00.000Z",
      reference: "TT-ABCDEF",
      surface: "contribution_prepare",
      code: "local_review_timed_out",
      requestId: "",
    },
  ];
  await writeFile(
    diagnosticsLogFile,
    `${notes.map((note) => JSON.stringify(note)).join("\n")}\n${PRIVATE_CANARY}\n`,
    { mode: 0o600 },
  );
  const app = await startApp(files, {
    diagnosticsLogFile,
    incrementalContributionController: controller,
    contributionSyncStatusProvider: async () => ({
      schemaVersion: "contribution-sync-status-v0.1",
      paused: false,
      counts: {
        pending: 0,
        in_flight: 0,
        accepted: 1,
        retryable: 1,
        rejected: 0,
      },
      dueNow: 0,
      nextAttemptAt: "2026-08-19T13:05:00.000Z",
      lastAcceptedAt: "2026-08-19T12:00:00.000Z",
    }),
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    assert.equal(
      (await fetch(`${base}/api/local/diagnostics/contribution`, {
        method: "POST",
      })).status,
      405,
    );
    const response = await fetch(
      `${base}/api/local/diagnostics/contribution`,
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes(PRIVATE_CANARY), false);
    assert.equal(text.includes("IDENTITY_TOKEN_INVALID"), false);
    assert.equal(text.includes("local_review_timed_out"), false);
    assert.deepEqual(JSON.parse(text), {
      schemaVersion: "local-contribution-diagnostics-v0.1",
      journeyPhase: "approved_connection_needed",
      previewState: "not_observed",
      queueState: "retry_wait",
      consent: { approved: true, current: true },
      signedIn: { observed: false, value: false },
      pairing: { observed: true, paired: false },
      recentDiagnosticReferences: [
        {
          reference: "TT-ABCDEF",
          recordedAt: "2026-08-19T13:01:00.000Z",
        },
        {
          reference: "TT-7QF3K2",
          recordedAt: "2026-08-19T13:00:00.000Z",
        },
      ],
      includesTokens: false,
      includesOauthState: false,
      includesVerifiers: false,
      includesDeviceIdentifiers: false,
      includesAccountIdentifiers: false,
      includesContent: false,
      includesPaths: false,
    });
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("an unconfigured companion refuses the approval and a device pairing resumes the v1.0 sync", async () => {
  const files = await fixture();
  const app = await startApp(files);
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const approve = await fetch(
      `${base}/api/local/contribution/incremental-approve`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ reviewToken: "A".repeat(43) }),
      },
    );
    assert.equal(approve.status, 409);
    assert.equal(
      (await approve.json()).error.code,
      "incremental_sync_not_configured",
    );
  } finally {
    await app.close();
  }

  const controller = fakeIncrementalController();
  const paired = await startApp(files, {
    incrementalContributionController: controller,
    contributionDevicePairingProvider: async () => ({
      status: "paired",
      scope: "upload_registration",
      expiresAt: "2026-08-04T00:00:00.000Z",
    }),
    contributionSyncPauseSetter: async ({ paused }) => ({
      schemaVersion: "contribution-sync-status-v0.1",
      paused,
      counts: {},
      dueNow: 0,
      nextAttemptAt: null,
      lastAcceptedAt: null,
    }),
  });
  try {
    const base = `http://127.0.0.1:${paired.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const pairing = await fetch(
      `${base}/api/local/contribution/device-pair`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          pairingCode: `um_pair_${REVIEW_JOB_ID}.${"C".repeat(43)}`,
        }),
      },
    );
    assert.equal(pairing.status, 200);
    // The cure for a device_unavailable auto-pause is the same pairing that
    // cures the v0.1 queue.
    assert.equal(controller.calls.resume, 1);
    // 2026-08-08: a fresh pairing also translates into a prompt sync attempt
    // — the re-pair path must not leave its first pass waiting on a timer.
    await settleKicks();
    assert.equal(controller.calls.runDue >= 1, true);
  } finally {
    await paired.close();
    await rm(files.root, { recursive: true });
  }
});

test("an approval on a Mac that already holds a device binding keeps the immediate first pass", async () => {
  const files = await fixture();
  // A paired Mac re-approving (a consent upgrade) has its binding file on
  // disk; presence is probed without touching the Keychain, and the
  // owner-directed immediate first pass (2026-08-08) stays in force.
  await mkdir(files.stateRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    join(files.stateRoot, "contribution-device-binding-v1.json"),
    `${JSON.stringify({ schemaVersion: "contribution-device-binding-v1" })}\n`,
    { mode: 0o600 },
  );
  const controller = fakeIncrementalController();
  const reviewedPayload = exactReviewContribution();
  const app = await startApp(files, {
    incrementalContributionController: controller,
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
    const approve = await fetch(
      `${base}/api/local/contribution/incremental-approve`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ reviewToken: review.reviewToken }),
      },
    );
    assert.equal(approve.status, 200);
    assert.equal(controller.calls.approve, 1);
    assert.deepEqual(controller.calls.approveOptions, {
      awaitingDevicePairing: false,
    });
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("a denied Keychain read at pairing answers with its dialog-specific recovery code", async () => {
  // Deny (or cancel) in the macOS access dialog surfaces from the capability
  // layer as contribution_device_credential_denied. The route must keep that
  // one cause distinguishable — the dashboard tells the user which dialog to
  // answer differently — while every other broken-credential state stays on
  // the generic recovery code, and non-recovery failures stay 502.
  const files = await fixture();
  const failures = [
    ["contribution_device_credential_denied", 409,
      "contribution_device_keychain_access_denied"],
    ["contribution_device_credential_locked", 409,
      "contribution_device_recovery_required"],
    ["contribution_device_credential_conflict", 409,
      "contribution_device_recovery_required"],
    ["contribution_device_client_pairing_rejected", 502,
      "contribution_device_pairing_failed"],
  ];
  let thrownCode = null;
  const app = await startApp(files, {
    incrementalContributionController: fakeIncrementalController(),
    contributionDevicePairingProvider: async () => {
      const error = new Error("pairing failed");
      error.code = thrownCode;
      throw error;
    },
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    for (const [capabilityCode, status, routeCode] of failures) {
      thrownCode = capabilityCode;
      const pairing = await fetch(
        `${base}/api/local/contribution/device-pair`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            pairingCode: `um_pair_${REVIEW_JOB_ID}.${"C".repeat(43)}`,
          }),
        },
      );
      assert.equal(pairing.status, status, capabilityCode);
      assert.equal((await pairing.json()).error.code, routeCode, capabilityCode);
    }
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("the local kick route resumes the schedule now and starts a due pass (2026-08-10)", async () => {
  // The operator's lever against an inherited retry backoff: during the live
  // 86-day backfill stall, resume() was reachable only through device-pair,
  // and the only alternative was waiting the ladder out.
  const files = await fixture();

  // Unconfigured companion: the route exists and refuses honestly.
  const bare = await startApp(files);
  try {
    const base = `http://127.0.0.1:${bare.port}`;
    const refused = await fetch(
      `${base}/api/local/contribution/incremental-run`,
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
    assert.equal(refused.status, 409);
    assert.equal(
      (await refused.json()).error.code,
      "incremental_sync_not_configured",
    );
  } finally {
    await bare.close();
  }

  const controller = fakeIncrementalController();
  const app = await startApp(files, {
    incrementalContributionController: controller,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };

    // Guarded exactly like the other sync controls: POST only, same-origin
    // first-party callers only.
    assert.equal(
      (await fetch(`${base}/api/local/contribution/incremental-run`)).status,
      405,
    );
    const foreign = await fetch(
      `${base}/api/local/contribution/incremental-run`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(foreign.status, 403);
    assert.equal(controller.calls.resume, 0);

    await controller.approve();
    const response = await fetch(
      `${base}/api/local/contribution/incremental-run`,
      { method: "POST", headers, body: "{}" },
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes(PRIVATE_CANARY), false);
    const status = JSON.parse(body);
    assert.equal(
      status.schemaVersion,
      "local-incremental-contribution-sync-v1.0",
    );
    assert.equal(status.status, "available");
    assert.equal(status.consent.approved, true);
    // resume() reset the ladder and re-armed the schedule...
    assert.equal(controller.calls.resume, 1);
    // ...and the due pass starts in this tick, not on a timer.
    await settleKicks();
    assert.equal(controller.calls.runDue >= 1, true);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

const SERVICE_ORIGIN = "http://127.0.0.1:9";

function persistedConsentSettings() {
  return {
    schemaVersion: "incremental-contribution-sync-settings-v1.0",
    consent: {
      consentedAt: "2026-08-08T17:31:13.735Z",
      destinationOrigin: SERVICE_ORIGIN,
      telemetrySchemaVersion: "telemetry-contribution-v1.0",
      fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0",
    },
    paused: false,
    pausedReason: null,
    retryCount: 0,
    lastAttemptAt: null,
    lastOutcome: null,
    nextAttemptAt: null,
    progress: {
      daysTotal: 86,
      daysSynced: 7,
      daysPending: 79,
      chunksUploaded: 80,
      acknowledgedThroughDay: "2026-05-24",
    },
  };
}

async function seedConsentedIncrementalSettings(files) {
  const privateDirectory = join(files.stateRoot, "private");
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(privateDirectory, "incremental-contribution-sync-v1.json"),
    `${JSON.stringify(persistedConsentSettings())}\n`,
    { mode: 0o600 },
  );
}

async function statusUntil(base, predicate) {
  let status = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    status = await fetch(
      `${base}/api/local/contribution/incremental-status`,
    ).then((response) => response.json());
    if (predicate(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return status;
}

test("a thrown capability failure pauses as device_unavailable instead of an anonymous run_failed loop (2026-08-10)", async () => {
  // Observed live: a Sparkle update invalidated the audited Keychain
  // binding, so the wiring's backend factory threw before the sync engine
  // could shape the failure — and the controller walked an anonymous
  // run_failed retry ladder forever while the dashboard showed no repair
  // path. The wiring now hands the engine's own device_unavailable shape to
  // the controller, which pauses with the reason the re-approve surface
  // keys on, and the last honest progress survives.
  const files = await fixture();
  await seedConsentedIncrementalSettings(files);
  const app = await startApp(files, {
    contributionServiceOrigin: SERVICE_ORIGIN,
    contributionDeviceBackendFactory: () => {
      const error = new Error(
        "Contribution device capability operation failed",
      );
      error.code = "contribution_device_credential_unavailable";
      throw error;
    },
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const kicked = await fetch(
      `${base}/api/local/contribution/incremental-run`,
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
    assert.equal(kicked.status, 200);
    const status = await statusUntil(base, (value) => value.paused === true);
    assert.equal(status.status, "available");
    assert.equal(status.paused, true);
    assert.equal(status.pausedReason, "device_unavailable");
    assert.equal(status.lastOutcome.code, "device_unavailable");
    assert.equal(status.lastOutcome.status, "paused");
    // The no-run outcome measured nothing: the progress a real pass
    // recorded is still shown beside the pause.
    assert.deepEqual(status.progress, {
      daysTotal: 86,
      daysSynced: 7,
      daysPending: 79,
      chunksUploaded: 80,
      acknowledgedThroughDay: "2026-05-24",
    });
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("the credential reset succeeds by attribute delete when the backend cannot even be constructed (2026-08-10)", async () => {
  // Observed live: the in-app cure 500ed in exactly the state it exists to
  // cure, because building the Keychain backend itself threw. The reset now
  // treats the backend as best-effort and falls back to an
  // attribute-addressed delete that needs neither the native binding nor
  // the item's access control list.
  const files = await fixture();
  const attributeDeletes = [];
  const app = await startApp(files, {
    contributionDeviceBackendFactory: () => {
      const error = new Error(
        "Contribution device capability operation failed",
      );
      error.code = "contribution_device_credential_unavailable";
      throw error;
    },
    contributionDeviceCredentialAttributeDelete: async () => {
      attributeDeletes.push("deleted");
      return "deleted";
    },
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const response = await fetch(
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
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      schemaVersion: "local-contribution-device-reset-v0.1",
      status: "reset",
      credential: "deleted",
      binding: "already_missing",
      hostedDataDeleted: false,
      includesIdentifiers: false,
    });
    assert.equal(attributeDeletes.length, 1);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("the credential reset falls back to attribute delete when the read is broken, and never when it works", async () => {
  const files = await fixture();

  // A backend whose read throws — the broken access-control state — still
  // resets, by attributes.
  const brokenDeletes = [];
  const broken = await startApp(files, {
    contributionDeviceBackendFactory: () => ({
      async read() {
        const error = new Error("macOS Keychain backend failed");
        error.code = "export_identity_keychain_denied";
        throw error;
      },
      async createIfMissing() {
        throw new Error("unexpected createIfMissing");
      },
      async deleteExact() {
        throw new Error("unexpected deleteExact");
      },
    }),
    contributionDeviceCredentialAttributeDelete: async () => {
      brokenDeletes.push("deleted");
      return "deleted";
    },
  });
  try {
    const base = `http://127.0.0.1:${broken.port}`;
    const response = await fetch(
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
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "reset");
    assert.equal(body.credential, "deleted");
    assert.equal(brokenDeletes.length, 1);
  } finally {
    await broken.close();
  }

  // A backend that reads cleanly keeps today's exact-value behavior: a
  // missing credential reports already_absent and the attribute delete is
  // never consulted.
  const healthyDeletes = [];
  const healthy = await startApp(files, {
    contributionDeviceBackendFactory: () => ({
      async read() {
        return null;
      },
      async createIfMissing() {
        throw new Error("unexpected createIfMissing");
      },
      async deleteExact() {
        throw new Error("unexpected deleteExact");
      },
    }),
    contributionDeviceCredentialAttributeDelete: async () => {
      healthyDeletes.push("deleted");
      return "deleted";
    },
  });
  try {
    const base = `http://127.0.0.1:${healthy.port}`;
    const response = await fetch(
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
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "already_absent");
    assert.equal(body.credential, "already_missing");
    assert.equal(body.binding, "already_missing");
    assert.equal(healthyDeletes.length, 0);
  } finally {
    await healthy.close();
    await rm(files.root, { recursive: true });
  }
});

test("the pre-consent review preparation refuses once the v1.0 consent is current", async () => {
  const files = await fixture();
  const controller = fakeIncrementalController();
  let preparations = 0;
  const app = await startApp(files, {
    incrementalContributionController: controller,
    contributionPreparationRunner: async () => {
      preparations += 1;
      throw new Error("no coverage in this fixture");
    },
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const prepare = () => fetch(`${base}/api/local/contribution/prepare`, {
      method: "POST",
      headers,
      body: JSON.stringify({ lookbackHours: 24 }),
    });

    // Pre-consent, the ceremony's silent bootstrap reaches preparation: the
    // stub throws, which is proof the route ran it.
    const preConsent = await prepare();
    assert.equal(preConsent.status, 500);
    assert.equal((await preConsent.json()).errorCode, "preparation_failed");
    assert.equal(preparations, 1);

    // Approved and current: a prepared set could never deliver — no
    // scheduler drains the v0.1 queue for this consent model — so the route
    // refuses before any set is minted (the owner install grew a stranded
    // 70-file set exactly this way, observed 2026-08-19).
    await controller.approve();
    const refused = await prepare();
    assert.equal(refused.status, 409);
    const refusal = await refused.json();
    assert.equal(
      refusal.schemaVersion,
      "local-contribution-preparation-error-v0.1",
    );
    assert.equal(refusal.errorCode, "consent_already_current");
    assert.equal(refusal.status, "failed");
    assert.equal(
      preparations,
      1,
      "an approved Mac never mints a new prepared set",
    );
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("a consent-version change still prepares the fresh review its ceremony needs", async () => {
  const files = await fixture();
  // Approved under an older consent version: approved=true, current=false.
  // The re-approval ceremony legitimately needs one fresh local review
  // instance, so preparation must stay reachable.
  const staleController = {
    async start() {},
    async stop() {},
    async approve() {
      throw new Error("unexpected approve");
    },
    async resume() {
      throw new Error("unexpected resume");
    },
    async inspect() {
      return {
        schemaVersion: "incremental-contribution-sync-status-v1.0",
        contractVersion: "telemetry-contribution-v1.0",
        configured: true,
        settingsAvailable: true,
        consent: {
          approved: true,
          current: false,
          consentedAt: "2026-08-08T17:31:13.735Z",
        },
        paused: false,
        pausedReason: null,
        running: false,
        progress: null,
        lastAttemptAt: null,
        nextAttemptAt: null,
        lastOutcome: null,
      };
    },
  };
  let preparations = 0;
  const app = await startApp(files, {
    incrementalContributionController: staleController,
    contributionPreparationRunner: async () => {
      preparations += 1;
      throw new Error("no coverage in this fixture");
    },
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const response = await fetch(`${base}/api/local/contribution/prepare`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1",
        Origin: base,
      },
      body: JSON.stringify({ lookbackHours: 24 }),
    });
    assert.equal(response.status, 500);
    assert.equal((await response.json()).errorCode, "preparation_failed");
    assert.equal(preparations, 1);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("an approved consent's startup and approval converge superseded v0.1 sets", async () => {
  const files = await fixture();
  const controller = fakeIncrementalController();
  const retirements = [];
  const retirementRunner = async () => {
    retirements.push("pass");
    return {
      retiredSets: 0,
      retiredJobs: 0,
      interrupted: false,
      networkActivity: false,
    };
  };

  // Pre-consent, nothing is superseded and nothing may be retired: the
  // pending set IS the ceremony's review bootstrap.
  let app = await startApp(files, {
    incrementalContributionController: controller,
    supersededContributionRetirementRunner: retirementRunner,
  });
  try {
    await app.snapshotReady;
    await settleKicks();
    assert.equal(retirements.length, 0, "pre-consent startup retires nothing");
  } finally {
    await app.close();
  }

  // The approval itself converges the queue in this process, without waiting
  // for a relaunch — the same fire-and-forget contract as the first-pass kick.
  const reviewedPayload = exactReviewContribution();
  app = await startApp(files, {
    incrementalContributionController: controller,
    supersededContributionRetirementRunner: retirementRunner,
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
  });
  try {
    await app.snapshotReady;
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
    const approve = await fetch(
      `${base}/api/local/contribution/incremental-approve`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ reviewToken: review.reviewToken }),
      },
    );
    assert.equal(approve.status, 200);
    await settleKicks();
    assert.equal(
      retirements.length,
      1,
      "the approval converges the queue without a relaunch",
    );
  } finally {
    await app.close();
  }

  // Every later launch of the approved Mac runs one bounded pass, which is
  // how installs that predate this fix (73 stranded jobs) converge.
  app = await startApp(files, {
    incrementalContributionController: controller,
    supersededContributionRetirementRunner: retirementRunner,
  });
  try {
    await app.snapshotReady;
    await settleKicks();
    assert.equal(retirements.length, 2, "an approved startup runs one pass");
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});
