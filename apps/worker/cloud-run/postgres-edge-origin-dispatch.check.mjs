import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { dirname, resolve } from "node:path";
import { after, before, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// The Cloud Run origin boundary with a stub inner handler and synthetic,
// signature-removed invoker tokens, plus the REAL src/admission.ts helpers
// replaying edge outcomes through createEdgeAdmissionLimiters().

const ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(ROOT, "..");
const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;
const INVOKER = "edge-invoker@synthetic-edge-0.iam.gserviceaccount.com";
const VERIFIER = "origin-verifier@synthetic-edge-0.iam.gserviceaccount.com";
const OTHER_ACCOUNT = "other-invoker@synthetic-edge-0.iam.gserviceaccount.com";
const AUDIENCE = "https://origin.synthetic.example/edge";
const PUBLIC_ORIGIN = "https://tibotattle.com";
const ADMIN_ORIGIN = "https://admin.tibotattle.com";
const RAW_ORIGIN = "https://tibotattle-origin-abc123-uc.a.run.app";
const REQUEST_ID = "4f2c8a7e-1b3d-4e5f-9a6b-7c8d9e0f1a2b";
const CALLBACK_PATH = "/api/v1/identity/google/callback";
const ORIGIN_IDENTITY_LINK_SECRET = "synthetic-origin-identity-link-secret-0000000000";
const ORIGIN_ENV = Object.freeze({
  ENVIRONMENT: "production",
  IDENTITY_LINK_SECRET: ORIGIN_IDENTITY_LINK_SECRET,
});
const REFUSAL_HEADERS = Object.freeze([
  ["cache-control", "no-store"],
  ["connection", "close"],
  ["content-type", "application/json; charset=utf-8"],
  ["referrer-policy", "no-referrer"],
  ["x-content-type-options", "nosniff"],
]);
const FORWARDED_VALUES = Object.freeze({
  "content-type": "application/json",
  "content-length": "17",
  authorization: "Bearer synthetic-device-credential",
  cookie: "__Host-usage_monitor_session=synthetic",
  origin: PUBLIC_ORIGIN,
  "sec-fetch-site": "same-origin",
  "x-usage-monitor-csrf": "synthetic-csrf",
  "x-usage-monitor-admin": "1",
  "x-previous-device-authorization": "Bearer synthetic-previous",
});
const DROPPED_VALUES = Object.freeze({
  "cf-connecting-ip": "203.0.113.7",
  "cf-ray": "0123456789abcdef-SJC",
  "cf-ipcountry": "US",
  "cf-visitor": "{\"scheme\":\"https\"}",
  "x-forwarded-for": "203.0.113.7",
  "x-forwarded-proto": "https",
  "x-forwarded-host": "tibotattle.com",
  forwarded: "for=203.0.113.7",
  "x-real-ip": "203.0.113.7",
  "true-client-ip": "203.0.113.7",
  "user-agent": "synthetic-agent/1.0",
  "x-usage-monitor-release-nonce": "synthetic-nonce",
  "x-cloud-trace-context": "0123456789abcdef0123456789abcdef/1",
  traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
});
const BODY_TEXT = "{\"synthetic\":true}";
const CONSOLE_METHODS = Object.freeze(["log", "info", "warn", "error", "debug", "trace"]);

let vite;
let dispatchModule;
let limiters;
let contract;
let admissionHelpers;
let errors;
const consoleSpies = [];

before(async () => {
  for (const method of CONSOLE_METHODS) consoleSpies.push(mock.method(console, method));
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    server: { middlewareMode: true, ws: false },
    appType: "custom",
    logLevel: "silent",
  });
  [dispatchModule, limiters, contract, admissionHelpers, errors] = await Promise.all([
    vite.ssrLoadModule("/cloud-run/postgres-edge-origin-dispatch.mjs"),
    vite.ssrLoadModule("/cloud-run/postgres-edge-admission-limiters.mjs"),
    vite.ssrLoadModule("/src/edge-origin-contract.ts"),
    vite.ssrLoadModule("/src/admission.ts"),
    vite.ssrLoadModule("/src/errors.ts"),
  ]);
});

after(async () => {
  await vite?.close();
});

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A delivered invoker token: base64url header and payload, removed signature. */
function token(overrides = {}, omit = []) {
  const payload = {
    aud: AUDIENCE,
    azp: "100000000000000000000",
    email: INVOKER,
    email_verified: true,
    exp: NOW_SECONDS + 3_000,
    iat: NOW_SECONDS - 600,
    iss: "https://accounts.google.com",
    sub: "100000000000000000000",
    ...overrides,
  };
  for (const key of omit) delete payload[key];
  const header = base64UrlJson({ alg: "RS256", kid: "0".repeat(40), typ: "JWT" });
  return `Bearer ${header}.${base64UrlJson(payload)}.SIGNATURE_REMOVED_BY_GOOGLE`;
}

/** A body whose every pull is counted; nothing is pulled until it is read. */
function trackedBody(text = BODY_TEXT) {
  const tracker = { pulls: 0, cancels: 0 };
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  tracker.stream = new ReadableStream({
    pull(controller) {
      tracker.pulls += 1;
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(bytes);
    },
    cancel() {
      tracker.cancels += 1;
    },
  }, { highWaterMark: 0 });
  return tracker;
}

/**
 * A raw request as the Node host would build it. Headers are appended in
 * order, so a repeated name arrives joined; `edge: false` omits the edge
 * headers and `omit` drops individual defaults.
 */
