#!/usr/bin/env node

import http from "node:http";
import { createFilesystemAssets } from "./assets.mjs";
import {
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION,
  isTelemetryV12ConsentCurrent,
} from "@app-usagemonitor/telemetry-contract";

const BACKEND_ORIGIN = "https://tibotattle-test-app-5t5mehqi7a-ue.a.run.app";
const METADATA_IDENTITY_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";
const CONTROL_BODY_READ_POLICY = Object.freeze({ maximumTotalMilliseconds: 15_000, maximumIdleMilliseconds: 5_000 });
const CONTRIBUTION_BODY_READ_POLICY = Object.freeze({ maximumTotalMilliseconds: 60_000, maximumIdleMilliseconds: 15_000 });
const STATIC_ASSET_CONTENT_TYPES = new Set([
  "text/css; charset=utf-8",
  "text/html; charset=utf-8",
  "text/javascript; charset=utf-8",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "video/mp4",
]);
const STATIC_ASSET_SECURITY_HEADERS = Object.freeze({
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});
const V12_DAY_MANIFEST_READ_ROUTE = Object.freeze({
  id: "telemetry_v12_day_manifest_read", method: "GET", body: "none", maxBodyBytes: 0,
  responseTypes: ["application/json"], maxResponseBytes: 128 * 1_024,
  requireDeviceAuthorization: true, allowMissingOrigin: true, rejectCookie: true,
  queryContract: "day_range",
});
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
  ["/api/v1/envelope-key", Object.freeze({
    id: "envelope_key", method: "GET", body: "none", maxBodyBytes: 0,
    responseTypes: ["application/json"], maxResponseBytes: 8 * 1_024,
    sessionCookie: false, forwardAuthorization: false, forwardCsrf: false,
  })],
  ["/api/v1/session", Object.freeze({
    id: "session", method: "GET", body: "none", maxBodyBytes: 0,
    responseTypes: ["application/json"], maxResponseBytes: 8 * 1_024,
    sessionCookie: true, forwardAuthorization: false, forwardCsrf: false,
  })],
  ["/api/v1/me/devices", Object.freeze({
    id: "participant_devices", method: "GET", body: "none", maxBodyBytes: 0,
    responseTypes: ["application/json"], maxResponseBytes: 32 * 1_024,
    // The private projection allows 100 UUID rows with four 24-byte UTC
    // timestamps and the longest state. Its exact JSON size is exercised by
    // oauth-gateway.check.mjs before this cap is changed.
    sessionCookie: true, requireSessionCookie: true, forwardAuthorization: false,
    rejectAuthorization: true, forwardCsrf: false,
  })],
  ["/api/v1/me/devices/revoke", Object.freeze({
    id: "participant_device_revoke", method: "POST", body: "json", maxBodyBytes: 2 * 1_024 * 1_024,
    responseTypes: ["application/json"], maxResponseBytes: 8 * 1_024,
    sessionCookie: true, requireSessionCookie: true, forwardAuthorization: false,
    rejectAuthorization: true, forwardCsrf: true, requireCsrf: true,
    forwardSecFetchSite: true, requireSecFetchSite: true,
    originContract: "backend",
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
  ["/api/v1/me/device-telemetry-v12-consents", Object.freeze({
    id: "telemetry_v12_consent", method: "POST", body: "json", maxBodyBytes: 4_096,
    responseTypes: ["application/json"], maxResponseBytes: 8 * 1_024,
    sessionCookie: true, requireSessionCookie: true, forwardAuthorization: false,
    rejectAuthorization: true, forwardCsrf: true, requireCsrf: true,
    forwardSecFetchSite: true, requireSecFetchSite: true,
    originContract: "backend",
  })],
  ["/api/v1/device/sync/state", Object.freeze({
    id: "device_sync_state", method: "GET", body: "none", maxBodyBytes: 0,
    responseTypes: ["application/json"], maxResponseBytes: 32 * 1_024,
    requireDeviceAuthorization: true, allowMissingOrigin: true, rejectCookie: true,
  })],
  ["/api/v1/device/sync-capabilities-v1.2", Object.freeze({
    id: "device_sync_capabilities_v12", method: "GET", body: "none", maxBodyBytes: 0,
    responseTypes: ["application/json"], maxResponseBytes: 32 * 1_024,
    requireDeviceAuthorization: true, allowMissingOrigin: true, rejectCookie: true,
  })],
  ["/api/v1/device/sync/manifest", Object.freeze({
    id: "device_sync_manifest", method: "GET", body: "none", maxBodyBytes: 0,
    responseTypes: ["application/json"], maxResponseBytes: 2 * 1_024 * 1_024,
    requireDeviceAuthorization: true, allowMissingOrigin: true, rejectCookie: true,
    queryContract: "day_range",
  })],
  ["/api/v1/me/telemetry-v12/domain-predecessor", Object.freeze({
    id: "telemetry_v12_domain_predecessor", method: "POST", body: "json", maxBodyBytes: 4_096,
    responseTypes: ["application/json"], maxResponseBytes: 32 * 1_024,
    requireDeviceAuthorization: true, allowMissingOrigin: true, rejectCookie: true,
    originContract: "backend",
  })],
  ["/api/v1/device/telemetry/v1.2/day-manifests", Object.freeze({
    id: "telemetry_v12_day_manifest", method: "POST", body: "json", maxBodyBytes: 1_250_000,
    responseTypes: ["application/json"], maxResponseBytes: 1_250_000,
    requireDeviceAuthorization: true, allowMissingOrigin: true, rejectCookie: true,
    allowedMethods: "GET, POST", getRoute: V12_DAY_MANIFEST_READ_ROUTE,
    originContract: "backend",
  })],
  ["/api/v1/device/upload-authorizations", Object.freeze({
    id: "device_upload_authorization", method: "POST", body: "json", maxBodyBytes: 4_096,
    responseTypes: ["application/json"], maxResponseBytes: 32 * 1_024,
    requireDeviceAuthorization: true, allowMissingOrigin: true, rejectCookie: true,
    originContract: "backend",
  })],
  ["/api/v1/contributions", Object.freeze({
    id: "contribution_upload", method: "POST", body: "json", maxBodyBytes: 2_116_384,
    bodyReadPolicy: CONTRIBUTION_BODY_READ_POLICY,
    responseTypes: ["application/json"], maxResponseBytes: 32 * 1_024,
    requireUploadAuthorization: true, allowMissingOrigin: true, rejectCookie: true,
    // Match the Cloud Run host's envelope plus HTTP JSON framing allowance.
    // Streamed bytes remain subject to this exact cap in readIncomingBody.
    originContract: "backend",
  })],
  ["/api/v1/me/telemetry-v12/domain-activate", Object.freeze({
    id: "telemetry_v12_domain_activate", method: "POST", body: "json", maxBodyBytes: 1_250_000,
    responseTypes: ["application/json"], maxResponseBytes: 32 * 1_024,
    requireDeviceAuthorization: true, allowMissingOrigin: true, rejectCookie: true,
    originContract: "backend",
  })],
  ["/api/v1/device/credential/renew", Object.freeze({
    id: "device_credential_renewal", method: "POST", body: "json", maxBodyBytes: 4_096,
    responseTypes: ["application/json"], maxResponseBytes: 8 * 1_024,
    requireDeviceAuthorization: true, allowMissingOrigin: true, rejectCookie: true,
    originContract: "backend",
  })],
  ["/api/v1/accountless/enrollment", Object.freeze({
    id: "accountless_enrollment", method: "POST", body: "json", maxBodyBytes: 512,
    responseTypes: ["application/json"], maxResponseBytes: 16 * 1_024,
    // Enrollment is intentionally unauthenticated; the private handler applies
    // its own closed body, mode, issuance-budget, and rate-limit checks.
    sessionCookie: false, forwardAuthorization: false, rejectAuthorization: true,
    allowMissingOrigin: true, rejectCookie: true,
    cookieError: "AUTH_INVALID", cookieErrorStatus: 401,
    originContract: "backend",
  })],
  ["/api/v1/accountless/ownership", Object.freeze({
    id: "accountless_ownership", method: "POST", body: "json", maxBodyBytes: 512,
    responseTypes: ["application/json"], maxResponseBytes: 16 * 1_024,
    requireDeviceAuthorization: true, allowMissingOrigin: true, rejectCookie: true,
    cookieError: "DEVICE_AUTH_INVALID", cookieErrorStatus: 401,
    originContract: "backend",
  })],
  ["/api/v1/accountless/telemetry-v1.2-authorization", Object.freeze({
    id: "accountless_telemetry_v12_authorization", method: "POST", body: "json", maxBodyBytes: 512,
    responseTypes: ["application/json"], maxResponseBytes: 16 * 1_024,
    requireDeviceAuthorization: true, allowMissingOrigin: true, rejectCookie: true,
    cookieError: "DEVICE_AUTH_INVALID", cookieErrorStatus: 401,
    originContract: "backend",
  })],
  ["/api/v1/accountless/renewal", Object.freeze({
    id: "accountless_renewal", method: "POST", body: "json", maxBodyBytes: 512,
    responseTypes: ["application/json"], maxResponseBytes: 16 * 1_024,
    requireDeviceAuthorization: true, allowMissingOrigin: true, rejectCookie: true,
    cookieError: "AUTH_INVALID", cookieErrorStatus: 401,
    originContract: "backend",
  })],
  ["/api/v1/device/disconnect", Object.freeze({
    id: "device_disconnect", method: "POST", body: "none", maxBodyBytes: 0,
    responseTypes: ["application/json"], maxResponseBytes: 16 * 1_024,
    requireDeviceAuthorization: true, allowMissingOrigin: true, rejectCookie: true,
    cookieError: "DEVICE_AUTH_INVALID", cookieErrorStatus: 401,
    originContract: "backend",
  })],
]);
const MAX_URL_LENGTH = 8_192;
const MAX_ACTIVE_REQUESTS = 4;
const MAX_STATIC_RESPONSE_BYTES = 8 * 1024 * 1024;
const BACKEND_TIMEOUT_MS = 30_000;
const METADATA_TIMEOUT_MS = 3_000;
const MAX_AUTHORIZATION_LENGTH = 8_192;
const MAX_REQUEST_CSRF_LENGTH = 96;
const MAX_PREVIOUS_DEVICE_AUTHORIZATION_LENGTH = 256;
const PAIRING_AUTHORIZATION_PATTERN = /^Pairing um_pair_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/u;
const DEVICE_AUTHORIZATION_PATTERN = /^Device um_device_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/u;
const UPLOAD_AUTHORIZATION_PATTERN = /^Upload um_device_upload_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/u;
const CALLBACK_QUERY_HEADER = "x-tibotattle-google-callback-query";
const SESSION_COOKIE_MEMBER = /^__Host-usage_monitor_session=[A-Za-z0-9_.-]{0,384}$/u;
const JWT_PATTERN = /^[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,8192}$/u;
const SAME_ORIGIN_FETCH_SITE = "same-origin";
const RESPONSE_HEADERS = Object.freeze([
  "allow",
  "cache-control",
  "content-security-policy",
  "content-length",
  "content-type",
  "permissions-policy",
  "referrer-policy",
  "vary",
  "x-content-type-options",
]);
const V12_CAPABILITY_KEYS = Object.freeze([
  "schemaVersion", "destinationOrigin", "enrollmentNamespace", "identityVersion", "authorityKind", "successor",
]);
const V12_SUCCESSOR_KEYS = Object.freeze([
  "schemaVersion", "envelopeSchemaVersion", "lifecycle", "requiredConsent", "consentCurrent",
  "authorizationCurrent", "activationTime",
]);
const ENROLLMENT_NAMESPACE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;

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

function exactRecord(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validCapabilityInstant(value) {
  return typeof value === "string" && value.length === 24
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Rewrite only the unsigned, closed v1.2 capability contract for the public
 * gateway. The private Request URL remains unchanged for private dispatch. */
function publicV12CapabilityBody(body, configuration, maximumBytes) {
  let value;
  try { value = JSON.parse(body.toString("utf8")); } catch {
    throw new Error("UPSTREAM_CAPABILITY_INVALID");
  }
  const successor = value?.successor;
  if (!exactRecord(value, V12_CAPABILITY_KEYS)
      || value.schemaVersion !== "device-sync-capabilities-v1.2"
      || (value.destinationOrigin !== configuration.backendOrigin
        && value.destinationOrigin !== configuration.publicOrigin)
      || typeof value.enrollmentNamespace !== "string"
      || !ENROLLMENT_NAMESPACE_PATTERN.test(value.enrollmentNamespace)
      || value.identityVersion !== "account-track-v2"
      || !["social", "accountless"].includes(value.authorityKind)
      || !exactRecord(successor, V12_SUCCESSOR_KEYS)
      || successor.schemaVersion !== TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION
      || successor.envelopeSchemaVersion !== TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION
      || !["accepted", "staged", "blocked"].includes(successor.lifecycle)
      || !isTelemetryV12ConsentCurrent(successor.requiredConsent)
      || typeof successor.consentCurrent !== "boolean"
      || typeof successor.authorizationCurrent !== "boolean"
      || (successor.activationTime !== null && !validCapabilityInstant(successor.activationTime))
      || (successor.authorizationCurrent && successor.activationTime === null)
      || (value.authorityKind === "accountless" && successor.consentCurrent)
      || (successor.authorizationCurrent && (successor.lifecycle !== "accepted"
        || (value.authorityKind === "social" && !successor.consentCurrent)))) {
    throw new Error("UPSTREAM_CAPABILITY_INVALID");
  }
  value.destinationOrigin = configuration.publicOrigin;
  const mapped = Buffer.from(JSON.stringify(value));
  if (mapped.byteLength > maximumBytes) throw new Error("UPSTREAM_RESPONSE_TOO_LARGE");
  return mapped;
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

function identifyRoute(requestTarget, publicOrigin, requestMethod) {
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
  const routeDefinition = ROUTES.get(url.pathname);
  const route = requestMethod === "GET" && routeDefinition?.getRoute
    ? routeDefinition.getRoute : routeDefinition;
  if (!route) return null;
  if (route.id !== "google_callback") {
    if (route.queryContract !== "day_range") {
      if (queryStart !== -1) return null;
    } else {
      const queryKeys = [...url.searchParams.keys()];
      if (queryKeys.length !== 2
          || queryKeys.some((key) => key !== "fromDay" && key !== "toDay")
          || url.searchParams.getAll("fromDay").length !== 1
          || url.searchParams.getAll("toDay").length !== 1) return null;
    }
  }
  return Object.freeze({
    route,
    url,
    allowedMethods: routeDefinition.allowedMethods ?? route.method,
  });
}

function safeStaticPath(requestTarget, publicOrigin) {
  if (typeof requestTarget !== "string" || requestTarget.length === 0
      || requestTarget.length > MAX_URL_LENGTH || !requestTarget.startsWith("/")
      || requestTarget.startsWith("//") || /[\\\u0000-\u0020\u007f#]/u.test(requestTarget)) {
    return null;
  }
  const queryStart = requestTarget.indexOf("?");
  const rawPath = queryStart === -1 ? requestTarget : requestTarget.slice(0, queryStart);
  let url;
  try { url = new URL(requestTarget, publicOrigin); } catch { return null; }
  if (url.origin !== publicOrigin || url.pathname !== rawPath || url.pathname.length > 512) return null;
  const segments = rawPath === "/" ? [] : rawPath.slice(1).split("/");
  for (const segment of segments) {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { return null; }
    if (segment.length === 0 || decoded === "." || decoded === ".."
        || decoded.includes("/") || decoded.includes("\\")
        || /[\u0000-\u001f\u007f]/u.test(decoded)) return null;
    if (/^admin(?:$|[._-])/iu.test(decoded) || decoded.toLowerCase().endsWith(".map")) return null;
  }
  const lowerPath = url.pathname.toLowerCase();
  if (lowerPath === "/api" || lowerPath.startsWith("/api/")) return null;
  return url.pathname;
}

async function staticAssetResponse(request, configuration, assets) {
  if (assets === null || (request.method !== "GET" && request.method !== "HEAD")) return null;
  const pathname = safeStaticPath(request.url, configuration.publicOrigin);
  if (pathname === null) return null;
  const publicUrl = new URL(configuration.publicOrigin);
  if (!validHostHeader(request.headers.host, publicUrl)) return safeError(421, "REQUEST_HOST_INVALID");
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== configuration.publicOrigin) return safeError(403, "CSRF_INVALID");
  try {
    await readIncomingBody(request, { body: "none", maxBodyBytes: 0 });
    const asset = await assets.fetch(new Request(new URL(pathname, configuration.publicOrigin), {
      method: request.method,
    }));
    if (!(asset instanceof Response) || asset.status !== 200) {
      await asset?.body?.cancel().catch(() => undefined);
      return safeError(404, "NOT_FOUND");
    }
    const contentType = asset.headers.get("content-type")?.toLowerCase();
    if (contentType === undefined || !STATIC_ASSET_CONTENT_TYPES.has(contentType)) {
      await asset.body?.cancel().catch(() => undefined);
      return safeError(404, "NOT_FOUND");
    }
    const body = await readBoundedResponse(asset, MAX_STATIC_RESPONSE_BYTES);
    return {
      status: 200,
      headers: { ...responseHeaders(asset), ...STATIC_ASSET_SECURITY_HEADERS },
      body,
    };
  } catch {
    return safeError(404, "NOT_FOUND");
  }
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
    // Worker and private PostgreSQL disconnect handlers use this exact
    // content-length contract: an advertised nonempty body is malformed, not
    // an oversized body. Keep the gateway refusal aligned for this route only.
    if (route.id === "device_disconnect"
        && request.headers["content-length"] !== undefined
        && request.headers["content-length"] !== "0") {
      const error = new Error("BODY_INVALID");
      error.status = 400;
      throw error;
    }
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
  const policy = route.bodyReadPolicy ?? CONTROL_BODY_READ_POLICY;
  const startedAt = Date.now();
  let total = 0;
  const iterator = request[Symbol.asyncIterator]();
  while (true) {
    const remaining = policy.maximumTotalMilliseconds - (Date.now() - startedAt);
    if (remaining <= 0) {
      const error = new Error("BODY_TIMEOUT");
      error.status = 408;
      error.closeRequest = true;
      request.pause();
      throw error;
    }
    let timer;
    let next;
    try {
      next = await Promise.race([
        iterator.next(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error("BODY_TIMEOUT");
            error.status = 408;
            error.closeRequest = true;
            reject(error);
          }, Math.min(policy.maximumIdleMilliseconds, remaining));
        }),
      ]);
    } catch (error) {
      if (error?.closeRequest === true) request.pause();
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (next.done) break;
    const chunk = next.value;
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
  const requiredAuthorization = route.requireDeviceAuthorization
    ? { pattern: DEVICE_AUTHORIZATION_PATTERN, code: "DEVICE_AUTH_INVALID" }
    : route.requireUploadAuthorization
      ? { pattern: UPLOAD_AUTHORIZATION_PATTERN, code: "UPLOAD_AUTH_INVALID" }
      : null;
  if (requiredAuthorization !== null
      && (typeof authorization !== "string"
        || authorization.length > MAX_AUTHORIZATION_LENGTH
        || !requiredAuthorization.pattern.test(authorization))) {
    const error = new Error(requiredAuthorization.code);
    error.status = 401;
    throw error;
  }
  if (route.rejectAuthorization && authorization !== undefined) {
    const error = new Error("AUTHORIZATION_INVALID");
    error.status = 400;
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
  if (route.requireSessionCookie && cookie === undefined) {
    const error = new Error("COOKIE_INVALID");
    error.status = 401;
    throw error;
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
  if (route.requireCsrf && csrf === undefined) {
    const error = new Error("CSRF_INVALID");
    error.status = 403;
    throw error;
  }
  const secFetchSite = request.headers["sec-fetch-site"];
  if (route.forwardSecFetchSite && secFetchSite !== undefined) {
    if (typeof secFetchSite !== "string" || secFetchSite !== SAME_ORIGIN_FETCH_SITE) {
      const error = new Error("CSRF_INVALID");
      error.status = 403;
      throw error;
    }
    result.set("sec-fetch-site", secFetchSite);
  }
  if (route.requireSecFetchSite && secFetchSite !== SAME_ORIGIN_FETCH_SITE) {
    const error = new Error("CSRF_INVALID");
    error.status = 403;
    throw error;
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
  if (response.status === 429 || response.status === 503) {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter !== null && /^(?:0|[1-9]\d{0,4})$/u.test(retryAfter)) {
      const seconds = Number(retryAfter);
      if (seconds >= 1 && seconds <= 86_400) result["retry-after"] = retryAfter;
    }
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
  assets = null,
  fetchImpl = globalThis.fetch,
  logger = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  if (configuration === null || typeof configuration !== "object"
      || configuration.publicOrigin !== canonicalOrigin(configuration.publicOrigin, "OAUTH_GATEWAY_PUBLIC_ORIGIN").origin
      || configuration.backendOrigin !== BACKEND_ORIGIN
      || configuration.backendAudience !== BACKEND_ORIGIN
      || (assets !== null && (typeof assets !== "object" || typeof assets.fetch !== "function"))
      || typeof fetchImpl !== "function" || typeof logger !== "function") {
    throw new Error("OAUTH_GATEWAY_CONFIGURATION_INVALID");
  }
  let activeRequests = 0;

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
    let ownsConcurrencySlot = false;
    let finished = false;
    const finish = (routeId, result) => {
      if (finished) return;
      finished = true;
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(result.status, result.headers);
        response.end(result.body, result.closeRequest === true
          ? () => request.destroy()
          : undefined);
      }
      logSafely(logger, {
        event: "oauth_gateway_request",
        route: routeId,
        method: request.method ?? "UNKNOWN",
        status: result.status,
        durationMs: Math.min(60_000, Math.max(0, Date.now() - startedAt)),
      });
      if (ownsConcurrencySlot) {
        ownsConcurrencySlot = false;
        activeRequests -= 1;
      }
    };

    if (activeRequests >= MAX_ACTIVE_REQUESTS) {
      finish("overloaded", safeError(503, "GATEWAY_BUSY"));
      return;
    }
    activeRequests += 1;
    ownsConcurrencySlot = true;

    const identified = identifyRoute(request.url, configuration.publicOrigin, request.method);
    if (!identified) {
      const staticResult = await staticAssetResponse(request, configuration, assets);
      if (staticResult !== null) {
        finish("static_asset", staticResult);
        return;
      }
      finish("unsupported", safeError(404, "NOT_FOUND"));
      return;
    }
    const { route, url, allowedMethods } = identified;
    if (request.method !== route.method) {
      finish(route.id, safeError(405, "METHOD_NOT_ALLOWED", allowedMethods));
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
      const rejection = safeError(
        Number.isSafeInteger(error?.status) ? error.status : 400,
        typeof error?.message === "string" && /^[A-Z0-9_]+$/u.test(error.message)
          ? error.message : "REQUEST_INVALID",
      );
      if (error?.closeRequest === true) rejection.closeRequest = true;
      finish(route.id, rejection);
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
      let responseBody = await readBoundedResponse(upstream, route.maxResponseBytes);
      const responseHeaderValues = responseHeaders(upstream);
      if (route.id === "device_sync_capabilities_v12" && upstream.status === 200
          && contentType === "application/json") {
        responseBody = publicV12CapabilityBody(responseBody, configuration, route.maxResponseBytes);
        responseHeaderValues["content-length"] = String(responseBody.byteLength);
      }
      result = {
        status: upstream.status,
        headers: responseHeaderValues,
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
  server.requestTimeout = CONTRIBUTION_BODY_READ_POLICY.maximumTotalMilliseconds;
  server.timeout = BACKEND_TIMEOUT_MS + 10_000;
  return server;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    const configuration = createOauthGatewayConfiguration();
    const assets = await createFilesystemAssets(
      process.env.ASSET_ROOT ?? "/app/apps/worker/cloud-run/assets",
    );
    const server = createOauthGatewayServer({ configuration, assets });
    server.listen(configuration.listenPort, configuration.listenHost);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "error", code: error?.message ?? "OAUTH_GATEWAY_START_FAILED" })}\n`);
    process.exitCode = 1;
  }
}
