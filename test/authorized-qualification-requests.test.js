import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAuthorizedRendererFetch, fetchRendererJson, fetchRendererJsonResponse } from "../scripts/lib/authorized-renderer-fetch.mjs";
import { createOwnerAuthorizedLocalReader } from "../scripts/lib/owner-authorized-local-read.mjs";
import { processHealth } from "../scripts/smoke-electron-linux-real-appimage-updater.mjs";
import { createRendererReadinessCompanionSnapshotObserver, probeRendererReadinessPrimaryApis } from "../scripts/smoke-electron-linux.mjs";

const origin = "http://127.0.0.1:43210";
function renderer(fetch, { selectedOrigin = origin, native = true } = {}) {
  return { evaluate: (expression) => runInNewContext(expression, {
    location: { origin: selectedOrigin }, tibotattleDesktop: native ? { version: "v1" } : undefined,
    URL, fetch, AbortController, setTimeout, clearTimeout, Uint8Array, TextDecoder,
  }) };
}

test("qualification GET stays inside the selected native renderer and returns only bounded response data", async () => {
  let observed;
  const cdp = renderer(async (url, options) => {
    observed = { url, options };
    return new Response(JSON.stringify({ status: "ready" }), { headers: { "x-sensitive-private-header": "not-returned" } });
  });
  assert.deepEqual(await fetchRendererJson(cdp, `${origin}/api/local/health`), { status: "ready" });
  assert.equal(observed.url, `${origin}/api/local/health`);
  assert.equal(observed.options.redirect, "error");
  assert.deepEqual(Array.from(observed.options.headers), []);
  const response = await createAuthorizedRendererFetch(cdp)(`${origin}/api/local/health`);
  assert.equal(response.headers.get("x-sensitive-private-header"), null);
});

test("renderer boundary rejects other origins, nonnative pages, unknown routes and supplied credentials", async () => {
  let reads = 0;
  const fetch = async () => { reads++; return new Response("{}"); };
  for (const options of [{ selectedOrigin: "http://127.0.0.1:43211" }, { native: false }]) {
    await assert.rejects(fetchRendererJson(renderer(fetch, options), `${origin}/api/local/health`), /Authorized renderer response unavailable/u);
  }
  const request = createAuthorizedRendererFetch(renderer(fetch));
  for (const path of ["https://example.invalid/api/local/health", `${origin}/api/local/unknown`, `${origin}/reports/private`]) {
    await assert.rejects(request(path), /Authorized renderer response unavailable/u);
  }
  await assert.rejects(request(`${origin}/api/local/health`, { headers: { "X-TiboTattle-Local-Capability": "synthetic" } }));
  await assert.rejects(request(`${origin}/api/local/health`, { method: "POST" }));
  assert.equal(reads, 0);
});

test("renderer refuses redirects, oversized or invalid JSON, and bounded cancellation never waits on cancel", async () => {
  const redirected = new Response("{}"); Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(fetchRendererJson(renderer(async () => redirected), `${origin}/api/local/health`));
  await assert.rejects(fetchRendererJson(renderer(async () => new Response("12345")), `${origin}/api/local/health`, { maximumBytes: 4 }));
  await assert.rejects(fetchRendererJson(renderer(async () => new Response("private-invalid-json")), `${origin}/api/local/health`), { message: "Authorized renderer response unavailable", status: 200 });
  await assert.rejects(fetchRendererJson(renderer(async () => new Response("{}", { headers: { "content-length": "99999" } })), `${origin}/api/local/health`, { maximumBytes: 64 }));
  const never = renderer(async () => new Response(new ReadableStream({ cancel: () => new Promise(() => {}) })));
  await assert.rejects(fetchRendererJson(never, `${origin}/api/local/health`, { timeoutMs: 20 }));
});

test("renderer measurement preserves denial status while mutation uses owner-scoped operation client", async () => {
  assert.deepEqual(await fetchRendererJsonResponse(renderer(async () => new Response("private denial detail", { status: 403 })), `${origin}/api/local/health`), { status: 403, body: null });
  let expression;
  const request = createAuthorizedRendererFetch({ evaluate: async (source) => { expression = source; return { status: 200, body: "{}" }; } });
  await request(`${origin}/api/local/work-usage/query`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  assert.match(expression, /await import\("\/local-request\.js"\)/u);
  assert.doesNotMatch(expression, /X-TiboTattle-Local-Capability|X-TiboTattle-Operation-Authorization/u);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(request(`${origin}/api/local/health`, { signal: controller.signal }));
});

async function bootstrap(t, overrides = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "qualification-authorization-")));
  await chmod(root, 0o700);
  const directory = join(root, "private"); await mkdir(directory, { mode: 0o700 });
  const path = join(directory, "dashboard-access.json");
  const value = { version: 1, origin, capability: "A".repeat(43), expiresAt: Date.now() + 60_000, ...overrides };
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory, path, value };
}

