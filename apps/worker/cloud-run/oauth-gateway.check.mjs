import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import {
  createOauthGatewayConfiguration,
  createOauthGatewayHandler,
} from "./oauth-gateway.mjs";

const PUBLIC_ORIGIN = "https://tibotattle-gateway-test.example";
const BACKEND_ORIGIN = "https://tibotattle-test-app-5t5mehqi7a-ue.a.run.app";
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJ0ZXN0In0.signature";

class MemoryResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = null;
    this.body = null;
    this.writableEnded = false;
  }

  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers;
  }

  end(body = Buffer.alloc(0)) {
    this.body = Buffer.from(body);
    this.writableEnded = true;
  }
}

function configuration(overrides = {}) {
  return createOauthGatewayConfiguration({
    OAUTH_GATEWAY_MODE: "test-only",
    OAUTH_GATEWAY_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    OAUTH_GATEWAY_BACKEND_ORIGIN: BACKEND_ORIGIN,
    OAUTH_GATEWAY_BACKEND_AUDIENCE: BACKEND_ORIGIN,
    ...overrides,
  });
}

function request({
  method = "POST",
  url = "/api/v1/identity/google/start",
  host = new URL(PUBLIC_ORIGIN).host,
  headers = {},
  body = "{}",
} = {}) {
  const input = Readable.from(body === null ? [] : [Buffer.from(body)]);
  input.method = method;
  input.url = url;
  const bodyHeaders = method === "POST" && body !== null
    ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }
    : {};
  input.headers = {
    host,
    ...bodyHeaders,
    origin: PUBLIC_ORIGIN,
    ...headers,
  };
  return input;
}

function metadataResponse(token = TOKEN) {
  return new Response(token, { status: 200 });
}

async function invoke(handler, options = {}) {
  const response = new MemoryResponse();
  await handler(request(options), response);
  return {
    status: response.statusCode,
    headers: response.headers,
    body: response.body,
    json: () => JSON.parse(response.body.toString("utf8")),
  };
}

function metadataFetch() {
  const calls = [];
  const fetchImpl = async (input, options) => {
    calls.push({ url: new URL(input).href, options });
    assert.equal(new URL(input).origin, "http://metadata.google.internal");
    assert.equal(options.headers["metadata-flavor"], "Google");
    assert.equal(options.redirect, "error");
    return metadataResponse();
  };
  return { calls, fetchImpl };
}

test("test-only gateway pins public origin, private backend, and token audience", () => {
  const config = configuration();
  assert.equal(config.publicOrigin, PUBLIC_ORIGIN);
  assert.equal(config.backendOrigin, BACKEND_ORIGIN);
  assert.equal(config.backendAudience, BACKEND_ORIGIN);
  assert.throws(() => configuration({ OAUTH_GATEWAY_MODE: "production" }), /OAUTH_GATEWAY_MODE_INVALID/);
  assert.throws(() => configuration({ OAUTH_GATEWAY_BACKEND_ORIGIN: "https://example.invalid" }), /OAUTH_GATEWAY_ORIGIN_INVALID/);
  assert.throws(() => configuration({ OAUTH_GATEWAY_BACKEND_AUDIENCE: "https://example.invalid" }), /OAUTH_GATEWAY_AUDIENCE_INVALID/);
  assert.throws(() => configuration({ OAUTH_GATEWAY_PUBLIC_ORIGIN: "http://tibotattle.example" }), /OAUTH_GATEWAY_PUBLIC_ORIGIN_INVALID/);
});

