// E12 harness checks: offline, no PostgreSQL, no Miniflare, no network.
//
// They prove the end-to-end harness can fail: the token issuer refuses a
// wrong-key, wrong-audience or expired assertion; the Cloud Run front-end
// emulator refuses a bad signature, a wrong audience and an account IAM does
// not admit with Google's unmarked 401/403 and strips the signature
// otherwise; the request matrix sends every WORKER_ROUTE_POLICY (route,
// method) pair at least once and every EP-1 policy entry the origin serves in
// S4; and the e2e bundle config keeps the checked-in compatibility settings.

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { bundleExportNames, readCompatibility, wranglerEnvironment } from "./edge-bundle.mjs";
import {
  RETIRED_DEFINITE_PREAMBLE_STEPS,
  RETIRED_ROUTE_DEFINITE_ANSWERS,
} from "../../cloud-run/postgres-production-registry.mjs";
import {
  EDGE_E2E_AUDIENCE,
  EDGE_E2E_INVOKER,
  EDGE_E2E_STRANGER,
  EDGE_E2E_UPSTREAM_ORIGIN,
  EDGE_E2E_VERIFIER,
  readCheckedInProductionLimits,
} from "./edge-instances.mjs";
import {
  ASSERTION_LIFETIME_SECONDS,
  GOOGLE_TOKEN_URL,
  SIGNATURE_REMOVED,
  SYNTHETIC_FRONT_END_EGRESS_ADDRESS,
  createGoogleFrontEnd,
  createSyntheticIssuer,
  createSyntheticServiceAccountKey,
  loopbackOrigin,
  mintIdToken,
  signJwt,
  verifyTokenAssertion,
} from "./google-front-end.mjs";
import {
  EDGE_LOCAL_ROUTE_IDS,
  PUBLICATION_DISABLED_ROW,
  UNKNOWN_DEVICE_BEARER,
  adminRows,
  admissionRows,
  definiteSweepAnswers,
  forwardedRows,
  localRows,
  routeMethodCoverage,
  sweepRows,
} from "./request-matrix.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
let vite;
let registry;
let policy;
let composition;

before(async () => {
  vite = await createServer({
    root: WORKER_ROOT, configFile: false, appType: "custom", logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
  });
  registry = await vite.ssrLoadModule("/src/route-registry.ts");
  policy = await vite.ssrLoadModule("/src/edge-admission-policy.ts");
  // The origin serves the production ported list (D-CRB: edge-test runs the
  // production handler over the one registry).
  composition = await vite.ssrLoadModule("/src/backend-composition.ts");
});
after(async () => { await vite?.close(); });

const invoker = createSyntheticServiceAccountKey(EDGE_E2E_INVOKER);

function assertion(overrides = {}, { key = null, header = {} } = {}) {
  const now = Math.floor(Date.now() / 1_000);
  const payload = {
    iss: EDGE_E2E_INVOKER, sub: EDGE_E2E_INVOKER, aud: GOOGLE_TOKEN_URL, target_audience: EDGE_E2E_AUDIENCE,
    iat: now, exp: now + ASSERTION_LIFETIME_SECONDS, ...overrides,
  };
  const signer = key ?? JSON.parse(invoker.keyJson).private_key;
  return signJwt(signer, { alg: "RS256", typ: "JWT", kid: invoker.keyId, ...header }, payload);
}

