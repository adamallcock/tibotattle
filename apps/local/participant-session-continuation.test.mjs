import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fetch as authorizedFetch,
  startLocalCompanionServer,
} from "../../test/helpers/local-authorized-client.js";

const SESSION = "__Host-usage_monitor_session=synthetic_enrollment_session";
const PERSISTED_SESSION = "__Host-usage_monitor_session=synthetic_persisted_session";
const SET_COOKIE = `${SESSION}; Path=/; Max-Age=1800; Secure; HttpOnly; SameSite=Strict`;
const ENROLL = "/api/v1/enroll";
const PAIR = "/api/v1/me/device-pairings";
const CONTINUATION = "X-TiboTattle-Enrollment-Continuation";

async function fixture(t, { upstreamResponse } = {}) {
  const root = await mkdtemp(join(tmpdir(), "relay-continuation-"));
  const resourceRoot = join(root, "resources");
  const stateRoot = join(root, "state");
  const codexHome = join(root, "synthetic-codex");
  const staticRoot = join(resourceRoot, "public");
  await mkdir(staticRoot, { recursive: true });
  await mkdir(join(codexHome, "sessions"), { recursive: true, mode: 0o700 });
  const forwarded = [];
  let app;
  t.after(async () => {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  });
  const options = {
    resourceRoot,
    stateRoot,
    codexHome,
    staticRoot,
    port: 0,
    dataStore: {
      async initialize() {},
      async reload() {},
      getOverview: () => ({ status: "unavailable" }),
    },
    refreshRunner: async () => ({}),
    centralOrigin: "http://127.0.0.1:8792",
    centralFetch: async (url, request) => {
      const path = new URL(url).pathname;
      forwarded.push({ path, ...request, headers: { ...request.headers } });
      const override = await upstreamResponse?.(path, request);
      if (override) return override;
      if (path === ENROLL) {
        return Response.json({ status: "enrolled" }, {
          status: 201,
          headers: { "Set-Cookie": SET_COOKIE },
        });
      }
      const authenticated = [SESSION, PERSISTED_SESSION].includes(request.headers.Cookie);
      return Response.json({ status: authenticated ? "ok" : "auth_required" }, {
        status: authenticated ? 200 : 401,
      });
    },
  };
  app = await startLocalCompanionServer(options);
  return {
    forwarded,
    get app() { return app; },
    get base() { return `http://127.0.0.1:${app.port}`; },
    async request(path, { method = "POST", headers = {}, body = "{}" } = {}) {
      const base = `http://127.0.0.1:${app.port}`;
      return authorizedFetch(`${base}${path}`, {
        method,
        headers: {
          ...(method === "GET" ? {} : { Origin: base, "Content-Type": "application/json" }),
          ...headers,
        },
        ...(method === "GET" ? {} : { body }),
      });
    },
    async enroll() {
      const response = await this.request(ENROLL);
      assert.equal(response.status, 201);
      assert.equal(response.headers.get("set-cookie"), SET_COOKIE);
      const continuation = response.headers.get(CONTINUATION);
      assert.match(continuation, /^[A-Za-z0-9_-]{43}$/u);
      return continuation;
    },
    async restart() {
      await app.close();
      app = await startLocalCompanionServer(options);
    },
  };
}

test("loopback enrollment gives no ambient session to probes and bridges one pairing", async (t) => {
  const relay = await fixture(t);
  const continuation = await relay.enroll();
  const count = relay.forwarded.length;
  const unauthenticated = await globalThis.fetch(`${relay.base}/api/v1/session`, {
    headers: {
      Origin: relay.base,
      "X-Usage-Monitor-Local": "1",
      [CONTINUATION]: continuation,
    },
  });
  assert.equal(unauthenticated.status, 403);
  assert.equal(relay.forwarded.length, count);
  assert.equal((await relay.request("/api/v1/session", { method: "GET" })).status, 401);
  assert.equal((await relay.request(PAIR)).status, 401);
  assert.equal((await relay.request(PAIR, { headers: { [CONTINUATION]: continuation } })).status, 200);
  assert.equal(relay.forwarded.at(-1).headers.Cookie, SESSION);
  assert.equal(Object.hasOwn(relay.forwarded.at(-1).headers, CONTINUATION), false);
  assert.equal((await relay.request(PAIR, { headers: { [CONTINUATION]: continuation } })).status, 401);
  assert.equal((await relay.request("/api/v1/session", {
    method: "GET", headers: { Cookie: PERSISTED_SESSION },
  })).status, 200);
});

