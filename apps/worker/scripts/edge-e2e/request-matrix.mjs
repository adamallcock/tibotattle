// E12 local end-to-end: the request matrix.
//
// Rows are data: a stage, a host (apex, admin or www), a method, a path, the
// client headers and body, the comparators that apply, and what the row
// expects. postgres-test/edge-origin-e2e.spec.mjs sends them and
// harness.check.mjs proves offline that every WORKER_ROUTE_POLICY (route,
// method) pair is sent at least once and that S4 covers every EP-1 policy
// entry the origin serves. Nothing here imports TypeScript: the registry, the
// EP-1 policy and the served-route list are passed in, so the same module
// runs under the Node 22 image runtime and in the offline check.
//
// Comparators:
// - worker: the edge's answer and the unchanged Worker's (the same bundle in
//   worker mode) agree on status, allow, location, cache-control,
//   content-type, retry-after, the Set-Cookie count and the error envelope's
//   keys and code; with bodyEqual, byte for byte.
// - transparency: every forwarded exchange the row causes reaches the
//   client unchanged: the origin's status, body bytes and headers, less the
//   contract's dropped headers and transport framing.
// - local: the row causes no front-end exchange at all.
// - unported: the origin answers the production handler's closed unported
//   answer: 503 POSTGRES_ROUTE_NOT_PORTED in the Worker envelope, no-store,
//   no retry-after (OD-CR-6 (iv)). Its body carries the request id, so the
//   comparator reads fields, never bytes.

/** Fixed synthetic values the rows use; none is a real credential. */
export const MATRIX_VALUES = Object.freeze({
  sessionCookie: "__Host-usage_monitor_session=synthetic-edge-e2e-session",
  unrelatedCookie: "theme=dark",
  malformedDevice: "Device not-a-device-credential",
  malformedUpload: "Upload not-an-upload-authorization",
  dailyQuery: "?from=2026-09-01&to=2026-09-02",
});

export const UNKNOWN_DEVICE_BEARER = "unknown_device_bearer";
export const UNKNOWN_UPLOAD_BEARER = "unknown_upload_bearer";
/** Resolved to the row's own host origin: a same-origin browser request. */
export const SAME_ORIGIN = "same_origin";

/** The six admin API route ids (E4's EDGE_ADMIN_API_ROUTE_IDS). */
export const ADMIN_API_ROUTE_IDS = Object.freeze([
  "admin_overview",
  "admin_metrics_history",
  "admin_community_allowance_preview",
  "admin_database_health",
  "admin_reconstruction_progress",
  "admin_action",
]);

/** Routes the edge answers itself in every mode; never forwarded. */
export const EDGE_LOCAL_ROUTE_IDS = Object.freeze(["apple_domain_association", "sparkle_appcast_guard"]);

function row(fields) {
  return Object.freeze({
    host: "apex",
    method: "GET",
    headers: Object.freeze({}),
    comparators: Object.freeze([]),
    ...fields,
  });
}

function routeById(registry, id) {
  const route = registry.find((entry) => entry.id === id);
  if (route === undefined) throw new Error(`REQUEST_MATRIX_ROUTE_UNKNOWN ${id}`);
  return route;
}

// ---------------------------------------------------------------------------
// S1: edge-local classes, compared with the Worker; never forwarded.