test("Google start forwards only the allowlisted request and separates serverless from application authorization", async () => {
  const { calls, fetchImpl: metadata } = metadataFetch();
  let backendCall;
  const fetchImpl = async (input, options) => {
    if (new URL(input).origin === "http://metadata.google.internal") return metadata(input, options);
    backendCall = { url: new URL(input).href, options };
    return new Response(JSON.stringify({ schemaVersion: "identity-google-start-v0.1" }), {
      status: 200,
      headers: { "content-type": "application/json", "x-forwarded-host": "spoofed.invalid" },
    });
  };
  const logs = [];
  const handler = createOauthGatewayHandler({ configuration: configuration(), fetchImpl, logger: (line) => logs.push(line) });
  const result = await invoke(handler, {
    headers: {
      authorization: "Bearer application-session-token",
      cookie: "__Host-usage_monitor_session=opaque",
      "x-usage-monitor-csrf": "csrf-test-token",
      "x-serverless-authorization": "Bearer caller-forgery",
      "x-forwarded-host": "spoofed.invalid",
      "x-forwarded-proto": "http",
      forwarded: "host=spoofed.invalid;proto=http",
      "cf-connecting-ip": "203.0.113.1",
      "cf-access-jwt-assertion": "caller-forgery",
    },
    body: JSON.stringify({ binding: "a".repeat(64) }),
  });

  assert.equal(result.status, 200);
  assert.equal(new URL(backendCall.url).origin, BACKEND_ORIGIN);
  assert.equal(new URL(backendCall.url).pathname, "/api/v1/identity/google/start");
  assert.equal(backendCall.options.redirect, "manual");
  assert.equal(backendCall.options.headers.get("origin"), PUBLIC_ORIGIN);
  assert.equal(backendCall.options.headers.get("authorization"), "Bearer application-session-token");
  assert.equal(backendCall.options.headers.get("x-serverless-authorization"), `Bearer ${TOKEN}`);
  assert.equal(backendCall.options.headers.has("cookie"), false);
  assert.equal(backendCall.options.headers.has("x-usage-monitor-csrf"), false);
  for (const header of [
    "x-forwarded-host", "x-forwarded-proto", "forwarded", "cf-connecting-ip",
    "cf-access-jwt-assertion",
  ]) assert.equal(backendCall.options.headers.has(header), false, header);
  assert.equal(backendCall.options.headers.get("x-serverless-authorization"), `Bearer ${TOKEN}`);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).searchParams.get("audience"), BACKEND_ORIGIN);
  assert.equal(calls[0].options.headers["metadata-flavor"], "Google");
  assert.equal(backendCall.options.signal.aborted, false);
  assert.deepEqual(JSON.parse(logs[0]), {
    event: "oauth_gateway_request", route: "google_start", method: "POST", status: 200,
    durationMs: JSON.parse(logs[0]).durationMs,
  });
});

