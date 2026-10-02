import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { after, before, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// EDGE_ORIGIN_MODE=edge-test (EORIGIN) without PostgreSQL: the configuration
// refusals, the Cloud Run listen rule, the composition around a spy inner,
// the raw Node request path through the real serve(), the pins this mode
// shares with postgres-test-dispatch.mjs and the deploy script, and the
// direct deploy variant's rendered env. Every token, account and key is
// synthetic; nothing listens beyond 127.0.0.1 and nothing reaches Google.

const ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(ROOT, "..");
const INVOKER = "edge-invoker@synthetic-edge-0.iam.gserviceaccount.com";
const VERIFIER = "origin-verifier@synthetic-edge-0.iam.gserviceaccount.com";
const AUDIENCE = "https://edge-test-origin.synthetic.example";
const REQUEST_ID = "4f2c8a7e-1b3d-4e5f-9a6b-7c8d9e0f1a2b";
// Request headers inner must never see. cf-access-jwt-assertion is forwarded
// by EP-6 only on the admin host, whose requests never reach inner here.
const FORBIDDEN_INNER_HEADERS = Object.freeze([
  ["cf-access-jwt-assertion", "synthetic.access.jwt"],
  ["cf-connecting-ip", "203.0.113.7"],
  ["cf-ray", "0123456789abcdef-SJC"],
  ["cf-ipcountry", "US"],
  ["x-forwarded-for", "203.0.113.7"],
  ["x-forwarded-proto", "https"],
  ["x-real-ip", "203.0.113.7"],
  ["true-client-ip", "203.0.113.7"],
]);

let vite;
let mode;
let edgeDispatch;
let limiters;
let contract;
let constants;
let registry;
let runtimeSchema;
let server;
let testDispatch;
let fastpathMode;
let deploy;

before(async () => {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    logLevel: "silent",
  });
  const load = (path) => vite.ssrLoadModule(path);
  [mode, edgeDispatch, limiters, contract, constants, registry, runtimeSchema, server] = await Promise.all([
    load("/cloud-run/origin-edge-test-mode.mjs"),
    load("/cloud-run/postgres-edge-origin-dispatch.mjs"),
    load("/cloud-run/postgres-edge-admission-limiters.mjs"),
    load("/src/edge-origin-contract.ts"),
    load("/src/constants.ts"),
    load("/src/route-registry.ts"),
    load("/src/postgres-runtime-schema.ts"),
    load("/cloud-run/server.mjs"),
  ]);
  testDispatch = await import("./postgres-test-dispatch.mjs");
  fastpathMode = await import("./origin-fastpath-mode.mjs");
  deploy = await import("../scripts/gcp-fastpath-test-deploy.mjs");
});

after(async () => {
  await vite?.close();
});

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A token as Cloud Run's front end delivers it: signature removed. */
function token(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: AUDIENCE,
    email: INVOKER,
    email_verified: true,
    exp: now + 3_000,
    iat: now - 60,
    iss: "https://accounts.google.com",
    sub: "100000000000000000000",
    ...overrides,
  };
  const header = base64UrlJson({ alg: "RS256", kid: "0".repeat(40), typ: "JWT" });
  return `Bearer ${header}.${base64UrlJson(payload)}.SIGNATURE_REMOVED_BY_GOOGLE`;
}

function localEnv(port, overrides = {}) {
  return {
    EDGE_ORIGIN_MODE: "edge-test",
    EDGE_ORIGIN_AUDIENCE: AUDIENCE,
    EDGE_INVOKER_SERVICE_ACCOUNT: INVOKER,
    ANALYTICS_V2_ENABLED: "1",
    HOST: "127.0.0.1",
    PORT: String(port),
    HOST_ORIGIN: `http://127.0.0.1:${port}`,
    ...overrides,
  };
}

function cloudEnv(overrides = {}) {
  return localEnv(8080, {
    K_SERVICE: fastpathMode.FASTPATH_TEST_CLOUD_TARGET.originService,
    HOST: "0.0.0.0",
    PORT: "8080",
    HOST_ORIGIN: mode.EDGE_TEST_CLOUD_ORIGIN,
    ...overrides,
  });
}

function read(env, postgresTestMode = "fastpath-test") {
  return mode.readEdgeTestOriginConfiguration(env, { postgresTestMode });
}

function assertRefused(work, code, label) {
  assert.throws(work, (error) => error?.code === code, label ?? code);
}

/**
 * Runs work with console.log captured (the edge-test refusal log), so each
 * test can read the lines it caused and nothing reaches the test output.
 */
async function withCapturedLog(work) {
  const lines = [];
  const spy = mock.method(console, "log", (...args) => { lines.push(args.join(" ")); });
  try {
    return await work(lines);
  } finally {
    spy.mock.restore();
  }
}

/** The reasons of captured refusal lines, each checked to be the closed line. */
function loggedReasons(lines) {
  return lines.map((line) => {
    const parsed = JSON.parse(line);
    assert.equal(parsed.event, "edge_origin_boundary_refusal", line);
    const keys = Object.keys(parsed);
    assert.deepEqual(keys.slice(0, 2), ["event", "reason"], line);
    assert.ok(keys.length === 2 || (keys.length === 3 && keys[2] === "invokerShape"), line);
    return parsed.reason;
  });
}

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

// ---------------------------------------------------------------------------
// Constants and pins

