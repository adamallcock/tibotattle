// CR-7 production host (D-CRB) over real HTTP on 127.0.0.1 against a
// disposable PostgreSQL 17 schema.
//
// Each fixture composes the real Cloud Run origin (cloud-run/server.mjs
// createRuntime + serve) with HOST_MODE=production from a synthetic CR-3
// environment, with injected local pools, connector, token provider and an
// in-memory object store; the schema is migrated through the production
// runner. Requests arrive as Cloud Run's front end delivers them: a synthetic
// ID token whose signature segment is SIGNATURE_REMOVED_BY_GOOGLE in
// x-serverless-authorization, with the Host of the service's run.app origin.
// Nothing reaches Google or Cloudflare; every account, token, key and row is
// synthetic and content-free, and each fixture drops only the schema it
// created (prefix d_crb_ph_).
//
// It proves: the release verifier (verifyEdgeOriginBeforeGcp) passes against
// the composed host once C-MAINT's lifecycle pass has run, and fails NOT_READY
// before it (the defined first-roll path); RD-3 health is the closed body with
// the deployment commit; the storage gate rereads the receipt on every
// request (TTL 0) and refuses a drifted or newer schema; unported routes and
// the admin host answer the closed 503 under the edge's request id with no
// retry-after; the contribution path takes and releases an ingress lease;
// every log line is the closed shape without request content; RD-2's reader
// refuses a missing or wrong typed pin and a missing or malformed lifecycle
// row with 503 BACKEND_STORAGE_UNAVAILABLE before the builder runs;
// run_maintenance over C-MAINT's lifecycle pass (the ADMIN-R12 path) answers
// and audits a refused or skipped pass as the Worker does, never as 200; and
// the admin run_maintenance task reports and audits the lifecycle pass's
// folded purges under the Worker's keys (MAINT-PURGE).
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
import { verifyEdgeOriginBeforeGcp } from "../scripts/production-edge-mode.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const SKIP = !PG_TEST_SOCKET;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NAMESPACE = "synthetic-production-host-namespace";
const KEY_ID = "key:synthetic-production-host";
const INVOKER = "edge-invoker@synthetic-project.iam.gserviceaccount.com";
const VERIFIER = "edge-verifier@synthetic-project.iam.gserviceaccount.com";
const AUDIENCE = "tibotattle-origin-audience";
const RUN_APP_ORIGIN = "https://tibotattle-origin-abc123def4-ue.a.run.app";
const RUN_APP_HOST = new URL(RUN_APP_ORIGIN).host;
const BUCKET = "synthetic-origin-quarantine";
const LOG_KEYS = Object.freeze(["level", "severity", "event", "requestId", "method", "routeClass", "code", "status"]);
// Values a request carries that must never reach a log line.
const INJECTED = Object.freeze({
  address: "203.0.113.77",
  query: "synthetic-query-marker-7f3a",
  cookie: "synthetic-cookie-marker-91bc",
});

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
  const [server, host, codec, health, ingressBudget, readiness, adminConsole, lifecyclePass] = await Promise.all([
    load("/cloud-run/server.mjs"),
    load("/cloud-run/postgres-production-host.mjs"),
    load("/src/typed-telemetry-codec.ts"),
    load("/src/postgres-health-contract.ts"),
    load("/src/postgres-ingress-budget.ts"),
    load("/cloud-run/postgres-readiness-dispatch.mjs"),
    load("/cloud-run/routes/admin-console.mjs"),
    load("/src/postgres-lifecycle-pass.ts"),
  ]);
  modules = { server, host, codec, health, ingressBudget, readiness, adminConsole, lifecyclePass };
  return modules;
}

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  const link = await lstat(PG_TEST_SOCKET);
  const socketHost = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(socketHost);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(socketHost.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.isDirectory(), true);
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host: socketHost, port: PG_TEST_PORT };
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

/** The CR-3 production environment of the synthetic service, minus nothing it needs. */
function productionEnvironment({ primarySchema, port, keys }) {
  return {
    HOST_MODE: "production",
    // A local listen: 127.0.0.1 even though K_SERVICE is set (only HOST=0.0.0.0 opens).
    HOST: "127.0.0.1",
    PORT: String(port),
    K_SERVICE: "tibotattle-origin",
    HOST_ORIGIN: RUN_APP_ORIGIN,
    PUBLIC_ORIGIN: "https://tibotattle.com",
    EDGE_ORIGIN_MODE: "cloudflare-worker-iam",
    EDGE_ORIGIN_AUDIENCE: AUDIENCE,
    EDGE_INVOKER_SERVICE_ACCOUNT: INVOKER,
    EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS: VERIFIER,
    DEPLOYMENT_SOURCE_COMMIT: COMMIT,
    TELEMETRY_STORAGE_NAMESPACE: NAMESPACE,
    PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-primary",
    PRIMARY_DATABASE: process.env.PG_TEST_DATABASE || "postgres",
    PRIMARY_SCHEMA: primarySchema,
    POSTGRES_IAM_USER: "origin-runtime@synthetic-project.iam",
    GCS_BUCKET_NAME: BUCKET,
    GCS_QUARANTINE_BUCKET_HISTORY_PROOF: JSON.stringify({ bucket: BUCKET, bucketGeneration: "1700000000000001",
      bucketMetageneration: "1", softDeleteRetentionDurationSeconds: "0" }),
    ENVELOPE_PUBLIC_JWK: keys.publicText,
    ENVELOPE_PRIVATE_JWK: keys.privateText,
    IDENTITY_LINK_SECRET: "synthetic-identity-link-secret-value-0000000001",
    POSTGRES_RATE_LIMIT_SECRET: "synthetic-rate-limit-secret-value-00000000002",
  };
}

