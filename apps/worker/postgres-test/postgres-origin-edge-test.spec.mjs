// The fastpath-test origin behind the EP-6 edge boundary (EORIGIN,
// EDGE_ORIGIN_MODE=edge-test), over real HTTP on 127.0.0.1.
//
// Each fixture composes the real Cloud Run origin (cloud-run/server.mjs
// createRuntime + serve) in POSTGRES_TEST_HTTP_MODE=fastpath-test against a
// disposable PostgreSQL 17 schema pair migrated through the production runner,
// with injected local pools, connector, token provider and an in-memory object
// store. Requests arrive as Cloud Run's front end delivers them to the edge's
// origin: a synthetic ID token whose signature segment is
// SIGNATURE_REMOVED_BY_GOOGLE in x-serverless-authorization, plus the edge
// contract headers (host kind, request id, admission outcome). Nothing reaches
// Google or Cloudflare; every account, token, key and row is synthetic and
// content-free, and each fixture drops only the schemas it created.
//
// It proves: the boundary's constant refusals over the wire; which forwarded
// (route, method) pairs the composition serves; that every EP-1 policy route
// it serves replays the edge's outcome at the Worker's own call point; the
// d43c8f92 order fixes that only show under a limited outcome or a cookie;
// and that fastpath-test without the edge charges its PostgreSQL limiters at
// the same points.
import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { randomBytes, randomUUID, webcrypto } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import http from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const SKIP = !PG_TEST_SOCKET;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ID = "synthetic-edge-test-journal";
const NAMESPACE = "synthetic-edge-test-namespace";
const KEY_ID = "key:synthetic-edge-test";
const INVOKER = "edge-invoker@synthetic-edge-0.iam.gserviceaccount.com";
const VERIFIER = "origin-verifier@synthetic-edge-0.iam.gserviceaccount.com";
const STRANGER = "other-invoker@synthetic-edge-0.iam.gserviceaccount.com";
const AUDIENCE = "https://edge-test-origin.synthetic.example";
const SESSION_COOKIE = "__Host-usage_monitor_session=synthetic-edge-session";
const UNRELATED_COOKIE = "theme=dark";
const DAILY_QUERY = "?from=2026-09-01&to=2026-09-02";
const ADMISSION_CODES = Object.freeze([
  "ATTEMPT_LIMIT_REACHED", "UPLOAD_INGRESS_LIMIT_REACHED",
  "ADMISSION_RATE_LIMIT_UNAVAILABLE", "UPLOAD_INGRESS_UNAVAILABLE", "ADMISSION_CONFIGURATION_INVALID",
]);
// Routes the edge answers itself (E4): never forwarded, so never probed here.
const EDGE_LOCAL_ROUTE_IDS = new Set(["apple_domain_association", "sparkle_appcast_guard"]);

let vite;
let modules;
after(async () => { await vite?.close(); });

async function loadModules() {
  if (modules) return modules;
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    logLevel: "silent",
  });
  const load = (path) => vite.ssrLoadModule(path);
  const [server, codec, registry, policy, contract, edgeMode] = await Promise.all([
    load("/cloud-run/server.mjs"),
    load("/src/typed-telemetry-codec.ts"),
    load("/src/route-registry.ts"),
    load("/src/edge-admission-policy.ts"),
    load("/src/edge-origin-contract.ts"),
    load("/cloud-run/origin-edge-test-mode.mjs"),
  ]);
  modules = { server, codec, registry, policy, contract, edgeMode };
  return modules;
}

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  const link = await lstat(PG_TEST_SOCKET);
  const host = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(host);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.isDirectory(), true);
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host, port: PG_TEST_PORT };
}

function localPoolOptions(socket, max, applicationName) {
  return {
    ...socket,
    user: process.env.PG_TEST_USER || "postgres",
    password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
    database: process.env.PG_TEST_DATABASE || "postgres",
    application_name: applicationName,
    ssl: false,
    max,
    connectionTimeoutMillis: 5_000,
  };
}

let keyPair;
async function envelopeKeys() {
  keyPair ??= (async () => {
    const pair = await webcrypto.subtle.generateKey({
      name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
    }, true, ["encrypt", "decrypt"]);
    return {
      publicText: JSON.stringify({ ...await webcrypto.subtle.exportKey("jwk", pair.publicKey), kid: KEY_ID }),
      privateText: JSON.stringify({ ...await webcrypto.subtle.exportKey("jwk", pair.privateKey), kid: KEY_ID }),
    };
  })();
  return keyPair;
}

