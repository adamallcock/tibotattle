/**
 * Edge proxy core for gcp mode (EDGE_UPSTREAM_MODE=gcp).
 *
 * In gcp mode the production Worker is a thin edge in front of the
 * IAM-private Cloud Run origin. This module is that edge's request path. All
 * I/O is injected: the Worker's own handleRequest (for the classes the edge
 * answers itself) and contribution preflight, the Google ID-token source, the
 * Workers Rate Limiting bindings, and the network fetcher. It never imports
 * index.ts; the entry module (edge-entry.ts) owns that import and passes both
 * functions in.
 *
 * Per request:
 * 1. classifyEdgeRequest decides, without I/O, whether the edge answers the
 *    request itself (www, assets, unknown API paths, the Apple path, admin API
 *    paths on the apex, a method outside the route registry, community/daily
 *    while PUBLIC_ANALYTICS_MODE is not 'enabled'), serves the Sparkle guard
 *    with guardEnv, or forwards it. Local classes and the guard go to the
 *    unchanged handleRequest and never touch a limiter, the token source or
 *    the upstream.
 * 2. A forwarded admin-host request first passes the same Access chokepoint
 *    handleRequest runs (verifyAdminAccessAssertion, then authorizeAdminEmail).
 *    A refusal is rendered as handleRequest's catch renders it, without the
 *    diagnostic write.
 * 3. A policy route's pre-admission guard (EDGE_PRE_ADMISSION_GUARDS) runs
 *    next: the refusals the Worker gives before its limiter that depend only
 *    on the request (a session cookie on the accountless routes,
 *    assertSameOrigin on enrollment and sign-in start, and the contribution
 *    preflight). A refusal is answered locally, rendered as handleRequest
 *    renders it, so it spends no budget and never reaches the origin.
 * 4. A declared content-length above EDGE_MAX_FORWARD_BODY_BYTES on a request
 *    whose body is forwarded is refused locally with 413 BODY_TOO_LARGE before
 *    any budget is spent. Anything else about the header is the origin's to
 *    judge. A body is never buffered.
 * 5. Address-keyed admission runs here (evaluateEdgeAdmission); only its
 *    purpose and outcome travel to the origin.
 * 6. The upstream request carries only the contract's allowlisted client
 *    headers, the contract headers, the edge-minted ID token and x-real-ip
 *    set to the constant EDGE_SUBREQUEST_REAL_IP. This module never sets a
 *    value derived from the client address or the edge client-key secret.
 *    Cloudflare itself adds CF-Connecting-IP, carrying the client address, to
 *    a subrequest for a non-Cloudflare host (edge-google-subrequest.ts).
 * 7. Only a response carrying the origin marker passes through, with the
 *    contract's dropped headers removed and each Set-Cookie kept separate.
 *    A network or TLS failure, a headers timeout, a token failure or an
 *    unmarked response becomes 503 EDGE_ORIGIN_UNAVAILABLE with retry-after.
 * 8. For the admin overview, the Cloudflare download analytics are read here,
 *    in parallel with the forward, and merged into the origin's body.
 *
 * Logging is content-free JSON: an event name, the edge request id, the
 * method, the route class and a code or reason. Never a URL, query, host,
 * address, cookie, credential, token, callback query, analytics row or body.
 */