async function withEnvironment(environment, work) {
  const names = Object.keys(environment);
  const saved = new Map(names.map((name) => [name, process.env[name]]));
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

/**
 * A HOST_MODE=production origin over a fresh, fully migrated "d_crb_ph_*"
 * schema with operational controls and the typed v1/v1.1 pins naming the
 * configured namespace (as the bootstrap leaves them). Nothing else is
 * seeded: the retention and reconciliation rows are the lifecycle pass's.
 */
async function withProductionHost(run) {
  const m = await loadModules();
  const socket = await localSocket();
  const base = new pg.Pool(localPoolOptions(socket, 4, "d-crb-production-host"));
  base.on("error", () => {});
  const primarySchema = `d_crb_ph_${randomBytes(5).toString("hex")}`;
  const pools = [];
  const lines = [];
  let close = null;
  let created = false;
  const sigterm = process.listeners("SIGTERM");
  const sigint = process.listeners("SIGINT");
  try {
    const server = await base.query(
      "SELECT inet_server_addr() AS address, current_setting('server_version_num')::integer AS version",
    );
    assert.equal(server.rows[0]?.address, null, "qualification requires the local Unix socket");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "the disposable socket must be PostgreSQL 17");
    await base.query(`CREATE SCHEMA "${primarySchema}"`);
    created = true;
    await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: base });
    const t = (name) => `"${primarySchema}"."${name}"`;
    await base.query(`UPDATE ${t("collection_controls")}
        SET revision=2, control_state='operational', enrollment_enabled=true, upload_registration_enabled=true,
            processing_enabled=true, publication_enabled=true, updated_at=$1
      WHERE singleton=1`, [new Date().toISOString()]);
    const namespace = await base.query(`INSERT INTO ${t("typed_telemetry_namespaces")} (original_id)
      VALUES ($1) RETURNING id`, [Buffer.from(m.codec.encodeTypedTelemetryId(NAMESPACE))]);
    for (const family of ["typed_v1_admission_state", "typed_v11_admission_state"]) {
      await base.query(`INSERT INTO ${t(family)}
          (id, source_namespace, namespace_id, runtime_contract_version, next_source_row_id)
        VALUES (1, $1, $2, 1, 1)`, [NAMESPACE, namespace.rows[0].id]);
    }
    const objects = new Map();
    const objectStore = {
      async head(key) { return objects.has(key) ? { key } : null; },
      async put(key, value) { objects.set(key, value); },
      async delete(key) { objects.delete(key); },
    };
    const port = await freePort();
    const env = productionEnvironment({ primarySchema, port, keys: await envelopeKeys() });
    const runtime = await withEnvironment(env, () => m.server.createRuntime({
      dependencies: {
        createConnector: () => ({ close() {} }),
        async createIamPool(options) {
          const pool = new pg.Pool(localPoolOptions(socket, options.max, options.applicationName));
          pool.on("error", () => {});
          pools.push(pool);
          return pool;
        },
        async createGoogleAccessTokenProvider() { return async () => "synthetic-access-token"; },
        createGcsQuarantineObjectStore: () => objectStore,
        logger: (line) => { lines.push(line); },
      },
    }));
    assert.equal(runtime.hostMode, "production");
    assert.equal(runtime.listenHost, "127.0.0.1");
    close = await m.server.serve(runtime);
    return await run({ m, base, t, port, primarySchema, objectStore, lines });
  } finally {
    await close?.();
    for (const pool of pools) await pool.end().catch(() => undefined);
    for (const listener of process.listeners("SIGTERM")) {
      if (!sigterm.includes(listener)) process.removeListener("SIGTERM", listener);
    }
    for (const listener of process.listeners("SIGINT")) {
      if (!sigint.includes(listener)) process.removeListener("SIGINT", listener);
    }
    if (created) await base.query(`DROP SCHEMA IF EXISTS "${primarySchema}" CASCADE`);
    await base.end();
  }
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A signed-shape synthetic ID token; Cloud Run's front end replaces the signature. */
function identityToken(email) {
  const now = Math.floor(Date.now() / 1000);
  return [
    base64UrlJson({ alg: "RS256", kid: "0".repeat(40), typ: "JWT" }),
    base64UrlJson({ aud: AUDIENCE, azp: "100000000000000000000", email, email_verified: true, exp: now + 3_000,
      iat: now - 60, iss: "https://accounts.google.com", sub: "100000000000000000000" }),
    "c3ludGhldGljLXNpZ25hdHVyZQ",
  ].join(".");
}

/** What Cloud Run's front end forwards in place of the caller's token. */
function frontEndToken(bearer) {
  const [scheme, value] = bearer.split(" ");
  const [header, payload] = value.split(".");
  return `${scheme} ${header}.${payload}.SIGNATURE_REMOVED_BY_GOOGLE`;
}

function edgeHeaders({ email = INVOKER, hostKind = "apex", admission = null, requestId = randomUUID() } = {}) {
  return {
    "x-serverless-authorization": frontEndToken(`Bearer ${identityToken(email)}`),
    "x-tibotattle-edge-host": hostKind,
    "x-tibotattle-edge-request-id": requestId,
    ...(admission === null ? {} : { "x-tibotattle-edge-admission": admission }),
  };
}