export function localRows({ registry }) {
  const rows = [
    row({ id: "www-get-page", host: "www", path: "/privacy.html?ref=a", comparators: ["worker", "local"],
      expect: { status: 308, location: "https://tibotattle.test/privacy.html?ref=a" } }),
    row({ id: "www-post-api", host: "www", method: "POST", path: "/api/v1/contributions",
      headers: { "content-type": "application/json" }, body: "{}", comparators: ["worker", "local"],
      expect: { status: 308, location: "https://tibotattle.test/api/v1/contributions" } }),
    row({ id: "www-api-path", host: "www", path: "/api/x", comparators: ["worker", "local"],
      expect: { status: 308, location: "https://tibotattle.test/api/x" } }),
    row({ id: "www-network-path", host: "www", path: "//evil.example/x", comparators: ["worker", "local"],
      expect: { status: 308, location: "https://tibotattle.test/evil.example/x" } }),
    row({ id: "apex-root", path: "/", comparators: ["worker", "local"], bodyEqual: true, expect: { status: 200 } }),
    row({ id: "apex-privacy", path: "/privacy.html", comparators: ["worker", "local"], bodyEqual: true,
      expect: { status: 200 } }),
    row({ id: "apex-release-manifest", path: "/release-site-manifest.json", comparators: ["worker", "local"],
      bodyEqual: true, expect: { status: 200 } }),
    row({ id: "apex-missing-asset", path: "/missing-page.html", comparators: ["worker", "local"], bodyEqual: true,
      expect: { status: 404 } }),
    row({ id: "apex-admin-ui", path: "/admin", comparators: ["worker", "local"],
      expect: { status: 404, code: "NOT_FOUND" } }),
    row({ id: "apex-admin-asset", path: "/admin.js", comparators: ["worker", "local"],
      expect: { status: 404, code: "NOT_FOUND" } }),
  ];
  for (const id of ADMIN_API_ROUTE_IDS) {
    const route = routeById(registry, id);
    for (const method of route.methods) {
      rows.push(row({ id: `apex-${id}-${method}`, routeId: id, path: route.pathname, method,
        ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
        comparators: ["worker", "local"], expect: { status: 404, code: "NOT_FOUND" } }));
    }
  }
  const apple = routeById(registry, "apple_domain_association");
  for (const method of ["GET", "POST"]) {
    rows.push(row({ id: `apple-${method}`, routeId: apple.id, path: apple.pathname, method,
      ...(method === "POST" ? { body: "x" } : {}), comparators: ["worker", "local"], expect: { status: 404 } }));
  }
  rows.push(
    row({ id: "unknown-api", path: "/api/v1/nope", comparators: ["worker", "local"],
      expect: { status: 404, code: "NOT_FOUND" } }),
    row({ id: "delete-me", path: "/api/v1/me", method: "DELETE", comparators: ["worker", "local"],
      expect: { status: 404, code: "NOT_FOUND" } }),
    row({ id: "session-post-405", routeId: "session", path: "/api/v1/session", method: "POST",
      headers: { "content-type": "application/json" }, body: "{}", comparators: ["worker", "local"],
      expect: { status: 405, allow: "GET", code: "METHOD_NOT_ALLOWED" } }),
    row({ id: "v12-manifests-put-405", path: "/api/v1/device/telemetry/v1.2/day-manifests", method: "PUT",
      headers: { "content-type": "application/json" }, body: "{}", comparators: ["worker", "local"],
      expect: { status: 405, allow: "GET, POST", code: "METHOD_NOT_ALLOWED" } }),
    row({ id: "health-head-405", path: "/api/health", method: "HEAD", comparators: ["worker", "local"],
      expect: { status: 405, allow: "GET" } }),
    row({ id: "contributions-options-405", path: "/api/v1/contributions", method: "OPTIONS",
      comparators: ["worker", "local"], expect: { status: 405, allow: "POST", code: "METHOD_NOT_ALLOWED" } }),
  );
  return Object.freeze(rows);
}

/** S1's PUBLIC_ANALYTICS_MODE=disabled row (on its own edge/reference pair). */
export const PUBLICATION_DISABLED_ROW = row({
  id: "community-daily-publication-disabled", routeId: "community_daily",
  path: `/api/v1/community/daily${MATRIX_VALUES.dailyQuery}`, comparators: ["worker", "local"],
  expect: { status: 503, code: "PUBLICATION_DISABLED" },
});

// ---------------------------------------------------------------------------
// S2: the admin host.