function rawRequest({
  method = "POST",
  path = "/api/v1/example",
  headers = [],
  omit = [],
  edge = true,
  auth = token(),
  body,
  signal,
} = {}) {
  const defaults = [];
  if (auth !== null) defaults.push(["x-serverless-authorization", auth]);
  if (edge) {
    defaults.push(["x-tibotattle-edge-host", "apex"], ["x-tibotattle-edge-request-id", REQUEST_ID]);
  }
  const list = new Headers();
  for (const [name, value] of defaults) {
    if (!omit.includes(name) && !headers.some(([override]) => override === name)) list.append(name, value);
  }
  for (const [name, value] of headers) list.append(name, value);
  const init = { method, headers: list };
  if (body !== undefined) {
    init.body = body;
    init.duplex = "half";
  }
  if (signal !== undefined) init.signal = signal;
  return new Request(`${RAW_ORIGIN}${path}`, init);
}

function recordingInner(respond = () => new Response("inner", { status: 200 })) {
  const calls = [];
  const inner = async (...args) => {
    const [request] = args;
    calls.push({
      arity: args.length,
      request,
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      context: dispatchModule.edgeRequestContext(request),
    });
    return respond(request);
  };
  return { inner, calls };
}

function createDispatch(overrides = {}) {
  return dispatchModule.createEdgeOriginDispatch({
    invokerServiceAccount: INVOKER,
    verifierServiceAccounts: [VERIFIER],
    audience: AUDIENCE,
    publicOrigin: PUBLIC_ORIGIN,
    admission: limiters.createEdgeAdmissionLimiters(),
    inner: async () => new Response("inner"),
    clock: () => NOW_MS,
    ...overrides,
  });
}

async function assertRefusal(response, label) {
  assert.equal(response.status, 421, label);
  assert.equal(response.statusText, "", label);
  assert.deepEqual([...response.headers].sort(), REFUSAL_HEADERS, label);
  assert.equal(response.headers.get("x-tibotattle-origin"), null, label);
  assert.equal(await response.text(), contract.ORIGIN_BOUNDARY_ERROR_BODY, label);
}

function assertMarked(response) {
  assert.equal(response.headers.get("x-tibotattle-origin"), "1");
}

