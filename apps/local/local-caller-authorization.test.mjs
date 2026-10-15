import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, lstat, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalCompanionServer } from "./server.js";
import {
  createLocalCallerAuthorization, LOCAL_CAPABILITY_HEADER, LOCAL_OPERATION_HEADER,
} from "./transport/local-caller-authorization.js";
import { writeLocalAuthorizationBootstrap } from "./transport/local-authorization-bootstrap.js";
import { createLocalRequestClient } from "../web/public/local-request.js";
import { LocalCompanionClient } from "../web/public/data-client.js";

test("launch capabilities and operation credentials are distinct, bounded and revoked", () => {
  let now = 100;
  const auth = createLocalCallerAuthorization({ now: () => now });
  const other = createLocalCallerAuthorization();
  const credential = auth.headers()[LOCAL_CAPABILITY_HEADER];
  assert.equal(auth.authorize(credential), true);
  for (const value of [undefined, "1", [], `${credential}x`, other.headers()[LOCAL_CAPABILITY_HEADER]]) {
    assert.equal(auth.authorize(value), false);
  }
  const path = "/api/local/contribution/device-disconnect";
  const token = auth.issue("POST", path);
  assert.equal(auth.consume(token, "POST", "/api/local/refresh"), false);
  assert.equal(auth.consume(token, "POST", path), false);
  const expired = auth.issue("POST", path);
  now += 15_000;
  assert.equal(auth.consume(expired, "POST", path), false);
  const once = auth.issue("POST", path);
  assert.equal(auth.consume(once, "POST", path), true);
  assert.equal(auth.consume(once, "POST", path), false);
  for (let index = 0; index < 128; index += 1) assert.ok(auth.issue("POST", path));
  assert.equal(auth.issue("POST", path), null);
  now += 15_000;
  assert.ok(auth.issue("POST", path));
  auth.revoke();
  assert.equal(auth.authorize(credential), false);
  assert.equal(auth.issue("POST", path), null);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "local-authority-"));
  const resourceRoot = join(root, "resources");
  const staticRoot = join(resourceRoot, "public");
  const codexHome = join(root, "codex");
  await mkdir(staticRoot, { recursive: true });
  await mkdir(codexHome, { mode: 0o700 });
  const calls = { overview: 0, refresh: 0, disconnect: 0 };
  const apps = [];
  t.after(async () => {
    for (const app of apps) await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    calls,
    async start() {
      const app = await startLocalCompanionServer({
        environment: {}, resourceRoot, staticRoot, codexHome,
        stateRoot: join(root, `state-${apps.length}`), port: 0,
        dataStore: {
          async initialize() {}, async reload() {},
          getOverview() { calls.overview += 1; return { privateSynthetic: true }; },
          getGradient() { return {}; }, getWeekly() { return {}; }, getQuality() { return {}; },
          getReports() { return { reports: [] }; },
        },
        refreshRunner: async () => { calls.refresh += 1; return {}; },
        contributionDeviceDisconnectRunner: async () => {
          calls.disconnect += 1;
          return { status: "disconnected", deliveryPaused: true, localCredential: "deleted", localBinding: "removed" };
        },
      });
      apps.push(app);
      await app.snapshotReady;
      return { ...app, origin: `http://127.0.0.1:${app.port}` };
    },
  };
}

test("actual loopback denies perfect public headers before every private read or mutation", async (t) => {
  const f = await fixture(t);
  const app = await f.start();
  const before = { ...f.calls };
  for (const path of ["/api/local/overview", "/api/local/health", "/api/local/desktop-status",
    "/api/local/diagnostics/contribution", "/api/local/refresh", "/api/local/work-usage/query",
    "/api/v1/session", "/reports/gradient", "/reports/weekly", "/reports/quality", "/reports/multi-surface"]) {
    for (const capability of [undefined, "A".repeat(43)]) {
      const response = await fetch(`${app.origin}${path}`, {
        headers: { Origin: app.origin, "X-Usage-Monitor-Local": "1",
          ...(capability ? { [LOCAL_CAPABILITY_HEADER]: capability } : {}) },
      });
      assert.equal(response.status, 403, path);
      assert.equal((await response.json()).error.code, "local_caller_not_authorized");
    }
  }
  const denied = await fetch(`${app.origin}/api/local/contribution/device-disconnect`, {
    method: "POST", headers: { Origin: app.origin, "X-Usage-Monitor-Local": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: "disconnect_this_mac" }),
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(f.calls, before);
  const allowed = await fetch(`${app.origin}/api/local/overview`, { headers: app.localAuthorizationHeaders() });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).privateSynthetic, true);
  const restarted = await f.start();
  assert.equal((await fetch(`${restarted.origin}/api/local/overview`, { headers: app.localAuthorizationHeaders() })).status, 403);
});

