import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_COMPANION_REPORT_FILES,
  LOCAL_COMPANION_SCHEMA_VERSION,
  LocalCompanionDataStore,
  buildLocalCompanionSnapshot,
} from "../../src/local-companion-data.js";
import {
  refreshReplaySafeAccountingCache,
} from "../../src/replay-safe-accounting-cache.js";
import {
  AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS,
  acquireAutomaticContributionInstanceLock,
  createAutomaticContributionController,
} from "../../src/automatic-contribution.js";
import { createLocalCentralProxy } from "../../src/local-companion-central-proxy.js";
import {
  LocalCompanionRefreshController,
  createLocalCollectorRefreshRunner,
} from "../../src/local-companion-refresh.js";
import {
  inspectExactNextContributionSyncUpload,
  inspectContributionSyncQueue,
  inspectNextContributionSyncUpload,
  retireAcceptedContributionArtifacts,
  runContributionSyncQueueOnce,
  setContributionSyncPaused,
} from "../../src/contribution-sync-queue.js";
import {
  createProductionContributionDeviceBackend,
} from "../../src/contribution-device-capability.js";
import {
  claimContributionDevicePairing,
} from "../../src/contribution-device-client.js";
import {
  LOCAL_CONTRIBUTION_PREPARATION_ALLOWED_LOOKBACK_HOURS,
  LOCAL_CONTRIBUTION_PREPARATION_DEFAULT_LOOKBACK_HOURS,
  LOCAL_CONTRIBUTION_PREPARATION_ERROR_VERSION,
  LOCAL_CONTRIBUTION_PREPARATION_MAX_WINDOW_MS,
  LOCAL_CONTRIBUTION_PREPARATION_RESULT_VERSION,
  createLocalContributionPreparationRunner,
  projectLocalContributionPreparationError,
} from "../../src/local-contribution-preparation.js";
import {
  assertLocalAbsolutePath,
  assertLocalResourceDirectory,
  assertLocalStatePath,
  defaultLocalCompanionStateRoot,
  inspectLocalOnboarding,
  prepareLocalInstallationRoots,
  projectLocalOnboarding,
} from "../../src/local-installation-diagnostics.js";
import {
  selectProductionParticipantIdentity,
} from "../../src/export-identity-production.js";
import {
  PRODUCT_BRAND,
  SEMANTIC_OPEN_TARGET_PLACEHOLDER,
} from "../../config/product-brand.js";
import {
  validateTelemetryContribution,
} from "@app-usagemonitor/telemetry-contract";
import {
  LOCAL_COMPANION_STATIC_FILES as STATIC_FILES,
  createLocalCompanionReportRoutes,
} from "./static-assets.js";
import {
  matchParticipantRelayRoute,
} from "./transport/participant-relay-routes.js";

const LOOPBACK_HOST = "127.0.0.1";
const LOCAL_COMPANION_MODULE_FILE = fileURLToPath(import.meta.url);
const DEFAULT_RESOURCE_ROOT = resolve(
  dirname(LOCAL_COMPANION_MODULE_FILE),
  "..",
  "..",
);
const PARENT_WATCHDOG_PID = Symbol("parentWatchdogPid");
const PARENT_PID_ENV = "USAGE_MONITOR_PARENT_PID";
const PARENT_PID = /^[1-9][0-9]{0,9}$/u;
const MAXIMUM_PARENT_PID = 2_147_483_647;
const PARENT_WATCHDOG_INTERVAL_MS = 250;
const MAX_REQUEST_BODY_BYTES = 1_024;
const MAX_STATIC_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const LOCAL_SYNC_MAXIMUM_JOBS = 10;
const LOCAL_SYNC_MAXIMUM_RESERVED_UPLOAD_BYTES = 16 * 1024 * 1024;
const LOCAL_AUTOMATIC_SYNC_MAXIMUM_JOBS = 100;
const LOCAL_AUTOMATIC_SYNC_MAXIMUM_RESERVED_UPLOAD_BYTES =
  64 * 1024 * 1024;
const MAX_PARTICIPANT_RELAY_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_PARTICIPANT_RELAY_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PARTICIPANT_EXPORT_RESPONSE_BYTES = 192 * 1024 * 1024;
const PARTICIPANT_RELAY_TIMEOUT_MS = 15_000;
const DEVELOPMENT_IDENTITY_FILE_ENV =
  "USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE";
const DEVELOPMENT_IDENTITY_OPT_IN_ENV =
  "USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY";
const EXPORT_IDENTITY_ENV = "APP_USAGEMONITOR_EXPORT_SECRET";
const REVIEW_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const CONTRIBUTION_DEVICE_PAIRING_CODE =
  /^um_pair_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/u;
const REVIEW_JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REVIEW_AUTHORIZATION_LIFETIME_MS = 10 * 60 * 1000;
const GOOGLE_OAUTH_CALLBACK_PATH = "/oauth/google/callback";
const GOOGLE_OAUTH_RESULT_STORAGE_KEY = "tibotattle-google-oauth-result";
export const APPLE_IDENTITY_HANDOFF_LIFETIME_MS = 5 * 60 * 1000;
const MAX_APPLE_IDENTITY_REQUEST_BYTES = 17_408;
const MAX_APPLE_IDENTITY_TOKEN_LENGTH = 16_384;
const APPLE_IDENTITY_TOKEN =
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

function developmentIdentityConfigurationError() {
  const error = new TypeError(
    "Development identity override configuration is invalid",
  );
  error.code = "USAGE_MONITOR_DEVELOPMENT_IDENTITY_INVALID";
  return error;
}

function resolveDevelopmentIdentityConfiguration({
  file,
  optIn,
  environmentExportSecretPresent,
} = {}) {
  const fileConfigured = file !== null && file !== undefined;
  const optInConfigured = optIn !== null && optIn !== undefined;
  if (!fileConfigured) {
    if (optInConfigured) throw developmentIdentityConfigurationError();
    return Object.freeze({
      explicitSecretFile: null,
      mode: environmentExportSecretPresent
        ? "development_environment_override"
        : "production_keychain",
    });
  }
  if (typeof file !== "string"
      || file.length < 1
      || !isAbsolute(file)
      || optIn !== "1"
      || environmentExportSecretPresent) {
    throw developmentIdentityConfigurationError();
  }
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch {
    throw developmentIdentityConfigurationError();
  }
  const userId = typeof process.getuid === "function"
    ? process.getuid()
    : null;
  if (!metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || metadata.size !== 44
      || !Number.isSafeInteger(userId)
      || metadata.uid !== userId
      || (metadata.mode & 0o7777) !== 0o600) {
    throw developmentIdentityConfigurationError();
  }
  return Object.freeze({
    explicitSecretFile: file,
    mode: "development_file_override",
  });
}

const SESSION_COOKIE_NAME = "__Host-usage_monitor_session";
const SESSION_COOKIE_VALUE = /^[A-Za-z0-9_.-]{0,384}$/u;
const SET_COOKIE_VALUE =
  /^__Host-usage_monitor_session=[A-Za-z0-9_.-]{0,384}; Path=\/; Max-Age=[0-9]+; Secure; HttpOnly; SameSite=Strict$/u;
const CSRF_VALUE = /^[A-Za-z0-9_-]{1,384}$/u;
const UPLOAD_AUTHORIZATION_VALUE =
  /^Upload um_(?:upload|device_upload)_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u;
const REPORT_ROUTES = createLocalCompanionReportRoutes(
  LOCAL_COMPANION_REPORT_FILES,
);

const API_ROUTES = new Set([
  "/api/local/health",
  "/api/local/identity/apple",
  "/api/local/onboarding",
  "/api/local/overview",
  "/api/local/gradient",
  "/api/local/weekly",
  "/api/local/quality",
  "/api/local/reports",
  "/api/local/refresh",
  "/api/local/refresh/cancel",
  "/api/local/contribution/preview",
  "/api/local/contribution/prepare",
  "/api/local/contribution/sync-status",
  "/api/local/contribution/sync-next",
  "/api/local/contribution/device-pair",
  "/api/local/contribution/sync-inspect-exact",
  "/api/local/contribution/sync-once",
  "/api/local/contribution/sync-pause",
  "/api/local/contribution/sync-resume",
  "/api/local/contribution/automatic-settings",
  "/api/local/contribution/automatic-enable",
  "/api/local/contribution/automatic-disable",
]);