import { authorizeAdminEmail, verifyAdminAccessAssertion } from "./admin-access";
import { adminHostname, canonicalPublicRedirectUrl } from "./admin-ui";
import { JSON_HEADERS } from "./constants";
import {
  cloudflareDistributionFromSegments,
  readCloudflareDistributionSegments,
} from "./distribution-analytics";
import type { CloudflareDistributionSegment } from "./distribution-analytics";
import { evaluateEdgeAdmission } from "./edge-admission-policy";
import type { EdgeAdmissionLimiters } from "./edge-admission-policy";
import { EDGE_SUBREQUEST_REAL_IP, EDGE_SUBREQUEST_REAL_IP_HEADER } from "./edge-google-subrequest";
import {
  ADMIN_ONLY_FORWARDED_REQUEST_HEADERS,
  DROPPED_RESPONSE_HEADERS,
  EDGE_HEADERS,
  EDGE_MAX_FORWARD_BODY_BYTES,
  EDGE_MAX_OVERVIEW_MERGE_BYTES,
  EDGE_MIN_CLIENT_KEY_SECRET_LENGTH,
  EDGE_ORIGIN_UNAVAILABLE,
  EDGE_UNAVAILABLE_RETRY_AFTER_SECONDS,
  FORWARDED_REQUEST_HEADERS,
  GOOGLE_CALLBACK_PATH,
  MAX_GOOGLE_CALLBACK_URL_LENGTH,
  encodeEdgeAdmission,
  parseEdgeOriginConfiguration,
  validGoogleCallbackQuery,
} from "./edge-origin-contract";
import type { EdgeHostKind, EdgeOriginConfiguration } from "./edge-origin-contract";
import { ApiError, errorResponse } from "./errors";
import { publicAnalyticsEnabled } from "./public-analytics-gate";
import { matchWorkerRoute } from "./route-registry";
import type {
  ExactWorkerRouteId,
  WorkerRouteMatch,
  WorkerRouteMethod,
} from "./route-registry";
import { assertSameOrigin, hasSessionCookie } from "./session";

// ---------------------------------------------------------------------------
// Public vocabulary

/** The code of every upstream failure the edge maps to 503. */
export const EDGE_PROXY_UPSTREAM_FAILURE_CODES = Object.freeze([
  "EDGE_TOKEN_UNAVAILABLE",
  "EDGE_UPSTREAM_TIMEOUT",
  "EDGE_UPSTREAM_NETWORK",
  "EDGE_UPSTREAM_UNMARKED",
] as const);
export type EdgeProxyUpstreamFailureCode = (typeof EDGE_PROXY_UPSTREAM_FAILURE_CODES)[number];

/** The only log events this module emits. */
export const EDGE_PROXY_LOG_EVENTS = Object.freeze([
  "edge_upstream_unavailable",
  "edge_admin_chokepoint_refused",
  "edge_distribution_merge_skipped",
] as const);
export type EdgeProxyLogEvent = (typeof EDGE_PROXY_LOG_EVENTS)[number];

/** Why an admin overview kept the origin's bytes; logged, never returned. */
export const EDGE_DISTRIBUTION_MERGE_SKIP_REASONS = Object.freeze([
  "content_type",
  "too_large",
  "body_unreadable",
  "invalid_json",
  "shape",
  "segments_unavailable",
] as const);
export type EdgeDistributionMergeSkipReason =
  (typeof EDGE_DISTRIBUTION_MERGE_SKIP_REASONS)[number];

/** Thrown by createEdgeOriginProxy for any malformed option; content-free. */
export const EDGE_PROXY_OPTIONS_INVALID = "EDGE_PROXY_OPTIONS_INVALID";

/**
 * The six admin API route ids. handleRequest answers them 404 on any host but
 * the admin host and runs them behind the Access chokepoint there
 * (index.ts handleRequest, admin hostname branch).
 */
export const EDGE_ADMIN_API_ROUTE_IDS = Object.freeze([
  "admin_overview",
  "admin_metrics_history",
  "admin_community_allowance_preview",
  "admin_database_health",
  "admin_reconstruction_progress",
  "admin_action",
] as const satisfies readonly ExactWorkerRouteId[]);

/**
 * The request-only refusals d43c8f92 gives on a policy route before it calls
 * its limiter, as the edge reproduces them before evaluateEdgeAdmission:
 * - session_cookie: the accountless handlers refuse a session cookie with
 *   401 AUTH_INVALID first (index.ts handleAccountlessEnrollment and its four
 *   siblings);
 * - same_origin: handleEnroll and both sign-in start handlers run
 *   assertSameOrigin first (403 CSRF_INVALID);
 * - contribution_preflight: handleContribution runs
 *   contributionRequestPreflight after its configuration checks.
 * Every later pre-limiter guard of these routes, and every guard of the other
 * policy routes, reads configuration or stored state (an enrollment mode, a
 * collection control, the publication control); those stay at the origin, and
 * the edge charges its budget for them (decision record, deviation 4).
 * test/edge-pre-admission-guards.spec.ts holds this map to handleRequest.
 * Frozen and prototype-free, like EDGE_ADMISSION_POLICY.
 */
