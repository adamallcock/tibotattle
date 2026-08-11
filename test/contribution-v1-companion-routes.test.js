import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    async approve() {
      calls.approve += 1;
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