// Served for the provider's loopback redirect. The page is entirely inline:
// it references no external script, style, image, or navigation target, and
// the server never parses the ?code or ?state values it arrives with. The
// inline script hands them to the already-open dashboard tab through one
// fixed localStorage key, then removes the key in the same turn — the
// dashboard consumes the storage event's newValue, so nothing persists in
// browser storage — and scrubs the query from this tab's history.
const GOOGLE_OAUTH_CALLBACK_HTML = Buffer.from(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${PRODUCT_BRAND.displayName} sign-in</title>
    <style>
      body {
        font: 15px/1.5 -apple-system, system-ui, sans-serif;
        margin: 3rem auto;
        max-width: 34rem;
        padding: 0 1rem;
      }
    </style>
  </head>
  <body>
    <h1>Google sign-in</h1>
    <p id="signin-status">Handing the one-time sign-in code to the ${PRODUCT_BRAND.displayName} dashboard tab…</p>
    <script>
      (() => {
        const status = document.getElementById("signin-status");
        try {
          const parameters = new URLSearchParams(window.location.search);
          window.localStorage.setItem(
            "${GOOGLE_OAUTH_RESULT_STORAGE_KEY}",
            JSON.stringify({
              code: parameters.get("code") ?? "",
              state: parameters.get("state") ?? "",
              receivedAt: new Date().toISOString(),
            }),
          );
          window.localStorage.removeItem(
            "${GOOGLE_OAUTH_RESULT_STORAGE_KEY}",
          );
          window.history.replaceState(null, "", "${GOOGLE_OAUTH_CALLBACK_PATH}");
          status.textContent =
            "Signed in — return to the ${PRODUCT_BRAND.displayName} dashboard tab.";
        } catch {
          status.textContent =
            "The sign-in result could not be handed to the dashboard tab. Return to the ${PRODUCT_BRAND.displayName} dashboard tab and start the sign-in again.";
        }
      })();
    </script>
  </body>
</html>
`);

function jsonBody(value) {
  return Buffer.from(JSON.stringify(value));
}

function securityHeaders({ report = false } = {}) {
  const scriptPolicy = report ? "'self' 'unsafe-inline'" : "'self'";
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; base-uri 'none'; connect-src 'self'; font-src 'self' data:; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src ${scriptPolicy}; style-src 'self' 'unsafe-inline'`,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function send(response, statusCode, body, type = "application/json; charset=utf-8", options = {}) {
  const payload = Buffer.isBuffer(body) ? body : jsonBody(body);
  response.writeHead(statusCode, {
    ...securityHeaders(options),
    ...(options.headers ?? {}),
    "Content-Type": type,
    "Content-Length": payload.length,
  });
  response.end(payload);
}

function sendError(response, statusCode, code) {
  send(response, statusCode, {
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    error: { code },
  });
}

function contributionDeviceRecoveryRequired(error) {
  try {
    return error?.code === "contribution_device_credential_conflict";
  } catch {
    return false;
  }
}

function actualPort(server) {
  const address = server.address();
  return address && typeof address === "object" ? address.port : null;
}

function allowedHostHeader(server, value) {
  const port = actualPort(server);
  if (!Number.isSafeInteger(port) || typeof value !== "string") return false;
  const normalized = value.toLowerCase();
  return normalized === `${LOOPBACK_HOST}:${port}` || normalized === `localhost:${port}`;
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== "string" || typeof host !== "string") return false;
  return origin.toLowerCase() === `http://${host.toLowerCase()}`;
}

function isLoopbackPeer(request) {
  const peer = request.socket.remoteAddress;
  return peer === LOOPBACK_HOST || peer === "::ffff:127.0.0.1";
}

function fixedRelayError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function participantCentralOrigin(value) {
  if (value === null || value === undefined || value === "") return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return null;
  }
  const developmentLoopback = parsed.protocol === "http:"
    && parsed.hostname === LOOPBACK_HOST
    && parsed.port !== "";
  const productionHTTPS = parsed.protocol === "https:"
    && !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (!developmentLoopback && !productionHTTPS) return null;
  return parsed.origin;
}

function participantSessionCookie(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > 2_048) {
    throw fixedRelayError("central_participant_cookie_invalid");
  }
  const candidates = value.split(";").map((item) => item.trim());
  const matching = candidates.filter((item) => item.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (matching.length === 0) return null;
  if (matching.length !== 1) throw fixedRelayError("central_participant_cookie_invalid");
  const cookie = matching[0];
  const cookieValue = cookie.slice(SESSION_COOKIE_NAME.length + 1);
  if (!SESSION_COOKIE_VALUE.test(cookieValue)) {
    throw fixedRelayError("central_participant_cookie_invalid");
  }
  return cookie;
}

async function boundedParticipantRelayBody(request) {
  if (["GET", "DELETE"].includes(request.method)) {
    const declared = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > 0) {
      throw fixedRelayError("central_participant_request_invalid");
    }
    return null;
  }
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string"
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw fixedRelayError("central_participant_content_type_invalid");
  }
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 1) {
      throw fixedRelayError("central_participant_request_invalid");
    }
    if (length > MAX_PARTICIPANT_RELAY_REQUEST_BYTES) {
      throw fixedRelayError("central_participant_request_too_large");
    }
  }
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_PARTICIPANT_RELAY_REQUEST_BYTES) {
      throw fixedRelayError("central_participant_request_too_large");
    }
    chunks.push(chunk);
  }
  if (total === 0) throw fixedRelayError("central_participant_request_invalid");
  return Buffer.concat(chunks);
}

async function boundedParticipantRelayResponse(
  response,
  maximumBytes = MAX_PARTICIPANT_RELAY_RESPONSE_BYTES,
) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw fixedRelayError("central_participant_response_invalid");
    }
    if (length > maximumBytes) {
      throw fixedRelayError("central_participant_response_too_large");
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw fixedRelayError("central_participant_response_too_large");
      }
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function createParticipantRelay({
  centralOrigin,
  fetchImpl,
  timeoutMs = PARTICIPANT_RELAY_TIMEOUT_MS,
}) {
  const origin = participantCentralOrigin(centralOrigin);
  return Object.freeze({
    enabled: origin !== null,
    handles(path) {
      return origin !== null && matchParticipantRelayRoute(path) !== null;
    },
    async request(request, path) {
      if (origin === null) throw fixedRelayError("central_participant_relay_not_configured");
      const route = matchParticipantRelayRoute(path);
      if (route === null) {
        throw fixedRelayError("central_participant_route_not_allowed");
      }
      if (!route.methods.includes(request.method)) {
        throw fixedRelayError("central_participant_method_not_allowed");
      }
      const body = await boundedParticipantRelayBody(request);
      const headers = {
        Accept: "application/json",
        Origin: origin,
      };
      if (body !== null) headers["Content-Type"] = "application/json";
      const cookie = participantSessionCookie(request.headers.cookie);
      if (cookie !== null) headers.Cookie = cookie;
      const csrf = request.headers["x-usage-monitor-csrf"];
      if (csrf !== undefined) {
        if (typeof csrf !== "string" || !CSRF_VALUE.test(csrf)) {
          throw fixedRelayError("central_participant_csrf_invalid");
        }
        headers["X-Usage-Monitor-CSRF"] = csrf;
      }
      const authorization = request.headers.authorization;
      if (authorization !== undefined) {
        if (path !== "/api/v1/contributions"
            || typeof authorization !== "string"
            || !UPLOAD_AUTHORIZATION_VALUE.test(authorization)) {
          throw fixedRelayError("central_participant_authorization_invalid");
        }
        headers.Authorization = authorization;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();
      let upstream;
      try {
        upstream = await fetchImpl(`${origin}${path}`, {
          method: request.method,
          headers,
          body,
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw fixedRelayError("central_participant_service_unavailable");
      } finally {
        clearTimeout(timeout);
      }
      const contentType = upstream.headers.get("content-type")
        ?.split(";", 1)[0]?.trim();
      if (contentType !== "application/json") {
        throw fixedRelayError("central_participant_response_invalid");
      }
      const responseBody = await boundedParticipantRelayResponse(
        upstream,
        path === "/api/v1/me/export"
          ? MAX_PARTICIPANT_EXPORT_RESPONSE_BYTES
          : MAX_PARTICIPANT_RELAY_RESPONSE_BYTES,
      );
      try {
        JSON.parse(responseBody.toString("utf8"));
      } catch {
        throw fixedRelayError("central_participant_response_invalid");
      }
      const responseHeaders = {};
      const setCookie = upstream.headers.get("set-cookie");
      if (setCookie !== null) {
        if (setCookie.length > 1_024 || !SET_COOKIE_VALUE.test(setCookie)) {
          throw fixedRelayError("central_participant_response_invalid");
        }
        responseHeaders["Set-Cookie"] = setCookie;
      }
      if (upstream.headers.get("idempotency-replayed") === "true") {
        responseHeaders["Idempotency-Replayed"] = "true";
      }
      if (upstream.headers.get("vary") === "Cookie") {
        responseHeaders.Vary = "Cookie";
      }
      return {
        status: upstream.status,
        body: responseBody,
        headers: responseHeaders,
      };
    },
  });
}

async function readEmptyJsonObject(
  request,
  { allowFixedUserRequest = true } = {},
) {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    const error = new Error("unsupported_media_type");
    error.code = "unsupported_media_type";
    throw error;
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    const error = new Error("request_too_large");
    error.code = "request_too_large";
    throw error;
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      const error = new Error("request_too_large");
      error.code = "request_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid_json");
    error.code = "invalid_json";
    throw error;
  }
  const isObject = value && typeof value === "object" && !Array.isArray(value);
  const keys = isObject ? Object.keys(value) : [];
  const isEmpty = isObject && keys.length === 0;
  const isFixedUserRequest = isObject && keys.length === 1 && keys[0] === "reason" && value.reason === "user_request";
  if (!isEmpty && !(allowFixedUserRequest && isFixedUserRequest)) {
    const error = new Error("invalid_request");
    error.code = "invalid_request";
    throw error;
  }
}

async function authorizeLocalMutation(
  request,
  response,
  errorCode,
  { allowFixedUserRequest = true } = {},
) {
  if (!sameOrigin(request)
      || request.headers["x-usage-monitor-local"] !== "1") {
    sendError(response, 403, errorCode);
    return false;
  }
  try {
    await readEmptyJsonObject(request, { allowFixedUserRequest });
    return true;
  } catch (error) {
    const status = error.code === "unsupported_media_type"
      ? 415
      : error.code === "request_too_large" ? 413 : 400;
    sendError(response, status, error.code ?? "invalid_request");
    return false;
  }
}

async function authorizeContributionDevicePairing(request, response) {
  if (!sameOrigin(request)
      || request.headers["x-usage-monitor-local"] !== "1") {
    sendError(response, 403, "contribution_device_pairing_not_authorized");
    return null;
  }
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string"
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    sendError(response, 415, "unsupported_media_type");
    return null;
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength)
      && declaredLength > MAX_REQUEST_BODY_BYTES) {
    sendError(response, 413, "request_too_large");
    return null;
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      sendError(response, 413, "request_too_large");
      return null;
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    sendError(response, 400, "invalid_json");
    return null;
  }
  if (!value
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== "pairingCode"
      || !CONTRIBUTION_DEVICE_PAIRING_CODE.test(value.pairingCode)) {
    sendError(response, 400, "invalid_request");
    return null;
  }
  return value.pairingCode;
}

