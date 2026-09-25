#!/usr/bin/env node

import http from "node:http";

const BACKEND_ORIGIN = "https://tibotattle-test-app-5t5mehqi7a-ue.a.run.app";
const METADATA_IDENTITY_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";
const ROUTES = new Map([
  ["/api/health", Object.freeze({
    id: "health", method: "GET", body: "none", maxBodyBytes: 0,
    responseTypes: ["application/json"], maxResponseBytes: 16 * 1_024,
    sessionCookie: false, forwardAuthorization: false, forwardCsrf: false,
  })],
  ["/api/v1/identity/google/start", Object.freeze({
    id: "google_start", method: "POST", body: "json", maxBodyBytes: 4_096,
    responseTypes: ["application/json"], maxResponseBytes: 16 * 1_024,
    sessionCookie: false, forwardCsrf: false,
  })],
  ["/api/v1/identity/google/callback", Object.freeze({
    id: "google_callback", method: "GET", body: "none", maxBodyBytes: 0,
    responseTypes: ["text/html", "application/json"], maxResponseBytes: 32 * 1_024,
    sessionCookie: false, forwardCsrf: false,
  })],
  ["/api/v1/identity/google/result", Object.freeze({
    id: "google_result", method: "POST", body: "json", maxBodyBytes: 8_192,
    responseTypes: ["application/json"], maxResponseBytes: 8 * 1_024,
    sessionCookie: false, forwardCsrf: false,
  })],
  ["/api/v1/enroll", Object.freeze({
    id: "enroll", method: "POST", body: "json", maxBodyBytes: 16_384,
    responseTypes: ["application/json"], maxResponseBytes: 32 * 1_024,
    sessionCookie: false, forwardCsrf: false,
  })],
  ["/api/v1/session", Object.freeze({
    id: "session", method: "GET", body: "none", maxBodyBytes: 0,
    responseTypes: ["application/json"], maxResponseBytes: 8 * 1_024,
    sessionCookie: true, forwardAuthorization: false, forwardCsrf: false,
  })],
  ["/api/v1/logout", Object.freeze({
    id: "logout", method: "POST", body: "none", maxBodyBytes: 0,
    responseTypes: ["application/json"], maxResponseBytes: 8 * 1_024,
    sessionCookie: true, forwardAuthorization: false, forwardCsrf: true,
    originContract: "backend",
  })],
  ["/api/v1/me/device-pairings", Object.freeze({
    id: "device_pairing", method: "POST", body: "json", maxBodyBytes: 4_096,
    responseTypes: ["application/json"], maxResponseBytes: 8 * 1_024,
    sessionCookie: true, forwardAuthorization: false, forwardCsrf: true,
    originContract: "backend",
  })],
  ["/api/v1/device-pairings/claim", Object.freeze({
    id: "device_pairing_claim", method: "POST", body: "json", maxBodyBytes: 4_096,
    responseTypes: ["application/json"], maxResponseBytes: 8 * 1_024,
    sessionCookie: false, forwardCsrf: false, forwardPreviousDeviceAuthorization: true,
    requirePairingAuthorization: true, allowMissingOrigin: true,
    rejectCookie: true, cookieError: "PAIRING_AUTH_INVALID", cookieErrorStatus: 401,
    originContract: "backend",
  })],
]);
const MAX_URL_LENGTH = 8_192;
const BACKEND_TIMEOUT_MS = 30_000;
const METADATA_TIMEOUT_MS = 3_000;
const MAX_AUTHORIZATION_LENGTH = 8_192;
const MAX_REQUEST_CSRF_LENGTH = 96;
const MAX_PREVIOUS_DEVICE_AUTHORIZATION_LENGTH = 256;
const PAIRING_AUTHORIZATION_PATTERN = /^Pairing um_pair_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/u;
const CALLBACK_QUERY_HEADER = "x-tibotattle-google-callback-query";
const SESSION_COOKIE_MEMBER = /^__Host-usage_monitor_session=[A-Za-z0-9_.-]{0,384}$/u;
const JWT_PATTERN = /^[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,8192}$/u;
const RESPONSE_HEADERS = Object.freeze([
  "allow",
  "cache-control",
  "content-security-policy",
  "content-type",
  "permissions-policy",
  "referrer-policy",
  "vary",
  "x-content-type-options",
]);

function safeError(status, code, allow) {
  const body = Buffer.from(JSON.stringify({
    error: { code, requestId: crypto.randomUUID() },
  }));
  const headers = {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
    "x-content-type-options": "nosniff",
  };
  if (allow) headers.allow = allow;
  return { status, headers, body };
}