const INVALID_CASES = Object.freeze([
  // Delivered claims.
  { label: "a missing token", request: { auth: null } },
  { label: "a duplicate token", request: { headers: [["x-serverless-authorization", token()], ["x-serverless-authorization", token()]] } },
  { label: "a wrong audience", request: { auth: token({ aud: "https://origin.synthetic.example/other" }) } },
  { label: "the audience among others", request: { auth: token({ aud: [AUDIENCE, "https://origin.synthetic.example/other"] }) } },
  { label: "a wrong email", request: { auth: token({ email: OTHER_ACCOUNT }) } },
  { label: "a case-changed email", request: { auth: token({ email: INVOKER.toUpperCase() }) } },
  { label: "email_verified false", request: { auth: token({ email_verified: false }) } },
  { label: "email_verified missing", request: { auth: token({}, ["email_verified"]) } },
  { label: "email_verified as a string", request: { auth: token({ email_verified: "true" }) } },
  { label: "an expired token", request: { auth: token({ exp: NOW_SECONDS - 60, iat: NOW_SECONDS - 3_660 }) } },
  { label: "a long-expired token", request: { auth: token({ exp: NOW_SECONDS - 86_400, iat: NOW_SECONDS - 90_000 }) } },
  { label: "a token issued in the future", request: { auth: token({ iat: NOW_SECONDS + 120 }) } },
  { label: "a malformed JWT (two segments)", request: { auth: token().split(".").slice(0, 2).join(".") } },
  { label: "a malformed JWT (non-JSON payload)", request: { auth: `Bearer ${base64UrlJson({ alg: "RS256" })}.bm90LWpzb24.SIG` } },
  { label: "a lowercase bearer scheme", request: { auth: token().replace("Bearer ", "bearer ") } },
  { label: "a Basic credential", request: { auth: "Basic c3ludGhldGljOnN5bnRoZXRpYw==" } },
  // Edge identity headers.
  { label: "host kind 'www'", request: { headers: [["x-tibotattle-edge-host", "www"]] } },
  { label: "host kind 'APEX'", request: { headers: [["x-tibotattle-edge-host", "APEX"]] } },
  { label: "a missing host kind", request: { omit: ["x-tibotattle-edge-host"] } },
  { label: "a duplicate host kind", request: { headers: [["x-tibotattle-edge-host", "apex"], ["x-tibotattle-edge-host", "apex"]] } },
  { label: "an uppercase request id", request: { headers: [["x-tibotattle-edge-request-id", REQUEST_ID.toUpperCase()]] } },
  { label: "a version 1 request id", request: { headers: [["x-tibotattle-edge-request-id", "4f2c8a7e-1b3d-1e5f-9a6b-7c8d9e0f1a2b"]] } },
  { label: "a missing request id", request: { omit: ["x-tibotattle-edge-request-id"] } },
  { label: "a duplicate request id", request: { headers: [["x-tibotattle-edge-request-id", REQUEST_ID], ["x-tibotattle-edge-request-id", REQUEST_ID]] } },
  { label: "a legacy x-tibotattle-edge-client-key", request: { headers: [["x-tibotattle-edge-client-key", "0".repeat(64)]] } },
  { label: "an unknown x-tibotattle-* header", request: { headers: [["x-tibotattle-edge-proof", "synthetic"]] } },
  { label: "a client-sent origin marker", request: { headers: [["x-tibotattle-origin", "1"]] } },
  { label: "an admission with a v2 prefix", request: { headers: [["x-tibotattle-edge-admission", "v2;enrollment;allowed"]] } },
  { label: "an admission for upload_authorization", request: { headers: [["x-tibotattle-edge-admission", "v1;upload_authorization;allowed"]] } },
  { label: "an empty admission", request: { headers: [["x-tibotattle-edge-admission", ""]] } },
  { label: "a duplicate admission", request: { headers: [["x-tibotattle-edge-admission", "v1;enrollment;allowed"], ["x-tibotattle-edge-admission", "v1;enrollment;allowed"]] } },
  // Misplaced or invalid callback queries.
  { label: "a callback header on another path", request: { method: "GET", path: "/api/v1/identity/google/start", headers: [["x-tibotattle-google-callback-query", "?code=a&state=b"]] } },
  { label: "a callback header on the admin host", request: { method: "GET", path: CALLBACK_PATH, headers: [["x-tibotattle-edge-host", "admin"], ["x-tibotattle-google-callback-query", "?code=a&state=b"]] } },
  { label: "a callback header with a raw query", request: { method: "GET", path: `${CALLBACK_PATH}?code=raw`, headers: [["x-tibotattle-google-callback-query", "?code=a&state=b"]] } },
  { label: "a callback header on POST", request: { method: "POST", path: CALLBACK_PATH, headers: [["x-tibotattle-google-callback-query", "?code=a&state=b"]] } },
  { label: "a callback query without '?'", request: { method: "GET", path: CALLBACK_PATH, headers: [["x-tibotattle-google-callback-query", "code=a&state=b"]] } },
  { label: "a callback query with a space", request: { method: "GET", path: CALLBACK_PATH, headers: [["x-tibotattle-google-callback-query", "?code=a b"]] } },
  { label: "a callback query with '#'", request: { method: "GET", path: CALLBACK_PATH, headers: [["x-tibotattle-google-callback-query", "?code=a#b"]] } },
  { label: "a callback query with a backslash", request: { method: "GET", path: CALLBACK_PATH, headers: [["x-tibotattle-google-callback-query", "?code=a\\b"]] } },
  { label: "an 8193-character callback query", request: { method: "GET", path: CALLBACK_PATH, headers: [["x-tibotattle-google-callback-query", `?${"a".repeat(8192)}`]] } },
  { label: "a duplicate callback query", request: { method: "GET", path: CALLBACK_PATH, headers: [["x-tibotattle-google-callback-query", "?a=1"], ["x-tibotattle-google-callback-query", "?a=1"]] } },
  // Verifier restrictions.
  { label: "a verifier POST", request: { auth: token({ email: VERIFIER }), edge: false, path: "/api/health" } },
  { label: "a verifier HEAD", request: { auth: token({ email: VERIFIER }), edge: false, method: "HEAD", path: "/api/ready" } },
  { label: "a verifier with an edge header", request: { auth: token({ email: VERIFIER }), method: "GET", path: "/api/health" } },
  { label: "a verifier with an admission header", request: { auth: token({ email: VERIFIER }), edge: false, method: "GET", path: "/api/ready", headers: [["x-tibotattle-edge-admission", "v1;enrollment;allowed"]] } },
  { label: "a verifier with a query", request: { auth: token({ email: VERIFIER }), edge: false, method: "GET", path: "/api/health?deep=1" } },
  { label: "a verifier on another path", request: { auth: token({ email: VERIFIER }), edge: false, method: "GET", path: "/api/v1/session" } },
  { label: "a verifier with a trailing slash", request: { auth: token({ email: VERIFIER }), edge: false, method: "GET", path: "/api/health/" } },
  // Reconstruction bound.
  { label: "a rebuilt URL over 16384 characters", request: { path: `/${"a".repeat(16_384 - PUBLIC_ORIGIN.length)}` } },
]);

test("exports the reviewed boundary surface", () => {
  assert.deepEqual(Object.keys(dispatchModule).sort(), [
    "EDGE_ORIGIN_DISPATCH_PATHNAMES",
    "EDGE_ORIGIN_VERIFIER_PATHNAMES",
    "MAX_EDGE_ORIGIN_URL_LENGTH",
    "MAX_EDGE_ORIGIN_VERIFIER_ACCOUNTS",
    "ORIGIN_BOUNDARY_ERROR_HEADERS",
    "createEdgeOriginDispatch",
    "edgeRequestContext",
    "edgeServedAssets",
  ]);
  assert.deepEqual(dispatchModule.EDGE_ORIGIN_DISPATCH_PATHNAMES, []);
  assert.ok(Object.isFrozen(dispatchModule.EDGE_ORIGIN_DISPATCH_PATHNAMES));
  assert.deepEqual(dispatchModule.EDGE_ORIGIN_VERIFIER_PATHNAMES, ["/api/health", "/api/ready"]);
  assert.ok(Object.isFrozen(dispatchModule.EDGE_ORIGIN_VERIFIER_PATHNAMES));
  assert.ok(Object.isFrozen(dispatchModule.ORIGIN_BOUNDARY_ERROR_HEADERS));
  assert.ok(Object.isFrozen(dispatchModule.edgeServedAssets));
  assert.equal(dispatchModule.MAX_EDGE_ORIGIN_URL_LENGTH, 16_384);
  assert.equal(dispatchModule.MAX_EDGE_ORIGIN_VERIFIER_ACCOUNTS, 4);
  assert.equal(createDispatch().length, 1, "the dispatcher takes exactly one argument");
});