export type EdgePreAdmissionGuard = "session_cookie" | "same_origin" | "contribution_preflight";

const PRE_ADMISSION_GUARD_ENTRIES = {
  accountless_enrollment: "session_cookie",
  accountless_ownership: "session_cookie",
  accountless_telemetry_v12_authorization: "session_cookie",
  accountless_telemetry_performance_authorization: "session_cookie",
  accountless_renewal: "session_cookie",
  enroll: "same_origin",
  identity_google_start: "same_origin",
  identity_apple_start: "same_origin",
  contributions: "contribution_preflight",
} as const satisfies Readonly<Partial<Record<ExactWorkerRouteId, EdgePreAdmissionGuard>>>;

export const EDGE_PRE_ADMISSION_GUARDS: Readonly<
  Partial<Record<ExactWorkerRouteId, EdgePreAdmissionGuard>>
> = Object.freeze(
  Object.assign(
    Object.create(null) as Record<string, EdgePreAdmissionGuard>,
    PRE_ADMISSION_GUARD_ENTRIES,
  ),
);

export type EdgeLocalReason =
  | "www"
  | "asset"
  | "unknown_api"
  | "apple_domain_association"
  | "admin_api_on_apex"
  | "method_not_allowed"
  | "publication_mode_disabled";

export type EdgeRequestClass =
  | Readonly<{ kind: "local"; reason: EdgeLocalReason; routeId: WorkerRouteMatch["id"] }>
  | Readonly<{ kind: "guard"; routeId: "sparkle_appcast_guard" }>
  | Readonly<{ kind: "forward"; routeId: ExactWorkerRouteId; hostKind: EdgeHostKind }>;

export interface EdgeIdTokenSource {
  getToken(): Promise<string>;
}

export interface EdgeDistributionConfiguration {
  readonly zoneId: string;
  readonly apiToken: string;
}

export interface EdgeProxyLogger {
  warn(line: string): void;
  error(line: string): void;
}

/**
 * The edge's only network seam. It receives every upstream forward and every
 * distribution analytics read as a Request.
 */
export type EdgeProxyFetcher = (request: Request) => Promise<Response>;

export interface EdgeOriginProxyOptions {
  /** From parseEdgeOriginConfiguration; re-validated here. */
  readonly config: EdgeOriginConfiguration;
  /** index.ts handleRequest, injected by the entry module. */
  readonly handleRequest: (request: Request, env: Env) => Promise<Response>;
  /**
   * index.ts contributionRequestPreflight, injected by the entry module. It
   * reads only the request's headers and whether it has a body, and throws
   * the Worker's ApiError for a request it refuses.
   */
  readonly contributionRequestPreflight: (request: Request) => unknown;
  readonly idTokenSource: EdgeIdTokenSource;
  /** Edge-only HMAC secret for client rate-limit keys; never forwarded. */
  readonly clientKeySecret: string;
  /** Read by binding name only, through evaluateEdgeAdmission. */
  readonly limiters: EdgeAdmissionLimiters;
  /** The Cloudflare analytics zone and token, or null outside production. */
  readonly distribution: EdgeDistributionConfiguration | null;
  /** Defaults to the global fetch, resolved at call time and called unbound. */
  readonly fetcher?: EdgeProxyFetcher;
  /** Defaults to console. */
  readonly logger?: EdgeProxyLogger;
  /** Epoch milliseconds; defaults to Date.now. */
  readonly clock?: () => number;
}

export type EdgeOriginProxy = (
  request: Request,
  localEnv: Env,
  guardEnv: Env,
) => Promise<Response>;

// ---------------------------------------------------------------------------
// Classification

const ADMIN_API_ROUTE_ID_SET: ReadonlySet<string> = new Set(EDGE_ADMIN_API_ROUTE_IDS);