/** A verifier's read: the token alone (EP-6 refuses a verifier carrying edge headers). */
function verifierHeaders() {
  return { "x-serverless-authorization": frontEndToken(`Bearer ${identityToken(VERIFIER)}`) };
}

/** One HTTP exchange with the served origin, under the run.app Host. */
function send(port, { method = "GET", path, headers = {}, body, deadlineMs = 10_000 }) {
  return new Promise((resolveSend, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path, agent: false,
      headers: { host: RUN_APP_HOST, ...headers } });
    const timer = setTimeout(() => {
      request.destroy();
      reject(new Error(`no response within ${deadlineMs} ms: ${method} ${path}`));
    }, deadlineMs);
    request.on("error", (error) => { clearTimeout(timer); reject(error); });
    request.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        clearTimeout(timer);
        resolveSend({ status: response.statusCode, headers: response.headers,
          text: Buffer.concat(chunks).toString("utf8") });
      });
    });
    if (body === undefined) request.end();
    else request.end(body);
  });
}

/**
 * The verifier's fetch, delivered as Cloud Run's front end would: the run.app
 * URL to the local listener with the run.app Host, the token's signature
 * replaced. The Response carries the URL the verifier asked for.
 */
function frontEndFetch(port) {
  return async (url, init) => {
    const target = new URL(url);
    assert.equal(target.origin, RUN_APP_ORIGIN);
    const headers = { ...init.headers };
    headers["x-serverless-authorization"] = frontEndToken(headers["x-serverless-authorization"]);
    const answer = await send(port, { method: init.method, path: target.pathname + target.search, headers });
    const response = new Response(answer.text, {
      status: answer.status,
      headers: Object.entries(answer.headers).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value]).map((item) => [name, item])),
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
}

/** Past RD-2's Worker-exact reuse window, so the next read is a fresh evaluation. */
function afterReuseWindow(m) {
  return new Promise((resolveWait) => setTimeout(resolveWait, m.readiness.STATUS_REUSE_MILLISECONDS + 100));
}

function errorOf(answer) {
  try { return JSON.parse(answer.text)?.error ?? null; } catch { return null; }
}

function assertNoStoreMarked(answer, label) {
  assert.equal(answer.headers["cache-control"], "no-store", label);
  assert.equal(answer.headers["x-tibotattle-origin"], "1", `${label}: marked by the boundary`);
}

test("the release verifier: refused on a fresh schema, then passes once the lifecycle pass has run", {
  skip: SKIP, timeout: 300_000,
}, () => withProductionHost(async ({ m, base, port, primarySchema, objectStore }) => {
  const verify = () => verifyEdgeOriginBeforeGcp({
    upstreamOrigin: RUN_APP_ORIGIN, identityToken: identityToken(VERIFIER), fetchImpl: frontEndFetch(port),
  });
  // RD-3 answers ok with the deployment's commit before the first pass.
  const health = await send(port, { path: "/api/health", headers: verifierHeaders() });
  assert.equal(health.status, 200, health.text);
  assertNoStoreMarked(health, "health");
  const healthBody = JSON.parse(health.text);
  assert.deepEqual(m.health.validatePostgresHealthBody(healthBody), []);
  assert.equal(healthBody.status, "ok");
  assert.equal(healthBody.deployment.sourceCommit, COMMIT);
  // OD-CR-5: the two registry-derived flags are false while their routes are unported.
  assert.equal(healthBody.capabilities.participantExport, false);
  assert.equal(healthBody.capabilities.coordinatedSignInAdmission, false);
  // RD-2 is not ready until C-MAINT's pass has written its rows: the verifier
  // refuses the roll.
  const first = await verify();
  assert.equal(first.ok, false);
  // A not-ready 503 fails the verifier's status check.
  assert.deepEqual(first, { ok: false, code: "EDGE_ORIGIN_VERIFIER_INVALID", originCommit: null });
  const notReady = await send(port, { path: "/api/ready", headers: verifierHeaders() });
  assert.equal(notReady.status, 503, notReady.text);
  assertNoStoreMarked(notReady, "ready before the pass");
  // The defined first-roll path: one lifecycle pass (the maintenance job's
  // entry), then the verifier passes.
  const maintenance = m.host.createLifecyclePassMaintenance({ pool: base, objectStore, primarySchema });
  const result = await maintenance.runMaintenance(Date.now());
  assert.equal(result.code, "OK", JSON.stringify(result));
  await afterReuseWindow(m);
  const verified = await verify();
  assert.deepEqual(verified, { ok: true, code: null, originCommit: COMMIT });
}));