test("every invalid token, header, verifier and callback case gets the identical unmarked 421", async () => {
  assert.ok(INVALID_CASES.length >= 40);
  const { inner, calls } = recordingInner();
  const dispatch = createDispatch({ inner });
  for (const { label, request: options } of INVALID_CASES) {
    const bodyless = options.method === "GET" || options.method === "HEAD";
    const tracker = bodyless ? null : trackedBody();
    const request = rawRequest({ ...options, ...(tracker ? { body: tracker.stream } : {}) });
    await assertRefusal(await dispatch(request), label);
    if (tracker !== null) {
      assert.equal(tracker.pulls, 0, `${label}: body never pulled`);
      assert.equal(tracker.cancels, 0, `${label}: body left for the host`);
      assert.equal(request.bodyUsed, false, `${label}: body unread`);
    }
  }
  assert.equal(calls.length, 0, "inner is never called");
});

test("the boundary refuses a non-Request and a clock it cannot read", async () => {
  const { inner, calls } = recordingInner();
  await assertRefusal(await createDispatch({ inner })({ url: `${RAW_ORIGIN}/api/health` }), "plain object");
  await assertRefusal(await createDispatch({ inner })(undefined), "undefined");
  for (const clock of [() => Number.NaN, () => -1, () => "1800000000000"]) {
    await assertRefusal(await createDispatch({ inner, clock })(rawRequest()), "unreadable clock");
  }
  // A token within the 60 s skew is still accepted; at the skew edge it is not.
  const dispatch = createDispatch({ inner });
  assert.equal((await dispatch(rawRequest({ auth: token({ exp: NOW_SECONDS - 59 }) }))).status, 200);
  await assertRefusal(await dispatch(rawRequest({ auth: token({ exp: NOW_SECONDS - 60 }) })), "skew edge");
  assert.equal(calls.length, 1);
});

test("a valid invoker is accepted for apex and admin with exact rebuilt URLs", async () => {
  const { inner, calls } = recordingInner();
  const dispatch = createDispatch({ inner });
  const rows = [
    { kind: "apex", path: "/api/v1/session", expected: `${PUBLIC_ORIGIN}/api/v1/session` },
    { kind: "apex", path: "/api/v1/community/daily?day=2026-09-25&x=%20y", expected: `${PUBLIC_ORIGIN}/api/v1/community/daily?day=2026-09-25&x=%20y` },
    { kind: "admin", path: "/api/v1/admin/overview", expected: `${ADMIN_ORIGIN}/api/v1/admin/overview` },
    { kind: "admin", path: "/admin?tab=1", expected: `${ADMIN_ORIGIN}/admin?tab=1` },
    // Percent-encoded and '//x' paths stay on the configured origin.
    { kind: "apex", path: "/api/v1/a%2Fb%20c", expected: `${PUBLIC_ORIGIN}/api/v1/a%2Fb%20c` },
    { kind: "apex", path: "//evil.example/x", expected: `${PUBLIC_ORIGIN}//evil.example/x` },
    { kind: "apex", path: "/%2F%2Fevil.example/x", expected: `${PUBLIC_ORIGIN}/%2F%2Fevil.example/x` },
    { kind: "apex", path: "/\\evil.example/x", expected: `${PUBLIC_ORIGIN}//evil.example/x` },
    { kind: "admin", path: "//evil.example/x?y=1", expected: `${ADMIN_ORIGIN}//evil.example/x?y=1` },
    { kind: "apex", path: "/api/v1/../v1/session", expected: `${PUBLIC_ORIGIN}/api/v1/session` },
    { kind: "apex", path: "/api/health#fragment", expected: `${PUBLIC_ORIGIN}/api/health` },
    // Exactly 16384 characters is accepted.
    { kind: "apex", path: `/${"a".repeat(16_383 - PUBLIC_ORIGIN.length)}`, expected: `${PUBLIC_ORIGIN}/${"a".repeat(16_383 - PUBLIC_ORIGIN.length)}` },
  ];
  for (const row of rows) {
    const response = await dispatch(rawRequest({
      method: "GET",
      path: row.path,
      headers: [["x-tibotattle-edge-host", row.kind]],
    }));
    assert.equal(response.status, 200, row.path);
    assertMarked(response);
    const call = calls.at(-1);
    assert.equal(call.url, row.expected, row.path);
    assert.equal(new URL(call.url).origin, row.kind === "admin" ? ADMIN_ORIGIN : PUBLIC_ORIGIN);
    assert.equal(call.method, "GET");
    assert.equal(call.arity, 1, "inner gets exactly the request");
    assert.deepEqual(call.context, { requestId: REQUEST_ID, hostKind: row.kind });
  }
  assert.equal(calls.at(-1).url.length, 16_384);
});