function local(reason: EdgeLocalReason, routeId: WorkerRouteMatch["id"]): EdgeRequestClass {
  return Object.freeze({ kind: "local", reason, routeId });
}

/**
 * Pure classification of one request against the edge-local env, in
 * handleRequest's own order: the www redirect first, then the host and route
 * classes, then the registry method envelope, then the publication pre-gate.
 * Every non-admin host is treated as public, as handleRequest treats it.
 */
export function classifyEdgeRequest(request: Request, localEnv: Env): EdgeRequestClass {
  const url = new URL(request.url);
  const route = matchWorkerRoute(url.pathname);
  if (canonicalPublicRedirectUrl(url, localEnv) !== null) return local("www", route.id);
  if (route.kind === "asset") return local("asset", route.id);
  if (route.kind === "unknown_api") return local("unknown_api", route.id);
  if (route.id === "apple_domain_association") {
    return local("apple_domain_association", route.id);
  }
  const hostKind: EdgeHostKind = url.hostname === adminHostname(localEnv) ? "admin" : "apex";
  const adminApi = ADMIN_API_ROUTE_ID_SET.has(route.id);
  if (adminApi && hostKind === "apex") return local("admin_api_on_apex", route.id);
  // The admin API ids on the admin host keep every method: the origin runs
  // their own chokepoint and 405, after the edge's chokepoint below.
  if (!adminApi
      && route.methods !== "all"
      && !route.methods.includes(request.method as WorkerRouteMethod)) {
    return local("method_not_allowed", route.id);
  }
  // handleRequest answers this before dispatch and without a limiter; the
  // origin route does not read PUBLIC_ANALYTICS_MODE.
  if (route.id === "community_daily" && !publicAnalyticsEnabled(localEnv)) {
    return local("publication_mode_disabled", route.id);
  }
  if (route.id === "sparkle_appcast_guard") {
    return Object.freeze({ kind: "guard", routeId: route.id });
  }
  return Object.freeze({ kind: "forward", routeId: route.id, hostKind });
}

// ---------------------------------------------------------------------------
// Options

function invalidOptions(): never {
  throw new TypeError(EDGE_PROXY_OPTIONS_INVALID);
}

function validatedConfig(value: unknown): EdgeOriginConfiguration {
  if (value === null || typeof value !== "object") invalidOptions();
  const config = value as Partial<EdgeOriginConfiguration>;
  const settings: Readonly<Record<string, unknown>> = {
    EDGE_UPSTREAM_ORIGIN: config.upstreamOrigin,
    EDGE_ORIGIN_AUDIENCE: config.audience,
    EDGE_INVOKER_SERVICE_ACCOUNT: config.invokerServiceAccount,
    EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS: config.upstreamHeadersTimeoutSeconds,
  };
  const parsed = parseEdgeOriginConfiguration((name) =>
    Object.hasOwn(settings, name) ? settings[name] : undefined);
  if (parsed === null
      || parsed.upstreamOrigin !== config.upstreamOrigin
      || parsed.audience !== config.audience
      || parsed.invokerServiceAccount !== config.invokerServiceAccount
      || parsed.upstreamHeadersTimeoutSeconds !== config.upstreamHeadersTimeoutSeconds) {
    invalidOptions();
  }
  return parsed;
}

function validatedDistribution(value: unknown): EdgeDistributionConfiguration | null {
  if (value === null) return null;
  if (typeof value !== "object") invalidOptions();
  const zoneId = Reflect.get(value, "zoneId");
  const apiToken = Reflect.get(value, "apiToken");
  if (typeof zoneId !== "string" || zoneId.length === 0
      || typeof apiToken !== "string" || apiToken.length === 0) {
    invalidOptions();
  }
  return Object.freeze({ zoneId, apiToken });
}

function validatedLogger(value: unknown): EdgeProxyLogger {
  if (value === undefined) {
    return Object.freeze({
      warn: (line: string) => console.warn(line),
      error: (line: string) => console.error(line),
    });
  }
  if (value === null || typeof value !== "object"
      || typeof Reflect.get(value, "warn") !== "function"
      || typeof Reflect.get(value, "error") !== "function") {
    invalidOptions();
  }
  return value as EdgeProxyLogger;
}