test("the companion health, enrollment, session, and pairing journey uses exact supported routes", async () => {
  const routes = [
    { path: "/api/health", method: "GET", body: null, contentType: "application/json" },
    { path: "/api/v1/identity/google/start", method: "POST", body: "{}", contentType: "application/json" },
    { path: "/api/v1/identity/google/callback?state=opaque&code=opaque", method: "GET", body: null, contentType: "text/html" },
    { path: "/api/v1/identity/google/result", method: "POST", body: "{}", contentType: "application/json" },
    { path: "/api/v1/enroll", method: "POST", body: "{}", contentType: "application/json" },
    { path: "/api/v1/session", method: "GET", body: null, contentType: "application/json" },
    { path: "/api/v1/logout", method: "POST", body: null, contentType: "application/json" },
    {
      path: "/api/v1/me/device-pairings", method: "POST",
      body: JSON.stringify({ consentVersion: "ongoing-privacy-safe-telemetry-v1.0", ongoingUpload: true }),
      contentType: "application/json", status: 201,
    },
    {
      path: "/api/v1/device-pairings/claim", method: "POST",
      body: JSON.stringify({
        deviceId: "d81c0f3b-9d3e-4dc8-b367-9709e3f3fe9c",
        deviceSecretHash: "a".repeat(64),
      }),
      contentType: "application/json", status: 201,
      headers: {
        authorization: `Pairing um_pair_f50be1d0-5233-4e02-8f34-f7336d837d20.${"a".repeat(43)}`,
        "x-previous-device-authorization": `Device um_device_d81c0f3b-9d3e-4dc8-b367-9709e3f3fe9c.${"b".repeat(43)}`,
        "x-forwarded-host": "spoofed.invalid",
      },
    },
  ];
  const { fetchImpl: metadata } = metadataFetch();
  const backendCalls = [];
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input, options) => {
      if (new URL(input).origin === "http://metadata.google.internal") return metadata(input, options);
      backendCalls.push({ url: new URL(input), options });
      return new Response(
        options.headers.get("accept") === "text/html" ? "<html>complete</html>" : "{}",
        {
          status: ["/api/v1/me/device-pairings", "/api/v1/device-pairings/claim"]
            .includes(new URL(input).pathname) ? 201 : 200,
          headers: { "content-type": `${options.headers.get("accept")}; charset=utf-8` },
        },
      );
    },
    logger: () => {},
  });

  for (const route of routes) {
    const result = await invoke(handler, {
      method: route.method,
      url: route.path,
      body: route.body,
      headers: {
        ...(route.path === "/api/v1/device-pairings/claim" ? {} : {
          cookie: "__Host-usage_monitor_session=opaque",
          authorization: "Bearer caller-forgery",
          "x-usage-monitor-csrf": "csrf-test-token",
        }),
        ...route.headers,
      },
    });
    assert.equal(result.status, route.status ?? 200,
      `${route.path}: ${result.body.toString("utf8").slice(0, 200)}`);
  }
  assert.equal(backendCalls.length, routes.length);
  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index];
    const { url, options } = backendCalls[index];
    assert.equal(url.origin, BACKEND_ORIGIN);
    assert.equal(url.pathname, new URL(route.path, PUBLIC_ORIGIN).pathname);
    assert.equal(url.search, "");
    assert.equal(options.headers.get("accept"), route.contentType);
    const sessionRoute = route.path === "/api/v1/session"
      || route.path === "/api/v1/logout" || route.path === "/api/v1/me/device-pairings";
    assert.equal(options.headers.get("cookie"),
      sessionRoute
        ? "__Host-usage_monitor_session=opaque" : null);
    assert.equal(options.headers.has("authorization"), !sessionRoute && route.path !== "/api/health");
    if (route.path === "/api/v1/device-pairings/claim") {
      assert.equal(options.headers.get("authorization"), route.headers.authorization);
      assert.equal(options.headers.get("x-previous-device-authorization"), route.headers["x-previous-device-authorization"]);
      assert.equal(options.headers.has("cookie"), false);
      assert.equal(options.headers.has("x-usage-monitor-csrf"), false);
      assert.equal(options.headers.has("x-forwarded-host"), false);
    }
    assert.equal(options.headers.get("x-serverless-authorization"), `Bearer ${TOKEN}`);
    if (route.method === "POST" && (route.path.endsWith("/logout")
        || route.path === "/api/v1/me/device-pairings"
        || route.path === "/api/v1/device-pairings/claim")) {
      assert.equal(options.headers.get("origin"), BACKEND_ORIGIN);
      if (route.path !== "/api/v1/device-pairings/claim") {
        assert.equal(options.headers.get("x-usage-monitor-csrf"), "csrf-test-token");
      }
      if (route.path.endsWith("/logout")) {
        assert.equal(options.headers.has("content-type"), false);
        assert.equal(options.body, undefined);
      } else {
        assert.equal(options.headers.get("content-type"), "application/json");
        assert.equal(options.body.toString("utf8"), route.body);
        assert.ok(Buffer.byteLength(options.body) <= 4_096);
      }
    } else if (route.method === "POST") {
      assert.equal(options.headers.get("origin"), PUBLIC_ORIGIN);
      assert.equal(options.headers.get("content-type"), "application/json");
      assert.ok(Buffer.byteLength(options.body) <= 16_384);
      assert.equal(options.headers.has("x-usage-monitor-csrf"), false);
    } else {
      assert.equal(options.headers.has("origin"), false);
      assert.equal(options.headers.has("content-type"), false);
      assert.equal(options.body, undefined);
    }
  }
  assert.equal(backendCalls[2].options.headers.get("x-tibotattle-google-callback-query"), "?state=opaque&code=opaque");
  assert.equal(backendCalls[2].url.search, "", "callback query stays out of the private URL");
});

test("desktop pairing claim permits a missing Node Origin but still requires the pairing credential", async () => {
  let backendCall;
  const { fetchImpl: metadata } = metadataFetch();
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input, options) => {
      if (new URL(input).origin === "http://metadata.google.internal") return metadata(input, options);
      backendCall = { url: new URL(input), options };
      return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
    },
    logger: () => {},
  });
  const url = "/api/v1/device-pairings/claim";
  const body = JSON.stringify({
    deviceId: "d81c0f3b-9d3e-4dc8-b367-9709e3f3fe9c",
    deviceSecretHash: "a".repeat(64),
  });
  const authorization = `Pairing um_pair_f50be1d0-5233-4e02-8f34-f7336d837d20.${"a".repeat(43)}`;
  const desktop = await invoke(handler, {
    url,
    body,
    headers: { origin: undefined, authorization },
  });
  assert.equal(desktop.status, 201);
  assert.equal(backendCall.url.origin, BACKEND_ORIGIN);
  assert.equal(backendCall.options.headers.get("origin"), BACKEND_ORIGIN);
  assert.equal(backendCall.options.headers.get("authorization"), authorization);
  assert.equal(backendCall.options.headers.has("cookie"), false);

  const missingCredential = await invoke(handler, { url, body, headers: { origin: undefined } });
  assert.equal(missingCredential.status, 401);
  assert.equal(missingCredential.json().error.code, "PAIRING_AUTH_INVALID");
});