async function authorizeAppleIdentityHandoff(request, response) {
  if (!sameOrigin(request)
      || request.headers["x-usage-monitor-local"] !== "1") {
    sendError(response, 403, "identity_handoff_not_authorized");
    return null;
  }
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string"
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    sendError(response, 415, "unsupported_media_type");
    return null;
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength)
      && declaredLength > MAX_APPLE_IDENTITY_REQUEST_BYTES) {
    sendError(response, 413, "request_too_large");
    return null;
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_APPLE_IDENTITY_REQUEST_BYTES) {
      sendError(response, 413, "request_too_large");
      return null;
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    sendError(response, 400, "invalid_json");
    return null;
  }
  if (!value
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== "identityToken"
      || typeof value.identityToken !== "string"
      || value.identityToken.length > MAX_APPLE_IDENTITY_TOKEN_LENGTH
      || !APPLE_IDENTITY_TOKEN.test(value.identityToken)) {
    sendError(response, 400, "invalid_request");
    return null;
  }
  return value.identityToken;
}

async function readContributionPreparationRequest(request) {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string"
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    const error = new Error("unsupported_media_type");
    error.code = "unsupported_media_type";
    throw error;
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength)
      && declaredLength > MAX_REQUEST_BODY_BYTES) {
    const error = new Error("request_too_large");
    error.code = "request_too_large";
    throw error;
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      const error = new Error("request_too_large");
      error.code = "request_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid_json");
    error.code = "invalid_json";
    throw error;
  }
  const isObject = value && typeof value === "object" && !Array.isArray(value);
  const keys = isObject ? Object.keys(value) : [];
  if (!isObject
      || keys.length > 1
      || (keys.length === 1 && keys[0] !== "lookbackHours")) {
    const error = new Error("invalid_request");
    error.code = "invalid_request";
    throw error;
  }
  const lookbackHours = keys.length === 0
    ? LOCAL_CONTRIBUTION_PREPARATION_DEFAULT_LOOKBACK_HOURS
    : value.lookbackHours;
  if (!LOCAL_CONTRIBUTION_PREPARATION_ALLOWED_LOOKBACK_HOURS.includes(
    lookbackHours,
  )) {
    const error = new Error("invalid_request");
    error.code = "invalid_request";
    throw error;
  }
  return Object.freeze({ lookbackHours });
}

async function authorizeContributionPreparation(request, response) {
  if (!sameOrigin(request)
      || request.headers["x-usage-monitor-local"] !== "1") {
    sendError(response, 403, "preparation_not_authorized");
    return null;
  }
  try {
    return await readContributionPreparationRequest(request);
  } catch (error) {
    const status = error.code === "unsupported_media_type"
      ? 415
      : error.code === "request_too_large" ? 413 : 400;
    sendError(response, status, error.code ?? "invalid_request");
    return null;
  }
}

async function readAutomaticContributionEnableRequest(request) {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string"
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    const error = new Error("unsupported_media_type");
    error.code = "unsupported_media_type";
    throw error;
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength)
      && declaredLength > MAX_REQUEST_BODY_BYTES) {
    const error = new Error("request_too_large");
    error.code = "request_too_large";
    throw error;
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      const error = new Error("request_too_large");
      error.code = "request_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid_json");
    error.code = "invalid_json";
    throw error;
  }
  const consent = value?.consent;
  if (!value
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== "consent\0intervalHours"
      || value.intervalHours !== AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS
      || !consent
      || typeof consent !== "object"
      || Array.isArray(consent)
      || Object.keys(consent).sort().join("\0")
        !== "destinationOrigin\0fieldDictionaryVersion\0privacyContractVersion\0telemetrySchemaVersion"
      || ![
        consent.telemetrySchemaVersion,
        consent.fieldDictionaryVersion,
        consent.privacyContractVersion,
        consent.destinationOrigin,
      ].every((entry) => typeof entry === "string"
        && entry.length > 0
        && entry.length <= 2_048)) {
    const error = new Error("invalid_request");
    error.code = "invalid_request";
    throw error;
  }
  return Object.freeze({
    intervalHours: value.intervalHours,
    consent: Object.freeze({
      telemetrySchemaVersion: consent.telemetrySchemaVersion,
      fieldDictionaryVersion: consent.fieldDictionaryVersion,
      privacyContractVersion: consent.privacyContractVersion,
      destinationOrigin: consent.destinationOrigin,
    }),
  });
}

async function authorizeAutomaticContributionEnable(request, response) {
  if (!sameOrigin(request)
      || request.headers["x-usage-monitor-local"] !== "1") {
    sendError(response, 403, "automatic_contribution_not_authorized");
    return null;
  }
  try {
    return await readAutomaticContributionEnableRequest(request);
  } catch (error) {
    const status = error.code === "unsupported_media_type"
      ? 415
      : error.code === "request_too_large" ? 413 : 400;
    sendError(response, status, error.code ?? "invalid_request");
    return null;
  }
}

async function authorizeReviewedContributionMutation(
  request,
  response,
  errorCode,
) {
  if (!sameOrigin(request)
      || request.headers["x-usage-monitor-local"] !== "1") {
    sendError(response, 403, errorCode);
    return null;
  }
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string"
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    sendError(response, 415, "unsupported_media_type");
    return null;
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength)
      && declaredLength > MAX_REQUEST_BODY_BYTES) {
    sendError(response, 413, "request_too_large");
    return null;
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      sendError(response, 413, "request_too_large");
      return null;
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    sendError(response, 400, "invalid_json");
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 1
      || !REVIEW_TOKEN.test(value.reviewToken ?? "")) {
    sendError(response, 400, "invalid_request");
    return null;
  }
  return value.reviewToken;
}

async function readFixedFile(root, file, maximumBytes) {
  const path = resolve(root, file);
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    const error = new Error("not_found");
    error.code = "not_found";
    throw error;
  }
  if (!metadata.isFile() || metadata.size > maximumBytes) {
    const error = new Error("not_found");
    error.code = "not_found";
    throw error;
  }
  return readFile(path);
}

function stampSemanticOpenTarget(body) {
  const source = body.toString("utf8");
  const first = source.indexOf(SEMANTIC_OPEN_TARGET_PLACEHOLDER);
  if (first < 0
      || source.indexOf(
        SEMANTIC_OPEN_TARGET_PLACEHOLDER,
        first + SEMANTIC_OPEN_TARGET_PLACEHOLDER.length,
      ) >= 0) {
    const error = new Error("not_found");
    error.code = "not_found";
    throw error;
  }
  return Buffer.from(
    source.replace(
      SEMANTIC_OPEN_TARGET_PLACEHOLDER,
      PRODUCT_BRAND.appOpenURL,
    ),
  );
}

function finiteNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function previewProjection(value) {
  const counts = value?.counts ?? {};
  const coveredAt = value?.coveredAt ?? {};
  const accounting = value?.accounting ?? {};
  return {
    schemaVersion: "telemetry-contribution-v0.1",
    status: value?.status === "available" ? "available" : "not_configured",
    synthetic: false,
    coveredAt: {
      startAt: typeof coveredAt.startAt === "string" ? coveredAt.startAt : null,
      endAt: typeof coveredAt.endAt === "string" ? coveredAt.endAt : null,
    },
    counts: {
      usageEvents: finiteNonNegativeInteger(counts.usageEvents),
      quotaSnapshots: finiteNonNegativeInteger(counts.quotaSnapshots),
      activityMarkers: finiteNonNegativeInteger(counts.activityMarkers),
    },
    accounting: {
      basis: accounting.basis === "api_price_equivalent_not_subscription_allowance"
        ? accounting.basis
        : "api_price_equivalent_not_subscription_allowance",
      fullyPricedEvents: finiteNonNegativeInteger(accounting.fullyPricedEvents),
      partiallyPricedEvents: finiteNonNegativeInteger(accounting.partiallyPricedEvents),
      unpricedEvents: finiteNonNegativeInteger(accounting.unpricedEvents),
    },
    includesFullRows: false,
    remoteSendEnabled: false,
  };
}

function nullableInstant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function syncStatusProjection(value) {
  const counts = value?.counts ?? {};
  const valid = value?.schemaVersion === "contribution-sync-status-v0.1"
    && typeof value?.paused === "boolean";
  return {
    schemaVersion: "contribution-sync-status-v0.1",
    status: valid ? "available" : "unavailable",
    paused: valid ? value.paused : null,
    counts: {
      pending: finiteNonNegativeInteger(counts.pending),
      inFlight: finiteNonNegativeInteger(counts.in_flight),
      accepted: finiteNonNegativeInteger(counts.accepted),
      retryable: finiteNonNegativeInteger(counts.retryable),
      rejected: finiteNonNegativeInteger(counts.rejected),
    },
    dueNow: valid ? finiteNonNegativeInteger(value.dueNow) : 0,
    nextAttemptAt: valid ? nullableInstant(value.nextAttemptAt) : null,
    lastAcceptedAt: valid ? nullableInstant(value.lastAcceptedAt) : null,
    includesContent: false,
    includesPaths: false,
    includesCredentials: false,
  };
}