const RUNTIME_ENVIRONMENT_NAMES = Object.freeze([
  "POSTGRES_TEST_HTTP_MODE", "HOST", "PORT", "HOST_ORIGIN", "PUBLIC_ORIGIN", "ADMIN_HOST_ORIGIN",
  "K_SERVICE", "PRIMARY_DATABASE", "PRIMARY_SCHEMA", "PRIMARY_INSTANCE_CONNECTION_NAME",
  "LEDGER_DATABASE", "LEDGER_SCHEMA", "LEDGER_INSTANCE_CONNECTION_NAME", "POSTGRES_IAM_USER",
  "POSTGRES_SOURCE_ID", "POSTGRES_SOURCE_NAMESPACE", "POSTGRES_RATE_LIMIT_SECRET",
  "ENVELOPE_PUBLIC_JWK", "ENVELOPE_PRIVATE_JWK", "GCS_BUCKET_NAME", "GCS_ERASURE_BUCKET_HISTORY_PROOF",
  "ENVIRONMENT", "ENROLLMENT_MODE", "IDENTITY_LINK_SECRET", "IDENTITY_LINK_SECRET_VERSION",
  "GOOGLE_OIDC_CLIENT_ID", "GOOGLE_OIDC_CLIENT_SECRET", "SIGN_IN_START_MAX_PER_MINUTE",
  "ACCOUNTLESS_ENROLLMENT_MODE", "ACCOUNTLESS_OWNERSHIP_MODE", "SOURCE_CONTENT_DIGEST",
  "ANALYTICS_V2_ENABLED", "ANALYTICS_V2_TEST_NOW_MS",
  "EDGE_ORIGIN_MODE", "EDGE_ORIGIN_AUDIENCE", "EDGE_INVOKER_SERVICE_ACCOUNT",
  "EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS",
  "HOST_RATE_LIMIT_PUBLIC_READ_RATE_LIMIT_LIMIT", "HOST_RATE_LIMIT_UPLOAD_INGRESS_REQUEST_RATE_LIMIT_LIMIT",
]);

async function withEnvironment(environment, work) {
  const saved = new Map(RUNTIME_ENVIRONMENT_NAMES.map((name) => [name, process.env[name]]));
  for (const name of RUNTIME_ENVIRONMENT_NAMES) delete process.env[name];
  for (const [name, value] of Object.entries(environment)) process.env[name] = value;
  try {
    return await work();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

/**
 * A fastpath-test origin over a fresh, fully migrated "<schema>" and
 * "<schema>_ledger" pair with operational collection controls and the typed
 * v1/v1.1 targets initialized (as the intake spec seeds them). With edge, the
 * runtime is served on 127.0.0.1 behind EDGE_ORIGIN_MODE=edge-test; without,
 * requests go to runtime.postgresTestDispatch on the loopback origin.
 */
async function withOrigin({ edge, environment = {} }, run) {
  const m = await loadModules();
  const socket = await localSocket();
  const base = new pg.Pool(localPoolOptions(socket, 4, "pg-origin-edge-test"));
  const primarySchema = `tibotattle_fastpath_edge_${randomBytes(5).toString("hex")}`;
  const ledgerSchema = `${primarySchema}_ledger`;
  const created = [];
  const pools = [];
  let close = null;
  const sigterm = process.listeners("SIGTERM");
  const sigint = process.listeners("SIGINT");
  try {
    const server = await base.query(
      "SELECT inet_server_addr() AS address, current_setting('server_version_num')::integer AS version",
    );
    assert.equal(server.rows[0]?.address, null, "qualification requires the local Unix socket");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "the disposable socket must be PostgreSQL 17");
    for (const schema of [primarySchema, ledgerSchema]) {
      await base.query(`CREATE SCHEMA "${schema}"`);
      created.push(schema);
    }
    await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: base });
    await applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool: base });
    const t = (name) => `"${primarySchema}"."${name}"`;
    await base.query(`UPDATE ${t("collection_controls")}
        SET revision=2, control_state='operational', enrollment_enabled=true, upload_registration_enabled=true,
            processing_enabled=true, publication_enabled=true, updated_at=$1
      WHERE singleton=1`, [new Date().toISOString()]);
    await base.query(`INSERT INTO ${t("storage_source_state")} (singleton, source_id, authority_epoch)
      VALUES (1, $1, 0)`, [SOURCE_ID]);
    const namespace = await base.query(`INSERT INTO ${t("typed_telemetry_namespaces")} (original_id)
      VALUES ($1) RETURNING id`, [Buffer.from(m.codec.encodeTypedTelemetryId(NAMESPACE))]);
    for (const family of ["typed_v1_admission_state", "typed_v11_admission_state"]) {
      await base.query(`INSERT INTO ${t(family)}
          (id, source_namespace, namespace_id, runtime_contract_version, next_source_row_id)
        VALUES (1, $1, $2, 1, 1)`, [NAMESPACE, namespace.rows[0].id]);
    }
    await base.query(`UPDATE ${t("telemetry_transport_formats")} SET lifecycle='accepted'
      WHERE schema_version='telemetry-contribution-v1.1'`);

    const keys = await envelopeKeys();
    const bucket = "synthetic-edge-test-bucket";
    const objects = new Map();
    const port = await freePort();
    const hostOrigin = `http://127.0.0.1:${port}`;
    const env = {
      POSTGRES_TEST_HTTP_MODE: "fastpath-test",
      HOST: "127.0.0.1",
      PORT: String(port),
      HOST_ORIGIN: hostOrigin,
      PRIMARY_SCHEMA: primarySchema,
      PRIMARY_DATABASE: process.env.PG_TEST_DATABASE || "postgres",
      PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:synthetic-edge-test-primary",
      POSTGRES_IAM_USER: "synthetic-edge-test-runtime@synthetic.iam",
      POSTGRES_SOURCE_ID: SOURCE_ID,
      POSTGRES_SOURCE_NAMESPACE: NAMESPACE,
      POSTGRES_RATE_LIMIT_SECRET: "synthetic-edge-test-rate-limit-secret-0123456789abcdef",
      ENVELOPE_PUBLIC_JWK: keys.publicText,
      ENVELOPE_PRIVATE_JWK: keys.privateText,
      GCS_BUCKET_NAME: bucket,
      GCS_ERASURE_BUCKET_HISTORY_PROOF: JSON.stringify({
        bucket, bucketGeneration: "1", bucketMetageneration: "1", softDeleteRetentionDurationSeconds: "0",
      }),
      ACCOUNTLESS_ENROLLMENT_MODE: "enabled",
      ACCOUNTLESS_OWNERSHIP_MODE: "enabled",
      ANALYTICS_V2_ENABLED: "1",
      ...(edge ? {
        EDGE_ORIGIN_MODE: "edge-test",
        EDGE_ORIGIN_AUDIENCE: AUDIENCE,
        EDGE_INVOKER_SERVICE_ACCOUNT: INVOKER,
        EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS: VERIFIER,
      } : {}),
      ...environment,
    };
    const runtime = await withEnvironment(env, () => m.server.createRuntime({
      dependencies: {
        ...m.server.originCompositionDependencies(env),
        createConnector: () => ({ close() {} }),
        async createIamPool(options) {
          const pool = new pg.Pool(localPoolOptions(socket, options.max, `pg-origin-edge-test-${options.role}`));
          pool.on("error", () => {});
          pools.push(pool);
          return pool;
        },
        async createGoogleAccessTokenProvider() { return async () => "synthetic-access-token"; },
        createGcsQuarantineObjectStore: () => ({
          async put(key, value) { objects.set(key, value); },
          async delete(key) { objects.delete(key); },
        }),
      },
    }));
    assert.equal(runtime.postgresTestHostMode, "fastpath-test");
    if (edge) {
      assert.equal(runtime.edgeTestOrigin.listen.hostOrigin, hostOrigin);
      assert.equal(typeof runtime.edgeTestRequestFromNode, "function");
      close = await m.server.serve(runtime);
    } else {
      assert.equal(runtime.edgeTestOrigin, undefined);
      assert.equal(runtime.edgeTestRequestFromNode, undefined);
    }
    return await run({ m, base, t, port, hostOrigin, runtime });
  } finally {
    if (close !== null) await close().catch(() => {});
    for (const pool of pools) await pool.end().catch(() => {});
    for (const listener of process.listeners("SIGTERM")) {
      if (!sigterm.includes(listener)) process.removeListener("SIGTERM", listener);
    }
    for (const listener of process.listeners("SIGINT")) {
      if (!sigint.includes(listener)) process.removeListener("SIGINT", listener);
    }
    for (const schema of created.reverse()) await base.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await base.end();
  }
}

