import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createFilesystemAssets } from "./assets.mjs";
import {
  createOauthGatewayConfiguration,
  createOauthGatewayHandler,
  createOauthGatewayServer,
} from "./oauth-gateway.mjs";

const PUBLIC_ORIGIN = "https://tibotattle-gateway-test.example";
const BACKEND_ORIGIN = "https://tibotattle-test-app-5t5mehqi7a-ue.a.run.app";
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJ0ZXN0In0.signature";
const DEVICE_ID = "d81c0f3b-9d3e-4dc8-b367-9709e3f3fe9c";
const DEVICE_AUTHORIZATION = `Device um_device_${DEVICE_ID}.${"d".repeat(43)}`;
const UPLOAD_AUTHORIZATION = `Upload um_device_upload_${DEVICE_ID}.${"u".repeat(43)}`;
const SESSION_COOKIE = "__Host-usage_monitor_session=opaque";
const V12_CONSENT = Object.freeze({
  telemetrySchemaVersion: "telemetry-contribution-v1.2",
  fieldDictionaryVersion: "telemetry-v1.2-registry-2026-09-20.1",
  privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.2",
});

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

  end(body = Buffer.alloc(0), callback) {
    this.body = Buffer.from(body);
    this.writableEnded = true;
    callback?.();
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
  stream = null,
} = {}) {
  const input = stream ?? Readable.from(body === null ? [] : [Buffer.from(body)]);
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

test("the v1.2 desktop edge forwards only its exact routes and never logs credentials or payloads", async () => {
  const routes = [
    { path: "/api/v1/device/sync/state", method: "GET", body: null, authorization: DEVICE_AUTHORIZATION },
    { path: "/api/v1/device/sync-capabilities-v1.2", method: "GET", body: null, authorization: DEVICE_AUTHORIZATION },
    { path: "/api/v1/me/telemetry-v12/domain-predecessor", method: "POST", body: "{}", authorization: DEVICE_AUTHORIZATION },
    {
      path: "/api/v1/device/telemetry/v1.2/day-manifests", method: "POST",
      body: JSON.stringify({ schemaVersion: "telemetry-day-manifest-v1.2", day: "2026-09-25", privateMarker: "manifest-payload-secret" }),
      authorization: DEVICE_AUTHORIZATION,
    },
    {
      path: "/api/v1/device/upload-authorizations", method: "POST",
      body: JSON.stringify({ envelopeDigest: "a".repeat(64), contentLengthBytes: 42, contentType: "application/json", telemetrySchemaVersion: "telemetry-contribution-v1.2" }),
      authorization: DEVICE_AUTHORIZATION,
    },
    {
      path: "/api/v1/contributions", method: "POST",
      body: JSON.stringify({ schemaVersion: "telemetry-envelope-v1.2", ciphertext: "synthetic-ciphertext" }),
      authorization: UPLOAD_AUTHORIZATION,
    },
    {
      path: "/api/v1/me/telemetry-v12/domain-activate", method: "POST",
      body: JSON.stringify({ schemaVersion: "telemetry-domain-manifest-v1.2", privateMarker: "activation-payload-secret" }),
      authorization: DEVICE_AUTHORIZATION,
    },
    {
      path: "/api/v1/device/credential/renew", method: "POST",
      body: JSON.stringify({ nextDeviceSecretHash: "b".repeat(64), rotationAttemptId: "4f50c4ce-13db-4ab3-84f0-f262b599f65a" }),
      authorization: DEVICE_AUTHORIZATION,
    },
    {
      path: "/api/v1/me/device-telemetry-v12-consents", method: "POST",
      body: JSON.stringify({ deviceId: DEVICE_ID, consent: V12_CONSENT, ongoingUpload: true }),
      authorization: undefined,
      session: true,
    },
  ];
  const { calls: metadataCalls, fetchImpl: metadata } = metadataFetch();
  const backendCalls = [];
  const logs = [];
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input, options) => {
      if (new URL(input).origin === "http://metadata.google.internal") return metadata(input, options);
      backendCalls.push({ url: new URL(input), options });
      const status = new URL(input).pathname === "/api/v1/me/device-telemetry-v12-consents" ? 201 : 200;
      return new Response("{}", { status, headers: { "content-type": "application/json" } });
    },
    logger: (line) => logs.push(line),
  });

  for (const route of routes) {
    const result = await invoke(handler, {
      method: route.method,
      url: route.path,
      body: route.body,
      headers: {
        origin: route.session ? PUBLIC_ORIGIN : undefined,
        ...(route.authorization === undefined ? {} : { authorization: route.authorization }),
        ...(route.session ? {
          cookie: SESSION_COOKIE,
          "x-usage-monitor-csrf": "csrf-v12-consent",
          "sec-fetch-site": "same-origin",
        } : {}),
        "x-serverless-authorization": "Bearer caller-controlled",
        "x-forwarded-host": "attacker.invalid",
        "cf-connecting-ip": "203.0.113.9",
      },
    });
    assert.equal(result.status, route.session ? 201 : 200, route.path);
  }

  assert.equal(backendCalls.length, routes.length);
  assert.equal(metadataCalls.length, routes.length);
  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index];
    const { url, options } = backendCalls[index];
    assert.equal(url.origin, BACKEND_ORIGIN);
    assert.equal(url.pathname, route.path);
    assert.equal(url.search, "");
    assert.equal(options.method, route.method);
    assert.equal(options.headers.get("x-serverless-authorization"), `Bearer ${TOKEN}`);
    assert.equal(options.headers.get("authorization"), route.authorization ?? null);
    assert.equal(options.headers.get("origin"), route.method === "POST" ? BACKEND_ORIGIN : null);
    assert.equal(options.headers.get("cookie"), route.session ? SESSION_COOKIE : null);
    assert.equal(options.headers.get("x-usage-monitor-csrf"), route.session ? "csrf-v12-consent" : null);
    assert.equal(options.headers.get("sec-fetch-site"), route.session ? "same-origin" : null);
    assert.equal(options.headers.has("x-forwarded-host"), false);
    assert.equal(options.headers.has("cf-connecting-ip"), false);
    if (route.body === null) {
      assert.equal(options.body, undefined);
    } else {
      assert.equal(options.headers.get("content-type"), "application/json");
      assert.equal(options.body.toString("utf8"), route.body);
    }
  }
  const serializedLogs = logs.join("\n");
  for (const secret of [DEVICE_AUTHORIZATION, UPLOAD_AUTHORIZATION, DEVICE_ID,
    "manifest-payload-secret", "activation-payload-secret", "csrf-v12-consent"]) {
    assert.equal(serializedLogs.includes(secret), false, `log leaked ${secret}`);
  }
  assert.match(serializedLogs, /"route":"contribution_upload"/u);
  assert.match(serializedLogs, /"route":"telemetry_v12_consent"/u);
});