test("the storage gate rereads the receipt on every request: drift and a newer schema refuse at once", {
  skip: SKIP, timeout: 300_000,
}, () => withProductionHost(async ({ m, base, t, port, primarySchema, objectStore }) => {
  await m.host.createLifecyclePassMaintenance({ pool: base, objectStore, primarySchema }).runMaintenance(Date.now());
  const ready = async () => {
    await afterReuseWindow(m);
    return send(port, { path: "/api/ready", headers: verifierHeaders() });
  };
  assert.equal((await ready()).status, 200);
  const daily = () => send(port, { path: "/api/v1/community/daily?from=2026-09-01&to=2026-09-02",
    headers: edgeHeaders({ admission: "v1;public_aggregate_read;allowed" }) });
  const healthy = await daily();
  assert.notEqual(errorOf(healthy)?.code, "BACKEND_STORAGE_UNAVAILABLE", healthy.text);
  const history = t("_tibotattle_migration_history");
  const last = await base.query(`SELECT version, checksum_sha256 FROM ${history} ORDER BY version DESC LIMIT 1`);
  const { version, checksum_sha256: checksum } = last.rows[0];
  const refusedNow = async (label) => {
    const answer = await daily();
    assert.equal(answer.status, 503, `${label}: ${answer.text}`);
    assert.equal(errorOf(answer).code, "BACKEND_STORAGE_UNAVAILABLE", label);
    // RD-2 reads the receipt (the Worker-exact readiness); RD-3 health does
    // not, as the Worker's does not.
    const notReady = await ready();
    assert.equal(notReady.status, 503, `${label} ready: ${notReady.text}`);
    assert.equal(errorOf(notReady).code, "BACKEND_STORAGE_UNAVAILABLE", label);
  };
  // A drifted checksum: the very next request refuses (TTL 0, OD-ROLL).
  await base.query(`UPDATE ${history} SET checksum_sha256=$1 WHERE version=$2`, ["0".repeat(64), version]);
  await refusedNow("drifted checksum");
  await base.query(`UPDATE ${history} SET checksum_sha256=$1 WHERE version=$2`, [checksum, version]);
  assert.notEqual(errorOf(await daily())?.code, "BACKEND_STORAGE_UNAVAILABLE", "restored at once");
  assert.equal((await ready()).status, 200, "ready again at once");
  // A newer schema (a later migration applied by the next release) refuses
  // this reader: an older reader never serves newer state.
  await base.query(`INSERT INTO ${history} (version, name, checksum_sha256)
    VALUES ($1, $2, $3)`, [version + 1, `${String(version + 1).padStart(4, "0")}_synthetic_newer.sql`, "f".repeat(64)]);
  await refusedNow("newer schema");
}));

test("round 12: retired routes are the closed 503, the performance authorization its definite 403, the admin host open", {
  skip: SKIP, timeout: 300_000,
}, () => withProductionHost(async ({ port }) => {
  for (const [label, method, path, hostKind, extra] of [
    ["participant export", "GET", "/api/v1/me/export", "apex", {}],
    ["Google sign-in start", "POST", "/api/v1/identity/google/start", "apex", { "content-type": "application/json" }],
    ["Apple sign-in start", "POST", "/api/v1/identity/apple/start", "apex", { "content-type": "application/json" }],
    ["legacy enroll", "POST", "/api/v1/enroll", "apex", { "content-type": "application/json" }],
    ["security reset", "POST", "/api/v1/me/security-reset", "apex", { "content-type": "application/json" }],
    ["performance capabilities", "GET", "/api/v1/device/telemetry/performance/capabilities", "apex", {}],
    ["performance consent", "POST", "/api/v1/me/device-telemetry-performance-consents", "apex",
      { "content-type": "application/json" }],
    ["performance reports", "POST", "/api/v1/device/telemetry/performance/reports", "apex",
      { "content-type": "application/json" }],
  ]) {
    const requestId = randomUUID();
    const answer = await send(port, { method, path, ...(method === "POST" ? { body: "{}" } : {}),
      headers: { ...edgeHeaders({ hostKind, requestId }), ...extra } });
    assert.equal(answer.status, 503, `${label}: ${answer.text}`);
    assert.deepEqual(JSON.parse(answer.text), { error: { code: "POSTGRES_ROUTE_NOT_PORTED", requestId } }, label);
    assert.equal(answer.headers["retry-after"], undefined, `${label}: no retry-after (OD-CR-6 iv)`);
    assertNoStoreMarked(answer, label);
  }
  // The accountless performance authorization: production's definite 403, no retry-after.
  {
    const requestId = randomUUID();
    const answer = await send(port, { method: "POST", path: "/api/v1/accountless/telemetry-performance-authorization",
      body: "{}", headers: { ...edgeHeaders({ requestId, admission: "v1;accountless_ownership;allowed" }),
        "content-type": "application/json", authorization: "Device um_device_synthetic.unknown" } });
    assert.equal(answer.status, 403, answer.text);
    assert.deepEqual(JSON.parse(answer.text), { error: { code: "TELEMETRY_TRANSPORT_BLOCKED", requestId } });
    assert.equal(answer.headers["retry-after"], undefined);
    assertNoStoreMarked(answer, "performance authorization");
  }
  // ADMIN-R12: the admin host runs the Access chokepoint; a forged assertion is the Worker's 403.
  {
    const requestId = randomUUID();
    const answer = await send(port, { method: "GET", path: "/api/v1/admin/overview",
      headers: { ...edgeHeaders({ hostKind: "admin", requestId }), "cf-access-jwt-assertion": "synthetic.access.assertion" } });
    assert.equal(answer.status, 403, answer.text);
    assert.equal(JSON.parse(answer.text).error.code, "ACCESS_REQUIRED");
    assertNoStoreMarked(answer, "admin host");
  }
  // OD-CR-6 (ii), accepted: a query string on a v1.2 POST route or on the
  // upload-authorization route is refused, where the Worker ignores it; (i)
  // the refusal is the Worker envelope under the edge's request id.
  for (const [path, admission, authorization] of [
    ["/api/v1/contributions?synthetic=1", "v1;upload_ingress;allowed",
      `Upload um_device_upload_${randomUUID()}.${"A".repeat(43)}`],
    ["/api/v1/device/upload-authorizations?synthetic=1", undefined, "Device um_device_synthetic.unknown"],
  ]) {
    const requestId = randomUUID();
    const queried = await send(port, { method: "POST", path, body: "{}",
      headers: { ...edgeHeaders({ requestId, ...(admission === undefined ? {} : { admission }) }),
        "content-type": "application/json", authorization } });
    assert.equal(queried.status, 503, `${path}: ${queried.text}`);
    assert.deepEqual(JSON.parse(queried.text), { error: { code: "POSTGRES_TEST_ROUTE_UNSUPPORTED", requestId } }, path);
    assert.equal(queried.headers["retry-after"], undefined, path);
    assertNoStoreMarked(queried, `query string on POST ${path}`);
  }
  // A stranger is EP-6's unmarked 421; so is a request for another host.
  const stranger = await send(port, { path: "/api/health",
    headers: edgeHeaders({ email: "stranger@synthetic-project.iam.gserviceaccount.com" }) });
  assert.equal(stranger.status, 421);
  assert.equal(stranger.headers["x-tibotattle-origin"], undefined);
  const otherHost = await send(port, { path: "/api/health",
    headers: { ...verifierHeaders(), host: "tibotattle.com" } });
  assert.equal(otherHost.status, 421);
  // A Cloud Run revision tag of the service host is the same origin.
  const tagged = await send(port, { path: "/api/health",
    headers: { ...verifierHeaders(), host: `candidate---${RUN_APP_HOST}` } });
  assert.equal(tagged.status, 200, tagged.text);
}));