// ---------------------------------------------------------------------------
// Requests as Cloud Run's front end delivers them

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A verified, signature-removed ID token for the invoker unless overridden. */
function token(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: AUDIENCE,
    azp: "100000000000000000000",
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

/** The edge contract headers, as an invoker request carries them. */
function edgeHeaders({ hostKind = "apex", admission = null, auth = token() } = {}) {
  return {
    ...(auth === null ? {} : { "x-serverless-authorization": auth }),
    "x-tibotattle-edge-host": hostKind,
    "x-tibotattle-edge-request-id": randomUUID(),
    ...(admission === null ? {} : { "x-tibotattle-edge-admission": admission }),
  };
}

const unknownDeviceBearer = () => `Device um_device_${randomUUID()}.${randomBytes(32).toString("base64url")}`;
const unknownUploadBearer = () => `Upload um_device_upload_${randomUUID()}.${"A".repeat(43)}`;

/**
 * One HTTP exchange with the served origin. With hold, the body chunk is
 * written and the request is never ended: a response proves the origin
 * answered without waiting for (or reading) the rest of the body.
 */
function send(port, { method = "GET", path, headers = {}, body, hold = false, deadlineMs = 10_000 }) {
  return new Promise((resolveSend, reject) => {
    const started = performance.now();
    const request = http.request({ host: "127.0.0.1", port, method, path, headers, agent: false });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(new Error(`no response within ${deadlineMs} ms: ${method} ${path}`));
    }, deadlineMs);
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    request.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", () => {});
      response.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const answer = {
          status: response.statusCode,
          headers: response.headers,
          text: Buffer.concat(chunks).toString("utf8"),
          elapsedMs: performance.now() - started,
          bodyStillOpen: hold && !request.writableEnded,
        };
        request.destroy();
        resolveSend(answer);
      });
    });
    if (body === undefined) request.end();
    else if (hold) request.write(body);
    else request.end(body);
  });
}