function syncNextProjection(value, {
  previewConfigured = false,
  deliveryConfigured = false,
} = {}) {
  const allowedStates = new Set(["empty", "ready", "retry_wait", "paused"]);
  const item = value?.item;
  const valid = value?.schemaVersion === "contribution-sync-preview-v0.1"
    && value?.networkActivity === false
    && allowedStates.has(value?.state)
    && isNonNegativeInteger(value?.discoveredSets)
    && isNonNegativeInteger(value?.enqueued)
    && (value.state === "empty" ? item === null : item && typeof item === "object");
  const projected = {
    schemaVersion: "contribution-sync-preview-v0.1",
    status: valid
      ? "available"
      : previewConfigured ? "unavailable" : "not_configured",
    state: valid ? value.state : "unavailable",
    discoveredSets: valid ? value.discoveredSets : 0,
    newlyQueued: valid ? value.enqueued : 0,
    deliveryConfigured,
    item: null,
    networkActivity: false,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
  };
  if (!valid || item === null) return projected;
  const allowedPlatforms = new Set([
    "macos",
    "linux",
    "windows",
    "other",
    "unknown",
  ]);
  const allowedEpochs = new Set([
    "unknown",
    "openai_pre_agentic_pool_2026_07_09",
    "openai_agentic_pool_2026_07_09",
    "anthropic_unknown",
  ]);
  const allowedPriceBases = new Set([
    "current_api_prices",
    "historical_api_prices",
    "unpriced",
  ]);
  const counts = {
    usageEvents: item.recordCounts?.usageEvents,
    quotaSnapshots: item.recordCounts?.quotaSnapshots,
    activityMarkers: item.recordCounts?.activityMarkers,
  };
  const total = counts.usageEvents + counts.quotaSnapshots
    + counts.activityMarkers;
  const estimatedCost = item.accounting?.estimatedApiCostUsd;
  const coverage = item.accounting?.pricedEventCoveragePercent;
  const itemValid = item.schemaVersion === "telemetry-contribution-v0.1"
    && allowedPlatforms.has(item.clientPlatform)
    && allowedEpochs.has(item.providerPolicyEpoch)
    && nullableInstant(item.coveredAt?.startAt) !== null
    && nullableInstant(item.coveredAt?.endAt) !== null
    && Object.values(counts).every(isNonNegativeInteger)
    && total > 0 && total <= 200
    && item.recordCounts?.total === total
    && (estimatedCost === null
      || (typeof estimatedCost === "string"
        && /^(?:0|[1-9]\d*)\.\d{6}$/u.test(estimatedCost)))
    && Number.isFinite(coverage) && coverage >= 0 && coverage <= 100
    && Number.isSafeInteger(item.accounting?.unknownModelEventCount)
    && item.accounting.unknownModelEventCount >= 0
    && item.accounting.unknownModelEventCount <= counts.usageEvents
    && Number.isSafeInteger(item.accounting?.unknownBillableUnits)
    && item.accounting.unknownBillableUnits >= 0
    && item.accounting.unknownBillableUnits <= 1_000_000_000
    && allowedPriceBases.has(item.accounting?.priceBasis)
    && item.accounting?.verification === "client_declared_unverified"
    && Number.isSafeInteger(item.preparedBytes) && item.preparedBytes >= 0
    && Number.isSafeInteger(item.reservedUploadBytes)
    && item.reservedUploadBytes >= item.preparedBytes
    && Number.isSafeInteger(item.attemptCount) && item.attemptCount >= 0
    && nullableInstant(item.nextAttemptAt) !== null;
  if (!itemValid) {
    return {
      ...projected,
      status: "unavailable",
      state: "unavailable",
    };
  }
  return {
    ...projected,
    item: {
      schemaVersion: item.schemaVersion,
      clientPlatform: item.clientPlatform,
      providerPolicyEpoch: item.providerPolicyEpoch,
      coveredAt: {
        startAt: nullableInstant(item.coveredAt.startAt),
        endAt: nullableInstant(item.coveredAt.endAt),
      },
      recordCounts: { ...counts, total },
      accounting: {
        estimatedApiCostUsd: estimatedCost,
        pricedEventCoveragePercent: coverage,
        unknownModelEventCount: item.accounting.unknownModelEventCount,
        unknownBillableUnits: item.accounting.unknownBillableUnits,
        priceBasis: item.accounting.priceBasis,
        verification: "client_declared_unverified",
      },
      preparedBytes: item.preparedBytes,
      reservedUploadBytes: item.reservedUploadBytes,
      attemptCount: item.attemptCount,
      nextAttemptAt: nullableInstant(item.nextAttemptAt),
    },
  };
}

function syncExactReviewProjection(
  value,
  { configured = false, reviewToken = null } = {},
) {
  const allowedStates = new Set(["empty", "ready", "retry_wait", "paused"]);
  const validEnvelope = value?.schemaVersion
      === "contribution-sync-exact-review-v0.1"
    && value?.networkActivity === false
    && allowedStates.has(value?.state)
    && isNonNegativeInteger(value?.discoveredSets)
    && isNonNegativeInteger(value?.enqueued);
  const projected = {
    schemaVersion: "contribution-sync-exact-review-v0.1",
    status: validEnvelope
      ? "available"
      : configured ? "unavailable" : "not_configured",
    state: validEnvelope ? value.state : "unavailable",
    networkActivity: false,
    payloadBytes: null,
    payload: null,
    reviewToken: null,
    includesExactRetainedFields: false,
    includesRawContent: false,
    includesPaths: false,
    includesDirectIdentifiers: false,
    includesCredentials: false,
  };
  if (!validEnvelope || value.state === "empty") return projected;
  try {
    validateTelemetryContribution(value.payload);
  } catch {
    return { ...projected, status: "unavailable", state: "unavailable" };
  }
  const payloadBytes = value.payloadBytes;
  if (!Number.isSafeInteger(payloadBytes)
      || payloadBytes < 1
      || payloadBytes > 1_310_720
      || Buffer.byteLength(JSON.stringify(value.payload), "utf8") > 1_310_720) {
    return { ...projected, status: "unavailable", state: "unavailable" };
  }
  return {
    ...projected,
    payloadBytes,
    payload: value.payload,
    reviewToken: REVIEW_TOKEN.test(reviewToken ?? "") ? reviewToken : null,
    includesExactRetainedFields: true,
  };
}

function syncRunProjection(value) {
  const allowedStates = new Set(["completed", "paused", "interrupted"]);
  const numericFields = [
    "discoveredSets",
    "enqueued",
    "processed",
    "accepted",
    "retryable",
    "rejected",
    "reservedUploadBytes",
  ];
  const valid = allowedStates.has(value?.status)
    && typeof value?.bandwidthLimited === "boolean"
    && numericFields.every((name) => isNonNegativeInteger(value?.[name]));
  return {
    schemaVersion: "contribution-sync-run-v0.1",
    status: valid ? value.status : "unavailable",
    discoveredSets: valid ? value.discoveredSets : 0,
    newlyQueued: valid ? value.enqueued : 0,
    processed: valid ? value.processed : 0,
    accepted: valid ? value.accepted : 0,
    retryable: valid ? value.retryable : 0,
    rejected: valid ? value.rejected : 0,
    reservedUploadBytes: valid ? value.reservedUploadBytes : 0,
    bandwidthLimited: valid ? value.bandwidthLimited : false,
    queue: syncStatusProjection(value?.queue),
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
  };
}

const PREPARATION_ERROR_CODES = new Set([
  "coverage_unavailable",
  "coverage_invalid",
  "identity_unavailable",
  "no_safe_records",
  "export_too_large",
  "privacy_verification_failed",
  "review_archive_invalid",
  "prepared_spool_invalid",
  "preparation_in_progress",
  "preparation_failed",
]);

function preparationResultProjection(value) {
  const startAt = nullableInstant(value?.coveredAt?.startAt);
  const endAt = nullableInstant(value?.coveredAt?.endAt);
  const counts = value?.recordCounts ?? {};
  const countValues = [
    counts.usageEvents,
    counts.quotaSnapshots,
    counts.activityMarkers,
  ];
  const totalRecords = countValues.every(isNonNegativeInteger)
    ? countValues.reduce((sum, count) => sum + count, 0)
    : -1;
  const startMs = startAt === null ? Number.NaN : Date.parse(startAt);
  const endMs = endAt === null ? Number.NaN : Date.parse(endAt);
  const valid = value?.schemaVersion
      === LOCAL_CONTRIBUTION_PREPARATION_RESULT_VERSION
    && value?.status === "prepared"
    && Number.isFinite(startMs)
    && Number.isFinite(endMs)
    && endMs > startMs
    // Seven days is the largest request contract. The existing 100-batch,
    // 100k-record and 125 MiB ceilings below remain authoritative: a dense
    // seven-day selection deterministically fails as export_too_large rather
    // than being silently truncated or split into an unreviewed second set.
    && endMs - startMs <= LOCAL_CONTRIBUTION_PREPARATION_MAX_WINDOW_MS
    && totalRecords > 0
    && totalRecords <= 100_000
    && value?.privacy?.verdict === "passed"
    && isNonNegativeInteger(value?.privacy?.checksPassed)
    && value.privacy.checksPassed <= 32
    && value?.privacy?.checksFailed === 0
    && value?.privacy?.sourceTransportReady === false
    && value?.privacy?.provenanceRetained === true
    && value?.prepared?.schemaVersion === "prepared-contribution-set-v0.1"
    && value?.prepared?.eligibleSchemaVersion
      === "telemetry-contribution-v0.1"
    && Number.isSafeInteger(value?.prepared?.batchCount)
    && value.prepared.batchCount >= 1
    && value.prepared.batchCount <= 100
    && Number.isSafeInteger(value?.prepared?.bytes)
    && value.prepared.bytes >= 1
    && value.prepared.bytes <= 131_072_000
    && value?.networkActivity === false
    && value?.includesContent === false
    && value?.includesPaths === false
    && value?.includesIdentifiers === false
    && value?.includesCredentials === false;
  if (!valid) return null;
  return {
    schemaVersion: LOCAL_CONTRIBUTION_PREPARATION_RESULT_VERSION,
    status: "prepared",
    coveredAt: { startAt, endAt },
    recordCounts: {
      usageEvents: counts.usageEvents,
      quotaSnapshots: counts.quotaSnapshots,
      activityMarkers: counts.activityMarkers,
    },
    privacy: {
      verdict: "passed",
      checksPassed: value.privacy.checksPassed,
      checksFailed: 0,
      sourceTransportReady: false,
      provenanceRetained: true,
    },
    prepared: {
      schemaVersion: "prepared-contribution-set-v0.1",
      eligibleSchemaVersion: "telemetry-contribution-v0.1",
      batchCount: value.prepared.batchCount,
      bytes: value.prepared.bytes,
    },
    networkActivity: false,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
  };
}