function defaultFetcher(request: Request): Promise<Response> {
  // Resolved at call time and called as a plain function: workerd's fetch
  // throws "Illegal invocation" when called with a foreign `this`.
  const fetchFunction = globalThis.fetch;
  return fetchFunction(request);
}

// ---------------------------------------------------------------------------
// Responses

const DROPPED_RESPONSE_HEADER_SET: ReadonlySet<string> = new Set(DROPPED_RESPONSE_HEADERS);

/** The same transformation as index.ts noStore (not exported there). */
function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * handleRequest's catch-path log level: an error for a 5xx outside the
 * expected containment codes, a warning otherwise.
 */
const EXPECTED_CONTAINMENT_CODES: ReadonlySet<string> = new Set([
  "COLLECTION_ENROLLMENT_DISABLED",
  "ACCOUNTLESS_ENROLLMENT_DISABLED",
  "UPLOAD_REGISTRATION_DISABLED",
  "PROCESSING_DISABLED",
  "PUBLICATION_DISABLED",
]);

function catchLogLevel(error: ApiError): "error" | "warn" {
  return error.status >= 500 && !EXPECTED_CONTAINMENT_CODES.has(error.code) ? "error" : "warn";
}

function passThroughHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (name === "set-cookie" || DROPPED_RESPONSE_HEADER_SET.has(name)) continue;
    headers.append(name, value);
  }
  for (const cookie of source.getSetCookie()) headers.append("set-cookie", cookie);
  return headers;
}

function cancelBody(response: Response): void {
  const body = response.body;
  if (body === null) return;
  try {
    body.cancel().catch(() => undefined);
  } catch {
    // A locked or already-errored body has nothing left to release.
  }
}

