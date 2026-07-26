// Match the central Worker's encrypted-envelope ceiling. The relay still
// accepts only fixed JSON routes and never chooses an upstream from request
// data.
const MAX_CENTRAL_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_CENTRAL_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

const EXACT_ROUTES = new Map([
  ["/api/health", new Set(["GET"])],
  ["/api/v1/enroll", new Set(["POST"])],
  ["/api/v1/recover", new Set(["POST"])],
  ["/api/v1/envelope-key", new Set(["GET"])],
  ["/api/v1/contributions", new Set(["POST"])],
  ["/api/v1/me/export", new Set(["GET"])],
  ["/api/v1/me/stats", new Set(["GET"])],
  ["/api/v1/me/insights", new Set(["GET"])],
  ["/api/v1/stats/aggregate", new Set(["GET"])],
  ["/api/v1/community/insights", new Set(["GET"])],
  ["/api/v1/me", new Set(["GET", "DELETE"])],
]);

const CONTRIBUTION_PREFIX = "/api/v1/contributions/";
const CONTRIBUTION_ID = /^contribution:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function centralRouteMethods(path) {
  if (EXACT_ROUTES.has(path)) return EXACT_ROUTES.get(path);
  if (path.startsWith(CONTRIBUTION_PREFIX)) {
    let contributionId = "";
    try {
      contributionId = decodeURIComponent(path.slice(CONTRIBUTION_PREFIX.length));
    } catch {
      return null;
    }
    if (CONTRIBUTION_ID.test(contributionId)) return new Set(["GET", "DELETE"]);
  }
  return null;
}

function normalizedCentralOrigin(value) {
  if (value === null || value === undefined || value === "") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("centralOrigin must be an absolute HTTP or HTTPS origin");
  }
  if (!["http:", "https:"].includes(url.protocol)
      || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("centralOrigin must be an absolute HTTP or HTTPS origin");
  }
  return url.origin;
}

async function boundedRequestBody(request) {
  if (["GET", "HEAD", "DELETE"].includes(request.method)) {
    const declared = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > 0) throw fixedError("central_request_invalid");
    return null;
  }
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw fixedError("central_content_type_invalid");
  }
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_CENTRAL_REQUEST_BYTES) {
    throw fixedError("central_request_too_large");
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_CENTRAL_REQUEST_BYTES) throw fixedError("central_request_too_large");
    chunks.push(chunk);
  }
  if (bytes === 0) throw fixedError("central_request_invalid");
  return Buffer.concat(chunks);
}

async function boundedResponseBody(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CENTRAL_RESPONSE_BYTES) {
    throw fixedError("central_response_too_large");
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
      if (total > MAX_CENTRAL_RESPONSE_BYTES) {
        await reader.cancel();
        throw fixedError("central_response_too_large");
      }
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export function createLocalCentralProxy({
  centralOrigin = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const origin = normalizedCentralOrigin(centralOrigin);
  if (origin !== null && typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new TypeError("central proxy timeoutMs must be between 1,000 and 60,000");
  }
  return {
    enabled: origin !== null,
    handles(path) {
      return centralRouteMethods(path) !== null;
    },
    async request(request, path) {
      if (origin === null) throw fixedError("central_service_not_configured");
      const allowedMethods = centralRouteMethods(path);
      if (allowedMethods === null) throw fixedError("central_route_not_allowed");
      if (!allowedMethods.has(request.method)) throw fixedError("central_method_not_allowed");
      const body = await boundedRequestBody(request);
      const headers = { Accept: "application/json" };
      const authorization = request.headers.authorization;
      if (typeof authorization === "string" && authorization.length <= 4_096) {
        headers.Authorization = authorization;
      }
      if (body !== null) headers["Content-Type"] = "application/json";
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
        throw fixedError("central_service_unavailable");
      } finally {
        clearTimeout(timeout);
      }
      const contentType = upstream.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (contentType !== "application/json") throw fixedError("central_response_invalid");
      const responseBody = await boundedResponseBody(upstream);
      try {
        JSON.parse(responseBody.toString("utf8"));
      } catch {
        throw fixedError("central_response_invalid");
      }
      const replayed = upstream.headers.get("idempotency-replayed");
      return {
        status: upstream.status,
        body: responseBody,
        contentType: "application/json; charset=utf-8",
        headers: replayed === "true" ? { "Idempotency-Replayed": "true" } : {},
      };
    },
  };
}