test("actual loopback consumes a destructive operation once before concurrent side effects", async (t) => {
  const f = await fixture(t);
  const app = await f.start();
  const path = "/api/local/contribution/device-disconnect";
  const headers = { ...app.localAuthorizationHeaders(), Origin: app.origin,
    "Content-Type": "application/json", "X-Usage-Monitor-Local": "1" };
  const grant = await fetch(`${app.origin}/api/local/authorization`, {
    method: "POST", headers, body: JSON.stringify({ method: "POST", path }),
  });
  assert.equal(grant.status, 200);
  const { authorization } = await grant.json();
  const requests = Array.from({ length: 2 }, () => fetch(`${app.origin}${path}`, {
    method: "POST", headers: { ...headers, [LOCAL_OPERATION_HEADER]: authorization },
    body: JSON.stringify({ confirm: "disconnect_this_mac" }),
  }));
  const statuses = (await Promise.all(requests)).map((response) => response.status).sort();
  assert.deepEqual(statuses, [200, 403]);
  assert.equal(f.calls.disconnect, 1);
  assert.equal((await fetch(`${app.origin}${path}`, { method: "POST", headers,
    body: JSON.stringify({ confirm: "disconnect_this_mac" }) })).status, 403);
  assert.equal(f.calls.disconnect, 1);
});

test("standalone bootstrap is owner-private, bounded and removes only its own inode", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const auth = createLocalCallerAuthorization();
  const file = join(root, "private", "dashboard-access.json");
  const options = { stateRoot: root, origin: "http://127.0.0.1:12345", capability: auth.headers()[LOCAL_CAPABILITY_HEADER] };
  const first = await writeLocalAuthorizationBootstrap(options);
  const metadata = await lstat(file);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(metadata.nlink, 1);
  const payload = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(Object.keys(payload).sort(), ["capability", "expiresAt", "origin", "version"]);
  assert.ok(payload.expiresAt > Date.now());
  const replacement = await writeLocalAuthorizationBootstrap(options);
  await first.dispose();
  assert.equal((await lstat(file)).isFile(), true);
  await replacement.dispose();
  await assert.rejects(lstat(file), { code: "ENOENT" });
  await symlink(join(root, "synthetic-target"), file);
  await assert.rejects(writeLocalAuthorizationBootstrap(options), /local authorization bootstrap unavailable/u);
});

test("standalone browser file bootstrap and ordinary client use the actual authorization wire contract", async (t) => {
  const f = await fixture(t);
  const app = await f.start();
  const requests = [];
  const client = createLocalRequestClient({
    origin: app.origin,
    nativeAuthorization: () => false,
    fetchImpl: (input, options = {}) => {
      const url = new URL(input, app.origin);
      requests.push({ path: url.pathname, method: options.method ?? "GET" });
      const headers = new Headers(options.headers);
      headers.set("Origin", app.origin);
      return fetch(url, { ...options, headers });
    },
  });
  await assert.rejects(client.request("/api/local/overview"), { code: "local_caller_not_authorized" });
  assert.equal(requests.length, 0);
  const source = JSON.stringify({ version: 1, origin: app.origin,
    capability: app.localAuthorizationHeaders()[LOCAL_CAPABILITY_HEADER], expiresAt: Date.now() + 60_000 });
  await client.authorizeFile({ size: Buffer.byteLength(source), text: async () => source });
  assert.equal(client.needsAuthorization(), false);
  assert.equal((await client.request("/api/local/overview")).status, 200);
  await new LocalCompanionClient({ fetchImpl: client.request }).refresh();
  assert.deepEqual(requests.slice(-2), [
    { path: "/api/local/authorization", method: "POST" },
    { path: "/api/local/refresh/quick", method: "POST" },
  ]);
  const wrongOrigin = JSON.stringify({ version: 1, origin: "http://127.0.0.1:1",
    capability: app.localAuthorizationHeaders()[LOCAL_CAPABILITY_HEADER], expiresAt: Date.now() + 60_000 });
  await assert.rejects(client.authorizeFile({ size: Buffer.byteLength(wrongOrigin), text: async () => wrongOrigin }),
    { code: "local_caller_not_authorized" });
  assert.equal(client.needsAuthorization(), true);
});