test("token issuer: a valid assertion passes; a wrong key, audience or expired assertion is refused", () => {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const check = (value) => verifyTokenAssertion({ assertion: value, invoker, audience: EDGE_E2E_AUDIENCE, nowSeconds });
  assert.deepEqual(check(assertion()), { ok: true });
  const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  assert.deepEqual(check(assertion({}, { key: otherKey })), { ok: false, reason: "signature" });
  assert.deepEqual(check(assertion({ target_audience: "https://other.example" })), { ok: false, reason: "target_audience" });
  assert.deepEqual(check(assertion({ aud: "https://example.test/token" })), { ok: false, reason: "audience" });
  assert.deepEqual(check(assertion({ iat: nowSeconds - 7_200, exp: nowSeconds - 3_600 })), { ok: false, reason: "expired" });
  assert.deepEqual(check(assertion({ exp: nowSeconds + 60 })), { ok: false, reason: "lifetime" });
  assert.deepEqual(check(assertion({ iss: EDGE_E2E_STRANGER, sub: EDGE_E2E_STRANGER })), { ok: false, reason: "issuer" });
  assert.deepEqual(check(assertion({}, { header: { kid: "0".repeat(40) } })), { ok: false, reason: "key_id" });
});

async function withOrigin(work) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json", "x-tibotattle-origin": "1" });
    res.end("{\"ok\":true}");
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    return await work({ port: server.address().port, seen });
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

test("front-end emulator: bad signature, wrong audience and unknown accounts get Google's unmarked 401/403", async () => {
  await withOrigin(async ({ port, seen }) => {
    const frontEnd = createGoogleFrontEnd({ invoker, verifiers: [EDGE_E2E_VERIFIER], audience: EDGE_E2E_AUDIENCE,
      upstreamOrigin: EDGE_E2E_UPSTREAM_ORIGIN, origin: loopbackOrigin(port) });
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const foreign = createSyntheticIssuer();
    for (const [label, request, status] of [
      ["no token", { path: "/api/health" }, 401],
      ["bad signature", { path: "/api/health", token: mintIdToken({ issuer: foreign, email: EDGE_E2E_INVOKER,
        audience: EDGE_E2E_AUDIENCE, nowSeconds }) }, 401],
      ["wrong audience", { path: "/api/health", token: frontEnd.mintToken(EDGE_E2E_INVOKER,
        { audience: "https://other-origin.example" }) }, 401],
      ["expired", { path: "/api/health", token: frontEnd.mintToken(EDGE_E2E_INVOKER, { lifetimeSeconds: -10 }) }, 401],
      ["unknown account", { path: "/api/health", email: EDGE_E2E_STRANGER }, 403],
    ]) {
      const answer = await frontEnd.direct(request);
      assert.equal(answer.status, status, label);
      assert.equal(answer.headers["x-tibotattle-origin"], undefined, `${label}: never marked`);
      assert.match(answer.body.toString(), /<html>/u, `${label}: Google's own page`);
    }
    assert.equal(seen.length, 0, "no refused request reached the origin");
    const admitted = await frontEnd.direct({ path: "/api/health", email: EDGE_E2E_VERIFIER,
      headers: { "x-forwarded-for": "203.0.113.200", "cf-connecting-ip": "203.0.113.200" } });
    assert.equal(admitted.status, 200);
    assert.equal(seen.length, 1);
    const delivered = seen[0].headers["x-serverless-authorization"];
    assert.match(delivered, new RegExp(`^Bearer [A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.${SIGNATURE_REMOVED}$`, "u"));
    assert.equal(seen[0].headers["x-forwarded-for"], SYNTHETIC_FRONT_END_EGRESS_ADDRESS,
      "the front end's own address replaces any client value");
    assert.equal(seen[0].headers.host, `127.0.0.1:${port}`);
    assert.equal(admitted.headers.server, "Google Frontend");
    // Removing the account from IAM is the detector control: the same request is refused.
    frontEnd.setHooks({ iamRemoved: [EDGE_E2E_VERIFIER] });
    assert.equal((await frontEnd.direct({ path: "/api/health", email: EDGE_E2E_VERIFIER })).status, 403);
    frontEnd.clearHooks();
    assert.equal((await frontEnd.direct({ path: "/api/health", email: EDGE_E2E_VERIFIER })).status, 200);
  });
});