test("the public gateway exposes only the authenticated sync and v1.2 manifest GETs", async () => {
  const routes = [
    {
      path: "/api/v1/device/sync/manifest?fromDay=2026-09-01&toDay=2026-09-02",
      body: null,
    },
    {
      path: "/api/v1/device/telemetry/v1.2/day-manifests?fromDay=2026-09-01&toDay=2026-09-02",
      body: null,
    },
  ];
  const { calls: metadataCalls, fetchImpl: metadata } = metadataFetch();
  const backendCalls = [];
  const logs = [];
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input, options) => {
      if (new URL(input).origin === "http://metadata.google.internal") return metadata(input, options);
      backendCalls.push({ url: new URL(input), options });
      return new Response(JSON.stringify({ candidates: [], bounded: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    logger: (line) => logs.push(line),
  });

  for (const route of routes) {
    const result = await invoke(handler, {
      method: "GET",
      url: route.path,
      body: route.body,
      headers: {
        origin: undefined,
        authorization: DEVICE_AUTHORIZATION,
        "x-serverless-authorization": "Bearer caller-controlled",
        "x-forwarded-host": "attacker.invalid",
        "cf-connecting-ip": "203.0.113.9",
      },
    });
    assert.equal(result.status, 200, route.path);
  }

  assert.equal(backendCalls.length, routes.length);
  assert.equal(metadataCalls.length, routes.length);
  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index];
    const { url, options } = backendCalls[index];
    assert.equal(url.origin, BACKEND_ORIGIN);
    assert.equal(url.pathname + url.search, route.path);
    assert.equal(options.method, "GET");
    assert.equal(options.headers.get("authorization"), DEVICE_AUTHORIZATION);
    assert.equal(options.headers.get("x-serverless-authorization"), `Bearer ${TOKEN}`);
    assert.equal(options.headers.has("origin"), false);
    assert.equal(options.headers.has("cookie"), false);
    assert.equal(options.headers.has("x-forwarded-host"), false);
    assert.equal(options.headers.has("cf-connecting-ip"), false);
    assert.equal(options.headers.has("content-type"), false);
    assert.equal(options.body, undefined);
  }
  const serializedLogs = logs.join("\n");
  assert.equal(serializedLogs.includes(DEVICE_AUTHORIZATION), false);
  assert.equal(serializedLogs.includes("fromDay"), false);
  assert.match(serializedLogs, /"route":"device_sync_manifest"/u);
  assert.match(serializedLogs, /"route":"telemetry_v12_day_manifest_read"/u);
});

