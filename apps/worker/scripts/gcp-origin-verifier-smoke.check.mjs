import assert from "node:assert/strict";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer } from "vite";
import {
  ORIGIN_SMOKE_CODES,
  ORIGIN_SMOKE_PROBES,
  ORIGIN_SMOKE_RECEIPT_SCHEMA,
  evaluateRollGate,
  keySetSha256,
  parseOriginSmokeArgs,
  runOriginSmoke,
} from "./gcp-origin-verifier-smoke.mjs";
import { createGcloudIdentityTokenSource } from "./production-edge-mode.mjs";

// A7 verifier smoke (W3-CRA phase A), dry-run and offline only. The execute
// orchestration runs here solely against an in-memory origin: a fake Google
// front end in front of the real EP-6 boundary, the CR-6 request handler and
// the RD-2/RD-3 DTO builders, with an injected token source. No gcloud runs
// (the one real token-source case has an empty PATH), no request leaves the
// process, and every account, token and URL is synthetic.

const execFile = promisify(execFileCallback);
const SCRIPT = fileURLToPath(new URL("./gcp-origin-verifier-smoke.mjs", import.meta.url));
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = "1".repeat(40);
const OTHER_COMMIT = "2".repeat(40);
const PROJECT = "w3-cra-prod-synth";
const UPSTREAM = "https://tibotattle-origin-synthetic.a.run.app";
const AUDIENCE = "https://synthetic-origin-audience.example";
const VERIFIER = `tibotattle-verifier@${PROJECT}.iam.gserviceaccount.com`;
const INVOKER = `tibotattle-edge-invoker@${PROJECT}.iam.gserviceaccount.com`;
const PUBLIC_ORIGIN = "https://tibotattle.test";
const TARGET = Object.freeze({
  environment: "production",
  project: PROJECT,
  projectNumber: "123456789012",
  region: "us-east1",
  service: "tibotattle-origin",
  migrationJob: "tibotattle-production-migrate",
  jobNames: Object.freeze(["tibotattle-production-migrate", "tibotattle-analytics-refresh"]),
  primaryInstance: "tibotattle-primary",
  imageRepository: `us-east1-docker.pkg.dev/${PROJECT}/tibotattle/origin`,
  builderServiceAccount: `tibotattle-builder@${PROJECT}.iam.gserviceaccount.com`,
  verifierServiceAccount: VERIFIER,
  originAudience: AUDIENCE,
  // The rollout target's maintenance Job (D-CRB): none until D-OPS4.
  maintenanceJob: null,
});
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const CYCLE = "2026-10-02T11:00:00.000Z";

let vite;
let dispatch;
let registryModule;
let contextModule;
let edgeDispatch;
let limiters;
let errors;
let readiness;
let health;
let policy;

before(async () => {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
  });
  const load = (path) => vite.ssrLoadModule(path);
  let routeRegistry;
  [dispatch, registryModule, contextModule, edgeDispatch, limiters, errors, readiness, health, routeRegistry] =
    await Promise.all([
      load("/cloud-run/postgres-host-dispatch.mjs"),
      load("/cloud-run/postgres-production-registry.mjs"),
      load("/cloud-run/postgres-request-context.mjs"),
      load("/cloud-run/postgres-edge-origin-dispatch.mjs"),
      load("/cloud-run/postgres-edge-admission-limiters.mjs"),
      load("/src/errors.ts"),
      load("/src/postgres-readiness.ts"),
      load("/src/postgres-health.ts"),
      load("/src/route-registry.ts"),
    ]);
  policy = routeRegistry.WORKER_ROUTE_POLICY;
});

after(async () => {
  await vite?.close();
});