test("device pairing claim rejects cookies and oversized continuity credentials before private forwarding", async () => {
  let backendCount = 0;
  const { fetchImpl: metadata } = metadataFetch();
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input, options) => {
      if (new URL(input).origin === "http://metadata.google.internal") return metadata(input, options);
      backendCount += 1;
      return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
    },
    logger: () => {},
  });
  const base = {
    url: "/api/v1/device-pairings/claim",
    body: JSON.stringify({ deviceId: "d81c0f3b-9d3e-4dc8-b367-9709e3f3fe9c", deviceSecretHash: "a".repeat(64) }),
    headers: { authorization: `Pairing um_pair_f50be1d0-5233-4e02-8f34-f7336d837d20.${"a".repeat(43)}` },
  };
  const cookie = await invoke(handler, {
    ...base,
    headers: { ...base.headers, cookie: "__Host-usage_monitor_session=opaque" },
  });
  assert.equal(cookie.status, 401);
  assert.equal(cookie.json().error.code, "PAIRING_AUTH_INVALID");
  const oversizedContinuity = await invoke(handler, {
    ...base,
    headers: { ...base.headers, "x-previous-device-authorization": "x".repeat(257) },
  });
  assert.equal(oversizedContinuity.status, 400);
  assert.equal(oversizedContinuity.json().error.code, "PREVIOUS_DEVICE_AUTHORIZATION_INVALID");
  assert.equal(backendCount, 0);
});

test("Google callback stays on the configured public callback origin and query material stays out of logs", async () => {
  const { fetchImpl: metadata } = metadataFetch();
  let backendUrl;
  let backendHeaders;
  const logs = [];
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    logger: (line) => logs.push(line),
    fetchImpl: async (input, options) => {
      if (new URL(input).origin === "http://metadata.google.internal") return metadata(input, options);
      backendUrl = new URL(input).href;
      backendHeaders = options.headers;
      return new Response("<html>safe callback</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'" },
      });
    },
  });
  const privateQuery = "state=secret-state&code=secret-code";
  const result = await invoke(handler, {
    method: "GET",
    url: `/api/v1/identity/google/callback?${privateQuery}`,
    body: null,
    headers: { origin: undefined },
  });
  assert.equal(result.status, 200);
  assert.equal(backendUrl, `${BACKEND_ORIGIN}/api/v1/identity/google/callback`);
  assert.equal(backendHeaders.get("x-tibotattle-google-callback-query"), `?${privateQuery}`);
  assert.equal(backendHeaders.has("origin"), false);
  assert.equal(result.headers["content-security-policy"], "default-src 'none'");
  assert.equal(logs[0].includes("secret-state"), false);
  assert.equal(logs[0].includes("secret-code"), false);
  assert.match(logs[0], /"route":"google_callback"/u);
});

test("wrong methods, extra paths, and query parameters on POST routes never reach the backend", async () => {
  let fetchCount = 0;
  const { fetchImpl: metadata } = metadataFetch();
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input, options) => {
      if (new URL(input).origin === "http://metadata.google.internal") return metadata(input, options);
      fetchCount += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
    logger: () => {},
  });

  const wrongMethod = await invoke(handler, { method: "GET", url: "/api/v1/enroll", body: null });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "POST");
  const callbackMethod = await invoke(handler, { method: "POST", url: "/api/v1/identity/google/callback", body: "{}" });
  assert.equal(callbackMethod.status, 405);
  for (const [path, method] of [
    ["/api/health", "GET"],
    ["/api/v1/session", "GET"],
    ["/api/v1/logout", "POST"],
    ["/api/v1/me/device-pairings", "POST"],
    ["/api/v1/device-pairings/claim", "POST"],
  ]) {
    const wrong = await invoke(handler, {
      method: method === "GET" ? "POST" : "GET",
      url: path,
      body: method === "GET" ? "{}" : null,
    });
    assert.equal(wrong.status, 405, path);
    assert.equal(wrong.headers.allow, method, path);
  }
  assert.equal(callbackMethod.headers.allow, "GET");
  for (const url of [
    "/api/v1/me/device-telemetry-consents",
    "/api/v1/admin/action",
    "/api/v1/enroll?unexpected=1",
    "/api/v1/enroll?",
    "/api/v1/enroll/",
    "/api/v1/device-pairings/claim?unexpected=1",
    "/api/v1/device-pairings/claim/",
    "/api/v1/extra/../enroll",
    "/api/v1/%2e%2e/enroll",
  ]) {
    const result = await invoke(handler, { url, body: "{}" });
    assert.equal(result.status, 404);
  }
  assert.equal(fetchCount, 0);
});