function preparationErrorProjection(error, overrideCode = null) {
  const source = projectLocalContributionPreparationError(error);
  const candidate = overrideCode ?? source?.errorCode;
  const errorCode = PREPARATION_ERROR_CODES.has(candidate)
    ? candidate
    : "preparation_failed";
  return {
    schemaVersion: LOCAL_CONTRIBUTION_PREPARATION_ERROR_VERSION,
    status: "failed",
    errorCode,
    networkActivity: false,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
  };
}

function preparationErrorStatus(code) {
  if (code === "preparation_in_progress") return 409;
  if (code === "export_too_large") return 413;
  if (code === "coverage_unavailable"
      || code === "identity_unavailable") return 503;
  if (code === "coverage_invalid"
      || code === "no_safe_records"
      || code === "privacy_verification_failed") return 422;
  return 500;
}

function configuredHomeDirectory(environment) {
  const selected = process.platform === "win32"
    ? environment.USERPROFILE
    : environment.HOME;
  return typeof selected === "string" && selected.length > 0
    ? selected
    : homedir();
}

function parentWatchdogConfigurationError() {
  const error = new TypeError(
    "Parent watchdog configuration is invalid",
  );
  error.code = "USAGE_MONITOR_PARENT_PID_INVALID";
  return error;
}

function configuredParentWatchdogPid(
  environment,
  observedParentPid = process.ppid,
) {
  if (!Object.hasOwn(environment, PARENT_PID_ENV)) return null;
  const value = environment[PARENT_PID_ENV];
  if (typeof value !== "string" || !PARENT_PID.test(value)) {
    throw parentWatchdogConfigurationError();
  }
  const selected = Number(value);
  if (!Number.isSafeInteger(selected)
      || selected <= 1
      || selected > MAXIMUM_PARENT_PID
      || String(selected) !== value
      || selected !== observedParentPid) {
    throw parentWatchdogConfigurationError();
  }
  return selected;
}

function declaredParentIsCurrent(expectedParentPid) {
  if (expectedParentPid === null) return true;
  if (process.ppid !== expectedParentPid) return false;
  try {
    process.kill(expectedParentPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function closeHttpServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (!error || error.code === "ERR_SERVER_NOT_RUNNING") {
        resolveClose();
      } else {
        rejectClose(error);
      }
    });
    server.closeAllConnections?.();
  });
}

function startParentDeathWatchdog({
  server,
  expectedParentPid,
  terminateProcess,
}) {
  if (expectedParentPid === null) {
    return Object.freeze({ stop() {} });
  }
  let active = true;
  const timer = setInterval(() => {
    if (!active || declaredParentIsCurrent(expectedParentPid)) return;
    active = false;
    clearInterval(timer);
    void closeHttpServer(server)
      .catch(() => {})
      .then(() => {
        if (terminateProcess) process.exit(0);
      });
  }, PARENT_WATCHDOG_INTERVAL_MS);
  timer.unref?.();
  return Object.freeze({
    stop() {
      if (!active) return;
      active = false;
      clearInterval(timer);
    },
  });
}

export function createLocalCompanionServer(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  const environment = options.environment ?? process.env;
  if (!environment || typeof environment !== "object"
      || Array.isArray(environment)) {
    throw new TypeError("environment must be an object");
  }
  const parentWatchdogPid = configuredParentWatchdogPid(environment);
  const homeDirectory = configuredHomeDirectory(environment);
  const resourceRoot = options.resourceRoot
    ?? environment.USAGE_MONITOR_RESOURCE_ROOT
    ?? options.root
    ?? DEFAULT_RESOURCE_ROOT;
  const stateRoot = options.stateRoot
    ?? environment.USAGE_MONITOR_STATE_ROOT
    ?? defaultLocalCompanionStateRoot({
      homeDirectory,
      environment,
    });
  const installation = prepareLocalInstallationRoots({
    resourceRoot,
    stateRoot,
  });
  const staticRoot = assertLocalResourceDirectory(
    installation.resourceRoot,
    options.staticRoot
      ?? resolve(installation.resourceRoot, "apps", "web", "public"),
  );
  const codexHome = assertLocalAbsolutePath(
    options.codexHome
      ?? environment.CODEX_HOME
      ?? join(homeDirectory, ".codex"),
  );
  const contributionQueueFile = assertLocalStatePath(
    installation.stateRoot,
    options.contributionQueueFile
      ?? environment.USAGE_MONITOR_CONTRIBUTION_QUEUE_FILE
      ?? installation.paths.contributionQueueFile,
  );
  const preparedCandidate = Object.hasOwn(
    options,
    "preparedContributionDirectory",
  )
    ? options.preparedContributionDirectory
    : Object.hasOwn(environment, "USAGE_MONITOR_PREPARED_DIRECTORY")
      ? environment.USAGE_MONITOR_PREPARED_DIRECTORY
      : installation.paths.preparedSpoolDirectory;
  const preparedContributionDirectory = preparedCandidate === null
    ? null
    : assertLocalStatePath(installation.stateRoot, preparedCandidate);
  const contributionPreparationOptions =
    options.contributionPreparationOptions ?? {};
  if (!contributionPreparationOptions
      || typeof contributionPreparationOptions !== "object"
      || Array.isArray(contributionPreparationOptions)) {
    throw new TypeError("contributionPreparationOptions must be an object");
  }
  const selectedPreparationOptions = {
    ...contributionPreparationOptions,
    activityFile: assertLocalStatePath(
      installation.stateRoot,
      contributionPreparationOptions.activityFile
        ?? installation.paths.activityMarkersFile,
    ),
    reviewArchiveDirectory: assertLocalStatePath(
      installation.stateRoot,
      contributionPreparationOptions.reviewArchiveDirectory
        ?? installation.paths.reviewArchiveDirectory,
    ),
  };
  return createPreparedLocalCompanionServer({
    ...options,
    environment,
    resourceRoot: installation.resourceRoot,
    stateRoot: installation.stateRoot,
    statePaths: installation.paths,
    staticRoot,
    codexHome,
    contributionQueueFile,
    preparedContributionDirectory,
    contributionPreparationOptions: selectedPreparationOptions,
    parentWatchdogPid,
  });
}