test("constants: mode, origins, unported body and the served route ids", () => {
  assert.equal(mode.EDGE_TEST_ORIGIN_MODE, "edge-test");
  assert.equal(mode.EDGE_TEST_PUBLIC_ORIGIN, "https://tibotattle.test");
  assert.equal(mode.EDGE_TEST_CLOUD_ORIGIN, deploy.FASTPATH_TEST.originUrl,
    "the cloud origin is the deploy script's origin URL");
  assert.equal(contract.canonicalRunAppOrigin(mode.EDGE_TEST_CLOUD_ORIGIN), mode.EDGE_TEST_CLOUD_ORIGIN);
  assert.equal(mode.EDGE_TEST_UNPORTED_BODY,
    JSON.stringify({ status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" }));
  const ids = mode.EDGE_TEST_SERVED_ROUTE_IDS;
  assert.ok(Object.isFrozen(ids));
  assert.equal(ids.length, 29);
  assert.equal(new Set(ids).size, ids.length);
  const registryIds = new Set(registry.WORKER_ROUTE_POLICY.map((route) => route.id));
  for (const id of ids) assert.ok(registryIds.has(id), `${id} is a WORKER_ROUTE_POLICY id`);
  for (const id of ["apple_domain_association", "sparkle_appcast_guard", "ready", "admin_overview",
    "admin_action", "enroll", "identity_google_start", "participant_export"]) {
    assert.ok(!ids.includes(id), `${id} is not served`);
  }
});

test("postgres-test-dispatch.mjs pins: public origin, session cookie name and Upload header", async () => {
  const dispatchSource = await readFile(resolve(ROOT, "postgres-test-dispatch.mjs"), "utf8");
  const indexSource = await readFile(resolve(WORKER_ROOT, "src/index.ts"), "utf8");
  assert.ok(dispatchSource.includes(`const EDGE_TEST_PUBLIC_ORIGIN = "${mode.EDGE_TEST_PUBLIC_ORIGIN}";`));
  assert.ok(dispatchSource.includes(`const SESSION_COOKIE_NAME = "${constants.SESSION_COOKIE_NAME}";`));
  const literal = (source) => {
    const match = /const DEVICE_UPLOAD_AUTHORIZATION_HEADER =\s*(\/\^Upload [^\n]+\/u);/u.exec(source);
    assert.ok(match, "DEVICE_UPLOAD_AUTHORIZATION_HEADER literal");
    return match[1];
  };
  assert.equal(literal(dispatchSource), literal(indexSource),
    "the origin preflight's Upload header shape is index.ts's, byte for byte");

  // The dispatches accept exactly the edge-test public origin as a private origin.
  const pool = { connect() { throw new Error("no connection at construction"); } };
  const health = (privateOrigin) => testDispatch.createPostgresTestHealthDispatch({
    primaryPool: pool,
    schemaOptions: { primarySchema: "tibotattle_fastpath_check" },
    expectedMigrations: runtimeSchema.POSTGRES_RUNTIME_MIGRATIONS,
    privateOrigin,
  });
  assert.equal(typeof health(mode.EDGE_TEST_PUBLIC_ORIGIN), "function");
  for (const origin of ["http://tibotattle.test", "https://tibotattle.test/", "https://admin.tibotattle.test",
    "https://tibotattle.test:8443", "https://tibotattle.com"]) {
    assertRefused(() => health(origin), "POSTGRES_TEST_PRIVATE_ORIGIN_INVALID", origin);
  }
});

// ---------------------------------------------------------------------------
// Configuration

test("unset or empty EDGE_ORIGIN_MODE is null in every mode", () => {
  for (const postgresTestMode of [null, undefined, "health-only", "health-and-v12-day-manifest",
    "cloud-run-iam", "fastpath-test"]) {
    assert.equal(mode.readEdgeTestOriginConfiguration({}, { postgresTestMode }), null);
    assert.equal(mode.readEdgeTestOriginConfiguration({ EDGE_ORIGIN_MODE: "" }, { postgresTestMode }), null);
  }
  assert.equal(mode.readEdgeTestOriginConfiguration({}), null);
});

test("edge-test outside fastpath-test, or with no test mode, is refused first", () => {
  for (const postgresTestMode of [null, undefined, "health-only", "health-and-v12-day-manifest", "cloud-run-iam"]) {
    assertRefused(() => mode.readEdgeTestOriginConfiguration(localEnv(43000), { postgresTestMode }),
      "EDGE_TEST_ORIGIN_MODE_REQUIRES_FASTPATH_TEST", String(postgresTestMode));
    // The mode is checked before any other setting.
    assertRefused(() => mode.readEdgeTestOriginConfiguration(
      { EDGE_ORIGIN_MODE: "cloudflare-worker-iam" }, { postgresTestMode },
    ), "EDGE_TEST_ORIGIN_MODE_REQUIRES_FASTPATH_TEST", `${postgresTestMode}: production value`);
  }
});

test("any EDGE_ORIGIN_MODE other than edge-test is refused under fastpath-test", () => {
  for (const value of ["cloudflare-worker-iam", "cloudflare-shared-secret", "Edge-Test", " edge-test",
    "edge-test ", "edge", "gcp", "worker"]) {
    assertRefused(() => read(localEnv(43000, { EDGE_ORIGIN_MODE: value })),
      "EDGE_TEST_ORIGIN_MODE_INVALID", value);
  }
});

test("audience, invoker, verifiers and the community-daily module are validated", () => {
  for (const audience of [undefined, " padded", "a".repeat(257), "line\nbreak"]) {
    assertRefused(() => read(localEnv(43000, { EDGE_ORIGIN_AUDIENCE: audience })),
      "EDGE_TEST_ORIGIN_AUDIENCE_INVALID", String(audience));
  }
  for (const invoker of [undefined, "edge@example.com", "Edge-Invoker@synthetic-edge-0.iam.gserviceaccount.com",
    "edge-invoker@synthetic-edge-0.iam.gserviceaccount.com.evil"]) {
    assertRefused(() => read(localEnv(43000, { EDGE_INVOKER_SERVICE_ACCOUNT: invoker })),
      "EDGE_TEST_ORIGIN_INVOKER_INVALID", String(invoker));
  }
  const accounts = [0, 1, 2, 3, 4].map((index) => `origin-verifier-${index}@synthetic-edge-0.iam.gserviceaccount.com`);
  for (const verifiers of [
    accounts.join(","),
    `${VERIFIER},${VERIFIER}`,
    `${VERIFIER},${INVOKER}`,
    INVOKER,
    `${VERIFIER},`,
    `,${VERIFIER}`,
    `${VERIFIER}, ${accounts[0]}`,
    "verifier@example.com",
  ]) {
    assertRefused(() => read(localEnv(43000, { EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS: verifiers })),
      "EDGE_TEST_ORIGIN_VERIFIERS_INVALID", verifiers);
  }
  for (let count = 0; count <= 4; count += 1) {
    const configuration = read(localEnv(43000, {
      EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS: accounts.slice(0, count).join(","),
    }));
    assert.deepEqual(configuration.verifierServiceAccounts, accounts.slice(0, count));
    assert.ok(Object.isFrozen(configuration.verifierServiceAccounts));
  }
  for (const enabled of [undefined, "0", "true", "yes"]) {
    assertRefused(() => read(localEnv(43000, { ANALYTICS_V2_ENABLED: enabled })),
      "EDGE_TEST_COMMUNITY_DAILY_MODULE_REQUIRED", String(enabled));
  }
});

test("the local listen pair is loopback exactly as fastpath-test requires", () => {
  const configuration = read(localEnv(43001));
  assert.ok(Object.isFrozen(configuration));
  assert.deepEqual(Object.keys(configuration).sort(),
    ["audience", "invokerServiceAccount", "listen", "publicOrigin", "verifierServiceAccounts"]);
  assert.deepEqual(configuration.listen,
    { host: "127.0.0.1", port: 43001, hostOrigin: "http://127.0.0.1:43001", cloud: false });
  assert.equal(configuration.publicOrigin, mode.EDGE_TEST_PUBLIC_ORIGIN);
  assert.equal(configuration.audience, AUDIENCE);
  assert.equal(configuration.invokerServiceAccount, INVOKER);
  // HOST and PORT default to 127.0.0.1 and 8080.
  assert.deepEqual(read({ ...localEnv(8080), HOST: undefined, PORT: undefined }).listen,
    { host: "127.0.0.1", port: 8080, hostOrigin: "http://127.0.0.1:8080", cloud: false });
  for (const [label, overrides] of [
    ["0.0.0.0 without K_SERVICE", { HOST: "0.0.0.0" }],
    ["localhost", { HOST: "localhost" }],
    ["origin port differs", { HOST_ORIGIN: "http://127.0.0.1:43002" }],
    ["https origin", { HOST_ORIGIN: "https://127.0.0.1:43001" }],
    ["named host origin", { HOST_ORIGIN: "http://localhost:43001" }],
    ["origin with a path", { HOST_ORIGIN: "http://127.0.0.1:43001/" }],
    ["missing origin", { HOST_ORIGIN: undefined }],
    ["port zero", { PORT: "0", HOST_ORIGIN: "http://127.0.0.1:0" }],
    ["port not decimal", { PORT: "0x10" }],
    ["public origin set", { PUBLIC_ORIGIN: "https://tibotattle.test" }],
    ["admin origin set", { ADMIN_HOST_ORIGIN: "https://admin.tibotattle.test" }],
  ]) {
    assertRefused(() => read(localEnv(43001, overrides)), "EDGE_TEST_ORIGIN_LISTEN_INVALID", label);
  }
});

test("the Cloud Run listen rule accepts only the pinned service, host, port and origin", () => {
  const configuration = read(cloudEnv());
  assert.deepEqual(configuration.listen,
    { host: "0.0.0.0", port: 8080, hostOrigin: mode.EDGE_TEST_CLOUD_ORIGIN, cloud: true });
  for (const [label, overrides] of [
    ["another service", { K_SERVICE: "tibotattle-test-app" }],
    ["loopback host (sidecar)", { HOST: "127.0.0.1", HOST_ORIGIN: "http://127.0.0.1:8080" }],
    ["loopback host, cloud origin", { HOST: "127.0.0.1" }],
    ["host unset", { HOST: undefined }],
    ["another port", { PORT: "8081" }],
    ["port unset", { PORT: undefined }],
    ["loopback origin", { HOST_ORIGIN: "http://127.0.0.1:8080" }],
    ["another run.app origin", { HOST_ORIGIN: "https://tibotattle-test-app-5t5mehqi7a-ue.a.run.app" }],
    ["public origin set", { PUBLIC_ORIGIN: mode.EDGE_TEST_CLOUD_ORIGIN }],
  ]) {
    assertRefused(() => read(cloudEnv(overrides)), "EDGE_TEST_ORIGIN_LISTEN_INVALID", label);
  }
});

test("serve() admits 0.0.0.0 only for an issued Cloud Run configuration under its service", () => {
  const cloud = read(cloudEnv());
  const local = read(localEnv(43003));
  const env = { K_SERVICE: fastpathMode.FASTPATH_TEST_CLOUD_TARGET.originService };
  assert.equal(mode.isEdgeTestCloudListen(cloud, "0.0.0.0", 8080, env), true);
  assert.equal(mode.isEdgeTestCloudListen(cloud, "0.0.0.0", 8081, env), false);
  assert.equal(mode.isEdgeTestCloudListen(cloud, "0.0.0.0", 8080, {}), false);
  assert.equal(mode.isEdgeTestCloudListen(cloud, "0.0.0.0", 8080, { K_SERVICE: "tibotattle-test-app" }), false);
  assert.equal(mode.isEdgeTestCloudListen(local, "0.0.0.0", 8080, env), false);
  assert.equal(mode.isEdgeTestCloudListen({ ...cloud }, "0.0.0.0", 8080, env), false, "a copy is not issued");
  assert.equal(mode.isEdgeTestCloudListen(undefined, "0.0.0.0", 8080, env), false);
});

test("serve() keeps POSTGRES_TEST_PRIVATE_HOST_REQUIRED for any other 0.0.0.0 test runtime", async () => {
  const forged = { ...read(cloudEnv()) };
  const saved = process.env.K_SERVICE;
  process.env.K_SERVICE = fastpathMode.FASTPATH_TEST_CLOUD_TARGET.originService;
  try {
    for (const edgeTestOrigin of [undefined, forged, read(localEnv(43004))]) {
      await assert.rejects(server.serve({
        postgresTestDispatch: async () => new Response(null, { status: 500 }),
        listenHost: "0.0.0.0",
        listenPort: 8080,
        edgeTestOrigin,
      }), (error) => error?.code === "POSTGRES_TEST_PRIVATE_HOST_REQUIRED");
    }
  } finally {
    if (saved === undefined) delete process.env.K_SERVICE;
    else process.env.K_SERVICE = saved;
  }
});

test("createRuntime refuses edge-test outside fastpath-test before any pool exists", async () => {
  const names = ["POSTGRES_TEST_HTTP_MODE", "EDGE_ORIGIN_MODE", "EDGE_ORIGIN_AUDIENCE",
    "EDGE_INVOKER_SERVICE_ACCOUNT", "ANALYTICS_V2_ENABLED", "HOST", "PORT", "HOST_ORIGIN", "K_SERVICE",
    "PUBLIC_ORIGIN", "ADMIN_HOST_ORIGIN", "EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS"];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  const dependencies = {
    createConnector() { throw new Error("no connector may be created"); },
    async createIamPool() { throw new Error("no pool may be created"); },
  };
  const withEnv = async (env, code, label) => {
    for (const name of names) delete process.env[name];
    for (const [name, value] of Object.entries(env)) if (value !== undefined) process.env[name] = value;
    await assert.rejects(server.createRuntime({ dependencies }), (error) => error?.code === code, label);
  };
  try {
    // No test mode: the production request path is still refused first.
    await withEnv(localEnv(43005), "POSTGRES_WORKER_REQUEST_PATH_UNSUPPORTED", "no test mode");
    for (const testMode of ["health-only", "health-and-v12-day-manifest"]) {
      await withEnv({ ...localEnv(43005), POSTGRES_TEST_HTTP_MODE: testMode },
        "EDGE_TEST_ORIGIN_MODE_REQUIRES_FASTPATH_TEST", testMode);
    }
    // The retired cloud-run-iam mode (OD-6) is refused as a mode first.
    await withEnv({ ...localEnv(43005), POSTGRES_TEST_HTTP_MODE: "cloud-run-iam" },
      "POSTGRES_TEST_HTTP_MODE_INVALID", "cloud-run-iam");
    await withEnv({ ...localEnv(43005, { EDGE_ORIGIN_MODE: "cloudflare-worker-iam" }),
      POSTGRES_TEST_HTTP_MODE: "fastpath-test" }, "EDGE_TEST_ORIGIN_MODE_INVALID", "production value");
    await withEnv({ ...localEnv(43005, { HOST: "0.0.0.0" }), POSTGRES_TEST_HTTP_MODE: "fastpath-test" },
      "EDGE_TEST_ORIGIN_LISTEN_INVALID", "0.0.0.0 locally");
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// ---------------------------------------------------------------------------
// Admission env and composition

test("edgeTestAdmissionEnv replaces exactly the six edge-tier bindings", () => {
  const admission = limiters.createEdgeAdmissionLimiters();
  const marker = (name) => Object.freeze({ name, async limit() { return { success: true }; } });
  const base = { ENVIRONMENT: "synthetic-development", ACCOUNTLESS_ENROLLMENT_MODE: "enabled" };
  for (const name of [...limiters.EDGE_ADMISSION_REPLAY_BINDINGS,
    "UPLOAD_AUTHORIZATION_RATE_LIMIT", "UPLOAD_PRINCIPAL_RATE_LIMIT"]) base[name] = marker(name);
  const env = mode.edgeTestAdmissionEnv(base, admission);
  assert.ok(Object.isFrozen(env));
  assert.deepEqual(Object.keys(env).sort(), Object.keys(base).sort());
  for (const name of limiters.EDGE_ADMISSION_REPLAY_BINDINGS) assert.equal(env[name], admission.bindings[name], name);
  assert.equal(env.UPLOAD_AUTHORIZATION_RATE_LIMIT, base.UPLOAD_AUTHORIZATION_RATE_LIMIT);
  assert.equal(env.UPLOAD_PRINCIPAL_RATE_LIMIT, base.UPLOAD_PRINCIPAL_RATE_LIMIT);
  assert.equal(env.ENVIRONMENT, "synthetic-development");
  assert.equal(base.ENROLLMENT_RATE_LIMIT.name, "ENROLLMENT_RATE_LIMIT", "the input is not mutated");
  for (const [label, args] of [
    ["no env", [null, admission]],
    ["no admission", [base, null]],
    ["bindings missing one", [base, { bindings: { ...admission.bindings, PUBLIC_READ_RATE_LIMIT: undefined } }]],
  ]) {
    assert.throws(() => mode.edgeTestAdmissionEnv(...args),
      (error) => error?.code === "EDGE_TEST_ADMISSION_ENV_INVALID", label);
  }
});

function edgeRequest({ method = "GET", path = "/api/health", hostKind = "apex", headers = [], auth = token() } = {}) {
  const list = new Headers();
  if (auth !== null) list.append("x-serverless-authorization", auth);
  list.append("x-tibotattle-edge-host", hostKind);
  list.append("x-tibotattle-edge-request-id", REQUEST_ID);
  for (const [name, value] of headers) list.append(name, value);
  return new Request(`http://127.0.0.1:43010${path}`, { method, headers: list });
}

test("composeEdgeTestOrigin: issued configuration only; admin host answers the unported 503 without inner", () => withCapturedLog(async (lines) => {
  const configuration = read(localEnv(43010, { EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS: VERIFIER }));
  const admission = limiters.createEdgeAdmissionLimiters();
  assertRefused(() => mode.composeEdgeTestOrigin({ configuration: { ...configuration }, admission, inner: async () => {} }),
    "EDGE_TEST_ORIGIN_MODE_INVALID", "a forged configuration");
  assertRefused(() => mode.composeEdgeTestOrigin({ configuration, admission, inner: null }),
    "EDGE_ORIGIN_INNER_INVALID");
  assertRefused(() => mode.composeEdgeTestOrigin({ configuration, admission: null, inner: async () => {} }),
    "EDGE_ORIGIN_ADMISSION_INVALID");
  const seen = [];
  const dispatch = mode.composeEdgeTestOrigin({
    configuration,
    admission,
    inner: async (request) => {
      seen.push(request);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  for (const path of ["/api/v1/admin/overview", "/api/v1/community/daily", "/admin", "/api/health"]) {
    const response = await dispatch(edgeRequest({ path, hostKind: "admin",
      headers: [["cf-access-jwt-assertion", "synthetic.access.jwt"], ["x-usage-monitor-admin", "1"]] }));
    assert.equal(response.status, 503, path);
    assert.equal(await response.text(), mode.EDGE_TEST_UNPORTED_BODY, path);
    assert.deepEqual([...response.headers].sort(), [
      ["cache-control", "no-store"],
      ["content-type", "application/json; charset=utf-8"],
      ["referrer-policy", "no-referrer"],
      ["x-content-type-options", "nosniff"],
      ["x-tibotattle-origin", "1"],
    ], path);
  }
  assert.equal(seen.length, 0, "no admin-host request reaches inner");
  const apex = await dispatch(edgeRequest({ path: "/api/v1/community/daily" }));
  assert.equal(apex.status, 200);
  assert.equal(apex.headers.get("x-tibotattle-origin"), "1");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://tibotattle.test/api/v1/community/daily");
  // A verifier reads health on the apex; its request carries no edge context.
  const verifier = await dispatch(new Request("http://127.0.0.1:43010/api/health", {
    headers: { "x-serverless-authorization": token({ email: VERIFIER }) },
  }));
  assert.equal(verifier.status, 200);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].url, "https://tibotattle.test/api/health");
  // EP-6 refusals stay unmarked 421s, and each logs its one reason line.
  assert.deepEqual(lines, [], "admitted and unported requests log nothing");
  const refused = await dispatch(edgeRequest({ auth: null }));
  assert.equal(refused.status, 421);
  assert.equal(mode.isEdgeOriginBoundaryRefusal(refused), true);
  assert.equal(mode.isEdgeOriginBoundaryRefusal(apex), false);
  assert.equal(seen.length, 2);
  assert.deepEqual(lines, ["{\"event\":\"edge_origin_boundary_refusal\",\"reason\":\"invoker_header_missing\"}"]);
}));

// ---------------------------------------------------------------------------
// The raw Node request path through the real serve()

/** A chunked body's payload, or null while the last chunk has not arrived. */
function dechunk(raw) {
  let rest = raw;
  let payload = Buffer.alloc(0);
  for (;;) {
    const lineEnd = rest.indexOf("\r\n");
    if (lineEnd < 0) return null;
    const size = Number.parseInt(rest.subarray(0, lineEnd).toString("latin1"), 16);
    if (!Number.isSafeInteger(size)) throw new Error("invalid chunk size");
    if (size === 0) return rest.length >= lineEnd + 4 ? payload : null;
    if (rest.length < lineEnd + 2 + size + 2) return null;
    payload = Buffer.concat([payload, rest.subarray(lineEnd + 2, lineEnd + 2 + size)]);
    rest = rest.subarray(lineEnd + 2 + size + 2);
  }
}

/** One HTTP/1.1 exchange over a raw socket; resolves with the parsed response. */
function exchange(port, { method = "GET", target = "/api/health", headers = [], body = null, holdOpen = false }) {
  return new Promise((resolveExchange, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let data = Buffer.alloc(0);
    let settled = false;
    const finish = () => {
      if (settled) return;
      const text = data.toString("latin1");
      const split = text.indexOf("\r\n\r\n");
      if (split < 0) return;
      const head = text.slice(0, split).split("\r\n");
      const status = Number(head[0].split(" ")[1]);
      const responseHeaders = new Map();
      for (const line of head.slice(1)) {
        const index = line.indexOf(":");
        responseHeaders.set(line.slice(0, index).toLowerCase(), line.slice(index + 1).trim());
      }
      const length = Number(responseHeaders.get("content-length") ?? Number.NaN);
      const raw = data.subarray(Buffer.byteLength(text.slice(0, split + 4), "latin1"));
      let bodyText = raw.toString("utf8");
      if (responseHeaders.get("transfer-encoding") === "chunked") {
        const payload = dechunk(raw);
        if (payload === null) return;
        bodyText = payload.toString("utf8");
      } else if (Number.isFinite(length) && raw.length < length) {
        return;
      }
      settled = true;
      resolveExchange({ status, headers: responseHeaders, text: bodyText, socket, raw: text });
    };
    socket.on("data", (chunk) => { data = Buffer.concat([data, chunk]); finish(); });
    socket.on("end", finish);
    socket.on("close", () => {
      finish();
      if (!settled) reject(new Error("socket closed before a full response"));
    });
    socket.on("error", (error) => {
      finish();
      if (!settled) reject(error);
    });
    const lines = [`${method} ${target} HTTP/1.1`, ...headers.map(([name, value]) => `${name}: ${value}`)];
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (body !== null) socket.write(body);
    if (!holdOpen) socket.end();
  });
}

async function withServedRuntime(dispatchFactory, work) {
  const port = await freePort();
  const configuration = read(localEnv(port, { EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS: VERIFIER }));
  const admission = limiters.createEdgeAdmissionLimiters();
  const hostOrigin = configuration.listen.hostOrigin;
  const runtime = {
    edgeTestOrigin: configuration,
    edgeTestRequestFromNode: (req, res) => mode.edgeTestRequestFromNode(req, res, { hostOrigin }),
    postgresTestDispatch: mode.composeEdgeTestOrigin({ configuration, admission, inner: dispatchFactory() }),
    listenHost: configuration.listen.host,
    listenPort: configuration.listen.port,
    pools: [],
  };
  const sigterm = process.listeners("SIGTERM");
  const sigint = process.listeners("SIGINT");
  const close = await server.serve(runtime);
  try {
    return await work({ port, host: `127.0.0.1:${port}` });
  } finally {
    await close();
    // serve() installs once-handlers for the entry point; drop this run's.
    for (const listener of process.listeners("SIGTERM")) {
      if (!sigterm.includes(listener)) process.removeListener("SIGTERM", listener);
    }
    for (const listener of process.listeners("SIGINT")) {
      if (!sigint.includes(listener)) process.removeListener("SIGINT", listener);
    }
  }
}

function assertBoundaryRefusal(response, label) {
  assert.equal(response.status, 421, label);
  assert.equal(response.text, contract.ORIGIN_BOUNDARY_ERROR_BODY, label);
  assert.equal(response.headers.get("connection"), "close", label);
  assert.equal(response.headers.get("cache-control"), "no-store", label);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8", label);
  assert.equal(response.headers.has("x-tibotattle-origin"), false, label);
}

test("edgeTestRequestFromNode: the URL is HOST_ORIGIN plus the raw target, at most 16384 characters", () => {
  // Node's own header limit (16 KiB, request line included) refuses most
  // long targets with 431 before serve() runs, so the bound is driven here.
  const hostOrigin = "http://127.0.0.1:43020";
  const fake = (url, host = "127.0.0.1:43020") => ({
    headers: host === null ? {} : { host },
    rawHeaders: host === null ? [] : ["Host", host],
    url,
    method: "GET",
    once() {},
  });
  const res = { once() {}, writableEnded: false };
  const longest = `/${"q".repeat(16_384 - hostOrigin.length - 1)}`;
  assert.equal(mode.edgeTestRequestFromNode(fake(longest), res, { hostOrigin }).url, hostOrigin + longest);
  // A '//host' target stays a path on HOST_ORIGIN.
  assert.equal(mode.edgeTestRequestFromNode(fake("//evil.example/x"), res, { hostOrigin }).url,
    `${hostOrigin}//evil.example/x`);
  const observed = new Set();
  for (const [label, request, options, reason] of [
    ["a target over 16384 characters", fake(`${longest}q`), { hostOrigin }, "request_target_too_long"],
    ["asterisk target", fake("*"), { hostOrigin }, "request_target_invalid"],
    ["absolute target", fake("http://evil.example/x"), { hostOrigin }, "request_target_invalid"],
    ["missing Host", fake("/api/health", null), { hostOrigin }, "host_header_missing"],
    ["Host with another port", fake("/api/health", "127.0.0.1:43021"), { hostOrigin }, "host_mismatch"],
    ["HOST_ORIGIN with a path", fake("/api/health"), { hostOrigin: `${hostOrigin}/` }, "host_origin_not_canonical"],
    ["no HOST_ORIGIN", fake("/api/health"), {}, "host_origin_invalid"],
    ["a raw header Headers refuses", { ...fake("/api/health"), rawHeaders: ["Host", "127.0.0.1:43020", "bad name", "x"] },
      { hostOrigin }, "raw_headers_invalid"],
    ["a method Request refuses", { ...fake("/api/health"), method: "TRACE" }, { hostOrigin }, "node_request_invalid"],
  ]) {
    assert.throws(() => mode.edgeTestRequestFromNode(request, res, options), (error) => {
      assert.ok(error instanceof mode.EdgeTestBoundaryRefusal, label);
      assert.equal(error.code, "EDGE_TEST_ORIGIN_BOUNDARY_REFUSED", label);
      assert.equal(error.reason, reason, label);
      return true;
    }, label);
    observed.add(reason);
  }
  // request_target_unparseable and request_target_origin guard what the URL
  // parser already ensures for a target that starts with '/'.
  assert.deepEqual([...observed].sort(), mode.EDGE_TEST_REQUEST_REFUSAL_REASONS
    .filter((reason) => !["request_target_unparseable", "request_target_origin"].includes(reason)).sort());
  // The Host comparison is case-insensitive, as HTTP hosts are.
  const named = "http://localhost:43020";
  assert.equal(mode.edgeTestRequestFromNode(fake("/api/health", "LocalHost:43020"), res, { hostOrigin: named }).url,
    `${named}/api/health`);
});

test("serve(): a wrong Host and an absolute target are refused before EP-6", () => withCapturedLog(async (lines) => {
  const seen = [];
  await withServedRuntime(() => async (request) => {
    seen.push(request);
    return new Response("{}");
  }, async ({ port, host }) => {
    const edge = [["x-serverless-authorization", token()], ["x-tibotattle-edge-host", "apex"],
      ["x-tibotattle-edge-request-id", REQUEST_ID]];
    for (const [label, target, hostHeader] of [
      ["wrong Host", "/api/health", "tibotattle.test"],
      ["another loopback port", "/api/health", `127.0.0.1:${port + 1}`],
      ["absolute target", `http://${host}/api/health`, host],
    ]) {
      const response = await exchange(port, { target, headers: [["host", hostHeader], ...edge] });
      assertBoundaryRefusal(response, label);
    }
    // The same request with the right Host reaches inner.
    const admitted = await exchange(port, { headers: [["host", host], ...edge] });
    assert.equal(admitted.status, 200);
    assert.equal(admitted.headers.get("x-tibotattle-origin"), "1");
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(loggedReasons(lines), ["host_mismatch", "host_mismatch", "request_target_invalid"]);
}));

test("serve(): EP-6 refusals are written with connection: close while the body is still unread", () => withCapturedLog(async (lines) => {
  let innerCalls = 0;
  await withServedRuntime(() => async () => {
    innerCalls += 1;
    return new Response("{}");
  }, async ({ port, host }) => {
    const base = [["host", host], ["content-type", "application/json"], ["transfer-encoding", "chunked"]];
    for (const [label, headers] of [
      ["no token", [["x-tibotattle-edge-host", "apex"], ["x-tibotattle-edge-request-id", REQUEST_ID]]],
      ["client edge key", [["x-serverless-authorization", token()], ["x-tibotattle-edge-host", "apex"],
        ["x-tibotattle-edge-request-id", REQUEST_ID], ["x-tibotattle-edge-client-key", "0".repeat(64)]]],
      ["verifier POST", [["x-serverless-authorization", token({ email: VERIFIER })]]],
    ]) {
      // One chunk is written and the body is never finished: the refusal
      // must arrive without the origin waiting for (or reading) the rest.
      const response = await exchange(port, {
        method: "POST", target: "/api/v1/contributions", headers: [...base, ...headers],
        body: "10\r\n{\"synthetic\":tru\r\n", holdOpen: true,
      });
      assertBoundaryRefusal(response, label);
      await new Promise((done) => {
        if (response.socket.destroyed || response.socket.readableEnded) done();
        else response.socket.once("close", done);
      });
    }
  });
  assert.equal(innerCalls, 0);
  assert.deepEqual(loggedReasons(lines), ["invoker_header_missing", "edge_header_unknown", "verifier_method"]);
}));

test("the refusal log line is closed: event, a listed reason and, for a token refusal, its shape", () => {
  const requestReasons = mode.EDGE_TEST_REQUEST_REFUSAL_REASONS;
  const boundaryReasons = edgeDispatch.EDGE_ORIGIN_BOUNDARY_REFUSAL_REASONS;
  assert.ok(Object.isFrozen(requestReasons));
  assert.equal(new Set(requestReasons).size, requestReasons.length);
  assert.deepEqual(requestReasons.filter((reason) => boundaryReasons.includes(reason)), [],
    "no reason names two sites");
  assert.equal(mode.EDGE_ORIGIN_BOUNDARY_REFUSAL_EVENT, "edge_origin_boundary_refusal");
  const shape = Object.freeze({
    bearerPrefix: true,
    scheme: "Bearer",
    separatorSpaces: 1,
    segments: 3,
    segmentEmpty: Object.freeze([false, false, false]),
    segmentBase64url: Object.freeze([true, true, true]),
    signatureRemovedByGoogle: true,
  });
  const line = mode.edgeTestBoundaryRefusalLogLine;
  assert.equal(line(new mode.EdgeTestBoundaryRefusal("host_mismatch")),
    "{\"event\":\"edge_origin_boundary_refusal\",\"reason\":\"host_mismatch\"}");
  assert.equal(line({ reason: "audience_mismatch", invokerShape: shape }),
    "{\"event\":\"edge_origin_boundary_refusal\",\"reason\":\"audience_mismatch\",\"invokerShape\":"
    + "{\"bearerPrefix\":true,\"scheme\":\"Bearer\",\"separatorSpaces\":1,\"segments\":3,"
    + "\"segmentEmpty\":[false,false,false],\"segmentBase64url\":[true,true,true],"
    + "\"signatureRemovedByGoogle\":true}}");
  // Only a token refusal carries a shape.
  assert.equal(line({ reason: "edge_host_kind_invalid", invokerShape: shape }),
    "{\"event\":\"edge_origin_boundary_refusal\",\"reason\":\"edge_host_kind_invalid\"}");
  // Nothing outside the allowlist reaches the line, whatever a diagnostic carries.
  const secret = "Bearer synthetic.secret-token.SIGNATURE_REMOVED_BY_GOOGLE edge-invoker@synthetic.example /p?q=secret";
  for (const diagnostic of [
    { reason: secret },
    { reason: "host_mismatch", host: secret, path: secret },
    { reason: "email_mismatch", email: secret, invokerShape: {
      ...shape, token: secret, scheme: secret, separatorSpaces: secret, segments: secret,
      segmentEmpty: [secret, true], segmentBase64url: secret, signatureRemovedByGoogle: secret,
      bearerPrefix: "true" } },
    null,
    undefined,
    secret,
  ]) {
    const written = line(diagnostic);
    assert.ok(!written.includes("secret") && !written.includes("@") && !written.includes("Bearer"), written);
    assert.ok(!written.includes("SIGNATURE_REMOVED_BY_GOOGLE"), written);
  }
  assert.equal(line({ reason: secret }), "{\"event\":\"edge_origin_boundary_refusal\",\"reason\":\"unclassified\"}");
  assert.equal(line({ reason: "email_mismatch", invokerShape: {
    ...shape, token: secret, scheme: "bearer", separatorSpaces: 5, segments: secret,
    segmentEmpty: [secret, true], segmentBase64url: Array(20).fill(true), bearerPrefix: "true" } }),
  "{\"event\":\"edge_origin_boundary_refusal\",\"reason\":\"email_mismatch\",\"invokerShape\":"
    + "{\"bearerPrefix\":false,\"scheme\":null,\"separatorSpaces\":null,\"segments\":null,"
    + "\"segmentEmpty\":[false,true],\"segmentBase64url\":[true,true,true,true,true,true,true,true],"
    + "\"signatureRemovedByGoogle\":true}}");
  for (const kind of edgeDispatch.EDGE_ORIGIN_INVOKER_SCHEME_KINDS) {
    for (const spaces of [0, 4]) {
      const parsed = JSON.parse(line({ reason: "email_mismatch", invokerShape: { ...shape, scheme: kind,
        separatorSpaces: spaces } }));
      assert.equal(parsed.invokerShape.scheme, kind);
      assert.equal(parsed.invokerShape.separatorSpaces, spaces);
    }
  }
  // logEdgeTestBoundaryRefusal writes exactly that line once and never throws.
  const written = [];
  mode.logEdgeTestBoundaryRefusal({ reason: "audience_count", invokerShape: shape }, (value) => written.push(value));
  assert.deepEqual(written, [line({ reason: "audience_count", invokerShape: shape })]);
  assert.doesNotThrow(() => mode.logEdgeTestBoundaryRefusal({ reason: "host_mismatch" }, () => {
    throw new Error("synthetic log failure");
  }));
});

test("serve(): one content-free reason line per refusal; the 421 bytes never change", () => withCapturedLog(async (lines) => {
  // Synthetic secrets wherever a refused request carries content.
  const secretSubject = "synthetic-subject-secret-5d2a";
  const secretToken = token({ sub: secretSubject });
  const secretPath = "/api/v1/secret-path?secret-query=synthetic-query-secret";
  const otherAccount = "other-invoker@synthetic-edge-0.iam.gserviceaccount.com";
  const audienceToken = token({ sub: secretSubject, aud: "https://secret-audience.synthetic.example" });
  const strangerToken = token({ sub: secretSubject, email: otherAccount });
  let innerCalls = 0;
  const answers = [];
  const sentValues = new Set();
  await withServedRuntime(() => async () => {
    innerCalls += 1;
    return new Response("{}");
  }, async ({ port, host }) => {
    const edge = (auth) => [["x-serverless-authorization", auth], ["x-tibotattle-edge-host", "apex"],
      ["x-tibotattle-edge-request-id", REQUEST_ID]];
    const rows = [
      ["wrong Host", { target: secretPath, headers: [["host", "secret-host.synthetic.example"], ...edge(secretToken)] },
        "host_mismatch", null],
      ["absolute target", { target: `http://${host}${secretPath}`, headers: [["host", host], ...edge(secretToken)] },
        "request_target_invalid", null],
      ["TRACE", { method: "TRACE", target: secretPath, headers: [["host", host], ...edge(secretToken)] },
        "node_request_invalid", null],
      ["no token", { target: secretPath, headers: [["host", host], ["x-tibotattle-edge-host", "apex"],
        ["x-tibotattle-edge-request-id", REQUEST_ID]] }, "invoker_header_missing", null],
      ["another audience", { target: secretPath, headers: [["host", host], ...edge(audienceToken)] },
        "audience_mismatch", { bearerPrefix: true, scheme: "Bearer", separatorSpaces: 1, segments: 3,
          segmentEmpty: [false, false, false], segmentBase64url: [true, true, true], signatureRemovedByGoogle: true }],
      ["another account with a lowercase scheme", { target: secretPath, headers: [["host", host],
        ...edge(strangerToken.replace("Bearer ", "bearer  "))] },
        "email_mismatch", { bearerPrefix: false, scheme: "bearer-case-variant", separatorSpaces: 2, segments: 3,
          segmentEmpty: [false, false, false], segmentBase64url: [true, true, true], signatureRemovedByGoogle: true }],
      ["no 'Bearer '", { target: secretPath, headers: [["host", host], ...edge(secretToken.slice("Bearer ".length))] },
        "invoker_bearer_prefix_missing", { bearerPrefix: false, scheme: "none", separatorSpaces: 0, segments: 3,
          segmentEmpty: [false, false, false], segmentBase64url: [true, true, true], signatureRemovedByGoogle: true }],
      ["a tab after the scheme", { target: secretPath, headers: [["host", host],
        ...edge(secretToken.replace("Bearer ", "Bearer\t"))] },
        "invoker_bearer_prefix_missing", { bearerPrefix: false, scheme: "Bearer", separatorSpaces: 0, segments: 3,
          segmentEmpty: [false, false, false], segmentBase64url: [false, true, true], signatureRemovedByGoogle: true }],
      ["an intact signature with a second token", { target: secretPath, headers: [["host", host],
        ...edge(`${secretToken.replace("SIGNATURE_REMOVED_BY_GOOGLE", "c2VjcmV0LXNpZw")}`),
        ["x-serverless-authorization", secretToken]] },
        "invoker_segments", { bearerPrefix: true, scheme: "Bearer", separatorSpaces: 1, segments: 5,
          segmentEmpty: [false, false, false, false, false], segmentBase64url: [true, true, false, true, true],
          signatureRemovedByGoogle: false }],
      ["client edge key", { target: secretPath, headers: [["host", host], ...edge(secretToken),
        ["x-tibotattle-edge-client-key", "secret-client-key-0123456789abcdef"]] }, "edge_header_unknown", null],
      ["verifier query", { target: "/api/health?secret-query=1",
        headers: [["host", host], ["x-serverless-authorization", token({ sub: secretSubject, email: VERIFIER })]] },
      "verifier_query", null],
    ];
    for (const [label, request, reason, shape] of rows) {
      for (const [, value] of request.headers) sentValues.add(value);
      sentValues.add(request.target);
      const before = lines.length;
      const answer = await exchange(port, request);
      assertBoundaryRefusal(answer, label);
      answers.push([label, answer.raw.replace(/\r\nDate: [^\r]*/u, "")]);
      assert.equal(lines.length, before + 1, `${label}: exactly one line`);
      assert.deepEqual(loggedReasons(lines.slice(-1)), [reason], label);
      assert.deepEqual(JSON.parse(lines.at(-1)).invokerShape, shape ?? undefined, label);
    }
    // An admitted request logs nothing, with any case of the scheme and 1*SP.
    const before = lines.length;
    for (const auth of [secretToken, secretToken.replace("Bearer ", "bearer "), secretToken.replace("Bearer ", "BEARER   ")]) {
      const admitted = await exchange(port, { headers: [["host", host], ...edge(auth)] });
      assert.equal(admitted.status, 200);
    }
    assert.equal(lines.length, before);
  });
  assert.equal(innerCalls, 3);
  // Byte for byte (Date aside), every refusal is the same answer.
  for (const [label, raw] of answers) assert.equal(raw, answers[0][1], label);
  // No line carries a token, a segment, an email, a header value, a host or a path.
  const needles = new Set([secretSubject, "secret", "@", "Bearer", "SIGNATURE_REMOVED_BY_GOOGLE", INVOKER,
    VERIFIER, otherAccount, AUDIENCE, REQUEST_ID, "127.0.0.1", "/api/"]);
  for (const value of sentValues) {
    needles.add(value);
    for (const fragment of value.split(/[ .,;?=]+/u)) if (fragment.length >= 6) needles.add(fragment);
  }
  // A scheme kind is a closed constant, not the header's text.
  const logged = lines.join("\n").replaceAll(/"scheme":"[a-zA-Z-]+"/gu, "");
  const reasons = [...mode.EDGE_TEST_REQUEST_REFUSAL_REASONS, ...edgeDispatch.EDGE_ORIGIN_BOUNDARY_REFUSAL_REASONS];
  for (const needle of needles) {
    if (needle.length < 4 && needle !== "@") continue;
    // A reason code is itself never a needle (a 'bearer' fragment is in one).
    if (reasons.some((reason) => reason.includes(needle))) continue;
    assert.ok(!logged.includes(needle), `a refusal line carries ${JSON.stringify(needle.slice(0, 24))}`);
  }
}));

test("serve(): inner never sees cf-*, x-forwarded-*, the token or x-tibotattle-*; bodies stream", async () => {
  const seen = [];
  await withServedRuntime(() => async (request) => {
    const body = request.body === null ? null : await new Response(request.body).text();
    seen.push({ url: request.url, method: request.method, headers: [...request.headers], body });
    return new Response(JSON.stringify({ echoed: body }), {
      status: 201,
      headers: [["content-type", "application/json"], ["set-cookie", "a=1"], ["set-cookie", "b=2"]],
    });
  }, async ({ port, host }) => {
    const edge = [["x-serverless-authorization", token()], ["x-tibotattle-edge-host", "apex"],
      ["x-tibotattle-edge-request-id", REQUEST_ID],
      ["x-tibotattle-edge-admission", "v1;upload_ingress;allowed"]];
    const browser = [["cookie", "__Host-usage_monitor_session=synthetic; other=1"],
      ["origin", "https://tibotattle.test"], ["authorization", "Upload synthetic"],
      ["x-usage-monitor-csrf", "synthetic-csrf"]];
    const chunked = await exchange(port, {
      method: "POST", target: "/api/v1/contributions",
      headers: [["host", host], ["content-type", "application/json"], ["transfer-encoding", "chunked"],
        ...edge, ...browser, ...FORBIDDEN_INNER_HEADERS],
      body: "7\r\n{\"a\":1}\r\n0\r\n\r\n",
    });
    assert.equal(chunked.status, 201);
    assert.equal(chunked.text, JSON.stringify({ echoed: "{\"a\":1}" }));
    assert.equal(chunked.headers.get("x-tibotattle-origin"), "1");
    const sized = await exchange(port, {
      method: "POST", target: "/api/v1/device/disconnect",
      headers: [["host", host], ["content-length", "0"], ...edge, ...FORBIDDEN_INNER_HEADERS],
    });
    assert.equal(sized.status, 201);
    const admin = await exchange(port, {
      target: "/api/v1/admin/overview",
      headers: [["host", host], ["x-serverless-authorization", token()], ["x-tibotattle-edge-host", "admin"],
        ["x-tibotattle-edge-request-id", REQUEST_ID], ...FORBIDDEN_INNER_HEADERS],
    });
    assert.equal(admin.status, 503);
    assert.equal(admin.text, mode.EDGE_TEST_UNPORTED_BODY);
  });
  assert.equal(seen.length, 2, "the admin-host request never reached inner");
  const [upload, disconnect] = seen;
  assert.equal(upload.url, "https://tibotattle.test/api/v1/contributions");
  assert.equal(upload.body, "{\"a\":1}", "a chunked body is streamed through");
  assert.equal(disconnect.body, null, "a zero-length POST has no body, as in the Worker");
  for (const observed of seen) {
    for (const [name] of observed.headers) {
      assert.ok(!name.startsWith("cf-"), `${name} reached inner`);
      assert.ok(!name.startsWith("x-forwarded-"), `${name} reached inner`);
      assert.ok(!name.startsWith("x-tibotattle-"), `${name} reached inner`);
      assert.notEqual(name, "x-serverless-authorization");
      assert.notEqual(name, "x-real-ip");
      assert.notEqual(name, "true-client-ip");
      assert.notEqual(name, "host");
    }
  }
  const headers = new Map(upload.headers);
  assert.equal(headers.get("cookie"), "__Host-usage_monitor_session=synthetic; other=1");
  assert.equal(headers.get("origin"), "https://tibotattle.test");
  assert.equal(headers.get("authorization"), "Upload synthetic");
  assert.equal(headers.get("x-usage-monitor-csrf"), "synthetic-csrf");
});

test("serve(): an answer to a chunked body inner stops reading reaches the caller; the rest is drained, not reset", async () => {
  const limit = 2 * 1024 * 1024;
  let readBytes = 0;
  await withServedRuntime(() => async (request) => {
    // As readBoundedRequestBody does: read up to the limit, then cancel and refuse.
    const reader = request.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      readBytes += value.byteLength;
      if (readBytes > limit) {
        await reader.cancel();
        return Response.json({ error: { code: "BODY_TOO_LARGE" } }, { status: 413 });
      }
    }
    return Response.json({ read: readBytes }, { status: 200 });
  }, async ({ port, host }) => {
    const send = (total) => new Promise((resolveSend, reject) => {
      const request = http.request({
        host: "127.0.0.1", port, method: "POST", path: "/api/v1/contributions", agent: false,
        headers: { host, "content-type": "application/json", "transfer-encoding": "chunked",
          "x-serverless-authorization": token(), "x-tibotattle-edge-host": "apex",
          "x-tibotattle-edge-request-id": REQUEST_ID, "x-tibotattle-edge-admission": "v1;upload_ingress;allowed" },
      });
      let answer = null;
      request.on("response", (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          answer = { status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") };
          resolveSend(answer);
        });
      });
      request.on("error", (error) => { if (answer === null) reject(error); });
      const chunk = Buffer.alloc(64 * 1024, 0x78);
      let sent = 0;
      const pump = () => {
        while (sent < total) {
          sent += chunk.length;
          if (!request.write(chunk)) { request.once("drain", pump); return; }
        }
        request.end();
      };
      pump();
    });
    // The early answer raced the connection close: repeat it so a reset shows.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      readBytes = 0;
      const refused = await send(3 * 1024 * 1024);
      assert.equal(refused.status, 413, `attempt ${attempt}: the refusal arrives instead of a reset`);
      assert.equal(JSON.parse(refused.text).error.code, "BODY_TOO_LARGE");
    }
    readBytes = 0;
    const accepted = await send(1024 * 1024);
    assert.equal(accepted.status, 200, "a body under the limit still streams through whole");
    assert.equal(JSON.parse(accepted.text).read, 1024 * 1024);
  });
});

test("edgeTestRequestFromNode keeps every raw header for EP-6, joined as Headers joins them", async () => {
  const port = await freePort();
  const hostOrigin = `http://127.0.0.1:${port}`;
  const built = [];
  const probe = http.createServer((req, res) => {
    try {
      built.push(mode.edgeTestRequestFromNode(req, res, { hostOrigin }));
      res.writeHead(204).end();
    } catch (error) {
      built.push(error);
      mode.writeEdgeTestBoundaryRefusal(res);
    }
  });
  probe.listen(port, "127.0.0.1");
  await once(probe, "listening");
  try {
    await exchange(port, {
      target: "/api/v1/device/sync/state?x=1",
      headers: [["host", `127.0.0.1:${port}`], ["x-serverless-authorization", token()],
        ["x-tibotattle-edge-host", "apex"], ["x-tibotattle-edge-host", "admin"],
        ["x-tibotattle-edge-client-key", "k"], ["cf-connecting-ip", "203.0.113.9"]],
    });
    const refused = await exchange(port, { headers: [["host", "example.test"]] });
    assertBoundaryRefusal(refused, "wrong Host");
  } finally {
    await new Promise((done) => probe.close(done));
  }
  const [request, refusal] = built;
  assert.ok(request instanceof Request);
  assert.equal(request.url, `${hostOrigin}/api/v1/device/sync/state?x=1`);
  assert.equal(request.method, "GET");
  assert.equal(request.body, null);
  assert.match(request.headers.get("x-serverless-authorization"), /^Bearer [^ ]+\.SIGNATURE_REMOVED_BY_GOOGLE$/u);
  assert.equal(request.headers.get("x-tibotattle-edge-host"), "apex, admin");
  assert.equal(request.headers.get("x-tibotattle-edge-client-key"), "k");
  assert.equal(request.headers.get("cf-connecting-ip"), "203.0.113.9");
  assert.ok(refusal instanceof mode.EdgeTestBoundaryRefusal);
  assert.equal(refusal.code, "EDGE_TEST_ORIGIN_BOUNDARY_REFUSED");
});

// ---------------------------------------------------------------------------
// Deploy rendering (no command runs)

function renderedEnv(yaml) {
  const env = {};
  const pattern = /^ {8}- name: ([A-Z0-9_]+)\n {10}value: (".*")$/gmu;
  for (const match of yaml.matchAll(pattern)) env[match[1]] = JSON.parse(match[2]);
  return env;
}

test("the direct deploy variant renders an env readEdgeTestOriginConfiguration accepts under K_SERVICE", () => {
  const image = `${deploy.FASTPATH_TEST.imageRepository}@sha256:${"a".repeat(64)}`;
  const bucketHistoryProof = JSON.stringify({ bucket: deploy.FASTPATH_TEST.originBucket,
    bucketGeneration: "1", bucketMetageneration: "1", softDeleteRetentionDurationSeconds: "0" });
  const originEnv = [
    ["EDGE_ORIGIN_MODE", "edge-test"],
    ["EDGE_ORIGIN_AUDIENCE", mode.EDGE_TEST_CLOUD_ORIGIN],
    ["EDGE_INVOKER_SERVICE_ACCOUNT", deploy.FASTPATH_TEST.journeyServiceAccount],
  ];
  const cloudRunEnv = { K_SERVICE: deploy.FASTPATH_TEST.originService, PORT: "8080" };
  const direct = renderedEnv(deploy.renderOriginService({ image, variant: "direct", originEnv, bucketHistoryProof }));
  const env = { ...direct, ...cloudRunEnv };
  assert.equal(env.POSTGRES_TEST_HTTP_MODE, "fastpath-test");
  const configuration = mode.readEdgeTestOriginConfiguration(env, { postgresTestMode: env.POSTGRES_TEST_HTTP_MODE });
  assert.deepEqual(configuration.listen,
    { host: "0.0.0.0", port: 8080, hostOrigin: mode.EDGE_TEST_CLOUD_ORIGIN, cloud: true });
  assert.equal(configuration.audience, mode.EDGE_TEST_CLOUD_ORIGIN);
  assert.equal(configuration.invokerServiceAccount, deploy.FASTPATH_TEST.journeyServiceAccount);
  // The fast-path cloud pins still apply to the same env. The deploy script
  // (a dense-workstream file) still renders the retired LEDGER_* settings,
  // which the primary-only origin refuses (LEAD-SIMP); stripping them is a
  // post-dense follow-up in scripts/gcp-fastpath-test-deploy.mjs.
  const renderedLedgerSettings = Object.keys(env).filter((name) => name.startsWith("LEDGER_"));
  if (renderedLedgerSettings.length > 0) {
    assertRefused(() => fastpathMode.fastpathTestDatabaseConfig(env), "POSTGRES_FASTPATH_TEST_SCHEMA_INVALID",
      "a rendered LEDGER_ setting");
  }
  const primaryOnly = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("LEDGER_")));
  assert.equal(fastpathMode.fastpathTestDatabaseConfig(primaryOnly).primary.database, deploy.FASTPATH_TEST.database);
  // The deploy recognises this mode by the same value, and gives it env.production's admission settings.
  assert.equal(deploy.EDGE_TEST_ORIGIN_MODE, mode.EDGE_TEST_ORIGIN_MODE);
  for (const [name, value] of deploy.edgeTestProductionEnv()) assert.equal(env[name], value, name);
  // The sidecar variant keeps the loopback origin, which edge-test refuses on Cloud Run.
  const sidecar = { ...renderedEnv(deploy.renderOriginService({
    image, variant: "sidecar", originEnv, bucketHistoryProof })), ...cloudRunEnv };
  assertRefused(() => mode.readEdgeTestOriginConfiguration(sidecar, { postgresTestMode: "fastpath-test" }),
    "EDGE_TEST_ORIGIN_LISTEN_INVALID", "sidecar");
});