test("manifest GET routes reject bad authority, query shapes, methods, and unlisted APIs before forwarding", async () => {
  let metadataCount = 0;
  let backendCount = 0;
  const { fetchImpl: metadata } = metadataFetch();
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input, options) => {
      if (new URL(input).origin === "http://metadata.google.internal") {
        metadataCount += 1;
        return metadata(input, options);
      }
      backendCount += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
    logger: () => {},
  });
  const syncManifest = "/api/v1/device/sync/manifest?fromDay=2026-09-01&toDay=2026-09-02";
  const dayManifest = "/api/v1/device/telemetry/v1.2/day-manifests";
  const dayManifestQuery = `${dayManifest}?fromDay=2026-09-01&toDay=2026-09-02`;
  const denied = [
    { method: "GET", url: syncManifest, body: null, headers: { origin: undefined } },
    { method: "GET", url: syncManifest, body: null, headers: { authorization: "Bearer malformed" } },
    { method: "GET", url: syncManifest, body: null, headers: { authorization: DEVICE_AUTHORIZATION, cookie: SESSION_COOKIE } },
    { method: "GET", url: syncManifest, body: null, headers: { authorization: DEVICE_AUTHORIZATION, origin: "https://attacker.invalid" } },
    { method: "GET", url: dayManifestQuery, body: null, headers: { origin: undefined } },
    { method: "GET", url: dayManifestQuery, body: null, headers: { authorization: "Bearer malformed" } },
    { method: "GET", url: dayManifestQuery, body: null, headers: { authorization: DEVICE_AUTHORIZATION, cookie: SESSION_COOKIE } },
    { method: "GET", url: dayManifestQuery, body: null, headers: { authorization: DEVICE_AUTHORIZATION, origin: "https://attacker.invalid" } },
    { method: "GET", url: "/api/v1/device/sync/manifest", body: null, headers: { authorization: DEVICE_AUTHORIZATION } },
    { method: "GET", url: "/api/v1/device/sync/manifest?", body: null, headers: { authorization: DEVICE_AUTHORIZATION } },
    { method: "GET", url: dayManifest, body: null, headers: { authorization: DEVICE_AUTHORIZATION } },
    { method: "GET", url: `${dayManifest}?`, body: null, headers: { authorization: DEVICE_AUTHORIZATION } },
    { method: "GET", url: `${syncManifest}&fromDay=2026-09-03`, body: null, headers: { authorization: DEVICE_AUTHORIZATION } },
    { method: "GET", url: "/api/v1/device/sync/manifest?fromDay=2026-09-01&toDay=2026-09-02&extra=1", body: null, headers: { authorization: DEVICE_AUTHORIZATION } },
    { method: "GET", url: `${dayManifest}?fromDay=2026-09-01&fromDay=2026-09-02&toDay=2026-09-02`, body: null, headers: { authorization: DEVICE_AUTHORIZATION } },
    { method: "GET", url: `${dayManifest}?fromDay=2026-09-01&toDay=2026-09-02&extra=1`, body: null, headers: { authorization: DEVICE_AUTHORIZATION } },
    { method: "POST", url: syncManifest, body: "{}", headers: { authorization: DEVICE_AUTHORIZATION } },
    { method: "HEAD", url: dayManifest, body: null, headers: { authorization: DEVICE_AUTHORIZATION } },
    { method: "PUT", url: dayManifest, body: "{}", headers: { authorization: DEVICE_AUTHORIZATION } },
    { method: "POST", url: `${dayManifest}?fromDay=2026-09-01&toDay=2026-09-02`, body: "{}", headers: { authorization: DEVICE_AUTHORIZATION } },
    { method: "GET", url: "/api/v1/device/sync-capabilities-v1.2?extra=1", body: null, headers: { authorization: DEVICE_AUTHORIZATION } },
    { method: "POST", url: "/api/v1/admin/action", body: "{}" },
    { method: "GET", url: "/api/v1/admin/overview", body: null },
    { method: "POST", url: "/api/v1/internal/release/appcast", body: "{}" },
    { method: "GET", url: "/api/v1/not-implemented", body: null },
  ];
  const expectedStatuses = [401, 401, 400, 403, 401, 401, 400, 403, 404, 404, 404, 404, 404, 404, 404, 404, 405, 405, 405, 404, 404, 404, 404, 404, 404];
  for (let index = 0; index < denied.length; index += 1) {
    const result = await invoke(handler, denied[index]);
    assert.equal(result.status, expectedStatuses[index], `${denied[index].method} ${denied[index].url}`);
    if (denied[index].url === dayManifest && ["HEAD", "PUT"].includes(denied[index].method)) {
      assert.equal(result.headers.allow, "GET, POST");
    }
    if (denied[index].url === syncManifest && denied[index].method === "POST") {
      assert.equal(result.headers.allow, "GET");
    }
  }
  assert.equal(metadataCount, 0);
  assert.equal(backendCount, 0);
});

