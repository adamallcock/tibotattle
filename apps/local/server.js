import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_COMPANION_REPORT_FILES,
  LOCAL_COMPANION_SCHEMA_VERSION,
  LocalCompanionDataStore,
  buildLocalCompanionSnapshot,
} from "../../src/local-companion-data.js";
import { createLocalCentralProxy } from "../../src/local-companion-central-proxy.js";
import {
  LocalCompanionRefreshController,
  createLocalCollectorRefreshRunner,
} from "../../src/local-companion-refresh.js";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_REQUEST_BODY_BYTES = 1_024;
const MAX_STATIC_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;

const STATIC_FILES = Object.freeze({
  "/": Object.freeze({ file: "index.html", type: "text/html; charset=utf-8" }),
  "/index.html": Object.freeze({ file: "index.html", type: "text/html; charset=utf-8" }),
  "/app.js": Object.freeze({ file: "app.js", type: "text/javascript; charset=utf-8" }),
  "/data-client.js": Object.freeze({ file: "data-client.js", type: "text/javascript; charset=utf-8" }),
  "/lib.js": Object.freeze({ file: "lib.js", type: "text/javascript; charset=utf-8" }),
  "/styles.css": Object.freeze({ file: "styles.css", type: "text/css; charset=utf-8" }),
});

const REPORT_ROUTES = Object.freeze(
  Object.fromEntries(Object.entries(LOCAL_COMPANION_REPORT_FILES).map(([route, file]) => [
    route,
    Object.freeze({ file, type: "text/html; charset=utf-8" }),
  ])),
);

const API_ROUTES = new Set([
  "/api/local/health",
  "/api/local/overview",
  "/api/local/gradient",
  "/api/local/weekly",
  "/api/local/quality",
  "/api/local/reports",
  "/api/local/refresh",
  "/api/local/contribution/preview",
]);

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

async function readEmptyJsonObject(request) {
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
  if (!isEmpty && !isFixedUserRequest) {
    const error = new Error("invalid_request");
    error.code = "invalid_request";
    throw error;
  }
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

function finiteNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
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

export function createLocalCompanionServer({
  root = process.cwd(),
  staticRoot = resolve(root, "apps", "web", "public"),
  dataStore = new LocalCompanionDataStore({
    builder: () => buildLocalCompanionSnapshot({ root }),
  }),
  refreshRunner = createLocalCollectorRefreshRunner(),
  refreshTimeoutMs = 60_000,
  centralOrigin = process.env.USAGE_MONITOR_CENTRAL_ORIGIN ?? null,
  centralFetch = globalThis.fetch,
  contributionPreviewProvider = async () => ({ status: "not_configured" }),
  onError = () => {},
} = {}) {
  if (!dataStore || typeof dataStore.initialize !== "function") {
    throw new TypeError("dataStore.initialize must be a function");
  }
  if (typeof contributionPreviewProvider !== "function") {
    throw new TypeError("contributionPreviewProvider must be a function");
  }
  const refresh = new LocalCompanionRefreshController({
    runner: refreshRunner,
    dataStore,
    timeoutMs: refreshTimeoutMs,
  });
  const centralProxy = createLocalCentralProxy({
    centralOrigin,
    fetchImpl: centralFetch,
  });

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
      if (url.search !== "" || url.hash !== "") {
        sendError(response, 400, "invalid_request");
        return;
      }
      const path = url.pathname;
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
            centralServiceProxy: centralProxy.enabled,
            arbitraryPathAccess: false,
            remoteProxy: false,
          },
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
        if (!sameOrigin(request) || request.headers["x-usage-monitor-local"] !== "1") {
          sendError(response, 403, "refresh_not_authorized");
          return;
        }
        try {
          await readEmptyJsonObject(request);
        } catch (error) {
          const status = error.code === "unsupported_media_type"
            ? 415
            : error.code === "request_too_large" ? 413 : 400;
          sendError(response, status, error.code ?? "invalid_request");
          return;
        }
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

      const report = REPORT_ROUTES[path];
      if (report) {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        try {
          const body = await readFixedFile(root, report.file, MAX_REPORT_BYTES);
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
          const body = await readFixedFile(staticRoot, staticFile.file, MAX_STATIC_BYTES);
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

  return {
    server,
    dataStore,
    refresh,
    async initialize() {
      await dataStore.initialize();
    },
  };
}

export async function startLocalCompanionServer({
  port = 8787,
  host = LOOPBACK_HOST,
  ...options
} = {}) {
  if (host !== LOOPBACK_HOST) throw new TypeError("Local companion must bind to 127.0.0.1");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new TypeError("port is invalid");
  const app = createLocalCompanionServer(options);
  await app.initialize();
  await new Promise((resolveListen, rejectListen) => {
    app.server.once("error", rejectListen);
    app.server.listen(port, host, () => {
      app.server.off("error", rejectListen);
      resolveListen();
    });
  });
  return {
    ...app,
    host,
    port: actualPort(app.server),
    close: () => new Promise((resolveClose, rejectClose) => {
      app.server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const requestedPort = Number(process.env.USAGE_MONITOR_PORT ?? 8787);
  const app = await startLocalCompanionServer({ port: requestedPort });
  process.stdout.write(`Usage Monitor is available at http://${app.host}:${app.port}/\n`);
  const close = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

export const LOCAL_COMPANION_STATIC_FILES = STATIC_FILES;
export const LOCAL_COMPANION_REPORT_ROUTES = REPORT_ROUTES;