test("the Google callback header becomes the query of the apex callback", async () => {
  const { inner, calls } = recordingInner();
  const dispatch = createDispatch({ inner });
  for (const [query, expected] of [
    ["?code=4%2F0Aabc&state=synthetic-state&scope=openid", `${PUBLIC_ORIGIN}${CALLBACK_PATH}?code=4%2F0Aabc&state=synthetic-state&scope=openid`],
    ["?error=access_denied&state=s", `${PUBLIC_ORIGIN}${CALLBACK_PATH}?error=access_denied&state=s`],
    ["?", `${PUBLIC_ORIGIN}${CALLBACK_PATH}?`],
    [`?${"a".repeat(8191)}`, `${PUBLIC_ORIGIN}${CALLBACK_PATH}?${"a".repeat(8191)}`],
  ]) {
    const response = await dispatch(rawRequest({
      method: "GET",
      path: CALLBACK_PATH,
      headers: [["x-tibotattle-google-callback-query", query]],
    }));
    assert.equal(response.status, 200, query.slice(0, 40));
    assert.equal(calls.at(-1).url, expected);
    assert.ok(!calls.at(-1).headers.some(([name]) => name.startsWith("x-tibotattle-")));
  }
  // Without the header the callback keeps its (empty) raw query.
  await dispatch(rawRequest({ method: "GET", path: CALLBACK_PATH }));
  assert.equal(calls.at(-1).url, `${PUBLIC_ORIGIN}${CALLBACK_PATH}`);
});

test("inner sees only the forwarded headers; cf-access-jwt-assertion only on admin", async () => {
  const { inner, calls } = recordingInner();
  const dispatch = createDispatch({ inner });
  const sent = [
    ...Object.entries(FORWARDED_VALUES),
    ...Object.entries(DROPPED_VALUES),
    ["cf-access-jwt-assertion", "synthetic.access.assertion"],
    ["x-tibotattle-edge-admission", "v1;enrollment;allowed"],
  ];
  const expectedApex = Object.entries(FORWARDED_VALUES).sort();
  for (const kind of ["apex", "admin"]) {
    const tracker = trackedBody();
    const response = await dispatch(rawRequest({
      headers: [...sent, ["x-tibotattle-edge-host", kind]],
      body: tracker.stream,
    }));
    assert.equal(response.status, 200);
    const seen = calls.at(-1).headers.sort();
    const expected = kind === "admin"
      ? [...expectedApex, ["cf-access-jwt-assertion", "synthetic.access.assertion"]].sort()
      : expectedApex;
    assert.deepEqual(seen, expected, kind);
    for (const [name] of seen) {
      assert.ok(!name.startsWith("x-tibotattle-"), name);
      assert.ok(!name.startsWith("x-forwarded-"), name);
      assert.ok(name === "cf-access-jwt-assertion" || !name.startsWith("cf-"), name);
      assert.notEqual(name, "x-serverless-authorization");
    }
    const serialized = JSON.stringify(seen);
    assert.ok(!serialized.includes("203.0.113.7"), "no client address reaches inner");
    assert.ok(!serialized.includes("SIGNATURE_REMOVED_BY_GOOGLE"), "no token reaches inner");
  }
  // The list above is the contract's.
  assert.deepEqual(Object.keys(FORWARDED_VALUES), [...contract.FORWARDED_REQUEST_HEADERS]);
});

test("the body streams to inner unbuffered and the signal follows the raw request", async () => {
  const controller = new AbortController();
  let pullsBeforeInner = null;
  let aborted = null;
  const tracker = trackedBody();
  const dispatch = createDispatch({
    inner: async (request) => {
      pullsBeforeInner = tracker.pulls;
      const text = await request.text();
      controller.abort();
      aborted = request.signal.aborted;
      return new Response(text, { status: 201, statusText: "Created" });
    },
  });
  const response = await dispatch(rawRequest({ body: tracker.stream, signal: controller.signal }));
  assert.equal(pullsBeforeInner, 0, "nothing is read before inner");
  assert.equal(response.status, 201);
  assert.equal(response.statusText, "Created");
  assert.equal(await response.text(), BODY_TEXT);
  assert.equal(aborted, true);
});

test("every inner response carries the marker and separate Set-Cookie headers", async () => {
  const dispatch = createDispatch({
    inner: async () => {
      const headers = new Headers({
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-tibotattle-origin": "spoofed",
        vary: "Origin",
      });
      headers.append("set-cookie", "__Host-usage_monitor_session=a; Path=/; Secure; HttpOnly; SameSite=Lax");
      headers.append("set-cookie", "__Host-usage_monitor_handoff=; Path=/; Max-Age=0; Secure; HttpOnly");
      return new Response("{\"ok\":true}", { status: 202, statusText: "Accepted", headers });
    },
  });
  const response = await dispatch(rawRequest());
  assert.equal(response.status, 202);
  assert.equal(response.statusText, "Accepted");
  assertMarked(response);
  assert.deepEqual(response.headers.getSetCookie(), [
    "__Host-usage_monitor_session=a; Path=/; Secure; HttpOnly; SameSite=Lax",
    "__Host-usage_monitor_handoff=; Path=/; Max-Age=0; Secure; HttpOnly",
  ]);
  assert.equal(response.headers.get("vary"), "Origin");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "{\"ok\":true}");

  // Immutable-header responses (a redirect) are marked too.
  const redirect = await createDispatch({
    inner: async () => Response.redirect(`${PUBLIC_ORIGIN}/after`, 302),
  })(rawRequest({ method: "GET" }));
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), `${PUBLIC_ORIGIN}/after`);
  assertMarked(redirect);
});