function createPreparedLocalCompanionServer({
  environment,
  resourceRoot,
  stateRoot,
  statePaths,
  staticRoot,
  codexHome,
  parentWatchdogPid,
  dataStore = new LocalCompanionDataStore({
    builder: () => buildLocalCompanionSnapshot({
      root: resourceRoot,
      collectorFile: statePaths.collectorFile,
      checkpointFile: statePaths.checkpointFile,
      accountingCacheFile: statePaths.accountingCacheFile,
      allowDevelopmentArtifactFallback:
        environment.USAGE_MONITOR_DEVELOPMENT_ARTIFACT_FALLBACK === "1",
    }),
  }),
  refreshRunner = createLocalCollectorRefreshRunner({
    codexHome,
    dataFile: statePaths.collectorFile,
    checkpointFile: statePaths.checkpointFile,
    lockFile: statePaths.collectorLockFile,
    journalFile: statePaths.collectorJournalFile,
    accountObservationOperationLockFile:
      statePaths.accountObservationLockFile,
    refreshAccounting: refreshReplaySafeAccountingCache,
    accountingCacheFile: statePaths.accountingCacheFile,
  }),
  onboardingProvider = () => inspectLocalOnboarding({
    codexHome,
    stateRoot,
    explicitRefresh: true,
    customCodexHomeConfigured:
      typeof environment.CODEX_HOME === "string"
      && environment.CODEX_HOME.length > 0,
  }),
  refreshTimeoutMs = 300_000,
  centralOrigin = environment.USAGE_MONITOR_CENTRAL_ORIGIN ?? null,
  centralFetch = globalThis.fetch,
  contributionPreviewProvider = async () => ({ status: "not_configured" }),
  contributionPreparationRunner = null,
  contributionPreparationOptions = {},
  contributionPreparationCreateKeychainBackend = undefined,
  developmentExportSecretFile =
    environment[DEVELOPMENT_IDENTITY_FILE_ENV] ?? null,
  developmentIdentityOptIn =
    environment[DEVELOPMENT_IDENTITY_OPT_IN_ENV] ?? null,
  contributionQueueFile,
  contributionSyncStatusProvider = () => inspectContributionSyncQueue({
    queueFile: contributionQueueFile,
  }),
  preparedContributionDirectory,
  contributionServiceOrigin = centralOrigin,
  contributionDeviceBackendFactory =
    createProductionContributionDeviceBackend,
  contributionDevicePairingProvider = null,
  contributionSyncNextProvider = null,
  contributionSyncExactReviewProvider = null,
  contributionSyncOnceRunner = null,
  automaticContributionRetirementRunner = null,
  contributionSyncPauseSetter = null,
  contributionSyncTimeoutMs = 60_000,
  appleIdentityHandoffLifetimeMs = APPLE_IDENTITY_HANDOFF_LIFETIME_MS,
  automaticContributionController = null,
  automaticContributionOptions = {},
  onError = () => {},
} = {}) {
  if (!environment || typeof environment !== "object"
      || Array.isArray(environment)) {
    throw new TypeError("environment must be an object");
  }
  if (!dataStore || typeof dataStore.initialize !== "function") {
    throw new TypeError("dataStore.initialize must be a function");
  }
  if (typeof onboardingProvider !== "function") {
    throw new TypeError("onboardingProvider must be a function");
  }
  if (typeof contributionPreviewProvider !== "function") {
    throw new TypeError("contributionPreviewProvider must be a function");
  }
  if (contributionPreparationRunner !== null
      && typeof contributionPreparationRunner !== "function") {
    throw new TypeError(
      "contributionPreparationRunner must be a function or null",
    );
  }
  if (!contributionPreparationOptions
      || typeof contributionPreparationOptions !== "object"
      || Array.isArray(contributionPreparationOptions)) {
    throw new TypeError("contributionPreparationOptions must be an object");
  }
  if (contributionPreparationCreateKeychainBackend !== undefined
      && typeof contributionPreparationCreateKeychainBackend !== "function") {
    throw new TypeError(
      "contributionPreparationCreateKeychainBackend must be a function",
    );
  }
  if (!automaticContributionOptions
      || typeof automaticContributionOptions !== "object"
      || Array.isArray(automaticContributionOptions)) {
    throw new TypeError("automaticContributionOptions must be an object");
  }
  if (automaticContributionController !== null
      && (!automaticContributionController
        || typeof automaticContributionController !== "object"
        || typeof automaticContributionController.start !== "function"
        || typeof automaticContributionController.stop !== "function"
        || typeof automaticContributionController.inspect !== "function"
        || typeof automaticContributionController.enable !== "function"
        || typeof automaticContributionController.disable !== "function"
        || typeof automaticContributionController
          .recordReviewedManualAcceptance !== "function")) {
    throw new TypeError("automaticContributionController is invalid");
  }
  const developmentIdentity = resolveDevelopmentIdentityConfiguration({
    file: developmentExportSecretFile,
    optIn: developmentIdentityOptIn,
    environmentExportSecretPresent:
      Object.hasOwn(environment, EXPORT_IDENTITY_ENV),
  });
  if (typeof contributionSyncStatusProvider !== "function") {
    throw new TypeError("contributionSyncStatusProvider must be a function");
  }
  if (typeof contributionQueueFile !== "string"
      || contributionQueueFile.length < 1) {
    throw new TypeError("contributionQueueFile must be a non-empty string");
  }
  if (preparedContributionDirectory !== null
      && typeof preparedContributionDirectory !== "string") {
    throw new TypeError("preparedContributionDirectory must be a string or null");
  }
  if (contributionServiceOrigin !== null
      && typeof contributionServiceOrigin !== "string") {
    throw new TypeError("contributionServiceOrigin must be a string or null");
  }
  if (typeof contributionDeviceBackendFactory !== "function"
      || (contributionDevicePairingProvider !== null
        && typeof contributionDevicePairingProvider !== "function")
      || (contributionSyncNextProvider !== null
        && typeof contributionSyncNextProvider !== "function")
      || (contributionSyncExactReviewProvider !== null
        && typeof contributionSyncExactReviewProvider !== "function")
      || (contributionSyncOnceRunner !== null
        && typeof contributionSyncOnceRunner !== "function")
      || (automaticContributionRetirementRunner !== null
        && typeof automaticContributionRetirementRunner !== "function")
      || (contributionSyncPauseSetter !== null
        && typeof contributionSyncPauseSetter !== "function")
      || !Number.isSafeInteger(contributionSyncTimeoutMs)
      || contributionSyncTimeoutMs < 1_000
      || contributionSyncTimeoutMs > 5 * 60_000) {
    throw new TypeError("contribution sync controls are invalid");
  }
  if (!Number.isSafeInteger(appleIdentityHandoffLifetimeMs)
      || appleIdentityHandoffLifetimeMs < 1
      || appleIdentityHandoffLifetimeMs > 60 * 60_000) {
    throw new TypeError("appleIdentityHandoffLifetimeMs is invalid");
  }
  const nextContribution = contributionSyncNextProvider
    ?? (preparedContributionDirectory === null
      ? async () => null
      : () => inspectNextContributionSyncUpload({
        directory: preparedContributionDirectory,
        queueFile: contributionQueueFile,
      }));
  const pairContributionDevice = contributionDevicePairingProvider
    ?? (contributionServiceOrigin === null
      ? null
      : ({ pairingCode }) => claimContributionDevicePairing({
        origin: contributionServiceOrigin,
        pairingCode,
        capabilityOptions: {
          backend: contributionDeviceBackendFactory(),
          stateFile: statePaths.contributionDeviceStateFile,
        },
      }));
  const reviewExactContribution = contributionSyncExactReviewProvider
    ?? (preparedContributionDirectory === null
      ? async () => null
      : () => inspectExactNextContributionSyncUpload({
        directory: preparedContributionDirectory,
        queueFile: contributionQueueFile,
      }));
  const runContributionPass = contributionSyncOnceRunner
    ?? (preparedContributionDirectory === null
        || contributionServiceOrigin === null
      ? async () => null
      : ({
        signal,
        reviewedJob,
        preparedSetId,
        maximumJobs = LOCAL_SYNC_MAXIMUM_JOBS,
        maximumReservedUploadBytes =
          LOCAL_SYNC_MAXIMUM_RESERVED_UPLOAD_BYTES,
      }) => runContributionSyncQueueOnce({
        directory: preparedContributionDirectory,
        origin: contributionServiceOrigin,
        backend: contributionDeviceBackendFactory(),
        queueFile: contributionQueueFile,
        stateFile: statePaths.contributionDeviceStateFile,
        maximumJobs,
        maximumReservedUploadBytes,
        reviewedJob,
        preparedSetId,
        signal,
      }));
  const setContributionPaused = contributionSyncPauseSetter
    ?? (({ paused }) => setContributionSyncPaused({
      paused,
      queueFile: contributionQueueFile,
    }));
  const syncPreviewConfigured = preparedContributionDirectory !== null
    || contributionSyncNextProvider !== null;
  const contributionDevicePairingConfigured =
    pairContributionDevice !== null;
  const syncExactReviewConfigured = preparedContributionDirectory !== null
    || contributionSyncExactReviewProvider !== null;
  const syncDeliveryConfigured =
    (preparedContributionDirectory !== null
      && contributionServiceOrigin !== null)
    || contributionSyncOnceRunner !== null;
  const runContributionPreparation = contributionPreparationRunner
    ?? createLocalContributionPreparationRunner({
      ...contributionPreparationOptions,
      coverageProvider: () => (
        dataStore.getOverview()?.collector?.exportableCoveredAt
      ),
      ...(preparedContributionDirectory === null
        ? {}
        : { preparedSpoolDirectory: preparedContributionDirectory }),
      explicitSecretFile: developmentIdentity.explicitSecretFile,
      selectIdentity: ({ explicitSecretFile }) => (
        selectProductionParticipantIdentity({
          explicitSecretFile,
          environmentSecret: environment[EXPORT_IDENTITY_ENV],
          appStateSecretFile: statePaths.exportParticipantSecretFile,
          ...(contributionPreparationCreateKeychainBackend === undefined
            ? {}
            : {
              createKeychainBackend:
                contributionPreparationCreateKeychainBackend,
            }),
        })
      ),
    });
  let contributionPreparationInProgress = false;
  let contributionSyncInProgress = false;
  const runAutomaticContributionRetirement =
    automaticContributionRetirementRunner
    ?? (preparedContributionDirectory === null
      ? async () => ({
        retiredSets: 0,
        retiredJobs: 0,
        interrupted: false,
        networkActivity: false,
      })
      : ({ protectedPreparedSetIds, signal }) =>
        retireAcceptedContributionArtifacts({
          preparedSpoolDirectory: preparedContributionDirectory,
          reviewArchiveDirectory:
            contributionPreparationOptions.reviewArchiveDirectory,
          queueFile: contributionQueueFile,
          protectedPreparedSetIds,
          signal,
        }));
  const runAutomaticContributionPreparation = async (request) => {
    if (contributionPreparationInProgress) {
      const error = new Error("preparation_in_progress");
      error.code = "preparation_in_progress";
      throw error;
    }
    contributionPreparationInProgress = true;
    try {
      return await runContributionPreparation(request);
    } finally {
      contributionPreparationInProgress = false;
    }
  };
  const runAutomaticContributionUpload = async ({
    signal,
    preparedSetId,
  }) => {
    if (contributionSyncInProgress) {
      const error = new Error("sync_in_progress");
      error.code = "sync_in_progress";
      error.retryable = true;
      throw error;
    }
    contributionSyncInProgress = true;
    try {
      return await runContributionPass({
        signal,
        preparedSetId,
        maximumJobs: LOCAL_AUTOMATIC_SYNC_MAXIMUM_JOBS,
        maximumReservedUploadBytes:
          LOCAL_AUTOMATIC_SYNC_MAXIMUM_RESERVED_UPLOAD_BYTES,
      });
    } finally {
      contributionSyncInProgress = false;
    }
  };
  const automaticContribution = automaticContributionController
    ?? createAutomaticContributionController({
      ...automaticContributionOptions,
      settingsFile: statePaths.automaticContributionSettingsFile,
      destinationOrigin: syncDeliveryConfigured
        ? contributionServiceOrigin
        : null,
      prepareRunner: runAutomaticContributionPreparation,
      uploadRunner: runAutomaticContributionUpload,
      maintenanceRunner: runAutomaticContributionRetirement,
    });
  let automaticContributionInstanceLock = null;
  let automaticContributionInstanceLockRelease = null;
  let automaticContributionShutdown = null;
  let initializationPromise = null;
  const releaseAutomaticContributionInstanceLock = () => {
    if (automaticContributionInstanceLockRelease !== null) {
      return automaticContributionInstanceLockRelease;
    }
    const lock = automaticContributionInstanceLock;
    automaticContributionInstanceLock = null;
    automaticContributionInstanceLockRelease = Promise.resolve(
      lock?.release(),
    );
    return automaticContributionInstanceLockRelease;
  };
  const shutdownAutomaticContribution = () => {
    if (automaticContributionShutdown === null) {
      automaticContributionShutdown = (async () => {
        await automaticContribution.stop();
        await releaseAutomaticContributionInstanceLock();
      })();
    }
    return automaticContributionShutdown;
  };
  const refresh = new LocalCompanionRefreshController({
    runner: refreshRunner,
    dataStore,
    timeoutMs: refreshTimeoutMs,
  });
  const centralProxy = createLocalCentralProxy({
    centralOrigin,
    fetchImpl: centralFetch,
  });
  const participantRelay = createParticipantRelay({
    centralOrigin,
    fetchImpl: centralFetch,
  });
  let reviewedContributionAuthorization = null;
  // Latest Apple identity token handed over by the native app, held only in
  // process memory for one bounded window and consumed by a single dashboard
  // read. It is never written to disk or echoed back by the storing request.
  let appleIdentityHandoff = null;

  const server = createServer(async (request, response) => {
    try {
      if (!isLoopbackPeer(request)) {
        sendError(response, 403, "loopback_required");
        return;
      }
      if (!allowedHostHeader(server, request.headers.host)) {
        sendError(response, 403, "host_not_allowed");
        return;
      }
      let url;
      try {
        url = new URL(request.url, `http://${request.headers.host}`);
      } catch {
        sendError(response, 400, "invalid_request");
        return;
      }
      const path = url.pathname;
      if (path === GOOGLE_OAUTH_CALLBACK_PATH) {
        // The provider redirect legitimately carries ?code and ?state. This
        // is the only route that accepts a query string, and the server never
        // reads it: the inline page passes the values to the dashboard tab.
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        send(
          response,
          200,
          GOOGLE_OAUTH_CALLBACK_HTML,
          "text/html; charset=utf-8",
          { report: true },
        );
        return;
      }
      if (url.search !== "" || url.hash !== "") {
        sendError(response, 400, "invalid_request");
        return;
      }
      if (centralProxy.handles(path)) {
        if (request.method !== "GET" && !sameOrigin(request)) {
          sendError(response, 403, "central_request_not_authorized");
          return;
        }
        try {
          const upstream = await centralProxy.request(request, path);
          send(response, upstream.status, upstream.body, upstream.contentType, {
            headers: upstream.headers,
          });
        } catch (error) {
          const status = error.code === "central_service_not_configured" ? 503
            : error.code === "central_method_not_allowed" ? 405
              : error.code === "central_content_type_invalid" ? 415
                : error.code === "central_request_too_large" ? 413
                  : error.code === "central_request_invalid" ? 400
                    : error.code === "central_route_not_allowed" ? 404
                      : 502;
          sendError(response, status, error.code ?? "central_service_unavailable");
        }
        return;
      }
      if (participantRelay.handles(path)) {
        if (request.method !== "GET" && !sameOrigin(request)) {
          sendError(response, 403, "central_participant_request_not_authorized");
          return;
        }
        try {
          const upstream = await participantRelay.request(request, path);
          send(
            response,
            upstream.status,
            upstream.body,
            "application/json; charset=utf-8",
            { headers: upstream.headers },
          );
        } catch (error) {
          const status =
            error.code === "central_participant_method_not_allowed" ? 405
              : error.code === "central_participant_content_type_invalid" ? 415
                : error.code === "central_participant_request_too_large" ? 413
                  : error.code === "central_participant_request_invalid"
                    || error.code === "central_participant_cookie_invalid"
                    || error.code === "central_participant_csrf_invalid"
                    || error.code === "central_participant_authorization_invalid" ? 400
                    : error.code === "central_participant_route_not_allowed" ? 404
                      : 502;
          sendError(
            response,
            status,
            error.code ?? "central_participant_service_unavailable",
          );
        }
        return;
      }
      if (path.startsWith("/api/") && !API_ROUTES.has(path)) {
        sendError(response, 404, "not_found");
        return;
      }

      if (path === "/api/local/health") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        send(response, 200, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          status: "ready",
          mode: "loopback_real_local_evidence",
          remoteUploadEnabled: false,
          capabilities: {
            localDashboard: true,
            explicitRefresh: true,
            contributionPreview: true,
            contributionPreparation: true,
            contributionPreparationIdentityMode:
              developmentIdentity.mode,
            contributionSyncStatus: true,
            contributionSyncNext: syncPreviewConfigured,
            contributionDevicePairing:
              contributionDevicePairingConfigured,
            contributionSyncExactReview: syncExactReviewConfigured,
            contributionSyncActions: syncDeliveryConfigured,
            centralServiceProxy: centralProxy.enabled,
            centralParticipantRelay: participantRelay.enabled,
            arbitraryPathAccess: false,
            remoteProxy: false,
          },
        });
        return;
      }
      if (path === "/api/local/onboarding") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        let onboarding = null;
        try {
          onboarding = await onboardingProvider();
        } catch {
          // A failed source inspection is projected as closed, path-free
          // readiness rather than disclosing filesystem diagnostics.
        }
        send(response, 200, projectLocalOnboarding(onboarding));
        return;
      }
      if (path === "/api/local/identity/apple") {
        if (request.method === "POST") {
          const identityToken = await authorizeAppleIdentityHandoff(
            request,
            response,
          );
          if (identityToken === null) return;
          appleIdentityHandoff = {
            identityToken,
            expiresAt: Date.now() + appleIdentityHandoffLifetimeMs,
          };
          send(response, 200, {
            schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
            status: "stored",
            expiresAt: new Date(appleIdentityHandoff.expiresAt).toISOString(),
          });
          return;
        }
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        // Reading is a consuming mutation: the fixed local header keeps a
        // cross-site page from draining the one-use handoff with a bare GET.
        if (request.headers["x-usage-monitor-local"] !== "1") {
          sendError(response, 403, "identity_handoff_not_authorized");
          return;
        }
        const handoff = appleIdentityHandoff;
        appleIdentityHandoff = null;
        if (handoff === null || handoff.expiresAt < Date.now()) {
          sendError(response, 404, "not_found");
          return;
        }
        send(response, 200, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          identityToken: handoff.identityToken,
        });
        return;
      }
      if (path === "/api/local/overview") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        send(response, 200, dataStore.getOverview());
        return;
      }
      if (path === "/api/local/gradient") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        send(response, 200, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          gradient: dataStore.getGradient(),
        });
        return;
      }
      if (path === "/api/local/weekly") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        send(response, 200, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          weekly: dataStore.getWeekly(),
        });
        return;
      }
      if (path === "/api/local/quality") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        send(response, 200, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          quality: dataStore.getQuality(),
        });
        return;
      }
      if (path === "/api/local/reports") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        send(response, 200, dataStore.getReports());
        return;
      }
      if (path === "/api/local/contribution/preview") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        let preview;
        try {
          preview = await contributionPreviewProvider();
        } catch {
          preview = { status: "not_configured" };
        }
        send(response, 200, previewProjection(preview));
        return;
      }
      if (path === "/api/local/contribution/prepare") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        const preparationRequest = await authorizeContributionPreparation(
          request,
          response,
        );
        if (preparationRequest === null) return;
        if (contributionPreparationInProgress) {
          send(
            response,
            409,
            preparationErrorProjection(null, "preparation_in_progress"),
          );
          return;
        }
        contributionPreparationInProgress = true;
        try {
          const result = preparationResultProjection(
            await runContributionPreparation(preparationRequest),
          );
          if (result === null) {
            send(
              response,
              500,
              preparationErrorProjection(null, "preparation_failed"),
            );
            return;
          }
          send(response, 200, result);
        } catch (error) {
          const projected = preparationErrorProjection(error);
          send(
            response,
            preparationErrorStatus(projected.errorCode),
            projected,
          );
        } finally {
          contributionPreparationInProgress = false;
        }
        return;
      }
      if (path === "/api/local/contribution/automatic-settings") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        try {
          send(response, 200, await automaticContribution.inspect());
        } catch {
          sendError(
            response,
            500,
            "automatic_contribution_settings_unavailable",
          );
        }
        return;
      }
      if (path === "/api/local/contribution/automatic-enable") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        const enableRequest = await authorizeAutomaticContributionEnable(
          request,
          response,
        );
        if (enableRequest === null) return;
        try {
          send(
            response,
            200,
            await automaticContribution.enable(enableRequest),
          );
        } catch (error) {
          const code = error?.code;
          if (code === "automatic_contribution_not_configured") {
            sendError(
              response,
              409,
              "automatic_contribution_not_configured",
            );
          } else if (
            code === "automatic_contribution_first_review_required"
          ) {
            sendError(
              response,
              409,
              "automatic_contribution_first_review_required",
            );
          } else if (
            code === "automatic_contribution_consent_binding_mismatch"
          ) {
            sendError(
              response,
              409,
              "automatic_contribution_consent_binding_mismatch",
            );
          } else {
            sendError(
              response,
              500,
              "automatic_contribution_settings_unavailable",
            );
          }
        }
        return;
      }
      if (path === "/api/local/contribution/automatic-disable") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        if (!await authorizeLocalMutation(
          request,
          response,
          "automatic_contribution_not_authorized",
        )) return;
        try {
          send(response, 200, await automaticContribution.disable());
        } catch {
          sendError(
            response,
            500,
            "automatic_contribution_settings_unavailable",
          );
        }
        return;
      }
      if (path === "/api/local/contribution/sync-status") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        let status;
        try {
          status = await contributionSyncStatusProvider();
        } catch {
          status = null;
        }
        send(response, 200, syncStatusProjection(status));
        return;
      }
      if (path === "/api/local/contribution/sync-next") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        if (!await authorizeLocalMutation(
          request,
          response,
          "sync_preview_not_authorized",
        )) return;
        let preview;
        try {
          preview = await nextContribution();
        } catch {
          preview = null;
        }
        send(response, 200, syncNextProjection(preview, {
          previewConfigured: syncPreviewConfigured,
          deliveryConfigured: syncDeliveryConfigured,
        }));
        return;
      }
      if (path === "/api/local/contribution/device-pair") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        const pairingCode = await authorizeContributionDevicePairing(
          request,
          response,
        );
        if (pairingCode === null) return;
        if (!contributionDevicePairingConfigured) {
          sendError(
            response,
            409,
            "contribution_device_pairing_not_configured",
          );
          return;
        }
        try {
          const paired = await pairContributionDevice({ pairingCode });
          const expiresAt = nullableInstant(paired?.expiresAt);
          if (paired?.status !== "paired"
              || paired?.scope !== "upload_registration"
              || expiresAt === null) {
            throw new Error("pairing response invalid");
          }
          send(response, 200, {
            schemaVersion: "local-contribution-device-pairing-v0.1",
            status: "paired",
            scope: "upload_registration",
            expiresAt,
            includesCredentials: false,
            includesIdentifiers: false,
          });
        } catch (error) {
          const recoveryRequired =
            contributionDeviceRecoveryRequired(error);
          sendError(
            response,
            recoveryRequired ? 409 : 502,
            recoveryRequired
              ? "contribution_device_recovery_required"
              : "contribution_device_pairing_failed",
          );
        }
        return;
      }
      if (path === "/api/local/contribution/sync-inspect-exact") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        if (!await authorizeLocalMutation(
          request,
          response,
          "exact_review_not_authorized",
        )) return;
        let review;
        try {
          review = await reviewExactContribution();
        } catch {
          review = null;
        }
        const binding = review?.reviewBinding;
        const bindingValid = review?.state === "ready"
          && REVIEW_JOB_ID.test(binding?.jobId ?? "")
          && SHA256.test(binding?.contributionSha256 ?? "");
        const reviewToken = bindingValid
          ? randomBytes(32).toString("base64url")
          : null;
        reviewedContributionAuthorization = bindingValid
          ? {
            reviewToken,
            reviewedJob: {
              jobId: binding.jobId,
              contributionSha256: binding.contributionSha256,
            },
            expiresAt: Date.now() + REVIEW_AUTHORIZATION_LIFETIME_MS,
          }
          : null;
        send(response, 200, syncExactReviewProjection(review, {
          configured: syncExactReviewConfigured,
          reviewToken,
        }));
        return;
      }
      if (path === "/api/local/contribution/sync-once") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        const reviewToken = await authorizeReviewedContributionMutation(
          request,
          response,
          "sync_not_authorized",
        );
        if (reviewToken === null) return;
        const authorization = reviewedContributionAuthorization;
        reviewedContributionAuthorization = null;
        if (authorization === null
            || authorization.expiresAt < Date.now()
            || authorization.reviewToken !== reviewToken) {
          sendError(response, 409, "review_expired_or_changed");
          return;
        }
        if (contributionSyncInProgress) {
          sendError(response, 409, "sync_in_progress");
          return;
        }
        contributionSyncInProgress = true;
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          contributionSyncTimeoutMs,
        );
        let result;
        try {
          result = await runContributionPass({
            signal: controller.signal,
            reviewedJob: authorization.reviewedJob,
          });
        } catch {
          sendError(response, 502, "sync_failed");
          return;
        } finally {
          clearTimeout(timeout);
          contributionSyncInProgress = false;
        }
        if (result === null) {
          sendError(response, 503, "sync_not_configured");
          return;
        }
        if (result.status === "completed"
            && Number.isSafeInteger(result.accepted)
            && result.accepted > 0) {
          try {
            await automaticContribution.recordReviewedManualAcceptance({
              status: result.status,
              accepted: result.accepted,
              preparedSet: result.preparedSet,
            });
          } catch {
            // Delivery already succeeded. Never misreport it as failed or invite
            // a duplicate send merely because the optional scheduler receipt
            // could not be persisted; automatic enablement remains closed.
            onError("automatic_contribution_bootstrap_persist_failed");
          }
        }
        send(response, 200, syncRunProjection(result));
        return;
      }
      if (path === "/api/local/contribution/sync-pause"
          || path === "/api/local/contribution/sync-resume") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        if (!await authorizeLocalMutation(
          request,
          response,
          "sync_control_not_authorized",
        )) return;
        if (contributionSyncInProgress) {
          sendError(response, 409, "sync_in_progress");
          return;
        }
        let status;
        try {
          status = await setContributionPaused({
            paused: path.endsWith("sync-pause"),
          });
        } catch {
          sendError(response, 500, "sync_control_failed");
          return;
        }
        send(response, 200, syncStatusProjection(status));
        return;
      }
      if (path === "/api/local/refresh") {
        if (request.method === "GET") {
          send(response, 200, {
            schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
            refresh: refresh.getStatus(),
          });
          return;
        }
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        if (!await authorizeLocalMutation(
          request,
          response,
          "refresh_not_authorized",
        )) return;
        if (!refresh.start()) {
          sendError(response, 409, "refresh_in_progress");
          return;
        }
        send(response, 202, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          refresh: refresh.getStatus(),
        });
        return;
      }
      if (path === "/api/local/refresh/cancel") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        if (!await authorizeLocalMutation(
          request,
          response,
          "refresh_cancel_not_authorized",
        )) return;
        if (!refresh.cancel()) {
          sendError(response, 409, "refresh_not_running");
          return;
        }
        send(response, 202, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          refresh: refresh.getStatus(),
        });
        return;
      }

      const report = REPORT_ROUTES[path];
      if (report) {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        try {
          const body = await readFixedFile(
            resourceRoot,
            report.file,
            MAX_REPORT_BYTES,
          );
          send(response, 200, body, report.type, { report: true });
        } catch {
          sendError(response, 404, "not_found");
        }
        return;
      }

      const staticFile = STATIC_FILES[path];
      if (staticFile) {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        try {
          const source = await readFixedFile(
            staticRoot,
            staticFile.file,
            MAX_STATIC_BYTES,
          );
          const body = staticFile.file === "index.html"
            ? stampSemanticOpenTarget(source)
            : source;
          send(response, 200, body, staticFile.type);
        } catch {
          sendError(response, 404, "not_found");
        }
        return;
      }
      sendError(response, 404, "not_found");
    } catch {
      onError("request_failed");
      if (!response.headersSent) sendError(response, 500, "internal_error");
      else response.destroy();
    }
  });
  server.once("close", () => {
    void shutdownAutomaticContribution().catch(() => {
      onError("automatic_contribution_lock_release_failed");
    });
  });

  return {
    server,
    dataStore,
    refresh,
    automaticContribution,
    [PARENT_WATCHDOG_PID]: parentWatchdogPid,
    async initialize() {
      if (initializationPromise === null) {
        initializationPromise = (async () => {
          automaticContributionInstanceLock =
            await acquireAutomaticContributionInstanceLock({
              lockFile: statePaths.automaticContributionLockFile,
            });
          try {
            await dataStore.initialize();
            await automaticContribution.start();
          } catch (error) {
            await shutdownAutomaticContribution().catch(() => {});
            throw error;
          }
        })();
      }
      return initializationPromise;
    },
    shutdownAutomaticContribution,
  };
}