test("spoofed origins and authorities are rejected while forwarded security headers are ignored", async () => {
  let backendCount = 0;
  const { fetchImpl: metadata } = metadataFetch();
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input, options) => {
      if (new URL(input).origin === "http://metadata.google.internal") return metadata(input, options);
      backendCount += 1;
      assert.equal(options.headers.has("x-forwarded-host"), false);
      assert.equal(options.headers.has("x-serverless-authorization"), true);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
    logger: () => {},
  });
  const spoofedOrigin = await invoke(handler, { headers: { origin: "https://attacker.example" } });
  assert.equal(spoofedOrigin.status, 403);
  const callbackSpoofedOrigin = await invoke(handler, {
    method: "GET", url: "/api/v1/identity/google/callback?state=x&code=y", body: null,
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(callbackSpoofedOrigin.status, 403);
  const claimSpoofedOrigin = await invoke(handler, {
    url: "/api/v1/device-pairings/claim",
    body: JSON.stringify({ deviceId: "d81c0f3b-9d3e-4dc8-b367-9709e3f3fe9c", deviceSecretHash: "a".repeat(64) }),
    headers: {
      origin: "https://attacker.example",
      authorization: `Pairing um_pair_f50be1d0-5233-4e02-8f34-f7336d837d20.${"a".repeat(43)}`,
    },
  });
  assert.equal(claimSpoofedOrigin.status, 403);
  const spoofedHost = await invoke(handler, { host: "attacker.example" });
  assert.equal(spoofedHost.status, 421);
  const ignoredSpoofedForwarding = await invoke(handler, {
    headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http", forwarded: "host=attacker.example" },
  });
  assert.equal(ignoredSpoofedForwarding.status, 200);
  assert.equal(backendCount, 1);
});

test("request and response bodies, unsupported content, and upstream redirects stay bounded", async () => {
  let backendCount = 0;
  const { fetchImpl: metadata } = metadataFetch();
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input, options) => {
      if (new URL(input).origin === "http://metadata.google.internal") return metadata(input, options);
      backendCount += 1;
      if (new URL(input).pathname.endsWith("/result")) {
        return new Response("", { status: 302, headers: { location: "https://attacker.example" } });
      }
      if (new URL(input).pathname.endsWith("/enroll")) {
        return new Response("x".repeat(64 * 1_024 + 1), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
    logger: () => {},
  });
  const tooLargeDeclared = await invoke(handler, {
    url: "/api/v1/identity/google/result",
    headers: { "content-length": "9000" },
    body: "{}",
  });
  assert.equal(tooLargeDeclared.status, 413);
  const tooLargePairing = await invoke(handler, {
    url: "/api/v1/me/device-pairings",
    headers: { "content-length": "4097" },
    body: "{}",
  });
  assert.equal(tooLargePairing.status, 413);
  const tooLargeClaim = await invoke(handler, {
    url: "/api/v1/device-pairings/claim",
    headers: {
      "content-length": "4097",
      authorization: `Pairing um_pair_f50be1d0-5233-4e02-8f34-f7336d837d20.${"a".repeat(43)}`,
    },
    body: "{}",
  });
  assert.equal(tooLargeClaim.status, 413);
  const wrongContentType = await invoke(handler, {
    headers: { "content-type": "text/plain" }, body: "{}",
  });
  assert.equal(wrongContentType.status, 415);
  const redirect = await invoke(handler, { url: "/api/v1/identity/google/result", body: "{}" });
  assert.equal(redirect.status, 502);
  assert.equal(redirect.json().error.code, "UPSTREAM_UNAVAILABLE");
  const tooLargeResponse = await invoke(handler, { url: "/api/v1/enroll", body: "{}" });
  assert.equal(tooLargeResponse.status, 502);
  assert.equal(tooLargeResponse.json().error.code, "UPSTREAM_UNAVAILABLE");
  assert.equal(backendCount, 2);
});