function errorCode(answer) {
  try { return JSON.parse(answer.text)?.error?.code ?? null; } catch { return null; }
}

function assertMarked(answer, label) {
  assert.equal(answer.headers["x-tibotattle-origin"], "1", `${label}: marked by the boundary`);
}

function assertBoundaryRefusal(m, answer, label) {
  assert.equal(answer.status, 421, label);
  assert.equal(answer.text, m.contract.ORIGIN_BOUNDARY_ERROR_BODY, label);
  assert.equal(answer.headers.connection, "close", label);
  assert.equal(answer.headers["cache-control"], "no-store", label);
  assert.equal(answer.headers["x-tibotattle-origin"], undefined, `${label}: never marked`);
}

function assertUnported(m, answer, label) {
  assert.equal(answer.status, 503, label);
  assert.equal(answer.text, m.edgeMode.EDGE_TEST_UNPORTED_BODY, label);
  assert.equal(answer.headers["cache-control"], "no-store", label);
  assertMarked(answer, label);
}

function assertApiError(answer, status, code, label) {
  assert.equal(answer.status, status, `${label}: ${answer.text}`);
  assert.equal(errorCode(answer), code, label);
}

function assertAdmissionAnswer(answer, status, code, label) {
  assertApiError(answer, status, code, label);
  assert.equal(answer.headers["retry-after"], "60", label);
  assert.equal(answer.headers["cache-control"], "no-store", label);
  assertMarked(answer, label);
}

/** A request that reaches route's admission call point when admitted. */
function reachableRequest(route, method, { hostKind = "apex", admission = null, extra = {} } = {}) {
  const post = method !== "GET" && method !== "HEAD";
  const path = route.pathname + (route.id === "community_daily" ? DAILY_QUERY : "");
  return {
    method,
    path,
    headers: {
      ...edgeHeaders({ hostKind, admission }),
      authorization: route.id === "contributions" ? unknownUploadBearer() : unknownDeviceBearer(),
      ...(post ? { "content-type": "application/json" } : {}),
      ...(hostKind === "admin" ? { "cf-access-jwt-assertion": "synthetic.access.assertion" } : {}),
      ...extra,
    },
    ...(post ? { body: "{}" } : {}),
  };
}

// ---------------------------------------------------------------------------
// The boundary over the wire