test("contributions take an ingress lease and release it on a refused body", {
  skip: SKIP, timeout: 300_000,
}, () => withProductionHost(async ({ m, base, t, port }) => {
  const upload = () => send(port, {
    method: "POST", path: "/api/v1/contributions", body: "{}",
    headers: {
      ...edgeHeaders({ admission: "v1;upload_ingress;allowed" }),
      "content-type": "application/json",
      authorization: `Upload um_device_upload_${randomUUID()}.${"A".repeat(43)}`,
    },
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // The body is read under the lease; "{}" is no envelope, so the claim is
    // never reached and the lease is released on the refusal.
    const answer = await upload();
    assert.equal(answer.status, 400, answer.text);
    assert.equal(errorOf(answer).code, "ENVELOPE_INVALID");
  }
  const budgetName = m.ingressBudget.POSTGRES_UPLOAD_INGRESS_BUDGET_NAME;
  const state = await base.query(`SELECT tokens FROM ${t("upload_ingress_budget_states")} WHERE budget_name=$1`,
    [budgetName]);
  assert.equal(state.rows.length, 1, "the lease was taken through the budget");
  const leases = await base.query(`SELECT count(*)::integer AS count FROM ${t("upload_ingress_budget_leases")}`);
  assert.equal(leases.rows[0].count, 0, "every lease was released");
}));

test("log lines: the closed request line and the refusal line, without request content", {
  skip: SKIP, timeout: 300_000,
}, () => withProductionHost(async ({ port, lines }) => {
  const consoleLines = [];
  const spy = mock.method(console, "log", (...args) => { consoleLines.push(args.join(" ")); });
  try {
    const requestId = randomUUID();
    const refused = await send(port, {
      path: `/api/v1/me/export?marker=${INJECTED.query}`,
      headers: { ...edgeHeaders({ requestId }), "x-forwarded-for": INJECTED.address,
        cookie: `theme=${INJECTED.cookie}` },
    });
    assert.equal(refused.status, 503);
    const stranger = await send(port, { path: `/api/health?marker=${INJECTED.query}`,
      headers: { ...edgeHeaders({ email: "stranger@synthetic-project.iam.gserviceaccount.com" }),
        "x-forwarded-for": INJECTED.address } });
    assert.equal(stranger.status, 421);
  } finally {
    spy.mock.restore();
  }
  assert.ok(lines.length >= 1, "the unported answer wrote its request line");
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.deepEqual(Object.keys(parsed), LOG_KEYS, line);
  }
  const refusal = consoleLines.map((line) => JSON.parse(line))
    .filter((line) => line.event === "edge_origin_boundary_refusal");
  assert.equal(refusal.length, 1, consoleLines.join("\n"));
  for (const line of [...lines, ...consoleLines]) {
    for (const value of Object.values(INJECTED)) assert.ok(!line.includes(value), `no ${value} in ${line}`);
    assert.ok(!line.includes("stranger@"), `no account in ${line}`);
  }
}));