test("manifest gateway preserves private-backend refusal and fails closed on upstream loss", async () => {
  let backendCalls = 0;
  const { calls: metadataCalls, fetchImpl: metadata } = metadataFetch();
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input, options) => {
      if (new URL(input).origin === "http://metadata.google.internal") return metadata(input, options);
      backendCalls += 1;
      if (new URL(input).pathname.endsWith("sync/manifest")) {
        return new Response(JSON.stringify({ status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("synthetic upstream outage");
    },
    logger: () => {},
  });

  const unsupported = await invoke(handler, {
    method: "GET",
    url: "/api/v1/device/sync/manifest?fromDay=2026-09-01&toDay=2026-09-02",
    body: null,
    headers: { origin: undefined, authorization: DEVICE_AUTHORIZATION },
  });
  assert.equal(unsupported.status, 503);
  assert.deepEqual(unsupported.json(), {
    status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED",
  });

  const unavailable = await invoke(handler, {
    method: "GET",
    url: "/api/v1/device/telemetry/v1.2/day-manifests?fromDay=2026-09-01&toDay=2026-09-02",
    body: null,
    headers: { origin: undefined, authorization: DEVICE_AUTHORIZATION },
  });
  assert.equal(unavailable.status, 502);
  assert.equal(unavailable.json().error.code, "UPSTREAM_UNAVAILABLE");
  assert.equal(backendCalls, 2);
  assert.equal(metadataCalls.length, 2);
});

test("the v1.2 edge rejects unlisted, cross-origin, cookie-bearing, or unauthenticated device requests before metadata access", async () => {
  let metadataCount = 0;
  let backendCount = 0;
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input) => {
      if (new URL(input).origin === "http://metadata.google.internal") {
        metadataCount += 1;
        return metadataResponse();
      }
      backendCount += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
    logger: () => {},
  });
  const invalidRequests = [
    { url: "/api/v1/admin/action", body: "{}" },
    { method: "GET", url: "/api/v1/contributions", body: null, headers: { authorization: UPLOAD_AUTHORIZATION } },
    { url: "/api/v1/device/upload-authorizations", body: "{}", headers: { authorization: "Bearer malformed" } },
    { url: "/api/v1/device/sync/state", method: "GET", body: null, headers: { authorization: undefined } },
    { url: "/api/v1/device/sync/state", method: "GET", body: null, headers: { authorization: DEVICE_AUTHORIZATION, origin: "https://attacker.invalid" } },
    { url: "/api/v1/device/sync/state", method: "GET", body: null, headers: { authorization: DEVICE_AUTHORIZATION, cookie: SESSION_COOKIE } },
    { url: "/api/v1/device/telemetry/v1.2/day-manifests", body: "{}", headers: { authorization: UPLOAD_AUTHORIZATION } },
    { url: "/api/v1/contributions", body: "{}", headers: { authorization: DEVICE_AUTHORIZATION } },
  ];
  for (const options of invalidRequests) {
    const result = await invoke(handler, options);
    assert.ok([400, 401, 403, 404, 405].includes(result.status), `${options.url}: ${result.status}`);
  }

  const consentBody = JSON.stringify({ deviceId: DEVICE_ID, consent: V12_CONSENT, ongoingUpload: true });
  const consentBase = {
    url: "/api/v1/me/device-telemetry-v12-consents",
    body: consentBody,
    headers: { cookie: SESSION_COOKIE, "x-usage-monitor-csrf": "csrf-test" },
  };
  for (const headers of [
    { ...consentBase.headers, origin: "https://attacker.invalid", "sec-fetch-site": "same-origin" },
    { ...consentBase.headers, origin: PUBLIC_ORIGIN, "sec-fetch-site": "cross-site" },
    { cookie: SESSION_COOKIE, origin: PUBLIC_ORIGIN, "sec-fetch-site": "same-origin" },
    { ...consentBase.headers, origin: PUBLIC_ORIGIN },
    { ...consentBase.headers, origin: PUBLIC_ORIGIN, "sec-fetch-site": "same-origin", authorization: "Bearer unexpected" },
  ]) {
    const result = await invoke(handler, { ...consentBase, headers });
    assert.ok([400, 401, 403].includes(result.status), `consent refusal: ${result.status}`);
  }

  const oversizedChunk = await invoke(handler, {
    url: "/api/v1/contributions",
    body: "{}",
    headers: { origin: undefined, authorization: UPLOAD_AUTHORIZATION, "content-length": "2116385" },
  });
  const oversizedManifest = await invoke(handler, {
    url: "/api/v1/device/telemetry/v1.2/day-manifests",
    body: "{}",
    headers: { origin: undefined, authorization: DEVICE_AUTHORIZATION, "content-length": "1250001" },
  });
  assert.equal(oversizedChunk.status, 413);
  assert.equal(oversizedManifest.status, 413);
  assert.equal(metadataCount, 0);
  assert.equal(backendCount, 0);
});

test("the gateway bounds concurrently active request bodies and releases slots on completion", async () => {
  let metadataCount = 0;
  const pendingMetadata = [];
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input) => {
      if (new URL(input).origin === "http://metadata.google.internal") {
        metadataCount += 1;
        if (metadataCount > 4) return metadataResponse();
        return new Promise((resolve) => pendingMetadata.push(() => resolve(metadataResponse())));
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
    logger: () => {},
  });
  const deviceState = () => invoke(handler, {
    method: "GET",
    url: "/api/v1/device/sync/state",
    body: null,
    headers: { origin: undefined, authorization: DEVICE_AUTHORIZATION },
  });
  const inFlight = Array.from({ length: 4 }, deviceState);
  for (let attempt = 0; attempt < 10 && metadataCount < 4; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(metadataCount, 4);
  const saturated = await deviceState();
  assert.equal(saturated.status, 503);
  assert.equal(saturated.json().error.code, "GATEWAY_BUSY");
  assert.equal(metadataCount, 4);
  for (const release of pendingMetadata) release();
  const completed = await Promise.all(inFlight);
  assert.ok(completed.every((result) => result.status === 200));
  const afterRelease = await deviceState();
  assert.equal(afterRelease.status, 200);
});