function mediaType(value: string | null): string | null {
  if (value === null) return null;
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

function declaredLength(value: string | null): number | null {
  if (value === null) return null;
  // index.ts parses a declared length with Number and Number.isSafeInteger.
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The original chunks first, then whatever the reader still holds. */
function replayedBody(
  chunks: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const buffered = chunks[index];
      if (buffered !== undefined) {
        index += 1;
        controller.enqueue(buffered);
        return;
      }
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function concatenated(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

type SegmentsResult =
  | Readonly<{ ok: true; segments: readonly CloudflareDistributionSegment[] | null }>
  | Readonly<{ ok: false }>;

/**
 * The release tag the overview's own GitHub section names, or undefined when
 * the body does not have the overview's distribution shape.
 */
function overviewReleaseTag(distribution: JsonObject): string | null | undefined {
  if (!Object.hasOwn(distribution, "cloudflare")) return undefined;
  const github = distribution.github;
  if (!isJsonObject(github) || !Object.hasOwn(github, "release")) return undefined;
  const release = github.release;
  if (release === null) return null;
  if (!isJsonObject(release) || typeof release.tag !== "string") return undefined;
  return release.tag;
}

// ---------------------------------------------------------------------------
// The proxy

export function createEdgeOriginProxy(options: EdgeOriginProxyOptions): EdgeOriginProxy {
  if (options === null || typeof options !== "object") invalidOptions();
  const config = validatedConfig(options.config);
  const handleRequest = options.handleRequest;
  if (typeof handleRequest !== "function") invalidOptions();
  const contributionRequestPreflight = options.contributionRequestPreflight;
  if (typeof contributionRequestPreflight !== "function") invalidOptions();
  const idTokenSource = options.idTokenSource;
  if (idTokenSource === null || typeof idTokenSource !== "object"
      || typeof idTokenSource.getToken !== "function") {
    invalidOptions();
  }
  const clientKeySecret = options.clientKeySecret;
  if (typeof clientKeySecret !== "string"
      || clientKeySecret.length < EDGE_MIN_CLIENT_KEY_SECRET_LENGTH) {
    invalidOptions();
  }
  const limiters = options.limiters;
  if (limiters === null || typeof limiters !== "object") invalidOptions();
  const distribution = validatedDistribution(options.distribution);
  const fetcher = options.fetcher ?? defaultFetcher;
  if (typeof fetcher !== "function") invalidOptions();
  const logger = validatedLogger(options.logger);
  const clock = options.clock ?? Date.now;
  if (typeof clock !== "function") invalidOptions();
  const headersTimeoutMilliseconds = config.upstreamHeadersTimeoutSeconds * 1_000;

  // The analytics reader takes a fetch-shaped function; route it through the
  // same injected seam so the edge has exactly one network path.
  const analyticsFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetcher(new Request(input, init))) as typeof fetch;

  function log(level: "warn" | "error", fields: Readonly<Record<string, string | number>>): void {
    const line = JSON.stringify({ level, ...fields });
    try {
      if (level === "error") logger.error(line);
      else logger.warn(line);
    } catch {
      // Logging never changes a response.
    }
  }

  function upstreamUnavailable(
    request: Request,
    requestId: string,
    routeId: ExactWorkerRouteId,
    code: EdgeProxyUpstreamFailureCode,
  ): Response {
    log("warn", {
      event: "edge_upstream_unavailable",
      requestId,
      method: request.method,
      routeClass: routeId,
      code,
    });
    return Response.json(
      { error: { code: EDGE_ORIGIN_UNAVAILABLE, requestId } },
      {
        status: 503,
        headers: {
          ...JSON_HEADERS,
          "retry-after": String(EDGE_UNAVAILABLE_RETRY_AFTER_SECONDS),
        },
      },
    );
  }

  async function adminChokepointRefusal(
    request: Request,
    localEnv: Env,
    requestId: string,
    routeId: ExactWorkerRouteId,
  ): Promise<Response | null> {
    try {
      const identity = await verifyAdminAccessAssertion(request, localEnv);
      authorizeAdminEmail(identity, Reflect.get(localEnv, "ACCESS_ADMIN_EMAIL"));
      return null;
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError(500, "INTERNAL_ERROR");
      log(catchLogLevel(apiError), {
        event: "edge_admin_chokepoint_refused",
        requestId,
        method: request.method,
        routeClass: routeId,
        code: apiError.code,
        status: apiError.status,
      });
      // handleRequest's catch renders a chokepoint refusal with no Allow
      // header; the edge has no diagnostic table, so nothing is written.
      return noStore(errorResponse(apiError, requestId));
    }
  }

  /**
   * The Worker's request-only refusal ahead of the route's limiter, or null.
   * A throw that is not an ApiError is rendered as handleRequest's catch
   * renders it, 500 INTERNAL_ERROR.
   */
  function preAdmissionRefusal(request: Request, routeId: ExactWorkerRouteId): ApiError | null {
    const guard = Object.hasOwn(EDGE_PRE_ADMISSION_GUARDS, routeId)
      ? EDGE_PRE_ADMISSION_GUARDS[routeId]
      : undefined;
    if (guard === undefined) return null;
    try {
      switch (guard) {
        case "session_cookie":
          if (hasSessionCookie(request.headers.get("cookie"))) {
            return new ApiError(401, "AUTH_INVALID");
          }
          return null;
        case "same_origin":
          assertSameOrigin(request);
          return null;
        case "contribution_preflight":
          contributionRequestPreflight(request);
          return null;
      }
    } catch (error) {
      return error instanceof ApiError ? error : new ApiError(500, "INTERNAL_ERROR");
    }
  }

  function mergeSkipped(
    requestId: string,
    reason: EdgeDistributionMergeSkipReason,
  ): void {
    log("warn", { event: "edge_distribution_merge_skipped", requestId, reason });
  }

  async function mergedOverview(
    response: Response,
    segments: Promise<SegmentsResult>,
    requestId: string,
  ): Promise<Response> {
    const headers = passThroughHeaders(response.headers);
    const init = { status: response.status, statusText: response.statusText, headers };
    if (mediaType(headers.get("content-type")) !== "application/json") {
      mergeSkipped(requestId, "content_type");
      return new Response(response.body, init);
    }
    const declared = declaredLength(headers.get("content-length"));
    if (declared !== null && declared > EDGE_MAX_OVERVIEW_MERGE_BYTES) {
      mergeSkipped(requestId, "too_large");
      return new Response(response.body, init);
    }
    const body = response.body;
    if (body === null) {
      mergeSkipped(requestId, "body_unreadable");
      return new Response(null, init);
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
        total += next.value.byteLength;
        if (total > EDGE_MAX_OVERVIEW_MERGE_BYTES) {
          mergeSkipped(requestId, "too_large");
          return new Response(replayedBody(chunks, reader), init);
        }
      }
    } catch {
      mergeSkipped(requestId, "body_unreadable");
      // The replay ends with the same stream error the origin body raised.
      return new Response(replayedBody(chunks, reader), init);
    }
    const original = concatenated(chunks, total);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(original));
    } catch {
      mergeSkipped(requestId, "invalid_json");
      return new Response(original, init);
    }
    const distributionSection = isJsonObject(parsed) ? parsed.distribution : undefined;
    const releaseTag = isJsonObject(distributionSection)
      ? overviewReleaseTag(distributionSection)
      : undefined;
    if (!isJsonObject(parsed) || !isJsonObject(distributionSection) || releaseTag === undefined) {
      mergeSkipped(requestId, "shape");
      return new Response(original, init);
    }
    const result = await segments;
    if (!result.ok) {
      mergeSkipped(requestId, "segments_unavailable");
      return new Response(original, init);
    }
    let merged: string;
    try {
      distributionSection.cloudflare = cloudflareDistributionFromSegments(
        result.segments,
        releaseTag,
      );
      // The Worker renders the overview with Response.json, i.e. JSON.stringify.
      merged = JSON.stringify(parsed);
    } catch {
      mergeSkipped(requestId, "shape");
      return new Response(original, init);
    }
    headers.delete("content-length");
    return new Response(merged, init);
  }

  async function forward(
    request: Request,
    localEnv: Env,
    routeId: ExactWorkerRouteId,
    hostKind: EdgeHostKind,
  ): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);

    if (hostKind === "admin") {
      const refusal = await adminChokepointRefusal(request, localEnv, requestId, routeId);
      if (refusal !== null) return refusal;
    }

    // The Worker refuses these before its limiter from the request alone, so
    // the edge answers them before it spends any budget (d43c8f92 order).
    const guardRefusal = preAdmissionRefusal(request, routeId);
    if (guardRefusal !== null) return noStore(errorResponse(guardRefusal, requestId));

    // GET and HEAD never forward a body, so their declared length is neither
    // checked nor forwarded; index.ts reads a declared length only where it
    // reads a body.
    const forwardsBody = request.method !== "GET" && request.method !== "HEAD";
    if (forwardsBody) {
      const declared = declaredLength(request.headers.get("content-length"));
      if (declared !== null && declared > EDGE_MAX_FORWARD_BODY_BYTES) {
        return noStore(errorResponse(new ApiError(413, "BODY_TOO_LARGE"), requestId));
      }
    }

    const admission = await evaluateEdgeAdmission({
      routeId,
      request,
      limiters,
      clientKeySecret,
    });

    let segments: Promise<SegmentsResult> | null = null;
    if (distribution !== null && hostKind === "admin"
        && routeId === "admin_overview" && request.method === "GET") {
      segments = Promise.resolve()
        .then(() => readCloudflareDistributionSegments(
          distribution.zoneId,
          distribution.apiToken,
          clock(),
          analyticsFetch,
        ))
        .then(
          (value): SegmentsResult => Object.freeze({ ok: true, segments: value }),
          (): SegmentsResult => Object.freeze({ ok: false }),
        );
    }

    const upstreamHeaders = new Headers();
    const forwardedNames: readonly string[] = hostKind === "admin"
      ? [...FORWARDED_REQUEST_HEADERS, ...ADMIN_ONLY_FORWARDED_REQUEST_HEADERS]
      : FORWARDED_REQUEST_HEADERS;
    for (const name of forwardedNames) {
      if (name === "content-length" && !forwardsBody) continue;
      const value = request.headers.get(name);
      if (value !== null) upstreamHeaders.set(name, value);
    }
    // Cloudflare puts the client address into x-real-ip (and CF-Connecting-IP)
    // of a subrequest for a non-Cloudflare host unless the Worker sets
    // x-real-ip itself; CF-Connecting-IP cannot be set (see
    // edge-google-subrequest.ts).
    upstreamHeaders.set(EDGE_SUBREQUEST_REAL_IP_HEADER, EDGE_SUBREQUEST_REAL_IP);
    upstreamHeaders.set(EDGE_HEADERS.host, hostKind);
    upstreamHeaders.set(EDGE_HEADERS.requestId, requestId);
    if (admission !== null) {
      upstreamHeaders.set(EDGE_HEADERS.admission, encodeEdgeAdmission(admission));
    }

    const upstreamUrl = new URL(config.upstreamOrigin);
    // Field assignment keeps the configured authority: a '//host' path stays
    // a path on the origin.
    upstreamUrl.pathname = url.pathname;
    if (url.pathname === GOOGLE_CALLBACK_PATH) {
      // The OAuth code and state never ride on the origin URL (and so never
      // reach its request logs); on the apex they travel in the contract
      // header, and only when the origin would accept them. A fragment never
      // belongs to a callback the provider sent.
      if (hostKind === "apex"
          && request.url.length <= MAX_GOOGLE_CALLBACK_URL_LENGTH
          && !request.url.includes("#")
          && validGoogleCallbackQuery(url.search)) {
        upstreamHeaders.set(EDGE_HEADERS.callbackQuery, url.search);
      }
      upstreamUrl.search = "";
    } else {
      upstreamUrl.search = url.search;
    }

    try {
      const token = await idTokenSource.getToken();
      upstreamHeaders.set(EDGE_HEADERS.invokerToken, `Bearer ${token}`);
    } catch {
      return upstreamUnavailable(request, requestId, routeId, "EDGE_TOKEN_UNAVAILABLE");
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, headersTimeoutMilliseconds);
    // A client that goes away cancels the subrequest, headers or body.
    const clientSignal = request.signal;
    if (clientSignal.aborted) controller.abort();
    else clientSignal.addEventListener("abort", () => controller.abort(), { once: true });

    let response: Response;
    try {
      const upstreamRequest = new Request(upstreamUrl.href, {
        method: request.method,
        headers: upstreamHeaders,
        body: forwardsBody ? request.body : null,
        redirect: "manual",
        cache: "no-store",
        signal: controller.signal,
      });
      const received: unknown = await fetcher(upstreamRequest);
      if (!(received instanceof Response)) throw new TypeError("EDGE_UPSTREAM_RESPONSE_INVALID");
      response = received;
    } catch {
      return upstreamUnavailable(
        request,
        requestId,
        routeId,
        timedOut ? "EDGE_UPSTREAM_TIMEOUT" : "EDGE_UPSTREAM_NETWORK",
      );
    } finally {
      // Headers have arrived (or the attempt is over): the timeout never
      // cuts a streaming body.
      clearTimeout(timer);
    }

    if (response.headers.get(EDGE_HEADERS.originMarker) !== "1") {
      cancelBody(response);
      return upstreamUnavailable(request, requestId, routeId, "EDGE_UPSTREAM_UNMARKED");
    }
    if (segments !== null && response.status === 200) {
      return mergedOverview(response, segments, requestId);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: passThroughHeaders(response.headers),
    });
  }

  return async function edgeOriginProxy(
    request: Request,
    localEnv: Env,
    guardEnv: Env,
  ): Promise<Response> {
    const requestClass = classifyEdgeRequest(request, localEnv);
    switch (requestClass.kind) {
      case "local":
        return handleRequest(request, localEnv);
      case "guard":
        return handleRequest(request, guardEnv);
      case "forward":
        return forward(request, localEnv, requestClass.routeId, requestClass.hostKind);
    }
  };
}