test("boundary refusals are the unmarked 421 with connection: close, before any body is read", {
  skip: SKIP, timeout: 300_000,
}, () => withOrigin({ edge: true }, async ({ m, port }) => {
  // The composition root's one content-free refusal line per refusal.
  const lines = [];
  const logSpy = mock.method(console, "log", (...args) => { lines.push(args.join(" ")); });
  const sentValues = new Set();
  const reasonOf = (label) => {
    assert.equal(lines.length, 1, `${label}: exactly one refusal line`);
    const parsed = JSON.parse(lines.pop());
    assert.equal(parsed.event, "edge_origin_boundary_refusal", label);
    return parsed.reason;
  };
  try {
    const now = Math.floor(Date.now() / 1000);
    const contributions = "/api/v1/contributions";
    for (const [label, headers, reason] of [
      ["no token", edgeHeaders({ auth: null }), "invoker_header_missing"],
      ["wrong audience", edgeHeaders({ auth: token({ aud: "https://another-origin.synthetic.example" }) }),
        "audience_mismatch"],
      ["unverified email", edgeHeaders({ auth: token({ email_verified: false }) }), "email_unverified"],
      ["expired token", edgeHeaders({ auth: token({ exp: now - 120, iat: now - 3_720 }) }), "invoker_claims_invalid"],
      ["unknown email", edgeHeaders({ auth: token({ email: STRANGER }) }), "email_mismatch"],
      ["client-sent edge client key", { ...edgeHeaders({ admission: "v1;upload_ingress;allowed" }),
        "x-tibotattle-edge-client-key": "0".repeat(64) }, "edge_header_unknown"],
      ["no host kind", { "x-serverless-authorization": token(), "x-tibotattle-edge-request-id": randomUUID() },
        "edge_host_kind_invalid"],
      ["undecodable admission", edgeHeaders({ admission: "v2;upload_ingress;allowed" }), "admission_invalid"],
      ["verifier POST", { "x-serverless-authorization": token({ email: VERIFIER }) }, "verifier_method"],
    ]) {
      const request = {
        method: "POST", path: contributions, hold: true, body: "{\"synthetic\":tru",
        headers: { ...headers, "content-type": "application/json",
          authorization: unknownUploadBearer() },
      };
      for (const value of Object.values(request.headers)) sentValues.add(value);
      const answer = await send(port, request);
      assertBoundaryRefusal(m, answer, label);
      assert.equal(answer.bodyStillOpen, true, `${label}: answered while the body was still open`);
      assert.equal(reasonOf(label), reason, label);
    }
    const callbackHeaders = edgeHeaders();
    const callback = await send(port, {
      path: "/api/v1/identity/google/callback?code=synthetic&state=synthetic",
      headers: callbackHeaders,
    });
    assertBoundaryRefusal(m, callback, "raw callback query");
    assert.equal(reasonOf("raw callback query"), "callback_raw_query");
    const wrongHostHeaders = { ...edgeHeaders(), host: "tibotattle.test" };
    const wrongHost = await send(port, { path: "/api/health", headers: wrongHostHeaders });
    assertBoundaryRefusal(m, wrongHost, "Host other than HOST_ORIGIN's");
    assert.equal(reasonOf("Host other than HOST_ORIGIN's"), "host_mismatch");
    for (const value of [...Object.values(callbackHeaders), ...Object.values(wrongHostHeaders)]) sentValues.add(value);

    // A verifier may only read health and readiness.
    const health = await send(port, { path: "/api/health", headers: { "x-serverless-authorization": token({ email: VERIFIER }) } });
    assert.equal(health.status, 200, health.text);
    assert.equal(JSON.parse(health.text).status, "ready");
    assertMarked(health, "verifier health");
    const ready = await send(port, { path: "/api/ready", headers: { "x-serverless-authorization": token({ email: VERIFIER }) } });
    assertUnported(m, ready, "verifier ready (fastpath-test serves no /api/ready)");
    assert.deepEqual(lines, [], "admitted verifier reads log nothing");
    const verifierPost = await send(port, { method: "POST", path: "/api/health", body: "{}",
      headers: { "x-serverless-authorization": token({ email: VERIFIER }), "content-type": "application/json" } });
    assertBoundaryRefusal(m, verifierPost, "verifier POST");
    assert.equal(reasonOf("verifier POST /api/health"), "verifier_method");
    // The invoker reads health through the same composition.
    const invokerHealth = await send(port, { path: "/api/health", headers: edgeHeaders() });
    assert.equal(invokerHealth.status, 200);
    assertMarked(invokerHealth, "invoker health");
    assert.deepEqual(lines, [], "an admitted invoker read logs nothing");
  } finally {
    logSpy.mock.restore();
  }
  // No line carried a header value (a token, a segment, an email, a key).
  const logged = logSpy.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
  for (const value of sentValues) {
    for (const fragment of [value, ...value.split(/[ .,;]+/u)]) {
      if (fragment.length >= 6) assert.ok(!logged.includes(fragment), `a line carries ${fragment.slice(0, 24)}`);
    }
  }
  for (const needle of ["@", "Bearer", INVOKER, VERIFIER, STRANGER, AUDIENCE, "127.0.0.1", "/api/"]) {
    assert.ok(!logged.includes(needle), `a line carries ${needle}`);
  }
}));

// ---------------------------------------------------------------------------
// Served routes

test("served routes: every EDGE_TEST_SERVED_ROUTE_IDS pair is served; every other forwarded pair is unported", {
  skip: SKIP, timeout: 300_000,
}, () => withOrigin({ edge: true }, async ({ m, port }) => {
  const served = new Set(m.edgeMode.EDGE_TEST_SERVED_ROUTE_IDS);
  let servedPairs = 0;
  let unportedPairs = 0;
  const observedServedIds = new Set();
  for (const route of m.registry.WORKER_ROUTE_POLICY) {
    if (EDGE_LOCAL_ROUTE_IDS.has(route.id)) continue;
    assert.ok(Array.isArray(route.methods), `${route.id} has explicit methods`);
    const policy = m.policy.edgeAdmissionPolicyFor(route.id);
    const admission = policy === null ? null : `v1;${policy.purpose};allowed`;
    for (const method of route.methods) {
      // The six admin API ids are edge-local 404s on the apex (E4); every
      // other pair reaches the origin on the apex.
      if (!route.id.startsWith("admin_")) {
        const label = `${method} ${route.pathname} (${route.id}) on the apex`;
        const answer = await send(port, reachableRequest(route, method, { admission }));
        assertMarked(answer, label);
        if (served.has(route.id)) {
          assert.notEqual(answer.text, m.edgeMode.EDGE_TEST_UNPORTED_BODY, label);
          assert.ok(!ADMISSION_CODES.includes(errorCode(answer)), `${label}: admitted (${answer.text})`);
          observedServedIds.add(route.id);
          servedPairs += 1;
        } else {
          assertUnported(m, answer, label);
          unportedPairs += 1;
        }
      }
      // On the admin host the composition serves nothing.
      const adminLabel = `${method} ${route.pathname} (${route.id}) on the admin host`;
      assertUnported(m, await send(port, reachableRequest(route, method, { hostKind: "admin", admission })),
        adminLabel);
    }
  }
  assert.deepEqual([...observedServedIds].sort(), [...served].sort(), "every served id was probed");
  assert.equal(servedPairs, 31, "29 served ids, two with GET and POST");
  assert.ok(unportedPairs > 0);
}));