test("the gateway serves only bounded reviewed GET/HEAD assets and keeps API/admin paths private", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-oauth-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "<html>synthetic public UI</html>", "utf8");
  await writeFile(join(root, "app.js"), "export const value = 1;", "utf8");
  await writeFile(join(root, "feature-allowance.mp4"), "synthetic MP4 bytes", "utf8");
  await writeFile(join(root, "admin.html"), "private admin shell", "utf8");
  await writeFile(join(root, "app.js.map"), "private source map", "utf8");
  await writeFile(join(root, "contract.json"), "{}", "utf8");
  await writeFile(join(root, "untyped.bin"), "opaque", "utf8");
  const assets = await createFilesystemAssets(root);
  let upstreamCalls = 0;
  const logs = [];
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    assets,
    fetchImpl: async () => {
      upstreamCalls += 1;
      throw new Error("static requests must not call metadata or the backend");
    },
    logger: (line) => logs.push(line),
  });

  const home = await invoke(handler, { method: "GET", url: "/", body: null });
  assert.equal(home.status, 200);
  assert.equal(home.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(home.headers["content-length"], String(Buffer.byteLength("<html>synthetic public UI</html>")));
  assert.equal(home.headers["content-security-policy"],
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  assert.equal(home.headers["permissions-policy"], "camera=(), microphone=(), geolocation=()");
  assert.equal(home.headers["referrer-policy"], "no-referrer");
  assert.equal(home.headers["x-content-type-options"], "nosniff");
  assert.equal(home.body.toString("utf8"), "<html>synthetic public UI</html>");
  const head = await invoke(handler, { method: "HEAD", url: "/app.js?cache=1", body: null });
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(head.headers["content-length"], String(Buffer.byteLength("export const value = 1;")));
  assert.equal(head.body.byteLength, 0);
  const video = await invoke(handler, {
    method: "GET", url: "/feature-allowance.mp4", body: null,
  });
  assert.equal(video.status, 200);
  assert.equal(video.headers["content-type"], "video/mp4");
  assert.equal(video.body.toString("utf8"), "synthetic MP4 bytes");

  for (const path of [
    "/admin.html",
    "/app.js.map",
    "/contract.json",
    "/untyped.bin",
    "/api/v1/admin/action",
    "/%2e%2e/index.html",
    "/missing.js",
  ]) {
    const result = await invoke(handler, { method: "GET", url: path, body: null });
    assert.equal(result.status, 404, path);
  }
  const foreignOrigin = await invoke(handler, {
    method: "GET", url: "/app.js", body: null,
    headers: { origin: "https://attacker.invalid" },
  });
  assert.equal(foreignOrigin.status, 403);
  const spoofedHost = await invoke(handler, {
    method: "GET", url: "/app.js", body: null, host: "attacker.invalid",
  });
  assert.equal(spoofedHost.status, 421);
  const staticPost = await invoke(handler, { method: "POST", url: "/app.js", body: "{}" });
  assert.equal(staticPost.status, 404);
  assert.equal(upstreamCalls, 0);
  assert.equal(logs.join("\n").includes("private admin shell"), false);
});