test("standalone inspection requires explicit owner-only bounded bootstrap and same origin", { skip: process.platform === "win32" }, async (t) => {
  const fixture = await bootstrap(t);
  let request;
  const client = await createOwnerAuthorizedLocalReader(fixture.path, { expectedOrigin: origin, fetchImpl: async (url, options) => {
    request = { url, options }; return new Response('{"status":"ready"}');
  } });
  assert.deepEqual(await client.read("/api/local/health"), { status: "ready" });
  assert.equal(request.url.origin, origin);
  assert.equal(request.options.headers["X-TiboTattle-Local-Capability"], fixture.value.capability);
  assert.equal(request.options.redirect, "error");
  await assert.rejects(client.read("/api/local/work-usage/query"));
  await assert.rejects(createOwnerAuthorizedLocalReader(fixture.path, { expectedOrigin: "http://127.0.0.1:43211" }));
  await chmod(fixture.path, 0o644);
  await assert.rejects(createOwnerAuthorizedLocalReader(fixture.path), /Owner-selected local authorization unavailable/u);
});

test("standalone inspection rejects expired, linked, malformed and unsafe-directory bootstraps", { skip: process.platform === "win32" }, async (t) => {
  for (const overrides of [{ expiresAt: 1 }, { expiresAt: Date.now() + 60 * 60_000 }, { capability: "bad" }, { capability: ["A".repeat(43)] }, { extra: true }, { origin: "http://127.0.0.1:43210/extra" }]) {
    const { path } = await bootstrap(t, overrides);
    await assert.rejects(createOwnerAuthorizedLocalReader(path));
  }
  const hard = await bootstrap(t); await link(hard.path, join(hard.directory, "extra"));
  await assert.rejects(createOwnerAuthorizedLocalReader(hard.path));
  const symbolic = await bootstrap(t); const target = join(symbolic.directory, "target");
  await writeFile(target, JSON.stringify(symbolic.value), { mode: 0o600 }); await rm(symbolic.path); await symlink(target, symbolic.path);
  await assert.rejects(createOwnerAuthorizedLocalReader(symbolic.path));
  const unsafe = await bootstrap(t); await chmod(unsafe.directory, 0o755);
  await assert.rejects(createOwnerAuthorizedLocalReader(unsafe.path));
  const oversized = await bootstrap(t); await writeFile(oversized.path, " ".repeat(1025));
  await assert.rejects(createOwnerAuthorizedLocalReader(oversized.path));
});

test("controlled AppImage health requires owned CDP before and after a genuinely authorized renderer response", async () => {
  await assert.rejects(processHealth(123), { code: "LINUX_REAL_APPIMAGE_RESTART_AUTHORIZATION_UNAVAILABLE" });
  const calls = [];
  const dashboard = renderer(async (url) => { calls.push("authorized_health"); assert.equal(url, `${origin}/api/local/health`); return new Response('{"status":"ready"}'); });
  assert.equal(await processHealth(123, { dashboard, assertCdpAuthority: async () => { calls.push("owned_process_and_socket"); return true; } }), true);
  assert.deepEqual(calls, ["owned_process_and_socket", "authorized_health", "owned_process_and_socket"]);
  let checks = 0;
  await assert.rejects(processHealth(123, { dashboard, assertCdpAuthority: async () => ++checks === 1 }), { code: "LINUX_REAL_APPIMAGE_CDP_AUTHORITY_UNAVAILABLE" });
  await assert.rejects(processHealth(123, { dashboard, assertCdpAuthority: async () => false }), { code: "LINUX_REAL_APPIMAGE_CDP_AUTHORITY_UNAVAILABLE" });
});

test("pre-render diagnostics remain unobserved without an explicitly authorized transport", async () => {
  const observer = createRendererReadinessCompanionSnapshotObserver(origin);
  assert.deepEqual(observer.snapshot(), { status: "unobserved", errorCode: null });
  await observer.stop();
  assert.ok((await probeRendererReadinessPrimaryApis(origin)).every((row) => row.responseClass === "unobserved" && row.outcome === "unobserved"));
});