test("a throw or a non-Response from inner answers a marked Worker 500", async () => {
  for (const inner of [
    async () => { throw new Error("synthetic failure with /private/detail"); },
    () => { throw new TypeError("synchronous failure"); },
    async () => ({ status: 200 }),
    async () => Response.error(),
  ]) {
    const response = await createDispatch({ inner })(rawRequest());
    assert.equal(response.status, 500);
    assertMarked(response);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    const body = await response.json();
    assert.deepEqual(body, { error: { code: "INTERNAL_ERROR", requestId: REQUEST_ID } });
  }
});

test("the verifier reads /api/health and /api/ready on the apex, with no admission", async () => {
  const { inner, calls } = recordingInner(async (request) => {
    // The admission scope is null: any limiter call is refused.
    const limited = await limiters.createEdgeAdmissionLimiters().bindings.ENROLLMENT_RATE_LIMIT
      .limit({ key: "usage-monitor:enrollment:global" })
      .then(() => "resolved", (error) => error.code);
    return Response.json({ path: new URL(request.url).pathname, limited });
  });
  const dispatch = createDispatch({ inner, verifierServiceAccounts: [VERIFIER, OTHER_ACCOUNT] });
  for (const [path, email] of [["/api/health", VERIFIER], ["/api/ready", OTHER_ACCOUNT]]) {
    const response = await dispatch(rawRequest({
      method: "GET",
      path,
      edge: false,
      auth: token({ email }),
      headers: [["cf-connecting-ip", "203.0.113.7"], ["cookie", "a=b"]],
    }));
    assert.equal(response.status, 200, path);
    assertMarked(response);
    assert.equal(calls.at(-1).url, `${PUBLIC_ORIGIN}${path}`);
    assert.equal(calls.at(-1).context, undefined, "a verifier carries no edge request id");
    assert.deepEqual(calls.at(-1).headers, [["cookie", "a=b"]]);
  }
  assert.equal(calls[1].url, "https://tibotattle.com/api/ready");

  // The dispatch's own admission scope is null for the verifier.
  const admission = limiters.createEdgeAdmissionLimiters();
  const scoped = await createDispatch({
    admission,
    inner: async () => {
      const outcome = await admission.bindings.ENROLLMENT_RATE_LIMIT
        .limit({ key: "usage-monitor:enrollment:global" })
        .then(() => "resolved", (error) => error.code);
      return new Response(outcome);
    },
  })(rawRequest({ method: "GET", path: "/api/ready", edge: false, auth: token({ email: VERIFIER }) }));
  assert.equal(await scoped.text(), "EDGE_ADMISSION_REPLAY_NO_OUTCOME");
  // A verifier-shaped request from the invoker still needs the edge headers.
  await assertRefusal(await dispatch(rawRequest({ method: "GET", path: "/api/health", edge: false })), "invoker without edge headers");
});

test("edgeRequestContext returns the edge id only for the rebuilt Request", async () => {
  let seen;
  const raw = rawRequest({ headers: [["x-tibotattle-edge-host", "admin"]] });
  await createDispatch({
    inner: async (request) => {
      seen = {
        context: dispatchModule.edgeRequestContext(request),
        clone: dispatchModule.edgeRequestContext(request.clone()),
        copy: dispatchModule.edgeRequestContext(new Request(request.url, { headers: request.headers })),
        raw: dispatchModule.edgeRequestContext(raw),
      };
      return new Response(null, { status: 204 });
    },
  })(raw);
  assert.deepEqual(seen.context, { requestId: REQUEST_ID, hostKind: "admin" });
  assert.ok(Object.isFrozen(seen.context));
  assert.equal(seen.clone, undefined);
  assert.equal(seen.copy, undefined);
  assert.equal(seen.raw, undefined);
  for (const value of [undefined, null, "request", 7]) {
    assert.equal(dispatchModule.edgeRequestContext(value), undefined);
  }
});

test("edgeServedAssets answers the Worker JSON 404 NOT_FOUND with no-store", async () => {
  let inside;
  await createDispatch({
    inner: async (request) => {
      inside = await dispatchModule.edgeServedAssets.fetch(request);
      return new Response(null, { status: 204 });
    },
  })(rawRequest({ method: "GET", path: "/index.html" }));
  assert.equal(inside.status, 404);
  assert.equal(inside.headers.get("cache-control"), "no-store");
  assert.equal(inside.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await inside.json(), { error: { code: "NOT_FOUND", requestId: REQUEST_ID } });
  const outside = await dispatchModule.edgeServedAssets.fetch(new Request(`${PUBLIC_ORIGIN}/app.js`));
  assert.equal(outside.status, 404);
  const body = await outside.json();
  assert.equal(body.error.code, "NOT_FOUND");
  assert.ok(contract.isEdgeRequestId(body.error.requestId));
});