// ---------------------------------------------------------------------------
// Admission replay at the Worker's call points

test("replay parity: each served EP-1 policy route answers the Worker helper's 429 and 503 for the edge outcome", {
  skip: SKIP, timeout: 300_000,
}, () => withOrigin({ edge: true }, async ({ m, port }) => {
  const served = new Set(m.edgeMode.EDGE_TEST_SERVED_ROUTE_IDS);
  const routes = m.registry.WORKER_ROUTE_POLICY
    .filter((route) => served.has(route.id) && m.policy.edgeAdmissionPolicyFor(route.id) !== null);
  assert.deepEqual(routes.map((route) => route.id).sort(), [
    "accountless_enrollment", "accountless_ownership", "accountless_renewal",
    "accountless_telemetry_v12_authorization", "community_daily", "contributions",
    "device_credential_renew", "device_disconnect", "device_sync_capabilities",
    "device_sync_capabilities_v12", "device_sync_manifest", "device_sync_state",
    "telemetry_v11_day_manifests", "telemetry_v11_domain_activate", "telemetry_v11_domain_predecessor",
    "telemetry_v12_day_manifests", "telemetry_v12_domain_activate", "telemetry_v12_domain_predecessor",
  ]);
  for (const route of routes) {
    const { purpose } = m.policy.edgeAdmissionPolicyFor(route.id);
    const ingress = purpose === "upload_ingress";
    const limitedCode = ingress ? "UPLOAD_INGRESS_LIMIT_REACHED" : "ATTEMPT_LIMIT_REACHED";
    const unavailableCode = ingress ? "UPLOAD_INGRESS_UNAVAILABLE" : "ADMISSION_RATE_LIMIT_UNAVAILABLE";
    const wrongPurpose = purpose === "device_sync" ? "device_disconnect" : "device_sync";
    for (const method of route.methods) {
      const label = `${method} ${route.pathname}`;
      assertAdmissionAnswer(await send(port, reachableRequest(route, method, {
        admission: `v1;${purpose};limited`,
      })), 429, limitedCode, `${label} limited`);
      for (const [variant, admission] of [
        ["unavailable", `v1;${purpose};unavailable`],
        ["no admission header", null],
        [`wrong purpose ${wrongPurpose}`, `v1;${wrongPurpose};allowed`],
      ]) {
        assertAdmissionAnswer(await send(port, reachableRequest(route, method, { admission })),
          503, unavailableCode, `${label} ${variant}`);
      }
      const allowed = await send(port, reachableRequest(route, method, { admission: `v1;${purpose};allowed` }));
      assertMarked(allowed, `${label} allowed`);
      assert.ok(!ADMISSION_CODES.includes(errorCode(allowed)), `${label} allowed proceeds: ${allowed.text}`);
      assert.notEqual(allowed.status, 429, `${label} allowed`);
    }
  }
}));

// ---------------------------------------------------------------------------
// d43c8f92 order fixes (each answered differently on the base composition)

test("community/daily: a limited public read is 429 before its parameters are validated", {
  skip: SKIP, timeout: 300_000,
}, () => withOrigin({ edge: true }, async ({ port }) => {
  for (const query of ["?from=not-a-day&to=2026-09-02", "?unexpected=1", "", DAILY_QUERY]) {
    assertAdmissionAnswer(await send(port, {
      path: `/api/v1/community/daily${query}`,
      headers: edgeHeaders({ admission: "v1;public_aggregate_read;limited" }),
    }), 429, "ATTEMPT_LIMIT_REACHED", `limited ${query}`);
  }
  // Admitted, the same parameters keep the route's own answers.
  assertApiError(await send(port, {
    path: "/api/v1/community/daily?from=not-a-day&to=2026-09-02",
    headers: edgeHeaders({ admission: "v1;public_aggregate_read;allowed" }),
  }), 400, "BODY_INVALID", "allowed with an invalid day");
  const daily = await send(port, {
    path: `/api/v1/community/daily${DAILY_QUERY}`,
    headers: edgeHeaders({ admission: "v1;public_aggregate_read;allowed" }),
  });
  assert.equal(daily.status, 200, daily.text);
  assert.deepEqual(JSON.parse(daily.text).days, []);
}));

