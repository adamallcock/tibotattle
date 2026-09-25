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
  input.headers = {
    host,
    ...(method === "POST" ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}),
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
      cookie: "__Host-usage-monitor-session=opaque",
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
  assert.equal(backendCall.options.headers.get("cookie"), "__Host-usage-monitor-session=opaque");
  assert.equal(backendCall.options.headers.get("x-usage-monitor-csrf"), "csrf-test-token");
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
      return new Response("{}", { status: 200 });
    },
    logger: () => {},
  });

  const wrongMethod = await invoke(handler, { method: "GET", url: "/api/v1/enroll", body: null });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "POST");
  const callbackMethod = await invoke(handler, { method: "POST", url: "/api/v1/identity/google/callback", body: "{}" });
  assert.equal(callbackMethod.status, 405);
  assert.equal(callbackMethod.headers.allow, "GET");
  for (const url of [
    "/api/v1/admin/action",
    "/api/v1/enroll?unexpected=1",
    "/api/v1/enroll?",
    "/api/v1/enroll/",
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
      return new Response("{}", { status: 200 });
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
        return new Response("x".repeat(64 * 1_024 + 1), { status: 201 });
      }
      return new Response("{}", { status: 200 });
    },
    logger: () => {},
  });
  const tooLargeDeclared = await invoke(handler, {
    url: "/api/v1/identity/google/result",
    headers: { "content-length": "9000" },
    body: "{}",
  });
  assert.equal(tooLargeDeclared.status, 413);
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
          "set-cookie": "__Host-usage-monitor-session=secret; Path=/; Secure; HttpOnly; SameSite=Strict",
        },
      });
    },
    logger: () => {},
  });
  const result = await invoke(handler, { url: "/api/v1/enroll", body: "{}" });
  assert.equal(result.status, 201);
  assert.deepEqual(result.headers["set-cookie"], [
    "__Host-usage-monitor-session=secret; Path=/; Secure; HttpOnly; SameSite=Strict",
  ]);
  assert.equal(result.headers["cache-control"], "no-store");
});