test("construction refuses invalid configuration", () => {
  const invalid = [
    [{ invokerServiceAccount: "edge-invoker@gmail.com" }, "EDGE_ORIGIN_INVOKER_INVALID"],
    [{ invokerServiceAccount: undefined }, "EDGE_ORIGIN_INVOKER_INVALID"],
    [{ verifierServiceAccounts: "origin-verifier@synthetic-edge-0.iam.gserviceaccount.com" }, "EDGE_ORIGIN_VERIFIER_ACCOUNTS_INVALID"],
    [{ verifierServiceAccounts: [INVOKER] }, "EDGE_ORIGIN_VERIFIER_ACCOUNTS_INVALID"],
    [{ verifierServiceAccounts: [VERIFIER, VERIFIER] }, "EDGE_ORIGIN_VERIFIER_ACCOUNTS_INVALID"],
    [{ verifierServiceAccounts: ["not-an-account"] }, "EDGE_ORIGIN_VERIFIER_ACCOUNTS_INVALID"],
    [{
      verifierServiceAccounts: ["a", "b", "c", "d", "e"].map((prefix) => `${prefix}-verifier@synthetic-edge-0.iam.gserviceaccount.com`),
    }, "EDGE_ORIGIN_VERIFIER_ACCOUNTS_INVALID"],
    [{ audience: "" }, "EDGE_ORIGIN_AUDIENCE_INVALID"],
    [{ audience: " padded" }, "EDGE_ORIGIN_AUDIENCE_INVALID"],
    [{ audience: "a".repeat(257) }, "EDGE_ORIGIN_AUDIENCE_INVALID"],
    [{ publicOrigin: "http://tibotattle.com" }, "EDGE_ORIGIN_PUBLIC_ORIGIN_INVALID"],
    [{ publicOrigin: "https://tibotattle.com/" }, "EDGE_ORIGIN_PUBLIC_ORIGIN_INVALID"],
    [{ publicOrigin: "https://tibotattle.com/path" }, "EDGE_ORIGIN_PUBLIC_ORIGIN_INVALID"],
    [{ publicOrigin: "https://tibotattle.com:8443" }, "EDGE_ORIGIN_PUBLIC_ORIGIN_INVALID"],
    [{ publicOrigin: "https://user@tibotattle.com" }, "EDGE_ORIGIN_PUBLIC_ORIGIN_INVALID"],
    [{ publicOrigin: "https://admin.tibotattle.com" }, "EDGE_ORIGIN_PUBLIC_ORIGIN_INVALID"],
    [{ publicOrigin: undefined }, "EDGE_ORIGIN_PUBLIC_ORIGIN_INVALID"],
    [{ admission: {} }, "EDGE_ORIGIN_ADMISSION_INVALID"],
    [{ admission: null }, "EDGE_ORIGIN_ADMISSION_INVALID"],
    [{ inner: undefined }, "EDGE_ORIGIN_INNER_INVALID"],
    [{ clock: 1_800_000_000_000 }, "EDGE_ORIGIN_CLOCK_INVALID"],
  ];
  for (const [overrides, code] of invalid) {
    assert.throws(
      () => createDispatch(overrides),
      (error) => error instanceof TypeError && error.code === code,
      JSON.stringify(overrides),
    );
  }
  assert.throws(() => dispatchModule.createEdgeOriginDispatch(), TypeError);
  // Zero verifiers is valid, and so are four.
  createDispatch({ verifierServiceAccounts: [] });
  createDispatch({ verifierServiceAccounts: undefined });
  createDispatch({
    verifierServiceAccounts: ["a", "b", "c", "d"].map((prefix) => `${prefix}-verifier@synthetic-edge-0.iam.gserviceaccount.com`),
  });
});