test("contributions: the ingress limiter answers before a byte of the body is read; the preflight comes first", {
  skip: SKIP, timeout: 300_000,
}, () => withOrigin({ edge: true }, async ({ port }) => {
  const path = "/api/v1/contributions";
  const upload = (admission, extra = {}) => ({
    ...edgeHeaders({ admission }),
    "content-type": "application/json",
    authorization: unknownUploadBearer(),
    ...extra,
  });
  // Limited: 429 while the chunked body is still open and unread.
  const limited = await send(port, {
    method: "POST", path, hold: true, body: "{\"synthetic\":",
    headers: upload("v1;upload_ingress;limited"), deadlineMs: 3_000,
  });
  assertAdmissionAnswer(limited, 429, "UPLOAD_INGRESS_LIMIT_REACHED", "limited");
  assert.equal(limited.bodyStillOpen, true);
  // The d43c8f92 preflight (index.ts:621-644) answers before the limiter.
  for (const [label, headers, body, status, code] of [
    ["malformed Upload header", upload("v1;upload_ingress;limited", { authorization: "Upload not-an-authorization" }),
      "{}", 401, "UPLOAD_AUTH_INVALID"],
    ["Device bearer", upload("v1;upload_ingress;limited", { authorization: unknownDeviceBearer() }),
      "{}", 401, "UPLOAD_AUTH_INVALID"],
    ["no bearer", (() => {
      const headers = upload("v1;upload_ingress;limited");
      delete headers.authorization;
      return headers;
    })(), "{}", 401, "UPLOAD_AUTH_INVALID"],
    ["session cookie", upload("v1;upload_ingress;limited", { cookie: SESSION_COOKIE }), "{}", 401, "UPLOAD_AUTH_INVALID"],
    ["text content type", upload("v1;upload_ingress;limited", { "content-type": "text/plain" }), "{}", 415,
      "CONTENT_TYPE_INVALID"],
    ["declared oversize", upload("v1;upload_ingress;limited", { "content-length": String(2 * 1024 * 1024 + 1) }),
      undefined, 413, "BODY_TOO_LARGE"],
    ["no body", upload("v1;upload_ingress;limited", { "content-length": "0" }), undefined, 400, "BODY_INVALID"],
  ]) {
    const answer = await send(port, { method: "POST", path, headers, ...(body === undefined ? {} : { body }) });
    assertApiError(answer, status, code, label);
  }
  // An unrelated cookie is not a session cookie: the limiter still answers.
  assertAdmissionAnswer(await send(port, {
    method: "POST", path, body: "{}", headers: upload("v1;upload_ingress;limited", { cookie: UNRELATED_COOKIE }),
  }), 429, "UPLOAD_INGRESS_LIMIT_REACHED", "unrelated cookie, limited");
  // Admitted, an unknown authorization is refused at the claim.
  assertApiError(await send(port, {
    method: "POST", path, body: JSON.stringify({ schemaVersion: "telemetry-envelope-v1.1" }),
    headers: upload("v1;upload_ingress;allowed"),
  }), 401, "UPLOAD_AUTH_INVALID", "allowed reaches the claim");
}));

test("v1.2 day manifests and domain routes charge device_sync before the cookie and the credential", {
  skip: SKIP, timeout: 300_000,
}, () => withOrigin({ edge: true }, async ({ port }) => {
  for (const path of [
    "/api/v1/device/telemetry/v1.2/day-manifests",
    "/api/v1/me/telemetry-v12/domain-predecessor",
    "/api/v1/me/telemetry-v12/domain-activate",
  ]) {
    for (const [label, extra] of [
      ["missing credential", {}],
      ["unknown credential", { authorization: unknownDeviceBearer() }],
      ["cookie-bearing request", { authorization: unknownDeviceBearer(), cookie: UNRELATED_COOKIE }],
    ]) {
      assertAdmissionAnswer(await send(port, {
        method: "POST", path, body: "{}",
        headers: { ...edgeHeaders({ admission: "v1;device_sync;limited" }), "content-type": "application/json", ...extra },
      }), 429, "ATTEMPT_LIMIT_REACHED", `${path} ${label}`);
    }
    // Admitted, the cookie and the credential are refused as before.
    assertApiError(await send(port, {
      method: "POST", path, body: "{}",
      headers: { ...edgeHeaders({ admission: "v1;device_sync;allowed" }), "content-type": "application/json",
        authorization: unknownDeviceBearer(), cookie: UNRELATED_COOKIE },
    }), 401, "DEVICE_AUTH_INVALID", `${path} allowed with a cookie`);
    assertApiError(await send(port, {
      method: "POST", path, body: "{}",
      headers: { ...edgeHeaders({ admission: "v1;device_sync;allowed" }), "content-type": "application/json",
        authorization: unknownDeviceBearer() },
    }), 401, "DEVICE_AUTH_INVALID", `${path} allowed with an unknown credential`);
  }
}));

