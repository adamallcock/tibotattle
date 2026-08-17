import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalCompanionServer } from "../apps/local/server.js";

const PROVIDER = "anthropic_claude_code";
const AUTHORITY = "claude_desktop_plan_history";
const OBSERVED_AT_MS = 1_784_895_000_000;
const PRIVATE_PATH_CANARY = "/Users/canary/Library/Application Support/Claude/plan-usage-history.json";
const PRIVATE_ACCOUNT_CANARY = "account-scope-private-canary";
const PRIVATE_SOURCE_CANARY = "source-key-private-canary";
const PRIVATE_MESSAGE_CANARY = "private parser message must not cross loopback";

function fakeStore() {
  return {
    async initialize() {},
    async reload() {},
    getOverview() {
      return { status: "available" };
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
      return { reports: [] };
    },
  };
}

function automaticContributionStub() {
  return {
    async start() {},
    async stop() {},
    inspect() {
      return { status: "disabled" };
    },
    async enable() {},
    async disable() {},
    async recordReviewedManualAcceptance() {},
  };
}

function validQuotaProjection() {
  return {
    projection: {
      schemaVersion: "claude-desktop-quota-state-v0.1",
      provider: PROVIDER,
      authority: AUTHORITY,
      status: "available",
      source: {
        status: "present",
        sourceKey: PRIVATE_SOURCE_CANARY,
        accountScope: PRIVATE_ACCOUNT_CANARY,
        privatePath: PRIVATE_PATH_CANARY,
        lastSuccessAtMs: OBSERVED_AT_MS,
      },
      freshness: "fresh",
      coverage: {
        state: "complete",
        gapCount: 0,
      },
      counts: {
        observations: 1,
        points: 1,
        accounts: 1,
        meters: 1,
        unknownMeters: 0,
      },
      windows: [{
        meterId: "five_hour",
        utilizationPercent: 42,
        observedAtMs: OBSERVED_AT_MS,
        resetsAtMs: null,
        windowDurationMinutes: 300,
        sourceKey: PRIVATE_SOURCE_CANARY,
        accountScope: PRIVATE_ACCOUNT_CANARY,
      }],
    },
  };
}

const EXPECTED_CLOSED_PROJECTION = {
  schemaVersion: "local-claude-quota-v0.1",
  provider: PROVIDER,
  authority: AUTHORITY,
  status: "available",
  sourceStatus: "present",
  freshness: "fresh",
  lastSuccessAtMs: OBSERVED_AT_MS,
  coverage: {
    state: "complete",
    gapCount: 0,
  },
  counts: {
    observations: 1,
    points: 1,
    accounts: 1,
    meters: 1,
    unknownMeters: 0,
  },
  windows: [{
    meterId: "five_hour",
    utilizationPercent: 42,
    remainingPercent: 58,
    observedAtMs: OBSERVED_AT_MS,
    resetsAtMs: null,
    windowDurationMinutes: 300,
  }],
  includesContent: false,
  includesPaths: false,
  includesIdentifiers: false,
};

async function materializeServerFiles() {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-quota-route-"));
  await chmod(root, 0o700);
  const resourceRoot = join(root, "resources");
  const stateRoot = join(root, "state");
  const codexHome = join(root, "home", ".codex");
  const staticRoot = join(resourceRoot, "public");
  await mkdir(staticRoot, { recursive: true, mode: 0o700 });
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await writeFile(join(staticRoot, "index.html"), "<!doctype html>", { mode: 0o600 });
  return {
    root,
    resourceRoot,
    stateRoot,
    codexHome,
    staticRoot,
    homeDirectory: join(root, "home"),
  };
}

async function startRoute(claudeQuotaProvider) {
  const files = await materializeServerFiles();
  const app = await startLocalCompanionServer({
    port: 0,
    environment: { HOME: files.homeDirectory },
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    claudeQuotaProvider,
    automaticContributionController: automaticContributionStub(),
  });
  await app.snapshotReady;
  return { app, files };
}