test("with zero verifiers a verifier token is an unknown caller", async () => {
  const { inner, calls } = recordingInner();
  const dispatch = createDispatch({ inner, verifierServiceAccounts: [] });
  await assertRefusal(await dispatch(rawRequest({
    method: "GET",
    path: "/api/health",
    edge: false,
    auth: token({ email: VERIFIER }),
  })), "no verifiers");
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Admission replay through the boundary with the real helpers.

function originClientKey(purpose) {
  const digest = createHmac("sha256", ORIGIN_IDENTITY_LINK_SECRET)
    .update(`app-usagemonitor/rate-limit/v1\0${purpose}\0unavailable`)
    .digest("hex");
  return `usage-monitor:${purpose}:client:${digest}`;
}

/**
 * A stub route that calls the Worker helper the Worker calls for it and
 * renders failures as index.ts's catch does. `keys` records every limiter key.
 */
function routeStub(bindings, keys) {
  const spied = Object.fromEntries(Object.entries(bindings).map(([name, binding]) => [name, {
    async limit(options) {
      keys.push(options.key);
      return binding.limit(options);
    },
  }]));
  const helpers = {
    enroll: (request) => admissionHelpers.assertAttemptAllowed(
      spied.ENROLLMENT_RATE_LIMIT, spied.CLIENT_ATTEMPT_RATE_LIMIT, request, ORIGIN_ENV, "enrollment"),
    device_sync_state: (request) => admissionHelpers.assertAttemptAllowed(
      spied.RECOVERY_RATE_LIMIT, spied.CLIENT_ATTEMPT_RATE_LIMIT, request, ORIGIN_ENV, "device_sync"),
    contributions: (request) => admissionHelpers.assertUploadIngressRequestAllowed(
      spied.UPLOAD_INGRESS_REQUEST_RATE_LIMIT, spied.UPLOAD_INGRESS_CLIENT_RATE_LIMIT, request, ORIGIN_ENV),
    community_daily: (request) => admissionHelpers.assertPublicAggregateReadAllowed(
      spied.PUBLIC_READ_RATE_LIMIT, request, ORIGIN_ENV),
    // The removed v1.2 divergence: an extra device_sync attempt on uploads.
    contributions_with_device_sync: async (request) => {
      await admissionHelpers.assertAttemptAllowed(
        spied.RECOVERY_RATE_LIMIT, spied.CLIENT_ATTEMPT_RATE_LIMIT, request, ORIGIN_ENV, "device_sync");
      await admissionHelpers.assertUploadIngressRequestAllowed(
        spied.UPLOAD_INGRESS_REQUEST_RATE_LIMIT, spied.UPLOAD_INGRESS_CLIENT_RATE_LIMIT, request, ORIGIN_ENV);
    },
  };
  return async (request) => {
    const requestId = dispatchModule.edgeRequestContext(request)?.requestId ?? crypto.randomUUID();
    try {
      await helpers[new URL(request.url).searchParams.get("route")](request);
      return errors.jsonResponse({ ok: true });
    } catch (error) {
      const apiError = error instanceof errors.ApiError ? error : new errors.ApiError(500, "INTERNAL_ERROR");
      return errors.errorResponse(apiError, requestId);
    }
  };
}

test("real helpers replay edge outcomes through the boundary", async () => {
  const admission = limiters.createEdgeAdmissionLimiters();
  const keys = [];
  const dispatch = createDispatch({ admission, inner: routeStub(admission.bindings, keys) });
  const rows = [
    ["enroll", "v1;enrollment;allowed", 200, null],
    ["enroll", "v1;enrollment;limited", 429, "ATTEMPT_LIMIT_REACHED"],
    ["enroll", "v1;enrollment;unavailable", 503, "ADMISSION_RATE_LIMIT_UNAVAILABLE"],
    ["enroll", null, 503, "ADMISSION_RATE_LIMIT_UNAVAILABLE"],
    ["enroll", "v1;sign_in_start;allowed", 503, "ADMISSION_RATE_LIMIT_UNAVAILABLE"],
    ["device_sync_state", "v1;device_sync;allowed", 200, null],
    ["device_sync_state", "v1;device_sync;limited", 429, "ATTEMPT_LIMIT_REACHED"],
    ["contributions", "v1;upload_ingress;allowed", 200, null],
    ["contributions", "v1;upload_ingress;limited", 429, "UPLOAD_INGRESS_LIMIT_REACHED"],
    ["contributions", "v1;upload_ingress;unavailable", 503, "UPLOAD_INGRESS_UNAVAILABLE"],
    ["contributions", null, 503, "UPLOAD_INGRESS_UNAVAILABLE"],
    ["contributions", "v1;device_sync;allowed", 503, "UPLOAD_INGRESS_UNAVAILABLE"],
    ["contributions_with_device_sync", "v1;upload_ingress;allowed", 503, "ADMISSION_RATE_LIMIT_UNAVAILABLE"],
    ["community_daily", "v1;public_aggregate_read;allowed", 200, null],
    ["community_daily", "v1;public_aggregate_read;limited", 429, "ATTEMPT_LIMIT_REACHED"],
    ["community_daily", "v1;public_aggregate_read;unavailable", 503, "ADMISSION_RATE_LIMIT_UNAVAILABLE"],
  ];
  for (const [route, admissionHeader, status, code] of rows) {
    const headers = [["cf-connecting-ip", "203.0.113.7"], ["x-forwarded-for", "203.0.113.7"]];
    if (admissionHeader !== null) headers.push(["x-tibotattle-edge-admission", admissionHeader]);
    const label = `${route} ${admissionHeader}`;
    const response = await dispatch(rawRequest({ path: `/api/v1/example?route=${route}`, headers }));
    assert.equal(response.status, status, label);
    assertMarked(response);
    if (code === null) {
      assert.deepEqual(await response.json(), { ok: true }, label);
      continue;
    }
    assert.equal(response.headers.get("retry-after"), "60", label);
    assert.equal(response.headers.get("cache-control"), "no-store", label);
    assert.deepEqual(await response.json(), { error: { code, requestId: REQUEST_ID } }, label);
  }
  // Every client key came from the 'unavailable' subject: no address reached
  // the helpers even though the raw request carried one.
  const clientKeys = keys.filter((key) => key.includes(":client:"));
  assert.ok(clientKeys.length > 0);
  for (const key of clientKeys) {
    const purpose = key.split(":")[1];
    assert.equal(key, originClientKey(purpose));
  }
});

test("50 concurrent boundary requests keep their own outcomes", async () => {
  const admission = limiters.createEdgeAdmissionLimiters();
  const dispatch = createDispatch({ admission, inner: routeStub(admission.bindings, []) });
  const outcomes = [["allowed", 200], ["limited", 429], ["unavailable", 503]];
  const routes = [
    ["enroll", "enrollment"],
    ["device_sync_state", "device_sync"],
    ["contributions", "upload_ingress"],
    ["community_daily", "public_aggregate_read"],
  ];
  const requests = Array.from({ length: 50 }, (_, index) => {
    const [route, purpose] = routes[index % routes.length];
    const [outcome, status] = outcomes[index % outcomes.length];
    const requestId = crypto.randomUUID();
    return dispatch(rawRequest({
      path: `/api/v1/example?route=${route}`,
      headers: [
        ["x-tibotattle-edge-admission", `v1;${purpose};${outcome}`],
        ["x-tibotattle-edge-request-id", requestId],
      ],
    })).then(async (response) => ({ status, requestId, response, body: await response.json() }));
  });
  for (const { status, requestId, response, body } of await Promise.all(requests)) {
    assert.equal(response.status, status);
    if (status !== 200) assert.equal(body.error.requestId, requestId);
  }
});

test("no console output", () => {
  for (const spy of consoleSpies) assert.equal(spy.mock.callCount(), 0);
});