export function adminRows() {
  const refusals = [
    ["none", null, "ACCESS_REQUIRED"],
    ["malformed", "malformed", "ACCESS_REQUIRED"],
    ["wrong-audience", "wrongAudience", "ACCESS_REQUIRED"],
    ["wrong-key", "wrongKey", "ACCESS_REQUIRED"],
    ["non-owner", "nonOwner", "ADMIN_REQUIRED"],
  ];
  const rows = [];
  for (const [label, token, code] of refusals) {
    for (const [path, method] of [["/admin", "GET"], ["/api/v1/admin/overview", "GET"],
      ["/api/v1/community/daily", "GET"]]) {
      rows.push(row({ id: `admin-${label}-${method}-${path}`, host: "admin", method, path, accessToken: token,
        comparators: ["worker", "local"], expect: { status: 403, code } }));
    }
  }
  for (const carrier of ["header", "cookie"]) {
    rows.push(
      row({ id: `admin-owner-ui-${carrier}`, host: "admin", path: "/admin", accessToken: "owner", accessCarrier: carrier,
        comparators: ["worker", "local"], bodyEqual: true, expect: { status: 200 } }),
      row({ id: `admin-owner-ui-asset-${carrier}`, host: "admin", path: "/admin.js", accessToken: "owner",
        accessCarrier: carrier, comparators: ["worker", "local"], bodyEqual: true, expect: { status: 200 } }),
      row({ id: `admin-owner-overview-get-${carrier}`, routeId: "admin_overview", host: "admin",
        path: "/api/v1/admin/overview", accessToken: "owner", accessCarrier: carrier,
        headers: { cookie: MATRIX_VALUES.unrelatedCookie }, comparators: ["transparency", "unported"],
        expect: { forwardedHostKind: "admin", forwardsAccessAssertion: carrier === "header" } }),
      row({ id: `admin-owner-overview-post-${carrier}`, routeId: "admin_overview", host: "admin", method: "POST",
        path: "/api/v1/admin/overview", accessToken: "owner", accessCarrier: carrier,
        headers: { "content-type": "application/json", cookie: MATRIX_VALUES.unrelatedCookie }, body: "{}",
        comparators: ["transparency", "unported"],
        expect: { forwardedHostKind: "admin", forwardsAccessAssertion: carrier === "header" } }),
      row({ id: `admin-owner-daily-${carrier}`, routeId: "community_daily", host: "admin",
        path: `/api/v1/community/daily${MATRIX_VALUES.dailyQuery}`, accessToken: "owner", accessCarrier: carrier,
        comparators: ["transparency", "unported"],
        expect: { forwardedHostKind: "admin", admission: "public_aggregate_read" } }),
    );
  }
  return Object.freeze(rows);
}

// ---------------------------------------------------------------------------
// S3: forwarded rows.

const DEVICE_AUTH_VARIANTS = Object.freeze([
  ["no-bearer", {}],
  ["malformed-bearer", { authorization: MATRIX_VALUES.malformedDevice }],
  ["unknown-bearer", { authorization: UNKNOWN_DEVICE_BEARER }],
  ["cookie", { authorization: UNKNOWN_DEVICE_BEARER, cookie: MATRIX_VALUES.unrelatedCookie }],
]);