function args({ execute = false, expectReady = "not_ready", expectCommit = COMMIT, environment = "production" } = {}) {
  return [
    `--environment=${environment}`,
    `--upstream-origin=${UPSTREAM}`,
    `--expect-commit=${expectCommit}`,
    `--expect-ready=${expectReady}`,
    ...(execute ? ["--execute"] : []),
  ];
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** The verifier's token as gcloud would print it (a signed-looking JWT). */
function verifierToken(email = VERIFIER) {
  const now = Math.floor(Date.now() / 1000);
  return [
    base64UrlJson({ alg: "RS256", kid: "0".repeat(40), typ: "JWT" }),
    base64UrlJson({ aud: AUDIENCE, email, email_verified: true, exp: now + 3_000, iat: now - 60,
      iss: "https://accounts.google.com", sub: "100000000000000000001" }),
    "c3ludGhldGljLXNpZ25hdHVyZQ",
  ].join(".");
}

const READY_STATE = Object.freeze({
  retention: { state: "completed", lastCompletedAtMs: NOW - 60_000, maintenanceRunAtIso: CYCLE,
    quarantineRetentionComplete: true, restoreReplayComplete: true },
  reconciliation: { state: "completed", maintenanceRunAtIso: CYCLE, reconciliationComplete: true },
});
const FRESH_STATE = Object.freeze({
  retention: { state: "never_run", lastCompletedAtMs: null, maintenanceRunAtIso: null,
    quarantineRetentionComplete: false, restoreReplayComplete: false },
  reconciliation: { state: "never_run", maintenanceRunAtIso: null, reconciliationComplete: false },
});

/**
 * An in-memory GCP origin: a fake Google front end (401 without a token,
 * the issued token passed on with its signature removed, as Cloud Run
 * delivers it) in front of the real EP-6 boundary and the CR-6 handler, whose
 * health and ready families answer the RD-3 and RD-2 builders' bodies.
 */
function syntheticOrigin({
  readinessState = FRESH_STATE,
  sourceCommit = COMMIT,
  healthBody,
  issuedToken,
  frontEnd,
} = {}) {
  const env = Object.freeze({ PUBLIC_ORIGIN, PUBLIC_ANALYTICS_MODE: "enabled", ENROLLMENT_MODE: "open" });
  const families = new Map(registryModule.POSTGRES_SCOPE_ROUTE_IDS.map((id) => [id, async () =>
    Response.json({ served: id })]));
  families.set("health", async () => errors.jsonResponse(healthBody ?? health.buildPostgresHealthBody({
    env,
    enrollmentMode: "open",
    controls: { state: "operational", enrollment: true, uploadRegistration: true, processing: true, publication: true },
    retention: READY_STATE.retention,
    sourceCommit,
    capabilityFlags: { participantExport: true, coordinatedSignInAdmission: true },
  })));
  families.set("ready", async () => {
    const result = readiness.buildPostgresReadinessBody(readinessState, NOW, { semantics: "worker-exact" });
    return errors.jsonResponse(result.body, result.httpStatus);
  });
  const registry = registryModule.createProductionRouteRegistry({
    routePolicy: policy, handlers: families, portedRouteIds: registryModule.POSTGRES_SCOPE_ROUTE_IDS,
  });
  const handler = dispatch.createProductionRequestHandler({
    registry,
    env,
    requestContextStore: contextModule.createRequestContextStore(),
    requestContext: edgeDispatch.edgeRequestContext,
    storageGate: { async assertCurrent() {} },
    recordDiagnostic: async () => {},
    logger: () => {},
    adminHostPolicy: "refuse",
    // OD-CR-6(iv) is open and has no default; the smoke never reads an unported route.
    unportedRetryAfterSeconds: null,
  });
  const boundary = edgeDispatch.createEdgeOriginDispatch({
    invokerServiceAccount: INVOKER,
    verifierServiceAccounts: [VERIFIER],
    audience: AUDIENCE,
    publicOrigin: PUBLIC_ORIGIN,
    admission: limiters.createEdgeAdmissionLimiters(),
    inner: handler,
  });
  const requests = [];
  async function fetchImpl(url, init) {
    const headers = new Headers(init.headers);
    requests.push({ url, authorization: headers.get("x-serverless-authorization"), redirect: init.redirect,
      credentials: init.credentials });
    const wrap = (response) => ({
      url,
      status: response.status,
      headers: response.headers,
      text: () => response.text(),
    });
    if (frontEnd !== undefined) {
      const answer = await frontEnd(url, headers);
      if (answer !== undefined) return wrap(answer);
    }
    const authorization = headers.get("x-serverless-authorization");
    if (authorization === null) {
      return wrap(new Response("<html>401</html>", { status: 401, headers: { "content-type": "text/html" } }));
    }
    if (authorization !== `Bearer ${issuedToken}`) {
      return wrap(new Response("<html>403</html>", { status: 403, headers: { "content-type": "text/html" } }));
    }
    const [header, payload] = issuedToken.split(".");
    headers.set("x-serverless-authorization", `Bearer ${header}.${payload}.SIGNATURE_REMOVED_BY_GOOGLE`);
    return wrap(await boundary(new Request(url, { method: init.method, headers })));
  }
  return { fetchImpl, requests };
}

function noToken() {
  return () => async () => { throw new Error("the dry run must not ask for a token"); };
}

function noFetch() {
  return async () => { throw new Error("the dry run must not fetch"); };
}

async function execute(options = {}, smokeArgs = args({ execute: true, expectReady: options.expectReady })) {
  const issuedToken = options.token ?? verifierToken();
  const origin = syntheticOrigin({ ...options, issuedToken });
  const tokenRequests = [];
  const receipt = await runOriginSmoke(smokeArgs, {
    loadTarget: async (environment) => {
      assert.equal(environment, "production");
      return TARGET;
    },
    createTokenSource: (request) => {
      tokenRequests.push(request);
      return async () => issuedToken;
    },
    fetchImpl: origin.fetchImpl,
  });
  const text = JSON.stringify(receipt);
  for (const secret of [issuedToken, issuedToken.split(".")[1], VERIFIER, AUDIENCE, UPSTREAM, PROJECT]) {
    assert.doesNotMatch(text, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
      "the receipt is content-free");
  }
  return { receipt, requests: origin.requests, tokenRequests, issuedToken };
}

function probe(receipt, name) {
  return receipt.probes.find((entry) => entry.probe === name);
}

// ---------------------------------------------------------------------------
// Arguments and the dry run

test("arguments: four required values, an optional --execute, nothing else (OD-CR-4 has no default)", () => {
  assert.deepEqual({ ...parseOriginSmokeArgs(args()) }, {
    environment: "production", upstreamOrigin: UPSTREAM, expectCommit: COMMIT, expectReady: "not_ready", execute: false,
  });
  assert.equal(parseOriginSmokeArgs(args({ execute: true, expectReady: "ready", environment: "staging" })).execute, true);
  const valid = args();
  const cases = [
    valid.filter((arg) => !arg.startsWith("--expect-ready")),
    valid.filter((arg) => !arg.startsWith("--environment")),
    valid.filter((arg) => !arg.startsWith("--upstream-origin")),
    valid.filter((arg) => !arg.startsWith("--expect-commit")),
    [...valid, "--expect-ready=ready"],
    [...valid, "--execute", "--execute"],
    [...valid, "--execute=yes"],
    [...valid, "--force"],
    [...valid, "production"],
    valid.map((arg) => arg.startsWith("--expect-ready") ? "--expect-ready=degraded" : arg),
    valid.map((arg) => arg.startsWith("--expect-ready") ? "--expect-ready" : arg),
    valid.map((arg) => arg.startsWith("--environment") ? "--environment=dev" : arg),
    valid.map((arg) => arg.startsWith("--expect-commit") ? `--expect-commit=${"1".repeat(39)}` : arg),
    valid.map((arg) => arg.startsWith("--expect-commit") ? `--expect-commit=${"A".repeat(40)}` : arg),
    valid.map((arg) => arg.startsWith("--upstream-origin") ? "--upstream-origin=https://tibotattle.com" : arg),
    valid.map((arg) => arg.startsWith("--upstream-origin") ? `--upstream-origin=${UPSTREAM}/` : arg),
    valid.map((arg) => arg.startsWith("--upstream-origin") ? "--upstream-origin=http://tibotattle-origin-synthetic.a.run.app" : arg),
    [],
  ];
  for (const argv of cases) {
    assert.throws(() => parseOriginSmokeArgs(argv), { code: "ORIGIN_SMOKE_ARGUMENT_INVALID" }, argv.join(" "));
  }
  assert.throws(() => parseOriginSmokeArgs("--environment=production"), { code: "ORIGIN_SMOKE_ARGUMENT_INVALID" });
});

test("dry run: validates the target, prints the content-free plan, asks for no token and fetches nothing", async () => {
  const plan = await runOriginSmoke(args(), {
    loadTarget: async () => TARGET,
    createTokenSource: noToken(),
    fetchImpl: noFetch(),
    verifyOrigin: async () => { throw new Error("the dry run must not verify"); },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), {
    schema: ORIGIN_SMOKE_RECEIPT_SCHEMA,
    environment: "production",
    mode: "dry-run",
    expectReady: "not_ready",
    verifier: "rolloutTarget",
    probes: ORIGIN_SMOKE_PROBES.map((entry) => ({ ...entry })),
    rollGate: "verifyEdgeOriginBeforeGcp",
  });
  assert.doesNotMatch(JSON.stringify(plan), /iam\.gserviceaccount|audience|run\.app/u);
  // An invalid or unavailable target refuses before anything else.
  await assert.rejects(runOriginSmoke(args(), { loadTarget: async () => ({ ...TARGET, verifierServiceAccount: "x" }) }),
    { code: "ROLLOUT_TARGET_INVALID" });
  await assert.rejects(runOriginSmoke(args(), { loadTarget: async () => ({ ...TARGET, environment: "staging" }) }),
    { code: "ROLLOUT_TARGET_INVALID" });
  await assert.rejects(runOriginSmoke(args(), { loadTarget: async () => { throw new Error("no code"); } }),
    { code: "ORIGIN_SMOKE_TARGET_UNAVAILABLE" });
  await assert.rejects(runOriginSmoke(args({ execute: true }), {
    loadTarget: async () => { throw Object.assign(new Error("x"), { code: "GCP_INFRA_DESIRED_STATE_UNCONFIGURED" }); },
    createTokenSource: noToken(),
    fetchImpl: noFetch(),
  }), { code: "GCP_INFRA_DESIRED_STATE_UNCONFIGURED" });
});

test("the CLI on the committed production desired state: a dry run without --execute, fails closed without gcloud", async () => {
  // PROD-PREP filled the committed production desired state, so the OPS-2
  // target now loads: without --execute the CLI prints its dry-run plan and
  // reads nothing; with --execute and no gcloud on PATH the token source
  // fails closed before any probe. An unloadable target's closed codes are
  // covered in-process above (ORIGIN_SMOKE_TARGET_UNAVAILABLE).
  const empty = await mkdtemp(join(tmpdir(), "w3-cra-smoke-path-"));
  try {
    const env = { PATH: empty };
    const run = (argv) => execFile(process.execPath, [SCRIPT, ...argv], { env, timeout: 30_000 })
      .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), (error) => error);

    const dry = await run(args());
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.stderr, "");
    const planned = JSON.parse(dry.stdout);
    assert.equal(planned.mode, "dry-run");
    assert.equal(planned.environment, "production");
    assert.equal(planned.rollGate, "verifyEdgeOriginBeforeGcp");

    const executed = await run(args({ execute: true }));
    assert.equal(executed.code, 1, executed.stderr);
    const receipt = JSON.parse(executed.stdout);
    assert.equal(receipt.mode, "execute");
    assert.equal(receipt.ok, false);
    assert.equal(receipt.code, "EDGE_ORIGIN_IDENTITY_TOKEN_UNAVAILABLE");
    assert.deepEqual(receipt.probes, []);
    assert.equal(receipt.rollGate, null);

    const incomplete = await run(["--environment=production"]);
    assert.equal(incomplete.code, 2);
    assert.equal(incomplete.stdout, "");
    const printed = JSON.parse(incomplete.stderr);
    assert.equal(printed.ok, false);
    assert.equal(printed.code, "ORIGIN_SMOKE_ARGUMENT_INVALID");
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("no gcloud on PATH: the real token source fails closed and nothing is fetched", async () => {
  const empty = await mkdtemp(join(tmpdir(), "w3-cra-smoke-path-"));
  const fetched = [];
  const spawned = [];
  // Guard: the child's PATH, not this process's, must govern the lookup, or
  // the case could reach a real gcloud. Prove it with a harmless command first.
  assert.throws(() => execFileSync("ls", [], { env: { PATH: empty }, stdio: "ignore" }), { code: "ENOENT" });
  try {
    const receipt = await runOriginSmoke(args({ execute: true }), {
      loadTarget: async () => TARGET,
      createTokenSource: (request) => createGcloudIdentityTokenSource({
        ...request,
        execFile: (command, commandArgs, options) => {
          spawned.push(command);
          return execFileSync(command, commandArgs, { ...options, env: { PATH: empty } });
        },
      }),
      fetchImpl: async (url) => { fetched.push(url); throw new Error("unreachable"); },
    });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.code, "EDGE_ORIGIN_IDENTITY_TOKEN_UNAVAILABLE");
    assert.deepEqual(receipt.probes, []);
    assert.equal(receipt.rollGate, null);
    assert.deepEqual(fetched, []);
    assert.deepEqual(spawned, ["gcloud"], "one lookup, refused by the empty PATH");
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The execute orchestration against the in-memory origin

test("an empty origin (OD-CR-4 as today): health ok, ready not_ready, confinement holds, roll gate refuses", async () => {
  const { receipt, requests, tokenRequests, issuedToken } = await execute();
  assert.deepEqual(tokenRequests, [{ verifierAccount: VERIFIER, audience: AUDIENCE }]);
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.code, null);
  assert.deepEqual(receipt.probes.map((entry) => [entry.probe, entry.status, entry.marked, entry.ok]), [
    ["health", 200, true, true],
    ["ready", 503, true, true],
    ["verifier_off_path", 421, false, true],
    ["verifier_query", 421, false, true],
    ["no_token", 401, false, true],
  ]);
  const healthProbe = probe(receipt, "health");
  assert.equal(healthProbe.valid, true);
  assert.equal(healthProbe.commitMatches, true);
  assert.match(healthProbe.keySetSha256, /^[0-9a-f]{64}$/u);
  assert.equal(probe(receipt, "ready").readyStatus, "not_ready");
  assert.deepEqual({ ...receipt.rollGate }, { ok: true, code: null, passed: false,
    gateCode: "EDGE_ORIGIN_VERIFIER_INVALID", commitMatches: false });
  // Five probes plus the rollout gate's two reads; only the no-token probe
  // goes without the token, and nothing follows a redirect or sends cookies.
  assert.equal(requests.length, 7);
  assert.deepEqual(requests.map((entry) => entry.authorization === null), [false, false, false, false, true, false, false]);
  for (const entry of requests) {
    assert.equal(entry.redirect, "error");
    assert.equal(entry.credentials, "omit");
    if (entry.authorization !== null) assert.equal(entry.authorization, `Bearer ${issuedToken}`);
  }
});

test("a ready origin: every probe and the rollout gate pass with the expected commit", async () => {
  const { receipt } = await execute({ readinessState: READY_STATE, expectReady: "ready" });
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(probe(receipt, "ready").status, 200);
  assert.equal(probe(receipt, "ready").readyStatus, "ready");
  assert.deepEqual({ ...receipt.rollGate }, { ok: true, code: null, passed: true, gateCode: null, commitMatches: true });
  // The key-set digests prove the shape without a value: same shape, same digest.
  const other = await execute({ readinessState: READY_STATE, expectReady: "ready", sourceCommit: OTHER_COMMIT },
    args({ execute: true, expectReady: "ready", expectCommit: OTHER_COMMIT }));
  assert.equal(probe(other.receipt, "health").keySetSha256, probe(receipt, "health").keySetSha256);
});

test("negative: the wrong commit, readiness or shape fails with its closed code", async () => {
  const mismatch = await execute({ sourceCommit: OTHER_COMMIT });
  assert.equal(mismatch.receipt.code, "ORIGIN_SMOKE_HEALTH_COMMIT_MISMATCH");
  assert.equal(probe(mismatch.receipt, "health").valid, true);

  const notReady = await execute({ expectReady: "ready" });
  assert.equal(probe(notReady.receipt, "ready").code, "ORIGIN_SMOKE_READY_UNEXPECTED");
  assert.equal(notReady.receipt.rollGate.code, "ORIGIN_SMOKE_ROLL_GATE_REFUSED");
  assert.equal(notReady.receipt.code, "ORIGIN_SMOKE_READY_UNEXPECTED");

  const unexpectedlyReady = await execute({ readinessState: READY_STATE, expectReady: "not_ready" });
  assert.equal(probe(unexpectedlyReady.receipt, "ready").code, "ORIGIN_SMOKE_READY_UNEXPECTED");
  assert.equal(unexpectedlyReady.receipt.rollGate.code, "ORIGIN_SMOKE_ROLL_GATE_UNEXPECTED");

  // The Worker's own health body (with the ledger keys) is not the GCP contract.
  const workerShaped = health.buildPostgresHealthBody({
    env: Object.freeze({ PUBLIC_ANALYTICS_MODE: "enabled" }),
    enrollmentMode: "open",
    controls: { state: "operational", enrollment: true, uploadRegistration: true, processing: true, publication: true },
    retention: READY_STATE.retention,
    sourceCommit: COMMIT,
    capabilityFlags: { participantExport: true, coordinatedSignInAdmission: true },
  });
  const withLedger = {
    ...workerShaped,
    checks: { database: "ok", deletionLedger: "ok", ...workerShaped.checks },
  };
  const ledger = await execute({ healthBody: withLedger });
  assert.equal(probe(ledger.receipt, "health").code, "ORIGIN_SMOKE_HEALTH_INVALID");
  assert.equal(probe(ledger.receipt, "health").valid, false);
});

test("negative: a broken boundary, an open front end and an unreachable origin are each named", async () => {
  // The origin answers a verifier off its two paths (EP-6 not in front of it).
  const open = await execute({ frontEnd: async (url) => new URL(url).pathname === "/api/v1/envelope-key"
    ? Response.json({ served: true }, { headers: { "x-tibotattle-origin": "1" } }) : undefined });
  assert.equal(probe(open.receipt, "verifier_off_path").code, "ORIGIN_SMOKE_CONFINEMENT_BROKEN");
  assert.equal(probe(open.receipt, "verifier_query").ok, true);
  assert.equal(open.receipt.code, "ORIGIN_SMOKE_CONFINEMENT_BROKEN");

  // The front end lets an unauthenticated request through.
  const iam = await execute({ frontEnd: async (_url, headers) => headers.has("x-serverless-authorization")
    ? undefined : new Response("{}", { status: 200 }) });
  assert.equal(probe(iam.receipt, "no_token").code, "ORIGIN_SMOKE_IAM_OPEN");

  // A marked 401 is the origin, not Google's front end.
  const marked = await execute({ frontEnd: async (_url, headers) => headers.has("x-serverless-authorization")
    ? undefined : new Response("{}", { status: 401, headers: { "x-tibotattle-origin": "1" } }) });
  assert.equal(probe(marked.receipt, "no_token").code, "ORIGIN_SMOKE_IAM_OPEN");

  // Unreachable: every probe is named, and the rollout gate reports its own code.
  const down = await runOriginSmoke(args({ execute: true }), {
    loadTarget: async () => TARGET,
    createTokenSource: () => async () => verifierToken(),
    fetchImpl: async () => { throw new TypeError("fetch failed"); },
  });
  assert.deepEqual(down.probes.map((entry) => entry.code), [
    "ORIGIN_SMOKE_HEALTH_UNREACHABLE",
    "ORIGIN_SMOKE_READY_UNREACHABLE",
    "ORIGIN_SMOKE_CONFINEMENT_UNREACHABLE",
    "ORIGIN_SMOKE_CONFINEMENT_UNREACHABLE",
    "ORIGIN_SMOKE_IAM_UNREACHABLE",
  ]);
  assert.equal(down.rollGate.gateCode, "EDGE_ORIGIN_VERIFIER_UNREACHABLE");
  assert.equal(down.code, "ORIGIN_SMOKE_HEALTH_UNREACHABLE");
  // A response from another URL (a followed redirect) is not an answer.
  const moved = await runOriginSmoke(args({ execute: true }), {
    loadTarget: async () => TARGET,
    createTokenSource: () => async () => verifierToken(),
    fetchImpl: async () => ({ url: "https://elsewhere.example/", status: 200, headers: new Headers(), text: async () => "{}" }),
  });
  assert.equal(moved.code, "ORIGIN_SMOKE_HEALTH_UNREACHABLE");
});

test("evaluateRollGate: the OD-CR-4 truth table", () => {
  const ready = { expectCommit: COMMIT, expectReady: "ready" };
  const notReady = { expectCommit: COMMIT, expectReady: "not_ready" };
  const cases = [
    [{ ok: true, code: null, originCommit: COMMIT }, ready, null],
    [{ ok: true, code: null, originCommit: OTHER_COMMIT }, ready, "ORIGIN_SMOKE_ROLL_GATE_COMMIT_MISMATCH"],
    [{ ok: false, code: "EDGE_ORIGIN_VERIFIER_NOT_READY" }, ready, "ORIGIN_SMOKE_ROLL_GATE_REFUSED"],
    [{ ok: false, code: "EDGE_ORIGIN_VERIFIER_INVALID" }, notReady, null],
    [{ ok: false, code: "EDGE_ORIGIN_VERIFIER_UNREACHABLE" }, notReady, "ORIGIN_SMOKE_ROLL_GATE_UNEXPECTED"],
    [{ ok: true, code: null, originCommit: COMMIT }, notReady, "ORIGIN_SMOKE_ROLL_GATE_UNEXPECTED"],
    [undefined, ready, "ORIGIN_SMOKE_ROLL_GATE_REFUSED"],
  ];
  for (const [verification, expectation, code] of cases) {
    const verdict = evaluateRollGate(verification, expectation);
    assert.equal(verdict.code, code, JSON.stringify([verification, expectation]));
    assert.equal(verdict.ok, code === null);
  }
  for (const code of ORIGIN_SMOKE_CODES) assert.match(code, /^ORIGIN_SMOKE_[A-Z_]+$/u);
});

test("keySetSha256 depends on the key paths and their order, never on values", () => {
  const a = keySetSha256({ status: "ok", checks: { database: "ok", lifecycle: "completed" } });
  assert.equal(a, keySetSha256({ status: "x", checks: { database: "y", lifecycle: 1 } }));
  assert.notEqual(a, keySetSha256({ checks: { database: "ok", lifecycle: "completed" }, status: "ok" }));
  assert.notEqual(a, keySetSha256({ status: "ok", checks: { database: "ok" } }));
});
