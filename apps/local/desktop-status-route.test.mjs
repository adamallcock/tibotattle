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
import { startLocalCompanionServer } from "./server.js";

const NOW = Date.parse("2026-08-22T12:00:00.000Z");

function fakeStore() {
  return {
    async initialize() {},
    async reload() {},
    getOverview() { return { status: "available" }; },
    getGradient() { return { status: "available" }; },
    getWeekly() { return { status: "available" }; },
    getQuality() { return { status: "available" }; },
    getReports() { return { reports: [] }; },
  };
}

function automaticContributionStub() {
  return {
    async start() {},
    async stop() {},
    inspect() { return { status: "disabled" }; },
    async enable() {},
    async disable() {},
    async recordReviewedManualAcceptance() {},
  };
}

function evidence() {
  return {
    schemaVersion: "tibotattle-notification-evidence-v2",
    status: "fresh_provider_observation",
    provider: "openai_codex",
    source: "app_server_read",
    freshness: "fresh",
    observedAt: "2026-08-22T11:59:00.000Z",
    continuityKey: "a".repeat(43),
    windows: [{
      lane: "primary",
      usedPercent: 27.5,
      durationMinutes: 300,
      resetAt: "2026-08-22T15:00:00.000Z",
      resetProofKind: "provider_reported_schedule_only",
    }],
  };
}

async function startRoute(refreshRunner) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-desktop-status-route-"));
  await chmod(root, 0o700);
  const resourceRoot = join(root, "resources");
  const staticRoot = join(resourceRoot, "public");
  const stateRoot = join(root, "state");
  const homeDirectory = join(root, "home");
  const codexHome = join(homeDirectory, ".codex");
  await mkdir(staticRoot, { recursive: true, mode: 0o700 });
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await writeFile(join(staticRoot, "index.html"), "<!doctype html>", { mode: 0o600 });
  const app = await startLocalCompanionServer({
    port: 0,
    environment: { HOME: homeDirectory },
    resourceRoot,
    stateRoot,
    codexHome,
    staticRoot,
    dataStore: fakeStore(),
    refreshRunner,
    automaticContributionController: automaticContributionStub(),
    clock: () => NOW,
  });
  await app.snapshotReady;
  return { app, root };
}

async function closeRoute(route) {
  await route.app.close();
  await rm(route.root, { recursive: true, force: true });
}

async function waitForRefresh(app, status) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (app.refresh.getStatus().status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`refresh did not reach ${status}`);
}

test("desktop-status route is exact, fresh-only, and independent of dashboard payloads", async () => {
  let runnerCalls = 0;
  const route = await startRoute(async () => {
    runnerCalls += 1;
    return {
    notificationEvidence: evidence(),
    // These values must never cross the desktop-status boundary.
    dashboard: { privatePath: "/Users/private" },
    refreshId: "private-refresh-id",
    };
  });
  try {
    const base = `http://127.0.0.1:${route.app.port}`;
    const before = await fetch(`${base}/api/local/desktop-status`);
    assert.equal(before.status, 200);
    assert.deepEqual(await before.json(), {
      schemaVersion: "tibotattle-desktop-shell-status-v1",
      state: "unavailable",
      allowance: null,
      notificationEvidence: null,
    });

    assert.equal(
      (await fetch(`${base}/api/local/desktop-status`, { method: "POST" })).status,
      405,
    );
    assert.equal(
      (await fetch(`${base}/api/local/desktop-status?private=1`)).status,
      400,
    );

    assert.equal(route.app.refresh.start(), true);
    await waitForRefresh(route.app, "succeeded");
    assert.equal(runnerCalls, 1);
    const first = await fetch(`${base}/api/local/desktop-status`).then((response) => response.json());
    const second = await fetch(`${base}/api/local/desktop-status`).then((response) => response.json());
    assert.deepEqual(first, second);
    assert.deepEqual(first.allowance, {
      source: "direct",
      window: "five_hour",
      remainingPercent: 72.5,
    });
    assert.equal(first.state, "fresh");
    const serialized = JSON.stringify(first);
    assert.equal(serialized.includes("privatePath"), false);
    assert.equal(serialized.includes("private-refresh-id"), false);
    assert.equal(serialized.includes("dashboard"), false);
  } finally {
    await closeRoute(route);
  }
});

test("desktop-status route fails closed when a successful refresh has no direct evidence", async () => {
  const route = await startRoute(async () => ({
    notificationEvidence: {
      ...evidence(),
      freshness: "mixed",
    },
  }));
  try {
    assert.equal(route.app.refresh.start(), true);
    await waitForRefresh(route.app, "succeeded");
    const response = await fetch(
      `http://127.0.0.1:${route.app.port}/api/local/desktop-status`,
    );
    assert.deepEqual(await response.json(), {
      schemaVersion: "tibotattle-desktop-shell-status-v1",
      state: "stale",
      allowance: null,
      notificationEvidence: null,
    });
  } finally {
    await closeRoute(route);
  }
});