export function forwardedRows({ registry }) {
  const rows = [
    row({ id: "envelope-key", routeId: "envelope_key", path: "/api/v1/envelope-key",
      comparators: ["worker", "transparency"], bodyEqual: true, expect: { status: 200 } }),
  ];
  for (const id of ["device_sync_state", "device_sync_manifest", "device_sync_capabilities",
    "device_sync_capabilities_v12"]) {
    const route = routeById(registry, id);
    for (const [label, headers] of DEVICE_AUTH_VARIANTS) {
      rows.push(row({ id: `${id}-${label}`, routeId: id, path: route.pathname, headers,
        comparators: ["worker", "transparency"], expect: { status: 401, code: "DEVICE_AUTH_INVALID" } }));
    }
  }
  for (const id of ["telemetry_v11_day_manifests", "telemetry_v12_day_manifests"]) {
    const route = routeById(registry, id);
    for (const method of ["GET", "POST"]) {
      rows.push(row({ id: `${id}-${method}-unknown-bearer`, routeId: id, path: route.pathname, method,
        headers: { authorization: UNKNOWN_DEVICE_BEARER, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(method === "POST" ? { body: "{}" } : {}),
        comparators: ["worker", "transparency"], expect: { status: 401, code: "DEVICE_AUTH_INVALID" } }));
    }
  }
  const upload = { "content-type": "application/json", authorization: UNKNOWN_UPLOAD_BEARER };
  // The Worker's request-only refusals before its limiter (the contribution
  // preflight, a session cookie on an accountless route, assertSameOrigin on
  // enrollment and sign-in start) are answered at the edge, before any budget
  // is spent, so these rows are local. A declared body over 8 MiB still meets
  // the earlier refusal first, as in the Worker.
  rows.push(
    row({ id: "contributions-session-cookie", routeId: "contributions", method: "POST", path: "/api/v1/contributions",
      headers: { ...upload, cookie: MATRIX_VALUES.sessionCookie }, body: "{}",
      comparators: ["worker", "local"], expect: { status: 401, code: "UPLOAD_AUTH_INVALID" } }),
    row({ id: "contributions-content-type", routeId: "contributions", method: "POST", path: "/api/v1/contributions",
      headers: { ...upload, "content-type": "text/plain" }, body: "{}",
      comparators: ["worker", "local"], expect: { status: 415, code: "CONTENT_TYPE_INVALID" } }),
    row({ id: "contributions-declared-3mib", routeId: "contributions", method: "POST", path: "/api/v1/contributions",
      headers: upload, bodyBytes: 3 * 1024 * 1024,
      comparators: ["worker", "local"], expect: { status: 413, code: "BODY_TOO_LARGE" } }),
    row({ id: "contributions-declared-9mib", routeId: "contributions", method: "POST", path: "/api/v1/contributions",
      headers: upload, bodyBytes: 9 * 1024 * 1024,
      comparators: ["worker", "local"], expect: { status: 413, code: "BODY_TOO_LARGE" } }),
    row({ id: "contributions-9mib-content-type", routeId: "contributions", method: "POST", path: "/api/v1/contributions",
      headers: { ...upload, "content-type": "text/plain" }, bodyBytes: 9 * 1024 * 1024,
      comparators: ["worker", "local"], expect: { status: 415, code: "CONTENT_TYPE_INVALID" } }),
    row({ id: "contributions-9mib-session-cookie", routeId: "contributions", method: "POST", path: "/api/v1/contributions",
      headers: { ...upload, cookie: MATRIX_VALUES.sessionCookie }, bodyBytes: 9 * 1024 * 1024,
      comparators: ["worker", "local"], expect: { status: 401, code: "UPLOAD_AUTH_INVALID" } }),
    row({ id: "contributions-no-upload-header", routeId: "contributions", method: "POST", path: "/api/v1/contributions",
      headers: { "content-type": "application/json" }, body: "{}",
      comparators: ["worker", "local"], expect: { status: 401, code: "UPLOAD_AUTH_INVALID" } }),
    row({ id: "contributions-chunked-3mib", routeId: "contributions", method: "POST", path: "/api/v1/contributions",
      headers: upload, bodyBytes: 3 * 1024 * 1024, chunked: true,
      comparators: ["worker", "transparency"], expect: { status: 413, code: "BODY_TOO_LARGE" } }),
    row({ id: "community-daily-unknown-parameter", routeId: "community_daily",
      path: "/api/v1/community/daily?from=2026-09-01&to=2026-09-02&unexpected=1",
      comparators: ["worker", "transparency"], expect: { status: 400, code: "BODY_INVALID" } }),
    row({ id: "community-daily-bad-day", routeId: "community_daily",
      path: "/api/v1/community/daily?from=2026-02-30&to=2026-03-01",
      comparators: ["worker", "transparency"], expect: { status: 400, code: "BODY_INVALID" } }),
    row({ id: "community-daily-367-days", routeId: "community_daily",
      path: "/api/v1/community/daily?from=2025-09-01&to=2026-09-02",
      comparators: ["worker", "transparency"], expect: { status: 400, code: "BODY_INVALID" } }),
    row({ id: "accountless-enrollment-session-cookie", routeId: "accountless_enrollment", method: "POST",
      path: "/api/v1/accountless/enrollment",
      headers: { "content-type": "application/json", cookie: MATRIX_VALUES.sessionCookie }, body: "{}",
      comparators: ["worker", "local"], expect: { status: 401, code: "AUTH_INVALID" } }),
    row({ id: "accountless-enrollment-9mib-session-cookie", routeId: "accountless_enrollment", method: "POST",
      path: "/api/v1/accountless/enrollment",
      headers: { "content-type": "application/json", cookie: MATRIX_VALUES.sessionCookie }, bodyBytes: 9 * 1024 * 1024,
      comparators: ["worker", "local"], expect: { status: 401, code: "AUTH_INVALID" } }),
    row({ id: "accountless-renewal-session-cookie", routeId: "accountless_renewal", method: "POST",
      path: routeById(registry, "accountless_renewal").pathname,
      headers: { "content-type": "application/json", cookie: `${MATRIX_VALUES.unrelatedCookie}; ${MATRIX_VALUES.sessionCookie}` },
      body: "{}", comparators: ["worker", "local"], expect: { status: 401, code: "AUTH_INVALID" } }),
    row({ id: "enroll-foreign-origin", routeId: "enroll", method: "POST", path: routeById(registry, "enroll").pathname,
      headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}",
      comparators: ["worker", "local"], expect: { status: 403, code: "CSRF_INVALID" } }),
    row({ id: "google-start-no-origin", routeId: "identity_google_start", method: "POST",
      path: routeById(registry, "identity_google_start").pathname,
      headers: { "content-type": "application/json" }, body: "{}",
      comparators: ["worker", "local"], expect: { status: 403, code: "CSRF_INVALID" } }),
    row({ id: "apple-start-cross-site", routeId: "identity_apple_start", method: "POST",
      path: routeById(registry, "identity_apple_start").pathname,
      headers: { "content-type": "application/json", origin: SAME_ORIGIN, "sec-fetch-site": "cross-site" }, body: "{}",
      comparators: ["worker", "local"], expect: { status: 403, code: "CSRF_INVALID" } }),
    row({ id: "health", routeId: "health", path: "/api/health", comparators: ["transparency"],
      expect: { status: 200 } }),
    row({ id: "callback-query", routeId: "identity_google_callback",
      path: "/api/v1/identity/google/callback?code=synthetic-code&state=synthetic-state",
      comparators: ["transparency", "unported"], expect: { callbackHeader: "?code=synthetic-code&state=synthetic-state" } }),
  );
  return Object.freeze(rows);
}

