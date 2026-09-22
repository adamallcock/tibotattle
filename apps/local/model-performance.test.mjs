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
    modelPerformanceProvider: async (period, options) => {
      requests.push({ period, ...options });
      return { schemaVersion: 5, status: "ready", period, ...options, models: [] };
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
  assert.deepEqual(requests, ["7", "30", "all"].map(period => ({ period, speedMode: "standard" })));
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
  assert.deepEqual(requests, ["7", "30", "all"].map(period => ({ period, speedMode: "standard" })));
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

test("model performance accepts an exact rolling anchor and rejects ambiguous bounds", async (t) => {
  const calls = [];
  const { base } = await fixture(t, { modelPerformanceProvider: async (period, options) => {
    calls.push({ period, options }); return { status: 'loading', models: [] };
  } });
  const endAt = '2026-09-01T12:34:56.000Z';
  const route = `${base}/api/local/model-performance?period=1`;
  assert.equal((await fetch(`${route}&endAt=${encodeURIComponent(endAt)}`)).status, 200);
  assert.deepEqual(calls, [{ period: '1', options: { endAt, speedMode: 'standard' } }]);
  for (const query of ['&endAt=2026-09-01', '&endAt=', `&endAt=${endAt}&endAt=${endAt}`, '&endAt=9999-01-01T00:00:00.000Z']) {
    assert.equal((await fetch(`${route}${query}`)).status, 400);
  }
  assert.equal(calls.length, 1);
});

test("model performance mode selectors preserve optional exact windows and reject ambiguous modes", async t => {
  const calls = [];
  const { base } = await fixture(t, { modelPerformanceProvider: async (period, options) => {
    calls.push({ period, ...options }); return { period, ...options };
  } });
  const endAt = '2026-09-01T12:34:56.000Z';
  const route = `${base}/api/local/model-performance`;
  for (const speedMode of ['standard', 'fast']) for (const anchored of [false, true]) {
    const response = await fetch(`${route}?period=1&speedMode=${speedMode}${anchored ? `&endAt=${endAt}` : ''}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { period: '1', speedMode, ...(anchored ? { endAt } : {}) });
  }
  for (const query of ['speedMode=', 'speedMode=mixed', 'speedMode=FAST', 'speedMode=unknown',
    'speedMode=fast&speedMode=fast', 'speedMode=fast&speedMode=standard',
    'speedMode=fast&period=all', 'speedMode=fast&extra=1']) {
    assert.equal((await fetch(`${route}?period=all&${query}`)).status, 400, query);
  }
  assert.equal(calls.length, 4);
});