test("loopback continuation never overrides a different jar or authorizes other routes", async (t) => {
  const relay = await fixture(t);
  let continuation = await relay.enroll();
  const differentJar = "__Host-usage_monitor_session=synthetic_other_session";
  assert.equal((await relay.request(PAIR, {
    headers: { [CONTINUATION]: continuation, Cookie: differentJar },
  })).status, 401);
  assert.equal(relay.forwarded.at(-1).headers.Cookie, differentJar);
  assert.equal((await relay.request(PAIR, { headers: { [CONTINUATION]: continuation } })).status, 401);
  for (const path of ["/api/v1/session", "/api/v1/me/device-telemetry-consents", "/api/v1/logout"]) {
    continuation = await relay.enroll();
    assert.equal((await relay.request(path, {
      method: path.endsWith("/session") ? "GET" : "POST",
      headers: { [CONTINUATION]: continuation },
    })).status, 401);
    assert.equal(relay.forwarded.at(-1).headers.Cookie, undefined);
    assert.equal((await relay.request(PAIR, { headers: { [CONTINUATION]: continuation } })).status, 401);
  }
});

test("loopback continuation is consumed before failure and concurrent pairing requests", async (t) => {
  let failPairing = true;
  const relay = await fixture(t, {
    upstreamResponse: (path, request) => {
      if (path === PAIR && request.headers.Cookie === SESSION && failPairing) {
        failPairing = false;
        throw new Error("synthetic_unavailable");
      }
    },
  });
  let continuation = await relay.enroll();
  assert.equal((await relay.request(PAIR, { headers: { [CONTINUATION]: continuation } })).status, 502);
  assert.equal((await relay.request(PAIR, { headers: { [CONTINUATION]: continuation } })).status, 401);
  continuation = await relay.enroll();
  assert.equal((await relay.request(PAIR, {
    headers: { [CONTINUATION]: continuation, "Content-Type": "text/plain" },
  })).status, 415);
  assert.equal((await relay.request(PAIR, { headers: { [CONTINUATION]: continuation } })).status, 401);
  continuation = await relay.enroll();
  const statuses = await Promise.all(Array.from({ length: 4 }, async () =>
    (await relay.request(PAIR, { headers: { [CONTINUATION]: continuation } })).status));
  assert.deepEqual(statuses.sort(), [200, 401, 401, 401]);
});

test("failed enrollment cannot mint fallback and restart preserves only the persisted cookie", async (t) => {
  let failEnrollment = false;
  const relay = await fixture(t, {
    upstreamResponse: (path) => path === ENROLL && failEnrollment
      ? Response.json({ status: "denied" }, { status: 401, headers: { "Set-Cookie": SET_COOKIE } })
      : null,
  });
  const continuation = await relay.enroll();
  failEnrollment = true;
  const failed = await relay.request(ENROLL);
  assert.equal(failed.status, 401);
  assert.equal(failed.headers.get(CONTINUATION), null);
  assert.equal((await relay.request(PAIR, { headers: { [CONTINUATION]: continuation } })).status, 401);
  failEnrollment = false;
  const beforeRestart = await relay.enroll();
  await relay.restart();
  assert.equal((await relay.request(PAIR, { headers: { [CONTINUATION]: beforeRestart } })).status, 401);
  assert.equal((await relay.request(PAIR, { headers: { Cookie: PERSISTED_SESSION } })).status, 200);
});