test("route-specific response bounds and media types fail closed", async () => {
  const { fetchImpl: metadata } = metadataFetch();
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input, options) => {
      if (new URL(input).origin === "http://metadata.google.internal") return metadata(input, options);
      if (new URL(input).pathname === "/api/v1/session"
          || new URL(input).pathname === "/api/v1/me/device-pairings"
          || new URL(input).pathname === "/api/v1/device-pairings/claim") {
        return new Response("x".repeat(8 * 1_024 + 1), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "text/plain" } });
    },
    logger: () => {},
  });
  const oversizedSession = await invoke(handler, {
    method: "GET", url: "/api/v1/session", body: null,
  });
  assert.equal(oversizedSession.status, 502);
  assert.equal(oversizedSession.json().error.code, "UPSTREAM_UNAVAILABLE");
  const oversizedPairing = await invoke(handler, {
    method: "POST",
    url: "/api/v1/me/device-pairings",
    body: JSON.stringify({ consentVersion: "ongoing-privacy-safe-telemetry-v1.0", ongoingUpload: true }),
    headers: {
      cookie: "__Host-usage_monitor_session=opaque",
      "x-usage-monitor-csrf": "csrf-test-token",
    },
  });
  assert.equal(oversizedPairing.status, 502);
  assert.equal(oversizedPairing.json().error.code, "UPSTREAM_UNAVAILABLE");
  const oversizedClaim = await invoke(handler, {
    url: "/api/v1/device-pairings/claim",
    body: JSON.stringify({ deviceId: "d81c0f3b-9d3e-4dc8-b367-9709e3f3fe9c", deviceSecretHash: "a".repeat(64) }),
    headers: {
      authorization: `Pairing um_pair_f50be1d0-5233-4e02-8f34-f7336d837d20.${"a".repeat(43)}`,
    },
  });
  assert.equal(oversizedClaim.status, 502);
  assert.equal(oversizedClaim.json().error.code, "UPSTREAM_UNAVAILABLE");
  const wrongMediaType = await invoke(handler, { url: "/api/v1/enroll", body: "{}" });
  assert.equal(wrongMediaType.status, 502);
  assert.equal(wrongMediaType.json().error.code, "UPSTREAM_UNAVAILABLE");
});

test("bodyless logout rejects an unexpected body and GET routes reject foreign Origins", async () => {
  let backendCount = 0;
  const { fetchImpl: metadata } = metadataFetch();
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input, options) => {
      if (new URL(input).origin === "http://metadata.google.internal") return metadata(input, options);
      backendCount += 1;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    logger: () => {},
  });
  const logoutBody = await invoke(handler, {
    method: "POST", url: "/api/v1/logout", body: "{}",
  });
  assert.equal(logoutBody.status, 413);
  const foreignSessionOrigin = await invoke(handler, {
    method: "GET",
    url: "/api/v1/session",
    body: null,
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(foreignSessionOrigin.status, 403);
  const foreignPairingOrigin = await invoke(handler, {
    url: "/api/v1/me/device-pairings",
    body: JSON.stringify({ consentVersion: "ongoing-privacy-safe-telemetry-v1.0", ongoingUpload: true }),
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(foreignPairingOrigin.status, 403);
  assert.equal(backendCount, 0);
});

test("session routes forward only the exact host-only session cookie", async () => {
  let backendCount = 0;
  const { fetchImpl: metadata } = metadataFetch();
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input, options) => {
      if (new URL(input).origin === "http://metadata.google.internal") return metadata(input, options);
      backendCount += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
    logger: () => {},
  });
  const malformed = await invoke(handler, {
    method: "GET",
    url: "/api/v1/session",
    body: null,
    headers: { cookie: "__Host-usage-monitor-session=opaque" },
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json().error.code, "COOKIE_INVALID");
  assert.equal(backendCount, 0);
});

test("backend response cookies retain host-only session attributes", async () => {
  const { fetchImpl: metadata } = metadataFetch();
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input, options) => {
      if (new URL(input).origin === "http://metadata.google.internal") return metadata(input, options);
      return new Response(JSON.stringify({ enrolled: true }), {
        status: 201,
        headers: {
          "content-type": "application/json",
          "set-cookie": "__Host-usage_monitor_session=secret; Path=/; Secure; HttpOnly; SameSite=Strict",
        },
      });
    },
    logger: () => {},
  });
  const result = await invoke(handler, { url: "/api/v1/enroll", body: "{}" });
  assert.equal(result.status, 201);
  assert.deepEqual(result.headers["set-cookie"], [
    "__Host-usage_monitor_session=secret; Path=/; Secure; HttpOnly; SameSite=Strict",
  ]);
  assert.equal(result.headers["cache-control"], "no-store");
});
