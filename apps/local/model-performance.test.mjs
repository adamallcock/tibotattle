import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { startLocalCompanionServer } from "./server.js";

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "model-performance-route-"));
  const resourceRoot = join(root, "resources");
  const staticRoot = join(resourceRoot, "public");
  const codexHome = join(root, "codex");
  await mkdir(staticRoot, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  let app;
  t.after(async () => {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  });
  app = await startLocalCompanionServer({
    environment: {}, resourceRoot, staticRoot, codexHome,
    stateRoot: join(root, "state"), port: 0,
    dataStore: { async initialize() {}, async reload() {} },
    refreshRunner: async () => ({}),
    ...options,
  });
  return { app, base: `http://127.0.0.1:${app.port}` };
}

test("model performance accepts only one standard period and preserves read guards", async (t) => {
  const requests = [];
  const { base } = await fixture(t, {
    modelPerformanceProvider: async (period) => {
      requests.push(period);
      return { schemaVersion: "model-performance-v1", status: "available", period, models: [] };
    },
  });
  const route = `${base}/api/local/model-performance`;
  for (const period of ["7", "30", "all"]) {
    const response = await fetch(`${route}?period=${period}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).period, period);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  assert.deepEqual(requests, ["7", "30", "all"]);
  for (const query of ["", "?period=", "?period=90", "?period=ALL", "?period=7.0",
    "?period=7&period=7", "?period=7&path=synthetic", "?from=7", "?period=all&model=sol"]) {
    assert.equal((await fetch(`${route}${query}`)).status, 400, query);
  }
  for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
    assert.equal((await fetch(`${route}?period=all`, { method })).status, 405, method);
  }
  // Node fetch normalizes Host from the URL; send the actual hostile wire
  // header through http.request to exercise the companion's DNS-rebind fence.
  const refused = await new Promise((resolve, reject) => {
    const request = httpRequest(`${route}?period=all`, {
      headers: { Host: "untrusted.invalid" },
    }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
    request.end();
  });
  assert.equal(refused, 403);
  assert.deepEqual(requests, ["7", "30", "all"]);
});

test("model performance remains readable while accounting builds and after it fails", async (t) => {
  let failBuild;
  const barrier = new Promise((resolve, reject) => { failBuild = reject; });
  const { app, base } = await fixture(t, {
    dataStore: { initialize: () => barrier, async reload() {} },
    modelPerformanceProvider: async () => ({ status: "loading", models: [] }),
  });
  try {
    const route = `${base}/api/local/model-performance?period=all`;
    assert.equal((await fetch(route, { signal: AbortSignal.timeout(2000) })).status, 200);
    failBuild(new Error("synthetic_snapshot_failure"));
    await assert.rejects(app.snapshotReady, /synthetic_snapshot_failure/u);
    const response = await fetch(route, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "loading");
    assert.equal((await fetch(`${base}/api/local/overview`)).status, 503);
  } finally {
    failBuild(new Error("synthetic_snapshot_failure"));
  }
});

test("timing failures return a fixed content-free error without changing accounting health", async (t) => {
  const { app, base } = await fixture(t, {
    modelPerformanceProvider: async () => {
      throw new Error("private upstream payload must never leave this boundary");
    },
  });
  await app.snapshotReady;
  const response = await fetch(`${base}/api/local/model-performance?period=all`);
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.match(body, /model_performance_unavailable/u);
  assert.doesNotMatch(body, /private upstream/u);
  const health = await fetch(`${base}/api/local/health`).then((value) => value.json());
  assert.equal(health.snapshot.status, "ready");
});