test("RD-2's reader refuses a missing or wrong typed pin and a missing or malformed lifecycle row: 503 BACKEND_STORAGE_UNAVAILABLE", {
  skip: SKIP, timeout: 300_000,
}, () => withProductionHost(async ({ m, base, t, port, primarySchema, objectStore }) => {
  await m.host.createLifecyclePassMaintenance({ pool: base, objectStore, primarySchema }).runMaintenance(Date.now());
  const ready = async () => {
    await afterReuseWindow(m);
    return send(port, { path: "/api/ready", headers: verifierHeaders() });
  };
  assert.equal((await ready()).status, 200, "ready once the pass has run");
  const other = await base.query(`INSERT INTO ${t("typed_telemetry_namespaces")} (original_id)
    VALUES ($1) RETURNING id`, [Buffer.from(m.codec.encodeTypedTelemetryId("synthetic-other-namespace"))]);
  const otherNamespaceId = other.rows[0].id;
  // Each case replaces one singleton row and then puts the saved row back:
  // a DELETE, then an INSERT of the row as JSON (the v1.1 pin's 0060 guard
  // covers UPDATE only, and the 0033 and 0049 CHECKs still apply).
  const saved = async (table, key) => (await base.query(
    `SELECT to_jsonb(saved) AS row FROM ${t(table)} saved WHERE ${key} = 1`)).rows[0].row;
  const replace = async (table, key, row) => {
    await base.query(`DELETE FROM ${t(table)} WHERE ${key} = 1`);
    if (row !== null) {
      await base.query(`INSERT INTO ${t(table)} SELECT * FROM jsonb_populate_record(NULL::${t(table)}, $1::jsonb)`,
        [JSON.stringify(row)]);
    }
  };
  const cases = [];
  for (const [family, table] of [["v1", "typed_v1_admission_state"], ["v1.1", "typed_v11_admission_state"]]) {
    cases.push([`the ${family} pin deleted`, table, "id", () => null]);
    cases.push([`the ${family} pin naming another namespace`, table, "id",
      (row) => ({ ...row, source_namespace: "synthetic-other-namespace" })]);
    // 0033 admits runtime contract versions 0 and 1 only; the reader requires 1.
    cases.push([`the ${family} pin at runtime contract version 0`, table, "id",
      (row) => ({ ...row, runtime_contract_version: 0 })]);
    cases.push([`the ${family} pin joined to another namespace's original id`, table, "id",
      (row) => ({ ...row, namespace_id: otherNamespaceId })]);
  }
  cases.push(["the retention row deleted", "retention_state", "singleton", () => null]);
  cases.push(["the reconciliation row deleted", "quarantine_reconciliation_state", "singleton", () => null]);
  // Values the 0049 CHECKs admit and the closed readers refuse (StateShapeError).
  cases.push(["a retention counter beyond the reader's bound", "retention_state", "singleton",
    (row) => ({ ...row, quarantine_objects_deleted: "10000000000000000" })]);
  cases.push(["a reconciliation counter beyond the reader's bound", "quarantine_reconciliation_state", "singleton",
    (row) => ({ ...row, registrations_examined: "10000000000000000" })]);
  for (const [label, table, key, change] of cases) {
    const original = await saved(table, key);
    await replace(table, key, change(original));
    try {
      const answer = await ready();
      assert.equal(answer.status, 503, `${label}: ${answer.text}`);
      // The reader's refusal, not the builder's not_ready body.
      assert.equal(errorOf(answer)?.code, "BACKEND_STORAGE_UNAVAILABLE", `${label}: ${answer.text}`);
      assertNoStoreMarked(answer, label);
    } finally {
      await replace(table, key, original);
    }
    assert.equal((await ready()).status, 200, `${label}: ready again once the row is restored`);
  }
}));

test("run_maintenance through the admin action: a refused or skipped pass is a failure audit and the Worker's error", {
  skip: SKIP, timeout: 300_000,
}, () => withProductionHost(async ({ m, base, t, primarySchema, objectStore }) => {
  const adminOrigin = "https://admin.synthetic.example";
  const contexts = new WeakMap();
  const handlers = m.adminConsole.createAdminConsoleHandlers({
    requestContext: (request) => contexts.get(request),
    env: Object.freeze({ ENVIRONMENT: "production", TELEMETRY_STORAGE_NAMESPACE: NAMESPACE }),
    pools: { primary: base },
    schemaOptions: { primarySchema },
    maintenance: m.host.createLifecyclePassMaintenance({ pool: base, objectStore, primarySchema }),
  });
  const audits = async () => (await base.query(`SELECT action, outcome, details_json::jsonb AS details
      FROM ${t("admin_action_audit")} ORDER BY id`)).rows;
  const run = async (label, status) => {
    const before = (await audits()).length;
    const requestId = randomUUID();
    const request = new Request(`${adminOrigin}/api/v1/admin/action`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: adminOrigin, "sec-fetch-site": "same-origin",
        "x-usage-monitor-admin": "1" },
      body: JSON.stringify({ action: "run_maintenance" }),
    });
    contexts.set(request, Object.freeze({ requestId, routeId: "admin_action",
      adminIdentityKey: "owner@synthetic.example" }));
    const response = await handlers.get("admin_action")(request);
    const body = await response.json();
    assert.equal(response.status, status, `${label}: ${JSON.stringify(body)}`);
    assert.equal(response.headers.get("retry-after"), null, label);
    const added = (await audits()).slice(before);
    assert.equal(added.length, 1, `${label}: one audit row`);
    assert.equal(added[0].action, "run_maintenance", label);
    return { body, audit: added[0], requestId };
  };
  const refused = async (label, status, code) => {
    const { body, audit, requestId } = await run(label, status);
    assert.deepEqual(body, { error: { code, requestId } }, label);
    assert.equal(audit.outcome, "failure", `${label}: never a success audit`);
    assert.deepEqual(audit.details, { code }, label);
  };

  // A complete pass: 200 with the Worker's OK and a success audit.
  const complete = await run("complete", 200);
  assert.equal(complete.body.result.code, "OK");
  assert.equal(complete.audit.outcome, "success");
  assert.equal(complete.audit.details.code, "OK");
  assert.equal(complete.audit.details.lifecycleComplete, true);

  // Refused, POSTGRES_SCHEMA_RECEIPT_MISMATCH: 503 BACKEND_STORAGE_UNAVAILABLE.
  const history = t("_tibotattle_migration_history");
  const last = (await base.query(`SELECT version, checksum_sha256 FROM ${history} ORDER BY version DESC LIMIT 1`)).rows[0];
  await base.query(`UPDATE ${history} SET checksum_sha256=$1 WHERE version=$2`, ["0".repeat(64), last.version]);
  try {
    await refused("refused: a drifted receipt", 503, "BACKEND_STORAGE_UNAVAILABLE");
  } finally {
    await base.query(`UPDATE ${history} SET checksum_sha256=$1 WHERE version=$2`, [last.checksum_sha256, last.version]);
  }

  // Refused, LIFECYCLE_LEASE_CONFLICT: 503 LIFECYCLE_STATE_CONFLICT.
  await base.query(`UPDATE ${t("retention_state")}
      SET lease_id='synthetic-foreign-lease', lease_expires_at=now() + interval '1 hour' WHERE singleton=1`);
  try {
    await refused("refused: a lease the pass does not own", 503, "LIFECYCLE_STATE_CONFLICT");
  } finally {
    await base.query(`UPDATE ${t("retention_state")} SET lease_id=NULL, lease_expires_at=NULL WHERE singleton=1`);
  }

  // Skipped, MAINTENANCE_IN_PROGRESS: the Worker's 409 LIFECYCLE_STATE_CONFLICT.
  const holder = await base.connect();
  try {
    await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))",
      [m.lifecyclePass.POSTGRES_LIFECYCLE_PASS_LOCK_DOMAIN]);
    await refused("skipped: the maintenance lock held elsewhere", 409, "LIFECYCLE_STATE_CONFLICT");
  } finally {
    await holder.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))",
      [m.lifecyclePass.POSTGRES_LIFECYCLE_PASS_LOCK_DOMAIN]).catch(() => undefined);
    holder.release();
  }

  // Everything restored: the next run succeeds again.
  const again = await run("restored", 200);
  assert.equal(again.body.result.code, "OK");
  assert.equal(again.audit.outcome, "success");
}));