test("contribution streaming allows the bounded upload window while control routes keep short body deadlines", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const server = createOauthGatewayServer({ configuration: configuration() });
  assert.equal(server.requestTimeout, 60_000);

  const { fetchImpl: metadata } = metadataFetch();
  let backendCalls = 0;
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input, options) => {
      if (new URL(input).origin === "http://metadata.google.internal") return metadata(input, options);
      backendCalls += 1;
      return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
    },
    logger: () => {},
  });
  const body = JSON.stringify({ encryptedContribution: "synthetic" });
  const split = Math.floor(body.length / 2);
  const slowContribution = Readable.from((async function* () {
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    yield Buffer.from(body.slice(0, split));
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    yield Buffer.from(body.slice(split));
  })());
  const upload = invoke(handler, {
    url: "/api/v1/contributions",
    body: null,
    stream: slowContribution,
    headers: {
      authorization: UPLOAD_AUTHORIZATION,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(8_000);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(8_000);
  const uploadResult = await upload;
  assert.equal(uploadResult.status, 201);
  assert.equal(backendCalls, 1);

  const slowControl = Readable.from((async function* () {
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    yield Buffer.from("{}");
  })());
  const control = invoke(handler, {
    url: "/api/v1/identity/google/start",
    stream: slowControl,
    headers: { "content-length": "2" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5_001);
  await new Promise((resolve) => setImmediate(resolve));
  const controlResult = await control;
  assert.equal(controlResult.status, 408);
  assert.equal(controlResult.json().error.code, "BODY_TIMEOUT");
  assert.equal(backendCalls, 1);

  const stalledUpload = Readable.from((async function* () {
    await new Promise((resolve) => setTimeout(resolve, 16_000));
    yield Buffer.from(body);
  })());
  const stalled = invoke(handler, {
    url: "/api/v1/contributions",
    body: null,
    stream: stalledUpload,
    headers: {
      authorization: UPLOAD_AUTHORIZATION,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(15_001);
  await new Promise((resolve) => setImmediate(resolve));
  const stalledResult = await stalled;
  assert.equal(stalledResult.status, 408);
  assert.equal(stalledResult.json().error.code, "BODY_TIMEOUT");
  assert.equal(backendCalls, 1);
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

test("the public gateway exposes envelope-key and session-scoped device routes with bounded 100-device output", async () => {
  const timestamp = "2026-09-28T12:34:56.789Z";
  const devices = Array.from({ length: 100 }, (_, index) => ({
    deviceId: `d81c0f3b-9d3e-4dc8-b367-${String(index).padStart(12, "0")}`,
    state: "revoked",
    createdAt: timestamp,
    expiresAt: timestamp,
    lastUsedAt: timestamp,
    revokedAt: timestamp,
  }));
  const deviceListBody = Buffer.from(JSON.stringify({ devices }));
  assert.equal(deviceListBody.byteLength, 22_713,
    "100 maximum-width rows serialize to 22,713 bytes");
  assert.ok(deviceListBody.byteLength <= 32 * 1_024,
    "the private handler's 100-row response fits the route's 32 KiB cap");

  const envelopeBody = JSON.stringify({
    algorithm: "RSA-OAEP-256",
    keyId: "synthetic-key",
    publicJwk: { alg: "RSA-OAEP-256", e: "AQAB", key_ops: ["encrypt"], kid: "synthetic-key", kty: "RSA", n: "c3ludGhldGlj", use: "enc" },
  });
  const revokeBody = JSON.stringify({ revoked: true, deviceId: DEVICE_ID });
  const { calls: metadataCalls, fetchImpl: metadata } = metadataFetch();
  const backendCalls = [];
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      if (url.origin === "http://metadata.google.internal") return metadata(input, options);
      backendCalls.push({ url, options });
      if (url.pathname === "/api/v1/envelope-key") {
        return new Response(envelopeBody, { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/api/v1/me/devices") {
        return new Response(deviceListBody, {
          status: 200,
          headers: { "content-type": "application/json", vary: "Cookie" },
        });
      }
      if (url.pathname === "/api/v1/me/devices/revoke") {
        return new Response(revokeBody, {
          status: 200,
          headers: { "content-type": "application/json", vary: "Cookie" },
        });
      }
      assert.fail(`unexpected private route: ${url.pathname}`);
    },
    logger: () => {},
  });

  const envelope = await invoke(handler, {
    method: "GET",
    url: "/api/v1/envelope-key",
    body: null,
    headers: {
      origin: undefined,
      authorization: "Bearer caller-controlled",
      cookie: SESSION_COOKIE,
      "x-usage-monitor-csrf": "caller-controlled",
    },
  });
  assert.equal(envelope.status, 200);
  assert.equal(envelope.body.toString("utf8"), envelopeBody);

  const listed = await invoke(handler, {
    method: "GET",
    url: "/api/v1/me/devices",
    body: null,
    headers: { cookie: SESSION_COOKIE, "x-usage-monitor-csrf": "not-forwarded-on-GET" },
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.vary, "Cookie");
  assert.equal(JSON.parse(listed.body.toString("utf8")).devices.length, 100);

  const revoked = await invoke(handler, {
    method: "POST",
    url: "/api/v1/me/devices/revoke",
    body: revokeBody,
    headers: {
      cookie: SESSION_COOKIE,
      "x-usage-monitor-csrf": "csrf-test-token",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.headers.vary, "Cookie");
  assert.equal(revoked.body.toString("utf8"), revokeBody);

  assert.equal(backendCalls.length, 3);
  assert.equal(backendCalls[0].url.href, `${BACKEND_ORIGIN}/api/v1/envelope-key`);
  assert.equal(backendCalls[0].options.method, "GET");
  assert.equal(backendCalls[0].options.body, undefined);
  assert.equal(backendCalls[0].options.headers.has("authorization"), false);
  assert.equal(backendCalls[0].options.headers.has("cookie"), false);
  assert.equal(backendCalls[0].options.headers.has("x-usage-monitor-csrf"), false);
  assert.equal(backendCalls[0].options.headers.has("origin"), false);

  assert.equal(backendCalls[1].url.href, `${BACKEND_ORIGIN}/api/v1/me/devices`);
  assert.equal(backendCalls[1].options.method, "GET");
  assert.equal(backendCalls[1].options.body, undefined);
  assert.equal(backendCalls[1].options.headers.get("cookie"), SESSION_COOKIE);
  assert.equal(backendCalls[1].options.headers.has("authorization"), false);
  assert.equal(backendCalls[1].options.headers.has("x-usage-monitor-csrf"), false);
  assert.equal(backendCalls[1].options.headers.has("origin"), false);

  assert.equal(backendCalls[2].url.href, `${BACKEND_ORIGIN}/api/v1/me/devices/revoke`);
  assert.equal(backendCalls[2].options.method, "POST");
  assert.equal(backendCalls[2].options.headers.get("origin"), BACKEND_ORIGIN,
    "the gateway translates the verified public Origin for the private handler");
  assert.equal(backendCalls[2].options.headers.get("cookie"), SESSION_COOKIE);
  assert.equal(backendCalls[2].options.headers.has("authorization"), false);
  assert.equal(backendCalls[2].options.headers.get("x-usage-monitor-csrf"), "csrf-test-token");
  assert.equal(backendCalls[2].options.headers.get("sec-fetch-site"), "same-origin");
  assert.equal(backendCalls[2].options.headers.get("content-type"), "application/json");
  assert.equal(backendCalls[2].options.body.toString("utf8"), revokeBody);
  assert.ok(Buffer.byteLength(backendCalls[2].options.body) <= 2 * 1_024 * 1_024);
  assert.equal(metadataCalls.length, 3, "each private request obtains service identity before forwarding");
});

test("personal gateway routes reject unsupported methods, queries, bodies, and session or CSRF failures before forwarding", async () => {
  const { calls: metadataCalls, fetchImpl: metadata } = metadataFetch();
  let backendCalls = 0;
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input, options) => {
      if (new URL(input).origin === "http://metadata.google.internal") return metadata(input, options);
      backendCalls += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
    logger: () => {},
  });
  const session = { cookie: SESSION_COOKIE };
  const csrf = {
    ...session,
    "x-usage-monitor-csrf": "csrf-test-token",
    "sec-fetch-site": "same-origin",
  };
  const tooLargeStream = Readable.from([Buffer.alloc(2 * 1_024 * 1_024 + 1)]);
  const cases = [
    { name: "envelope method", options: { method: "POST", url: "/api/v1/envelope-key", body: "{}" }, status: 405, code: "METHOD_NOT_ALLOWED" },
    { name: "envelope query", options: { method: "GET", url: "/api/v1/envelope-key?unexpected=1", body: null }, status: 404, code: "NOT_FOUND" },
    { name: "envelope body", options: { method: "GET", url: "/api/v1/envelope-key", body: "{}", headers: { "content-length": "2" } }, status: 413, code: "BODY_TOO_LARGE" },
    { name: "device list method", options: { method: "POST", url: "/api/v1/me/devices", body: "{}" }, status: 405, code: "METHOD_NOT_ALLOWED" },
    { name: "device list query", options: { method: "GET", url: "/api/v1/me/devices?unexpected=1", body: null, headers: session }, status: 404, code: "NOT_FOUND" },
    { name: "device list body", options: { method: "GET", url: "/api/v1/me/devices", body: "{}", headers: { ...session, "content-length": "2" } }, status: 413, code: "BODY_TOO_LARGE" },
    { name: "device list cookie required", options: { method: "GET", url: "/api/v1/me/devices", body: null }, status: 401, code: "COOKIE_INVALID" },
    { name: "device list rejects Authorization", options: { method: "GET", url: "/api/v1/me/devices", body: null, headers: { ...session, authorization: "Bearer caller-controlled" } }, status: 400, code: "AUTHORIZATION_INVALID" },
    { name: "device list rejects malformed cookie", options: { method: "GET", url: "/api/v1/me/devices", body: null, headers: { cookie: "other=value" } }, status: 400, code: "COOKIE_INVALID" },
    { name: "revoke method", options: { method: "GET", url: "/api/v1/me/devices/revoke", body: null }, status: 405, code: "METHOD_NOT_ALLOWED" },
    { name: "revoke query", options: { url: "/api/v1/me/devices/revoke?unexpected=1", body: JSON.stringify({ deviceId: DEVICE_ID }), headers: csrf }, status: 404, code: "NOT_FOUND" },
    { name: "revoke requires cookie", options: { url: "/api/v1/me/devices/revoke", body: JSON.stringify({ deviceId: DEVICE_ID }), headers: { "x-usage-monitor-csrf": "csrf-test-token", "sec-fetch-site": "same-origin" } }, status: 401, code: "COOKIE_INVALID" },
    { name: "revoke rejects malformed cookie", options: { url: "/api/v1/me/devices/revoke", body: JSON.stringify({ deviceId: DEVICE_ID }), headers: { ...csrf, cookie: `${SESSION_COOKIE}; theme=dark` } }, status: 400, code: "COOKIE_INVALID" },
    { name: "revoke rejects Authorization", options: { url: "/api/v1/me/devices/revoke", body: JSON.stringify({ deviceId: DEVICE_ID }), headers: { ...csrf, authorization: "Bearer caller-controlled" } }, status: 400, code: "AUTHORIZATION_INVALID" },
    { name: "revoke requires CSRF token", options: { url: "/api/v1/me/devices/revoke", body: JSON.stringify({ deviceId: DEVICE_ID }), headers: { ...session, "sec-fetch-site": "same-origin" } }, status: 403, code: "CSRF_INVALID" },
    { name: "revoke requires same-origin fetch metadata", options: { url: "/api/v1/me/devices/revoke", body: JSON.stringify({ deviceId: DEVICE_ID }), headers: { ...csrf, "sec-fetch-site": "cross-site" } }, status: 403, code: "CSRF_INVALID" },
    { name: "revoke rejects absent fetch metadata", options: { url: "/api/v1/me/devices/revoke", body: JSON.stringify({ deviceId: DEVICE_ID }), headers: { cookie: SESSION_COOKIE, "x-usage-monitor-csrf": "csrf-test-token" } }, status: 403, code: "CSRF_INVALID" },
    { name: "revoke requires public Origin", options: { url: "/api/v1/me/devices/revoke", body: JSON.stringify({ deviceId: DEVICE_ID }), headers: { ...csrf, origin: undefined } }, status: 403, code: "CSRF_INVALID" },
    { name: "revoke rejects foreign Origin", options: { url: "/api/v1/me/devices/revoke", body: JSON.stringify({ deviceId: DEVICE_ID }), headers: { ...csrf, origin: "https://attacker.example" } }, status: 403, code: "CSRF_INVALID" },
    { name: "revoke requires JSON", options: { url: "/api/v1/me/devices/revoke", body: "{}", headers: { ...csrf, "content-type": "text/plain" } }, status: 415, code: "CONTENT_TYPE_INVALID" },
    { name: "revoke rejects declared oversize body", options: { url: "/api/v1/me/devices/revoke", body: "{}", headers: { ...csrf, "content-length": String(2 * 1_024 * 1_024 + 1) } }, status: 413, code: "BODY_TOO_LARGE" },
    { name: "revoke rejects streamed oversize body", options: { url: "/api/v1/me/devices/revoke", body: null, stream: tooLargeStream, headers: { ...csrf, "transfer-encoding": "chunked", "content-type": "application/json" } }, status: 413, code: "BODY_TOO_LARGE" },
    { name: "disconnect remains private", options: { method: "POST", url: "/api/v1/device/disconnect", body: "{}", headers: { authorization: DEVICE_AUTHORIZATION } }, status: 404, code: "NOT_FOUND" },
  ];

  for (const item of cases) {
    const result = await invoke(handler, item.options);
    assert.equal(result.status, item.status, item.name);
    assert.equal(result.json().error.code, item.code, item.name);
  }
  assert.equal(backendCalls, 0);
  assert.equal(metadataCalls.length, 0,
    "invalid or unlisted routes fail before private service identity lookup");
});

test("device revocation forwards closed JSON at the 2 MiB limit and preserves private errors without fallback", async () => {
  const maximumBodyBytes = 2 * 1_024 * 1_024;
  const compactBody = JSON.stringify({ deviceId: DEVICE_ID });
  const body = compactBody + " ".repeat(maximumBodyBytes - Buffer.byteLength(compactBody));
  assert.equal(Buffer.byteLength(body), maximumBodyBytes);
  assert.deepEqual(Object.keys(JSON.parse(body)), ["deviceId"]);

  const privateNotFound = JSON.stringify({ error: { code: "DEVICE_NOT_FOUND", requestId: "synthetic-request-id" } });
  const privateBodyInvalid = JSON.stringify({ error: { code: "BODY_INVALID", requestId: "synthetic-body-request-id" } });
  const { calls: metadataCalls, fetchImpl: metadata } = metadataFetch();
  const backendCalls = [];
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input, options) => {
      if (new URL(input).origin === "http://metadata.google.internal") return metadata(input, options);
      backendCalls.push({ url: new URL(input), options });
      const closedBody = Object.keys(JSON.parse(options.body.toString("utf8"))).length === 1;
      return new Response(closedBody ? privateNotFound : privateBodyInvalid, {
        status: closedBody ? 404 : 400,
        headers: { "content-type": "application/json; charset=utf-8", vary: "Cookie" },
      });
    },
    logger: () => {},
  });
  const result = await invoke(handler, {
    url: "/api/v1/me/devices/revoke",
    body,
    headers: {
      cookie: SESSION_COOKIE,
      "x-usage-monitor-csrf": "csrf-test-token",
      "sec-fetch-site": "same-origin",
    },
  });

  assert.equal(result.status, 404);
  assert.equal(result.headers.vary, "Cookie");
  assert.equal(result.body.toString("utf8"), privateNotFound);
  assert.equal(backendCalls.length, 1);
  assert.equal(backendCalls[0].url.href, `${BACKEND_ORIGIN}/api/v1/me/devices/revoke`);
  assert.equal(Buffer.byteLength(backendCalls[0].options.body), maximumBodyBytes);

  const extraPropertyBody = JSON.stringify({ deviceId: DEVICE_ID, unexpected: true });
  const invalidClosedBody = await invoke(handler, {
    url: "/api/v1/me/devices/revoke",
    body: extraPropertyBody,
    headers: {
      cookie: SESSION_COOKIE,
      "x-usage-monitor-csrf": "csrf-test-token",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(invalidClosedBody.status, 400);
  assert.equal(invalidClosedBody.body.toString("utf8"), privateBodyInvalid,
    "the private handler's closed-schema refusal is preserved");
  assert.equal(backendCalls.length, 2, "each request invokes only the private handler once");
  assert.equal(backendCalls[1].url.href, `${BACKEND_ORIGIN}/api/v1/me/devices/revoke`);
  assert.equal(backendCalls[1].options.body.toString("utf8"), extraPropertyBody);
  assert.equal(metadataCalls.length, 2);
});

test("new personal gateway routes fail closed when the private response exceeds its route cap", async () => {
  const { fetchImpl: metadata } = metadataFetch();
  const routes = [
    { path: "/api/v1/envelope-key", method: "GET", body: null, cap: 8 * 1_024, headers: {} },
    { path: "/api/v1/me/devices", method: "GET", body: null, cap: 32 * 1_024, headers: { cookie: SESSION_COOKIE } },
    {
      path: "/api/v1/me/devices/revoke",
      method: "POST",
      body: JSON.stringify({ deviceId: DEVICE_ID }),
      cap: 8 * 1_024,
      headers: {
        cookie: SESSION_COOKIE,
        "x-usage-monitor-csrf": "csrf-test-token",
        "sec-fetch-site": "same-origin",
      },
    },
  ];
  const backendCalls = [];
  const handler = createOauthGatewayHandler({
    configuration: configuration(),
    fetchImpl: async (input, options) => {
      if (new URL(input).origin === "http://metadata.google.internal") return metadata(input, options);
      backendCalls.push(new URL(input).pathname);
      const body = JSON.stringify({ padding: "x".repeat(routes[backendCalls.length - 1].cap) });
      assert.ok(Buffer.byteLength(body) > routes[backendCalls.length - 1].cap);
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    },
    logger: () => {},
  });

  for (const route of routes) {
    const result = await invoke(handler, {
      method: route.method,
      url: route.path,
      body: route.body,
      headers: route.headers,
    });
    assert.equal(result.status, 502, route.path);
    assert.equal(result.json().error.code, "UPSTREAM_UNAVAILABLE", route.path);
  }
  assert.deepEqual(backendCalls, routes.map((route) => route.path));
});