test("device credential renewal: limiter, upload-registration control, then the cookie refusal", {
  skip: SKIP, timeout: 300_000,
}, () => withOrigin({ edge: true }, async ({ port, base, t }) => {
  const path = "/api/v1/device/credential/renew";
  const renew = (admission, extra = {}) => ({
    method: "POST", path, body: "{}",
    headers: { ...edgeHeaders({ admission }), "content-type": "application/json",
      authorization: unknownDeviceBearer(), ...extra },
  });
  assertAdmissionAnswer(await send(port, renew("v1;device_credential_renew;limited", { cookie: SESSION_COOKIE })),
    429, "ATTEMPT_LIMIT_REACHED", "cookie and limited");
  assertApiError(await send(port, renew("v1;device_credential_renew;allowed", { cookie: UNRELATED_COOKIE })),
    401, "DEVICE_AUTH_INVALID", "any cookie, admitted");
  await base.query(`UPDATE ${t("collection_controls")}
      SET revision=revision+1, control_state='degraded', upload_registration_enabled=false, updated_at=$1
    WHERE singleton=1`, [new Date().toISOString()]);
  assertApiError(await send(port, renew("v1;device_credential_renew;allowed", { cookie: UNRELATED_COOKIE })),
    503, "UPLOAD_REGISTRATION_DISABLED", "the control precedes the cookie refusal");
}));

test("accountless routes refuse only the session cookie, with AUTH_INVALID", {
  skip: SKIP, timeout: 300_000,
}, () => withOrigin({ edge: true }, async ({ port }) => {
  for (const [path, purpose] of [
    ["/api/v1/accountless/enrollment", "enrollment"],
    ["/api/v1/accountless/ownership", "accountless_ownership"],
    ["/api/v1/accountless/telemetry-v1.2-authorization", "accountless_ownership"],
    ["/api/v1/accountless/renewal", "accountless_renewal"],
  ]) {
    const request = (cookie, outcome) => ({
      method: "POST", path, body: "{}",
      headers: { ...edgeHeaders({ admission: `v1;${purpose};${outcome}` }), "content-type": "application/json",
        authorization: unknownDeviceBearer(), ...(cookie === undefined ? {} : { cookie }) },
    });
    for (const cookie of [SESSION_COOKIE, `${UNRELATED_COOKIE}; ${SESSION_COOKIE}`]) {
      assertApiError(await send(port, request(cookie, "allowed")), 401, "AUTH_INVALID", `${path} ${cookie}`);
    }
    // An unrelated cookie is not refused for the cookie: the limiter answers,
    // and admitted, the route's own next check does. For the v1.2 grant that
    // is the device credential (d43c8f92 index.ts:780-789 authenticates
    // before it reads the body), so the unknown bearer is refused whether or
    // not the unrelated cookie is present; elsewhere it is body validation.
    assertAdmissionAnswer(await send(port, request(UNRELATED_COOKIE, "limited")),
      429, "ATTEMPT_LIMIT_REACHED", `${path} unrelated cookie, limited`);
    const admitted = await send(port, request(UNRELATED_COOKIE, "allowed"));
    if (path === "/api/v1/accountless/telemetry-v1.2-authorization") {
      assertApiError(admitted, 401, "DEVICE_AUTH_INVALID", `${path} unrelated cookie, admitted`);
      assertApiError(await send(port, request(undefined, "allowed")), 401, "DEVICE_AUTH_INVALID",
        `${path} no cookie, admitted`);
    } else {
      assert.ok(!["AUTH_INVALID", "DEVICE_AUTH_INVALID"].includes(errorCode(admitted)),
        `${path} unrelated cookie, admitted: ${admitted.text}`);
      assertApiError(admitted, 400, "BODY_INVALID", `${path} unrelated cookie, admitted`);
    }
  }
}));

// ---------------------------------------------------------------------------
// Without the edge: the same call points charge the PostgreSQL limiters

test("fastpath-test without EDGE_ORIGIN_MODE charges the PostgreSQL public-read and ingress limiters", {
  skip: SKIP, timeout: 300_000,
}, () => withOrigin({
  edge: false,
  environment: {
    HOST_RATE_LIMIT_PUBLIC_READ_RATE_LIMIT_LIMIT: "1",
    HOST_RATE_LIMIT_UPLOAD_INGRESS_REQUEST_RATE_LIMIT_LIMIT: "1",
  },
}, async ({ runtime, hostOrigin }) => {
  const dispatch = async (path, init = {}) => {
    const response = await runtime.postgresTestDispatch(new Request(`${hostOrigin}${path}`, init));
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      text: await response.text(),
    };
  };
  const first = await dispatch(`/api/v1/community/daily${DAILY_QUERY}`);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.headers["x-tibotattle-origin"], undefined, "no boundary without the edge");
  const second = await dispatch("/api/v1/community/daily?from=not-a-day");
  assertApiError(second, 429, "ATTEMPT_LIMIT_REACHED", "second public read");
  assert.equal(second.headers["retry-after"], "60");

  const upload = () => ({
    method: "POST",
    headers: { "content-type": "application/json", authorization: unknownUploadBearer() },
    body: JSON.stringify({ schemaVersion: "telemetry-envelope-v1.1" }),
  });
  assertApiError(await dispatch("/api/v1/contributions", upload()), 401, "UPLOAD_AUTH_INVALID",
    "first upload reaches the claim");
  const limited = await dispatch("/api/v1/contributions", upload());
  assertApiError(limited, 429, "UPLOAD_INGRESS_LIMIT_REACHED", "second upload");
  assert.equal(limited.headers["retry-after"], "60");
}));