test("front-end emulator: any host other than the token endpoint and the origin is refused", async () => {
  const frontEnd = createGoogleFrontEnd({ invoker, audience: EDGE_E2E_AUDIENCE, upstreamOrigin: EDGE_E2E_UPSTREAM_ORIGIN });
  const server = http.createServer((req, res) => frontEnd.node(req, res));
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const outcome = await new Promise((resolveRequest) => {
      const request = http.request({ host: "127.0.0.1", port: server.address().port, path: "/",
        headers: { host: "api.cloudflare.com" } }, () => resolveRequest("answered"));
      request.on("error", () => resolveRequest("refused"));
      request.end();
    });
    assert.equal(outcome, "refused");
    assert.deepEqual(frontEnd.refusals.map((refusal) => refusal.host), ["api.cloudflare.com"]);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("the request matrix sends every WORKER_ROUTE_POLICY (route, method) pair and S4 covers every served EP-1 entry", () => {
  const routes = registry.WORKER_ROUTE_POLICY;
  const served = composition.POSTGRES_PORTED_WORKER_ROUTE_IDS;
  const guard = routes.find((route) => route.id === "sparkle_appcast_guard");
  const rows = [
    ...localRows({ registry: routes }),
    PUBLICATION_DISABLED_ROW,
    ...adminRows(),
    ...forwardedRows({ registry: routes }),
    ...sweepRows({ registry: routes, servedRouteIds: served }),
    { path: guard.pathname, method: "POST" },
  ];
  const coverage = routeMethodCoverage({ registry: routes, rows });
  assert.deepEqual(coverage.missing, [], "every (route, method) pair is sent");
  const s4 = admissionRows({ registry: routes, policyFor: policy.edgeAdmissionPolicyFor, servedRouteIds: served });
  const policyRoutes = routes.filter((route) => policy.edgeAdmissionPolicyFor(route.id) !== null);
  for (const route of policyRoutes) {
    for (const method of route.methods) {
      const inS4 = s4.some((row) => row.routeId === route.id && row.method === method);
      assert.equal(inS4, served.includes(route.id), `${route.id} ${method}: in S4 exactly when the origin serves it`);
    }
  }
  // The policy routes the origin does not serve are swept as unported rows,
  // or (rounds 12 and 19) as their retired-definite answer.
  const definiteAnswers = definiteSweepAnswers(RETIRED_DEFINITE_PREAMBLE_STEPS);
  const sweep = sweepRows({ registry: routes, servedRouteIds: served, definiteAnswers });
  for (const route of policyRoutes.filter((candidate) => !served.includes(candidate.id))) {
    const comparator = Object.hasOwn(RETIRED_ROUTE_DEFINITE_ANSWERS, route.id) ? "definite" : "unported";
    assert.ok(sweep.some((row) => row.routeId === route.id && row.comparators.includes(comparator)), route.id);
  }
  // The definite route is never swept as the unported 503. Round 19: the
  // sweep's unknown device bearer stops at the device-bearer step, 401
  // DEVICE_AUTH_INVALID (never the terminal 403), which the unchanged Worker
  // gives the same request, so the row also compares with the Worker.
  const definite = sweep.filter((row) => row.comparators.includes("definite"));
  assert.deepEqual([...new Set(definite.map((row) => row.routeId))], Object.keys(RETIRED_ROUTE_DEFINITE_ANSWERS));
  assert.deepEqual(JSON.parse(JSON.stringify(definiteAnswers)),
    { accountless_telemetry_performance_authorization: { status: 401, code: "DEVICE_AUTH_INVALID" } });
  for (const row of definite) {
    assert.equal(row.comparators.includes("unported"), false, row.id);
    assert.ok(row.comparators.includes("worker"), row.id);
    assert.deepEqual(row.expect, { ...definiteAnswers[row.routeId] }, row.id);
    assert.equal(row.headers.authorization, UNKNOWN_DEVICE_BEARER, row.id);
    assert.equal(row.headers.cookie, undefined, row.id);
  }
  assert.throws(() => definiteSweepAnswers({ synthetic: [["session_cookie", 401, "AUTH_INVALID"]] }),
    /REQUEST_MATRIX_DEFINITE_STEP_UNKNOWN synthetic/u);
  assert.deepEqual([...EDGE_LOCAL_ROUTE_IDS].sort(), ["apple_domain_association", "sparkle_appcast_guard"]);
  // Removing one sweep row is detected.
  const short = routeMethodCoverage({ registry: routes, rows: rows.filter((row) => row.id !== "sweep-envelope_key-GET"
    && row.id !== "envelope-key") });
  assert.deepEqual(short.missing, ["envelope_key GET"]);
});

test("the e2e bundle config keeps wrangler.jsonc's compatibility settings and names the edge entry", async () => {
  const compatibility = await readCompatibility(WORKER_ROOT);
  assert.equal(compatibility.e2e.date, compatibility.checkedIn.date);
  assert.deepEqual(compatibility.e2e.flags, compatibility.checkedIn.flags);
  assert.equal(compatibility.e2e.main, "../../src/edge-entry.ts");
  const env = wranglerEnvironment({ PATH: "/bin", HOME: "/home/x", CLOUDFLARE_API_TOKEN: "x", CLOUDFLARE_ACCOUNT_ID: "y" });
  assert.deepEqual(Object.keys(env).sort(), ["CI", "HOME", "PATH", "WRANGLER_SEND_METRICS"]);
  assert.equal(env.WRANGLER_SEND_METRICS, "false");
  assert.deepEqual(bundleExportNames("var a;\nexport {\n  b,\n  c as default,\n  a\n};\n//# sourceMappingURL=x.js.map\n"),
    ["a", "b", "default"]);
});

test("S4's production limits are the checked-in env.production values", async () => {
  const limits = await readCheckedInProductionLimits(WORKER_ROOT);
  assert.deepEqual(limits, {
    ENROLLMENT_RATE_LIMIT: 20, RECOVERY_RATE_LIMIT: 20, CLIENT_ATTEMPT_RATE_LIMIT: 5, PUBLIC_READ_RATE_LIMIT: 120,
    UPLOAD_AUTHORIZATION_RATE_LIMIT: 3000, UPLOAD_PRINCIPAL_RATE_LIMIT: 3000,
    UPLOAD_INGRESS_REQUEST_RATE_LIMIT: 3000, UPLOAD_INGRESS_CLIENT_RATE_LIMIT: 3000,
  });
});

test("the edge-mode dry run fails a gcp candidate that keeps storage or a main module with other exports", async () => {
  const { dryRunViolations } = await import("./edge-mode-dry-run.mjs");
  const exports = ["UploadIngressBudget", "contributionRequestPreflight", "default", "handleRequest",
    "isPostgresWorkerRequestPathSupported", "runScheduledMaintenance"];
  const storage = { d1: ["ANALYTICS_DB", "DELETION_LEDGER", "USAGE_MONITOR_DB"], r2: ["QUARANTINE", "SPARKLE_RELEASES"] };
  const good = [
    { mode: "worker", main: "src/edge-entry.ts", modeVar: "worker", exports, ...storage },
    { mode: "fenced", main: "src/edge-entry.ts", modeVar: "fenced", exports, ...storage },
    { mode: "gcp", main: "src/edge-entry.ts", modeVar: "gcp", exports, d1: ["RELEASE_GUARD_DB"], r2: ["SPARKLE_RELEASES"] },
  ];
  assert.deepEqual(dryRunViolations(good), []);
  assert.deepEqual(dryRunViolations([good[0], good[1], { ...good[2], d1: ["RELEASE_GUARD_DB", "USAGE_MONITOR_DB"] }]),
    ["gcp: a data binding survives"]);
  assert.deepEqual(dryRunViolations([{ ...good[0], exports: [...exports, "EDGE_LOCAL_ENV_KEYS"] }, good[1], good[2]]),
    [`worker: main-module exports ${[...exports, "EDGE_LOCAL_ENV_KEYS"].join(",")}`]);
});