export async function startLocalCompanionServer({
  port = 8787,
  host = LOOPBACK_HOST,
  terminateProcessOnParentDeath = false,
  ...options
} = {}) {
  if (host !== LOOPBACK_HOST) throw new TypeError("Local companion must bind to 127.0.0.1");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new TypeError("port is invalid");
  if (typeof terminateProcessOnParentDeath !== "boolean") {
    throw new TypeError("terminateProcessOnParentDeath must be a boolean");
  }
  const app = createLocalCompanionServer(options);
  const expectedParentPid = app[PARENT_WATCHDOG_PID];
  if (!declaredParentIsCurrent(expectedParentPid)) {
    throw parentWatchdogConfigurationError();
  }
  const parentWatchdog = startParentDeathWatchdog({
    server: app.server,
    expectedParentPid,
    terminateProcess: terminateProcessOnParentDeath,
  });
  try {
    await app.initialize();
    if (!declaredParentIsCurrent(expectedParentPid)) {
      throw parentWatchdogConfigurationError();
    }
    await new Promise((resolveListen, rejectListen) => {
      app.server.once("error", rejectListen);
      app.server.listen(port, host, () => {
        app.server.off("error", rejectListen);
        resolveListen();
      });
    });
    if (!declaredParentIsCurrent(expectedParentPid)) {
      throw parentWatchdogConfigurationError();
    }
  } catch (error) {
    parentWatchdog.stop();
    await closeHttpServer(app.server).catch(() => {});
    await app.shutdownAutomaticContribution().catch(() => {});
    throw error;
  }
  return {
    ...app,
    host,
    port: actualPort(app.server),
    close: async () => {
      parentWatchdog.stop();
      await closeHttpServer(app.server);
      await app.shutdownAutomaticContribution();
    },
  };
}

if (process.argv[1]
    && resolve(process.argv[1]) === LOCAL_COMPANION_MODULE_FILE) {
  const requestedPort = Number(process.env.USAGE_MONITOR_PORT ?? 8787);
  const app = await startLocalCompanionServer({
    port: requestedPort,
    terminateProcessOnParentDeath: true,
  });
  process.stdout.write(`USAGE_MONITOR_READY http://${app.host}:${app.port}/\n`);
  let closing = false;
  const close = () => {
    if (closing) process.exit(0);
    closing = true;
    app.server.closeAllConnections?.();
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
