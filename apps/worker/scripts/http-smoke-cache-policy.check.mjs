import assert from "node:assert/strict";
import test from "node:test";
import { assertHttpSmokeCachePolicy } from "./http-smoke-cache-policy.mjs";

const dailyPath = "/api/v1/community/daily";
const publicCache = "public, max-age=300";
function response(cacheControl, { status = 200, headers = {} } = {}) {
  return new Response(null, {
    status,
    headers: {
      ...headers,
      ...(cacheControl === null ? {} : { "cache-control": cacheControl }),
    },
  });
}

test("successful daily community GET requires the exact bounded public cache policy", () => {
  const url = new URL(`${dailyPath}?from=2026-08-31&to=2026-08-31`, "http://127.0.0.1:8792");
  const request = { method: "GET", pathname: url.pathname };
  assert.doesNotThrow(() => assertHttpSmokeCachePolicy(response(publicCache), request));
  for (const invalid of [null, "no-store", "public", "public, max-age=301", "private, max-age=300", `${publicCache}, immutable`]) {
    assert.throws(() => assertHttpSmokeCachePolicy(response(invalid), request), /unexpected cache policy/u);
  }
});

test("private and all other paths still require no-store", () => {
  for (const pathname of [
    "/api/health", "/api/v1/session", "/api/v1/me/export", "/api/v1/admin/overview",
    "/api/v1/contributions", "/api/v1/community", `${dailyPath}/`, `${dailyPath}/export`,
    "/api/v1/community/DAILY",
  ]) {
    const request = { method: "GET", pathname };
    assert.doesNotThrow(() => assertHttpSmokeCachePolicy(response("no-store"), request));
    for (const invalid of [null, publicCache, "private, max-age=300"]) {
      assert.throws(() => assertHttpSmokeCachePolicy(response(invalid), request), /unexpected cache policy/u);
    }
  }
});

test("daily community failures and non-200 responses still require no-store", () => {
  const request = { method: "GET", pathname: dailyPath };
  for (const status of [201, 204, 301, 304, 400, 401, 403, 404, 405, 409, 413, 429, 500, 503]) {
    assert.doesNotThrow(() => assertHttpSmokeCachePolicy(response("no-store", { status }), request));
    assert.throws(() => assertHttpSmokeCachePolicy(response(publicCache, { status }), request), /unexpected cache policy/u);
  }
});

test("the public cache exception never applies to another method", () => {
  for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const request = { method, pathname: dailyPath };
    assert.doesNotThrow(() => assertHttpSmokeCachePolicy(response("no-store"), request));
    assert.throws(() => assertHttpSmokeCachePolicy(response(publicCache), request), /unexpected cache policy/u);
  }
});

test("a shared-cache community response cannot publish a session cookie", () => {
  const headers = { "set-cookie": "synthetic-session=not-a-credential" };
  assert.throws(() => assertHttpSmokeCachePolicy(response(publicCache, { headers }), {
    method: "GET", pathname: dailyPath,
  }), /unexpectedly set a cookie/u);
  assert.doesNotThrow(() => assertHttpSmokeCachePolicy(response("no-store", { headers }), {
    method: "POST", pathname: "/api/v1/enroll",
  }));
});