/**
 * S3's sweep: one request for every forwarded (route, method) pair, each
 * expected to be served (servedRouteIds: the production ported list) or to
 * answer the closed unported 503, and to carry the admission header exactly
 * when EP-1 names the route.
 */
export function sweepRows({ registry, servedRouteIds }) {
  const served = new Set(servedRouteIds);
  const rows = [];
  for (const route of registry) {
    if (EDGE_LOCAL_ROUTE_IDS.includes(route.id) || ADMIN_API_ROUTE_IDS.includes(route.id)) continue;
    if (!Array.isArray(route.methods)) throw new Error(`REQUEST_MATRIX_METHODS_UNEXPECTED ${route.id}`);
    for (const method of route.methods) {
      const post = method !== "GET";
      rows.push(row({
        id: `sweep-${route.id}-${method}`,
        routeId: route.id,
        method,
        path: route.pathname + (route.id === "community_daily" ? MATRIX_VALUES.dailyQuery : ""),
        // Same-origin, with a well-formed bearer and JSON body: every
        // request-only guard the edge runs before admission admits it.
        headers: {
          origin: SAME_ORIGIN,
          authorization: route.id === "contributions" ? UNKNOWN_UPLOAD_BEARER : UNKNOWN_DEVICE_BEARER,
          ...(post ? { "content-type": "application/json" } : {}),
        },
        ...(post ? { body: "{}" } : {}),
        comparators: served.has(route.id) ? ["transparency"] : ["transparency", "unported"],
        expect: { served: served.has(route.id) },
      }));
    }
  }
  return Object.freeze(rows);
}

// ---------------------------------------------------------------------------
// S4: admission under the checked-in production limits.

/**
 * One row per EP-1 policy route the origin serves: the request that reaches
 * the route's admission call point, repeated from one address until the
 * Worker answers 429.
 */
export function admissionRows({ registry, policyFor, servedRouteIds }) {
  const served = new Set(servedRouteIds);
  const rows = [];
  for (const route of registry) {
    const policy = policyFor(route.id);
    if (policy === null || !served.has(route.id)) continue;
    for (const method of route.methods) {
      const post = method !== "GET";
      const ingress = policy.purpose === "upload_ingress";
      rows.push(row({
        id: `admission-${route.id}-${method}`,
        routeId: route.id,
        method,
        purpose: policy.purpose,
        clientBinding: policy.clientBinding,
        coarseBinding: policy.coarseBinding,
        path: route.pathname + (route.id === "community_daily" ? MATRIX_VALUES.dailyQuery : ""),
        headers: {
          authorization: ingress ? UNKNOWN_UPLOAD_BEARER : UNKNOWN_DEVICE_BEARER,
          ...(post ? { "content-type": "application/json" } : {}),
        },
        ...(post ? { body: "{}" } : {}),
        comparators: ["worker"],
        expect: { limitedCode: ingress ? "UPLOAD_INGRESS_LIMIT_REACHED" : "ATTEMPT_LIMIT_REACHED" },
      }));
    }
  }
  return Object.freeze(rows);
}

// ---------------------------------------------------------------------------
// Coverage

/** Every (route, method) pair of `registry` that the rows send, and those they miss. */
export function routeMethodCoverage({ registry, rows }) {
  const sent = new Set();
  for (const entry of rows) {
    const route = registry.find((candidate) => candidate.pathname === entry.path.split("?")[0]);
    if (route !== undefined) sent.add(`${route.id} ${entry.method}`);
  }
  const missing = [];
  for (const route of registry) {
    const methods = Array.isArray(route.methods) ? route.methods : ["GET"];
    for (const method of methods) {
      if (!sent.has(`${route.id} ${method}`)) missing.push(`${route.id} ${method}`);
    }
  }
  return { sent: [...sent].sort(), missing };
}