test("admin run_maintenance reports and audits the folded purges under the Worker's keys", {
  skip: SKIP, timeout: 300_000,
}, () => withProductionHost(async ({ base, t, primarySchema, objectStore, m }) => {
  const adminConsole = await vite.ssrLoadModule("/cloud-run/routes/admin-console.mjs");
  const adminAction = await vite.ssrLoadModule("/cloud-run/routes/admin-action.mjs");
  const { createRequestContextStore } = await vite.ssrLoadModule("/cloud-run/postgres-request-context.mjs");
  const owner = "owner@synthetic.example";
  const adminOrigin = "https://admin.synthetic.example";
  const now = Date.now();
  // Two admin cycles in the past, so the pass's completion clock (the real
  // clock) is never before its cycle.
  const firstAt = now - 2 * 60_000;
  const secondAt = now - 60_000;
  let adminNow = firstAt;

  // Synthetic, content-free rows past each cutoff: two expired handoffs per
  // provider, one sign-in window past the 24 h retention, and one unused
  // pairing more than the device-lifecycle page of 250.
  const expired = new Date(now - 10 * 60_000).toISOString();
  const issued = new Date(now - 20 * 60_000).toISOString();
  const states = [randomUUID(), randomUUID()].map((id) => `synthetic-admin-maint-${id}`);
  await base.query(`INSERT INTO ${t("apple_signin_handoffs")} (state, nonce_hash, created_at, expires_at)
    SELECT seed.state, $2, $3::timestamptz, $4::timestamptz FROM unnest($1::text[]) AS seed(state)`,
  [states, "a".repeat(64), issued, expired]);
  await base.query(`INSERT INTO ${t("google_signin_handoffs")} (state, created_at, expires_at)
    SELECT seed.state, $2::timestamptz, $3::timestamptz FROM unnest($1::text[]) AS seed(state)`,
  [states, issued, expired]);
  const agedWindow = new Date(now - 25 * 60 * 60_000).toISOString();
  await base.query(`INSERT INTO ${t("sign_in_start_admission_windows")}
      (window_started_at, accepted_count, last_accepted_at)
    VALUES ($1::timestamptz, 1, $1::timestamptz)`, [agedWindow]);
  const participant = `synthetic-admin-maint-participant-${randomUUID()}`;
  const session = `synthetic-admin-maint-session-${randomUUID()}`;
  await base.query(`INSERT INTO ${t("participants")} (id, owner_kind, state, created_at)
    VALUES ($1, 'social', 'active', $2::timestamptz)`, [participant, issued]);
  await base.query(`INSERT INTO ${t("web_sessions")}
      (id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at)
    VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $5::timestamptz)`,
  [session, participant, randomBytes(32), randomBytes(32), issued, new Date(now + 60 * 60_000).toISOString()]);
  const pairings = Array.from({ length: 251 }, () => `synthetic-admin-maint-pairing-${randomUUID()}`);
  await base.query(`INSERT INTO ${t("device_pairings")} (
      id, participant_id, issued_by_session_id, secret_hash, consent_version,
      transport_consent_version, state, issued_at, expires_at)
    SELECT seed.id, $2, $3, seed.secret, 'privacy-safe-telemetry-v0.1', 'privacy-safe-telemetry-v0.1',
      'unused', $4::timestamptz, $5::timestamptz
      FROM unnest($1::text[], $6::bytea[]) AS seed(id, secret)`,
  [pairings, participant, session, issued, expired, pairings.map(() => randomBytes(32))]);

  const store = createRequestContextStore();
  const handlers = adminConsole.createAdminConsoleHandlers({
    requestContext: store.accessor,
    clock: () => adminNow,
    env: Object.freeze({ ENVIRONMENT: "production", TELEMETRY_STORAGE_NAMESPACE: NAMESPACE }),
    pools: { primary: base },
    schemaOptions: { primarySchema },
    maintenance: m.host.createLifecyclePassMaintenance({ pool: base, objectStore, primarySchema }),
  });
  const runMaintenance = async () => {
    const response = await store.dispatch(new Request(`${adminOrigin}/api/v1/admin/action`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: adminOrigin, "x-usage-monitor-admin": "1" },
      body: JSON.stringify({ action: "run_maintenance" }),
    }), { requestId: randomUUID(), routeId: "admin_action", adminIdentityKey: owner },
    handlers.get("admin_action"));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.schemaVersion, "admin-action-v0.1");
    assert.equal(body.action, "run_maintenance");
    const audit = await base.query(`SELECT outcome, details_json FROM ${t("admin_action_audit")}
      WHERE action = 'run_maintenance' ORDER BY id DESC LIMIT 1`);
    assert.equal(audit.rows[0].outcome, "success");
    return { result: body.result, details: JSON.parse(audit.rows[0].details_json) };
  };
  const countRows = async () => (await base.query(`SELECT
      (SELECT count(*) FROM ${t("apple_signin_handoffs")})::int AS apple,
      (SELECT count(*) FROM ${t("google_signin_handoffs")})::int AS google,
      (SELECT count(*) FROM ${t("sign_in_start_admission_windows")})::int AS windows,
      (SELECT count(*) FROM ${t("device_pairings")} WHERE state = 'unused')::int AS unused`)).rows[0];

  // The first run purges and reports each part under the Worker's keys, in
  // the Worker's order. The device-lifecycle backlog (one pairing beyond the
  // page) does not enter the Worker's completeness: the code stays OK.
  const first = await runMaintenance();
  assert.deepEqual(first.result, {
    code: "OK",
    lifecycleComplete: true,
    quarantineRetentionComplete: true,
    restoreReplayComplete: true,
    quarantineReconciliationComplete: true,
    expiredIdentityHandoffsPurged: 4,
    expiredIdentityHandoffPurgeComplete: true,
    expiredDeletionTombstonesPurged: 0,
    deletionTombstonePurgeComplete: true,
    expiredPrimaryIdentityReenrollmentCooldownsPurged: 0,
    primaryIdentityReenrollmentCooldownPurgeComplete: true,
    expiredIdentityReenrollmentCooldownsPurged: 0,
    identityReenrollmentCooldownPurgeComplete: true,
    expiredSignInAdmissionsPurged: 1,
    signInAdmissionPurgeComplete: true,
    staleDevicePairingsRevoked: 250,
    staleDeviceCredentialsRevoked: 0,
    staleDeviceUploadAuthorizationsRevoked: 0,
    expiredDeviceCredentialRotationsPurged: 0,
    expiredDevicePairingEventsPurged: 0,
    aggregateRebuildComplete: false,
    aggregateRebuildDelegated: true,
    publicationEnabled: null,
  });
  assert.deepEqual(Object.keys(first.result).slice(0, 7), ["code", "lifecycleComplete",
    "quarantineRetentionComplete", "restoreReplayComplete", "quarantineReconciliationComplete",
    "expiredIdentityHandoffsPurged", "expiredIdentityHandoffPurgeComplete"], "the Worker's key order");
  // The success audit records every Worker audit field, the purge among them.
  assert.deepEqual(Object.keys(first.details), [...adminAction.RUN_MAINTENANCE_AUDIT_FIELDS]);
  assert.equal(first.details.code, "OK");
  assert.equal(first.details.expiredIdentityHandoffsPurged, 4);
  assert.equal(first.details.expiredIdentityHandoffPurgeComplete, true);
  assert.deepEqual(await countRows(), { apple: 0, google: 0, windows: 0, unused: 1 });

  // The same minute is the cycle already complete: no purge ran, so the purge
  // keys are absent from the result and the audit, never reported as done.
  const repeat = await runMaintenance();
  assert.equal(repeat.result.code, "OK");
  for (const key of ["expiredIdentityHandoffsPurged", "expiredIdentityHandoffPurgeComplete",
    "expiredSignInAdmissionsPurged", "signInAdmissionPurgeComplete", "staleDevicePairingsRevoked"]) {
    assert.equal(Object.hasOwn(repeat.result, key), false, key);
    assert.equal(Object.hasOwn(repeat.details, key), false, key);
  }
  assert.deepEqual(await countRows(), { apple: 0, google: 0, windows: 0, unused: 1 });

  // The next cycle drains the device backlog.
  adminNow = secondAt;
  const next = await runMaintenance();
  assert.equal(next.result.code, "OK");
  assert.equal(next.result.expiredIdentityHandoffsPurged, 0);
  assert.equal(next.result.expiredIdentityHandoffPurgeComplete, true);
  assert.equal(next.result.staleDevicePairingsRevoked, 1);
  assert.equal(next.details.expiredIdentityHandoffsPurged, 0);
  assert.deepEqual(await countRows(), { apple: 0, google: 0, windows: 0, unused: 0 });
  assert.doesNotMatch(JSON.stringify([first, repeat, next]), /synthetic-admin-maint|owner@/u, "content-free");
}));