function canonicalOrigin(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name}_INVALID`); }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password || url.pathname !== "/"
      || url.search || url.hash || url.origin !== value) {
    throw new Error(`${name}_INVALID`);
  }
  return url;
}

function validHostHeader(value, origin) {
  if (typeof value !== "string" || value.length === 0 || value.length > 255
      || /[\s,/@\\]/u.test(value)) return false;
  return value.toLowerCase() === origin.host.toLowerCase();
}

function identifyRoute(requestTarget, publicOrigin) {
  if (typeof requestTarget !== "string" || requestTarget.length === 0
      || requestTarget.length > MAX_URL_LENGTH || !requestTarget.startsWith("/")
      || requestTarget.startsWith("//") || /[\u0000-\u0020\u007f#]/u.test(requestTarget)) {
    return null;
  }
  const queryStart = requestTarget.indexOf("?");
  const rawPath = queryStart === -1 ? requestTarget : requestTarget.slice(0, queryStart);
  if (!ROUTES.has(rawPath)) return null;
  let url;
  try { url = new URL(requestTarget, publicOrigin); } catch { return null; }
  if (url.origin !== publicOrigin || url.pathname !== rawPath || url.pathname.length > 512) return null;
  const route = ROUTES.get(url.pathname);
  if (!route) return null;
  if (route.id !== "google_callback" && queryStart !== -1) return null;
  return Object.freeze({ route, url });
}

function jsonContentType(value) {
  return typeof value === "string"
    && /^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(value.trim());
}

function declaredBodyLength(headers, maximum) {
  const raw = headers["content-length"];
  if (raw === undefined) return null;
  if (typeof raw !== "string" || !/^\d+$/u.test(raw)) {
    const error = new Error("BODY_INVALID");
    error.status = 400;
    throw error;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    const error = new Error("BODY_INVALID");
    error.status = 400;
    throw error;
  }
  if (value > maximum) {
    const error = new Error("BODY_TOO_LARGE");
    error.status = 413;
    throw error;
  }
  return value;
}

async function readIncomingBody(request, route) {
  if (route.body === "none") {
    const length = declaredBodyLength(request.headers, 0);
    if ((length !== null && length !== 0) || request.headers["transfer-encoding"] !== undefined) {
      const error = new Error("BODY_INVALID");
      error.status = 400;
      throw error;
    }
    return Buffer.alloc(0);
  }
  if (route.body !== "json" || !jsonContentType(request.headers["content-type"])) {
    const error = new Error("CONTENT_TYPE_INVALID");
    error.status = 415;
    throw error;
  }
  const declared = declaredBodyLength(request.headers, route.maxBodyBytes);
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > route.maxBodyBytes) {
      const error = new Error("BODY_TOO_LARGE");
      error.status = 413;
      throw error;
    }
    chunks.push(bytes);
  }
  if (declared !== null && total !== declared) {
    const error = new Error("BODY_INVALID");
    error.status = 400;
    throw error;
  }
  return Buffer.concat(chunks, total);
}

function upstreamHeaders(request, publicOrigin, backendOrigin, route, url) {
  const result = new Headers({
    accept: route.id === "google_callback" ? "text/html" : "application/json",
  });
  if (route.body === "json") result.set("content-type", "application/json");
  if (route.method === "POST") {
    // The gateway has already verified the browser-facing Origin. The private
    // Private session dispatchers validate Origin against their private
    // Request URL. These exact routes receive the backend origin on the
    // trusted service-to-service hop only after the browser Origin was checked.
    // OAuth and enrollment retain the public origin for their host rebasing.
    result.set("origin", route.originContract === "backend" ? backendOrigin : publicOrigin);
  }
  if (route.id === "google_callback" && url.search !== "") {
    // Keep OAuth code/state out of the private backend request URL, which is
    // also captured by Cloud Run's automatic request logging.
    result.set(CALLBACK_QUERY_HEADER, url.search);
  }

  const authorization = request.headers.authorization;
  if (route.requirePairingAuthorization
      && (typeof authorization !== "string" || !PAIRING_AUTHORIZATION_PATTERN.test(authorization))) {
    const error = new Error("PAIRING_AUTH_INVALID");
    error.status = 401;
    throw error;
  }
  if (route.forwardAuthorization !== false && authorization !== undefined) {
    if (typeof authorization !== "string" || authorization.length > MAX_AUTHORIZATION_LENGTH
        || /[\r\n]/u.test(authorization)) {
      const error = new Error("AUTHORIZATION_INVALID");
      error.status = 400;
      throw error;
    }
    result.set("authorization", authorization);
  }
  const cookie = request.headers.cookie;
  if (route.rejectCookie && cookie !== undefined) {
    const error = new Error(route.cookieError ?? "COOKIE_INVALID");
    error.status = route.cookieErrorStatus ?? 400;
    throw error;
  }
  if (route.sessionCookie && cookie !== undefined) {
    if (typeof cookie !== "string" || !SESSION_COOKIE_MEMBER.test(cookie)) {
      const error = new Error("COOKIE_INVALID");
      error.status = 400;
      throw error;
    }
    result.set("cookie", cookie);
  }
  const csrf = request.headers["x-usage-monitor-csrf"];
  if (route.forwardCsrf && csrf !== undefined) {
    if (typeof csrf !== "string" || csrf.length > MAX_REQUEST_CSRF_LENGTH || /[\r\n]/u.test(csrf)) {
      const error = new Error("CSRF_INVALID");
      error.status = 400;
      throw error;
    }
    result.set("x-usage-monitor-csrf", csrf);
  }
  const previousDeviceAuthorization = request.headers["x-previous-device-authorization"];
  if (route.forwardPreviousDeviceAuthorization && previousDeviceAuthorization !== undefined) {
    if (typeof previousDeviceAuthorization !== "string"
        || previousDeviceAuthorization.length > MAX_PREVIOUS_DEVICE_AUTHORIZATION_LENGTH
        || /[\r\n]/u.test(previousDeviceAuthorization)) {
      const error = new Error("PREVIOUS_DEVICE_AUTHORIZATION_INVALID");
      error.status = 400;
      throw error;
    }
    result.set("x-previous-device-authorization", previousDeviceAuthorization);
  }
  return result;
}

async function readBoundedResponse(response, maximum) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/u.test(declared) || Number(declared) > maximum) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("UPSTREAM_RESPONSE_TOO_LARGE");
    }
  }
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = Buffer.from(value);
      total += bytes.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new Error("UPSTREAM_RESPONSE_TOO_LARGE");
      }
      chunks.push(bytes);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function responseHeaders(response) {
  const result = {};
  for (const name of RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) result[name] = value;
  }
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) result["set-cookie"] = cookies;
  result["cache-control"] = "no-store";
  result["x-content-type-options"] = "nosniff";
  return result;
}

function logSafely(logger, entry) {
  try {
    logger(JSON.stringify(entry));
  } catch {
    // Logging failure must not change the sign-in result or expose request data.
  }
}

export function createOauthGatewayConfiguration(env = process.env) {
  if (env.OAUTH_GATEWAY_MODE !== "test-only") throw new Error("OAUTH_GATEWAY_MODE_INVALID");
  const publicUrl = canonicalOrigin(env.OAUTH_GATEWAY_PUBLIC_ORIGIN, "OAUTH_GATEWAY_PUBLIC_ORIGIN");
  const backendUrl = canonicalOrigin(env.OAUTH_GATEWAY_BACKEND_ORIGIN, "OAUTH_GATEWAY_BACKEND_ORIGIN");
  if (backendUrl.origin !== BACKEND_ORIGIN || publicUrl.origin === backendUrl.origin) {
    throw new Error("OAUTH_GATEWAY_ORIGIN_INVALID");
  }
  if (env.OAUTH_GATEWAY_BACKEND_AUDIENCE !== backendUrl.origin) {
    throw new Error("OAUTH_GATEWAY_AUDIENCE_INVALID");
  }
  return Object.freeze({
    publicOrigin: publicUrl.origin,
    backendOrigin: backendUrl.origin,
    backendAudience: backendUrl.origin,
    listenHost: env.HOST ?? "0.0.0.0",
    listenPort: Number(env.PORT ?? "8080"),
  });
}

export function createOauthGatewayHandler({
  configuration,
  fetchImpl = globalThis.fetch,
  logger = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  if (configuration === null || typeof configuration !== "object"
      || configuration.publicOrigin !== canonicalOrigin(configuration.publicOrigin, "OAUTH_GATEWAY_PUBLIC_ORIGIN").origin
      || configuration.backendOrigin !== BACKEND_ORIGIN
      || configuration.backendAudience !== BACKEND_ORIGIN
      || typeof fetchImpl !== "function" || typeof logger !== "function") {
    throw new Error("OAUTH_GATEWAY_CONFIGURATION_INVALID");
  }

  async function getBackendIdentityToken(clientSignal) {
    const url = new URL(METADATA_IDENTITY_URL);
    url.searchParams.set("audience", configuration.backendAudience);
    url.searchParams.set("format", "full");
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { "metadata-flavor": "Google" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([clientSignal, AbortSignal.timeout(METADATA_TIMEOUT_MS)]),
    });
    if (!response.ok || response.redirected) throw new Error("IDENTITY_TOKEN_UNAVAILABLE");
    const token = (await readBoundedResponse(response, 8_192)).toString("utf8");
    if (!JWT_PATTERN.test(token)) throw new Error("IDENTITY_TOKEN_INVALID");
    return token;
  }

  return async function handleOauthGatewayRequest(request, response) {
    const startedAt = Date.now();
    const clientAbort = new AbortController();
    const abortOnDisconnect = () => clientAbort.abort();
    request.once("aborted", abortOnDisconnect);
    response.once("close", () => {
      if (!response.writableEnded) clientAbort.abort();
    });
    const finish = (routeId, result) => {
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(result.status, result.headers);
        response.end(result.body);
      }
      logSafely(logger, {
        event: "oauth_gateway_request",
        route: routeId,
        method: request.method ?? "UNKNOWN",
        status: result.status,
        durationMs: Math.min(60_000, Math.max(0, Date.now() - startedAt)),
      });
    };

    const identified = identifyRoute(request.url, configuration.publicOrigin);
    if (!identified) {
      finish("unsupported", safeError(404, "NOT_FOUND"));
      return;
    }
    const { route, url } = identified;
    if (request.method !== route.method) {
      finish(route.id, safeError(405, "METHOD_NOT_ALLOWED", route.method));
      return;
    }
    if (!validHostHeader(request.headers.host, new URL(configuration.publicOrigin))) {
      finish(route.id, safeError(421, "REQUEST_HOST_INVALID"));
      return;
    }
    const origin = request.headers.origin;
    const allowedOrigin = origin === configuration.publicOrigin
      || (route.allowMissingOrigin === true && origin === undefined);
    if ((route.method === "POST" && !allowedOrigin)
        || (origin !== undefined && origin !== configuration.publicOrigin)) {
      finish(route.id, safeError(403, "CSRF_INVALID"));
      return;
    }

    let body;
    let headers;
    try {
      body = await readIncomingBody(request, route);
      headers = upstreamHeaders(
        request,
        configuration.publicOrigin,
        configuration.backendOrigin,
        route,
        url,
      );
    } catch (error) {
      finish(route.id, safeError(
        Number.isSafeInteger(error?.status) ? error.status : 400,
        typeof error?.message === "string" && /^[A-Z0-9_]+$/u.test(error.message)
          ? error.message : "REQUEST_INVALID",
      ));
      return;
    }

    let result;
    try {
      const token = await getBackendIdentityToken(clientAbort.signal);
      headers.set("x-serverless-authorization", `Bearer ${token}`);
      const backendSearch = route.id === "google_callback" ? "" : url.search;
      const backendUrl = new URL(`${url.pathname}${backendSearch}`, configuration.backendOrigin);
      const upstream = await fetchImpl(backendUrl, {
        method: route.method,
        headers,
        ...(route.body === "json" ? { body } : {}),
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.any([clientAbort.signal, AbortSignal.timeout(BACKEND_TIMEOUT_MS)]),
      });
      if (upstream.redirected || (upstream.status >= 300 && upstream.status < 400)) {
        await upstream.body?.cancel().catch(() => undefined);
        throw new Error("UPSTREAM_REDIRECT_REFUSED");
      }
      const contentType = upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (!route.responseTypes.includes(contentType)) {
        await upstream.body?.cancel().catch(() => undefined);
        throw new Error("UPSTREAM_RESPONSE_TYPE_INVALID");
      }
      const responseBody = await readBoundedResponse(upstream, route.maxResponseBytes);
      result = {
        status: upstream.status,
        headers: responseHeaders(upstream),
        body: responseBody,
      };
    } catch {
      result = safeError(502, "UPSTREAM_UNAVAILABLE");
    }
    finish(route.id, result);
  };
}

export function createOauthGatewayServer(options) {
  const configuration = options?.configuration ?? createOauthGatewayConfiguration();
  if (!Number.isSafeInteger(configuration.listenPort) || configuration.listenPort < 1
      || configuration.listenPort > 65_535
      || !["0.0.0.0", "127.0.0.1"].includes(configuration.listenHost)) {
    throw new Error("OAUTH_GATEWAY_LISTEN_CONFIGURATION_INVALID");
  }
  const server = http.createServer(createOauthGatewayHandler({ ...options, configuration }));
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.timeout = BACKEND_TIMEOUT_MS + 10_000;
  return server;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    const configuration = createOauthGatewayConfiguration();
    const server = createOauthGatewayServer({ configuration });
    server.listen(configuration.listenPort, configuration.listenHost);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "error", code: error?.message ?? "OAUTH_GATEWAY_START_FAILED" })}\n`);
    process.exitCode = 1;
  }
}