async function closeRoute(route) {
  await route.app.close();
  await rm(route.files.root, { recursive: true, force: true });
}

test("Claude quota route returns a closed projection, rejects POST, and advertises health capability", async () => {
  let providerCalls = 0;
  const route = await startRoute(async () => {
    providerCalls += 1;
    return validQuotaProjection();
  });
  try {
    const base = `http://127.0.0.1:${route.app.port}`;
    const health = await fetch(`${base}/api/local/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).capabilities.claudeDesktopQuota, true);

    const get = await fetch(`${base}/api/local/claude/quota`);
    assert.equal(get.status, 200);
    const body = await get.json();
    assert.deepEqual(body, EXPECTED_CLOSED_PROJECTION);
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(PRIVATE_PATH_CANARY), false);
    assert.equal(serialized.includes(PRIVATE_ACCOUNT_CANARY), false);
    assert.equal(serialized.includes(PRIVATE_SOURCE_CANARY), false);

    const post = await fetch(`${base}/api/local/claude/quota`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(providerCalls, 1);
  } finally {
    await closeRoute(route);
  }
});

test("Claude quota provider failures collapse to a fixed content-free error", async () => {
  const route = await startRoute(async () => {
    throw new Error(`${PRIVATE_MESSAGE_CANARY}: ${PRIVATE_PATH_CANARY}`);
  });
  try {
    const response = await fetch(`http://127.0.0.1:${route.app.port}/api/local/claude/quota`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, {
      schemaVersion: "local-claude-quota-v0.1",
      provider: PROVIDER,
      authority: AUTHORITY,
      status: "failed",
      errorCode: "claude_quota_projection_invalid",
      includesContent: false,
      includesPaths: false,
      includesIdentifiers: false,
    });
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(PRIVATE_MESSAGE_CANARY), false);
    assert.equal(serialized.includes(PRIVATE_PATH_CANARY), false);
  } finally {
    await closeRoute(route);
  }
});

test("Claude quota malformed projections collapse to the same fixed error", async () => {
  const route = await startRoute(async () => ({
    projection: {
      provider: "wrong-provider",
      authority: "wrong-authority",
      status: "available",
      source: {
        status: "present",
        privatePath: PRIVATE_PATH_CANARY,
        accountScope: PRIVATE_ACCOUNT_CANARY,
      },
      freshness: "fresh",
      coverage: { state: "complete", gapCount: 0 },
      message: PRIVATE_MESSAGE_CANARY,
      windows: [],
    },
  }));
  try {
    const response = await fetch(`http://127.0.0.1:${route.app.port}/api/local/claude/quota`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, {
      schemaVersion: "local-claude-quota-v0.1",
      provider: PROVIDER,
      authority: AUTHORITY,
      status: "failed",
      errorCode: "claude_quota_projection_invalid",
      includesContent: false,
      includesPaths: false,
      includesIdentifiers: false,
    });
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(PRIVATE_MESSAGE_CANARY), false);
    assert.equal(serialized.includes(PRIVATE_PATH_CANARY), false);
    assert.equal(serialized.includes(PRIVATE_ACCOUNT_CANARY), false);
  } finally {
    await closeRoute(route);
  }
});

test("Claude quota remains readable when the independent Codex snapshot fails", async () => {
  const files = await materializeServerFiles();
  const snapshotCanary = "private Codex snapshot failure";
  const app = await startLocalCompanionServer({
    port: 0,
    environment: { HOME: files.homeDirectory },
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: {
      ...fakeStore(),
      async initialize() { throw new Error(snapshotCanary); },
    },
    refreshRunner: async () => ({}),
    claudeQuotaProvider: async () => validQuotaProjection(),
    automaticContributionController: automaticContributionStub(),
  });
  try {
    await assert.rejects(app.snapshotReady, /private Codex snapshot failure/);
    const response = await fetch(`http://127.0.0.1:${app.port}/api/local/claude/quota`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, EXPECTED_CLOSED_PROJECTION);
    assert.equal(JSON.stringify(body).includes(snapshotCanary), false);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true, force: true });
  }
});
