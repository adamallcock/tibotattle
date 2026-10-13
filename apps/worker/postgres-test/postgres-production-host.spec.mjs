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
// folded purges under the Worker's keys (MAINT-PURGE); and the restored
// performance intake (owner decision 2026-10-10, decision 1) answers the
// Worker's sequence for a really enrolled accountless device: 403
// TELEMETRY_TRANSPORT_BLOCKED on the grant, capabilities and report upload
// while the runtime is staged (counted, never granted, never a 5xx), then,
// after the owner-only activation task (SPD-G5) runs through the admin
// action, a 201 grant and a 200 capability; and (FIX-FUTURE-V12) the
// released desktop client meets a v1.2 day after the server's UTC day plus
// one as a paced 429 that its scheduler waits out without pausing, then
// resumes from its kept journal once the day is admissible.
import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import http from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { verifyEdgeOriginBeforeGcp } from "../scripts/production-edge-mode.mjs";
import {
  canonicalTelemetryV12Json,
  telemetryV12DayManifestDigestInput,
  telemetryV12RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";
import { runTelemetryV12Sync } from "../test/helpers/contribution-v12-runner.js";
import { createTelemetryV12Envelope } from "../../../src/platform/telemetry-v12-envelope.js";
import { createAccountlessContributionScheduler } from "../../../src/application/accountless-contribution-scheduler.js";

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
function identityToken(email, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
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

function edgeHeaders({ email = INVOKER, hostKind = "apex", admission = null, requestId = randomUUID(),
  tokenNowMs = Date.now() } = {}) {
  return {
    "x-serverless-authorization": frontEndToken(`Bearer ${identityToken(email, tokenNowMs)}`),
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

test("round 12: retired routes are the closed 503, the performance intake served (decision 1), the admin host open", {
  skip: SKIP, timeout: 300_000,
}, () => withProductionHost(async ({ port }) => {
  for (const [label, method, path, hostKind, extra] of [
    ["participant export", "GET", "/api/v1/me/export", "apex", {}],
    ["Google sign-in start", "POST", "/api/v1/identity/google/start", "apex", { "content-type": "application/json" }],
    ["Apple sign-in start", "POST", "/api/v1/identity/apple/start", "apex", { "content-type": "application/json" }],
    ["legacy enroll", "POST", "/api/v1/enroll", "apex", { "content-type": "application/json" }],
    ["security reset", "POST", "/api/v1/me/security-reset", "apex", { "content-type": "application/json" }],
    ["performance consent", "POST", "/api/v1/me/device-telemetry-performance-consents", "apex",
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
  // The restored performance intake (decision 1): never the uniform 503. An
  // unknown bearer is the Worker's 401 DEVICE_AUTH_INVALID on all three
  // routes (S4 parity: no storage or runtime 5xx comes first; the whole
  // sequence is the next test).
  for (const [method, path, admission] of [
    ["POST", "/api/v1/accountless/telemetry-performance-authorization", "v1;accountless_ownership;allowed"],
    ["GET", "/api/v1/device/telemetry/performance/capabilities", "v1;device_sync;allowed"],
    ["GET", "/api/v1/device/telemetry/performance/reports", "v1;device_sync;allowed"],
    ["POST", "/api/v1/device/telemetry/performance/reports", "v1;device_sync;allowed"],
  ]) {
    const requestId = randomUUID();
    const answer = await send(port, { method, path, ...(method === "POST" ? { body: "{}" } : {}),
      headers: { ...edgeHeaders({ requestId, admission }),
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        authorization: "Device um_device_synthetic.unknown" } });
    assert.equal(answer.status, 401, `${method} ${path}: ${answer.text}`);
    assert.deepEqual(JSON.parse(answer.text), { error: { code: "DEVICE_AUTH_INVALID", requestId } }, path);
    assert.equal(answer.headers["retry-after"], undefined, path);
    assertNoStoreMarked(answer, `${method} ${path}`);
  }
  // The owner-decided public read (2026-10-10): before the first
  // publication every slot is the Worker's 404, no-store, never a 5xx.
  for (const query of ["?period=7&speedMode=fast", "?speedMode=ultrafast&period=all"]) {
    const requestId = randomUUID();
    const answer = await send(port, { method: "GET", path: `/api/v1/community/model-performance${query}`,
      headers: edgeHeaders({ requestId, admission: "v1;public_aggregate_read;allowed" }) });
    assert.equal(answer.status, 404, `${query}: ${answer.text}`);
    assert.deepEqual(JSON.parse(answer.text),
      { error: { code: "COMMUNITY_MODEL_PERFORMANCE_UNPUBLISHED", requestId } }, query);
    assertNoStoreMarked(answer, `model-performance ${query}`);
  }
  {
    const requestId = randomUUID();
    const refused = await send(port, { method: "GET", path: "/api/v1/community/model-performance?period=14",
      headers: edgeHeaders({ requestId, admission: "v1;public_aggregate_read;allowed" }) });
    assert.equal(refused.status, 400, refused.text);
    assert.deepEqual(JSON.parse(refused.text), { error: { code: "BODY_INVALID", requestId } });
    assertNoStoreMarked(refused, "model-performance bad slot");
  }
  // ADMIN-R12: the admin host runs the Access chokepoint; a forged assertion is the Worker's 403.
  for (const path of ["/api/v1/admin/overview", "/api/v1/admin/performance-intake"]) {
    const requestId = randomUUID();
    const answer = await send(port, { method: "GET", path,
      headers: { ...edgeHeaders({ hostKind: "admin", requestId }), "cf-access-jwt-assertion": "synthetic.access.assertion" } });
    assert.equal(answer.status, 403, answer.text);
    assert.equal(JSON.parse(answer.text).error.code, "ACCESS_REQUIRED");
    assertNoStoreMarked(answer, `admin host ${path}`);
  }
  // The admin view is never served on the apex.
  {
    const answer = await send(port, { method: "GET", path: "/api/v1/admin/performance-intake",
      headers: edgeHeaders({ requestId: randomUUID() }) });
    assert.equal(answer.status, 404, answer.text);
    assert.equal(JSON.parse(answer.text).error.code, "NOT_FOUND");
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

/** src/device-auth.ts deviceHash: the stored hash of an enrolled bearer's secret. */
function deviceSecretHash(deviceId, secret) {
  return createHash("sha256").update(`app-usagemonitor/device/v1\0${deviceId}\0`).update(secret).digest();
}

test("decision 1: the performance intake answers the Worker's sequence for a real accountless device, 403 while staged", {
  skip: SKIP, timeout: 300_000,
}, () => withProductionHost(async ({ m, base, t, port, primarySchema, objectStore }) => {
  const PATH = "/api/v1/accountless/telemetry-performance-authorization";
  const CAPABILITIES = "/api/v1/device/telemetry/performance/capabilities";
  const REPORTS = "/api/v1/device/telemetry/performance/reports";
  const validBody = JSON.stringify({ schemaVersion: "accountless-performance-owner-v1",
    policyVersion: "accountless-telemetry-performance-policy-v1", authorizationBasis: "accountless-performance-policy-v1" });
  // A shipped accountless installation enrolls and binds its owner through
  // the same origin, as Electron does.
  const deviceId = randomUUID();
  const secret = randomBytes(32);
  const bearer = `Device um_device_${deviceId}.${secret.toString("base64url")}`;
  const enrolled = await send(port, { method: "POST", path: "/api/v1/accountless/enrollment",
    headers: { ...edgeHeaders({ admission: "v1;enrollment;allowed" }), "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: "accountless-enrollment-v0.1", deviceId,
      deviceSecretHash: deviceSecretHash(deviceId, secret).toString("hex"),
      policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1" }) });
  assert.equal(enrolled.status, 201, enrolled.text);
  const owned = await send(port, { method: "POST", path: "/api/v1/accountless/ownership",
    headers: { ...edgeHeaders({ admission: "v1;accountless_ownership;allowed" }), "content-type": "application/json",
      authorization: bearer },
    body: JSON.stringify({ schemaVersion: "accountless-upload-owner-v0.1", policyVersion: "accountless-opt-out-v1",
      authorizationBasis: "accountless-policy-v1", telemetrySchemaVersion: "telemetry-contribution-v1.1" }) });
  assert.equal(owned.status, 201, owned.text);
  const usedBefore = (await base.query(`SELECT last_used_at FROM ${t("device_credentials")} WHERE id = $1`,
    [deviceId])).rows[0].last_used_at;

  const exchange = async ({ method = "POST", path = PATH, admission = "v1;accountless_ownership;allowed",
    authorization = bearer, cookie, contentType = "application/json", body = validBody } = {}) => {
    const requestId = randomUUID();
    const answer = await send(port, { method, path, ...(method === "POST" ? { body } : {}),
      headers: { ...edgeHeaders({ requestId, admission }), ...(authorization === null ? {} : { authorization }),
        ...(cookie === undefined ? {} : { cookie }),
        ...(contentType === null || method !== "POST" ? {} : { "content-type": contentType }) } });
    assertNoStoreMarked(answer, `${answer.status} ${answer.text}`);
    return { answer, requestId };
  };
  const ask = async (options) => {
    const { answer, requestId } = await exchange(options);
    assert.equal(JSON.parse(answer.text).error.requestId, requestId);
    return { status: answer.status, code: errorOf(answer)?.code, retryAfter: answer.headers["retry-after"] ?? null };
  };
  const device = (method, path, options = {}) => ask({ method, path, admission: "v1;device_sync;allowed",
    ...(method === "POST" ? {} : { body: undefined }), ...options });
  const blocked = { status: 403, code: "TELEMETRY_TRANSPORT_BLOCKED", retryAfter: null };
  // Every check passes while the runtime is staged (0079's seed): G2's staged
  // answer, no retry-after, nothing written.
  assert.deepEqual(await ask(), blocked);
  // Like the Worker's authenticateDevice, the accepted bearer was used.
  const usedAfter = (await base.query(`SELECT last_used_at FROM ${t("device_credentials")} WHERE id = $1`,
    [deviceId])).rows[0].last_used_at;
  assert.ok(new Date(usedAfter).getTime() > new Date(usedBefore ?? 0).getTime(), "last_used_at moved");
  // Step 1: a session cookie, whatever follows.
  assert.deepEqual(await ask({ cookie: "__Host-usage_monitor_session=synthetic", admission: "v1;accountless_ownership;limited",
    authorization: null, body: "x" }), { status: 401, code: "AUTH_INVALID", retryAfter: null });
  // Step 6: the edge's limited or unavailable outcome, replayed before the bearer.
  assert.deepEqual(await ask({ admission: "v1;accountless_ownership;limited", authorization: "Device um_device_x.y" }),
    { status: 429, code: "ATTEMPT_LIMIT_REACHED", retryAfter: "60" });
  assert.deepEqual(await ask({ admission: "v1;accountless_ownership;unavailable" }),
    { status: 503, code: "ADMISSION_RATE_LIMIT_UNAVAILABLE", retryAfter: "60" });
  // Step 7: an unknown or malformed bearer, before the body.
  for (const authorization of [`Device um_device_${randomUUID()}.${randomBytes(32).toString("base64url")}`,
    `Device um_device_${deviceId}.${randomBytes(32).toString("base64url")}`, "Device not-a-bearer", null]) {
    assert.deepEqual(await ask({ authorization, contentType: "text/plain", body: "x" }),
      { status: 401, code: "DEVICE_AUTH_INVALID", retryAfter: null }, String(authorization));
  }
  // Steps 10 and 11: the body, after authentication.
  assert.deepEqual(await ask({ contentType: "text/plain" }), { status: 415, code: "CONTENT_TYPE_INVALID", retryAfter: null });
  for (const body of ["{}", "{", JSON.stringify({ ...JSON.parse(validBody), extra: true })]) {
    assert.deepEqual(await ask({ body }), { status: 400, code: "BODY_INVALID", retryAfter: null }, body);
  }
  // Step 5: upload registration paused, before the limiter and the bearer.
  await base.query(`UPDATE ${t("collection_controls")}
      SET revision = revision + 1, control_state = 'degraded', upload_registration_enabled = false, updated_at = $1
    WHERE singleton = 1`, [new Date().toISOString()]);
  assert.deepEqual(await ask({ admission: "v1;accountless_ownership;limited" }),
    { status: 503, code: "UPLOAD_REGISTRATION_DISABLED", retryAfter: null });
  await base.query(`UPDATE ${t("collection_controls")}
      SET revision = revision + 1, control_state = 'operational', upload_registration_enabled = true, updated_at = $1
    WHERE singleton = 1`, [new Date().toISOString()]);
  // The device routes for the same device while staged: capabilities 403,
  // the report read 200 (nothing stored), a well-formed report upload 403
  // before any decryption, a cookie or an unknown bearer the neutral 401.
  assert.deepEqual(await device("GET", CAPABILITIES), blocked);
  {
    const { answer } = await exchange({ method: "GET", path: REPORTS, admission: "v1;device_sync;allowed" });
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(JSON.parse(answer.text), { schemaVersion: "telemetry-performance-read-v1",
      population: "reported_samples", reports: [] });
  }
  const envelope = JSON.stringify({ schemaVersion: "telemetry-performance-envelope-v1", synthetic: false, keyId: KEY_ID,
    wrappedKey: "A".repeat(342), iv: "A".repeat(16), ciphertext: "A".repeat(32) });
  assert.deepEqual(await device("POST", REPORTS, { body: envelope }), blocked);
  assert.deepEqual(await device("POST", REPORTS, { body: "{}" }), { status: 400, code: "ENVELOPE_INVALID", retryAfter: null });
  assert.deepEqual(await device("GET", CAPABILITIES, { cookie: "theme=dark" }),
    { status: 401, code: "DEVICE_AUTH_INVALID", retryAfter: null });
  assert.deepEqual(await device("GET", CAPABILITIES, { authorization: "Device not-a-bearer" }),
    { status: 401, code: "DEVICE_AUTH_INVALID", retryAfter: null });
  // Nothing was granted. Primary 0079 created the performance intake tables
  // and publication heads; the runtime is still staged at its seeded
  // revision, and no grant, capability, report or receipt names this device.
  const performanceTables = await base.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = $1 AND table_name LIKE '%performance%'`, [primarySchema]);
  assert.deepEqual(performanceTables.rows.map((row) => row.table_name).sort(), [
    "accountless_telemetry_performance_authorizations",
    "analytics_v2_published_performance",
    "telemetry_performance_buckets",
    "telemetry_performance_cohorts",
    "telemetry_performance_device_capabilities",
    "telemetry_performance_field_dictionaries",
    "telemetry_performance_receipts",
    "telemetry_performance_refusal_counts",
    "telemetry_performance_reports",
    "telemetry_performance_runtime",
  ]);
  assert.deepEqual((await base.query(`SELECT state, policy_revision FROM ${t("telemetry_performance_runtime")}`)).rows,
    [{ state: "staged", policy_revision: 1 }]);
  for (const table of ["accountless_telemetry_performance_authorizations", "telemetry_performance_device_capabilities",
    "telemetry_performance_reports", "telemetry_performance_receipts", "analytics_v2_published_performance"]) {
    assert.equal((await base.query(`SELECT count(*)::int AS n FROM ${t(table)}`)).rows[0].n, 0, table);
  }
  // Every refusal after authentication is counted (content-free: day, route,
  // code, status); none before it (the cookie, limiter, control and bearer).
  const counts = (await base.query(`SELECT route_id, code, status, refusals::int AS refusals
      FROM ${t("telemetry_performance_refusal_counts")} ORDER BY route_id, code, status`)).rows;
  assert.deepEqual(counts, [
    { route_id: "accountless_telemetry_performance_authorization", code: "BODY_INVALID", status: 400, refusals: 3 },
    { route_id: "accountless_telemetry_performance_authorization", code: "CONTENT_TYPE_INVALID", status: 415, refusals: 1 },
    { route_id: "accountless_telemetry_performance_authorization", code: "TELEMETRY_TRANSPORT_BLOCKED", status: 403,
      refusals: 1 },
    { route_id: "telemetry_performance_capabilities", code: "TELEMETRY_TRANSPORT_BLOCKED", status: 403, refusals: 1 },
    { route_id: "telemetry_performance_reports", code: "ENVELOPE_INVALID", status: 400, refusals: 1 },
    { route_id: "telemetry_performance_reports", code: "TELEMETRY_TRANSPORT_BLOCKED", status: 403, refusals: 1 },
  ]);

  // The owner-only activation (decision 2) through the composed admin task
  // (createPostgresOwnerMaintenance: SPD-G5 with this image's commit and the
  // runtime migration manifest), then the same device is granted.
  const schemaModule = await vite.ssrLoadModule("/src/postgres-runtime-schema.ts");
  const activationModule = await vite.ssrLoadModule("/src/postgres-telemetry-runtime-activation.ts");
  const historySha256 = await activationModule.postgresRuntimeMigrationHistorySha256(
    schemaModule.POSTGRES_RUNTIME_MIGRATIONS.primary);
  const adminOrigin = "https://admin.synthetic.example";
  const contexts = new WeakMap();
  const handlers = m.adminConsole.createAdminConsoleHandlers({
    requestContext: (request) => contexts.get(request),
    env: Object.freeze({ ENVIRONMENT: "production", TELEMETRY_STORAGE_NAMESPACE: NAMESPACE }),
    pools: { primary: base },
    schemaOptions: { primarySchema },
    maintenance: m.host.createPostgresOwnerMaintenance({ pool: base, objectStore, primarySchema, sourceCommit: COMMIT }),
  });
  const activation = new Request(`${adminOrigin}/api/v1/admin/action`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: adminOrigin, "sec-fetch-site": "same-origin",
      "x-usage-monitor-admin": "1" },
    body: JSON.stringify({ action: "run_maintenance", telemetryRuntimeActivation: {
      confirmation: "activate_telemetry_performance_runtime",
      deployment: { historySha256, sourceCommit: COMMIT },
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      target: "performance",
    } }),
  });
  contexts.set(activation, Object.freeze({ requestId: randomUUID(), routeId: "admin_action",
    adminIdentityKey: "owner@synthetic.example" }));
  const activated = await handlers.get("admin_action")(activation);
  const activatedBody = await activated.json();
  assert.equal(activated.status, 200, JSON.stringify(activatedBody));
  assert.equal(activatedBody.result.state, "active");
  assert.deepEqual((await base.query(`SELECT state, policy_revision FROM ${t("telemetry_performance_runtime")}`)).rows,
    [{ state: "active", policy_revision: 2 }]);
  // The composed read-only admin view (owner decision 2026-10-10, GATE-Q 4
  // and 23) reads the same runtime over the primary pool, with this image's
  // migration history and the performance routes' classes.
  {
    const intake = new Request(`${adminOrigin}/api/v1/admin/performance-intake`);
    contexts.set(intake, Object.freeze({ requestId: randomUUID(), routeId: "admin_performance_intake",
      adminIdentityKey: "owner@synthetic.example" }));
    const answer = await handlers.get("admin_performance_intake")(intake);
    const body = await answer.json();
    assert.equal(answer.status, 200, JSON.stringify(body));
    assert.equal(answer.headers.get("cache-control"), "no-store");
    assert.equal(body.schemaVersion, "admin-performance-intake-v0.1");
    assert.equal(body.runtime.state, "active");
    assert.equal(body.runtime.policyRevision, 2);
    assert.deepEqual(body.deployment, { sourceCommit: null, historySha256 });
    assert.deepEqual(body.routes, [
      { routeId: "accountless_telemetry_performance_authorization", routeClass: "performance" },
      { routeId: "admin_performance_intake", routeClass: "admin" },
      { routeId: "community_model_performance", routeClass: "performance" },
      { routeId: "telemetry_performance_capabilities", routeClass: "performance" },
      { routeId: "telemetry_performance_consent", routeClass: "retired" },
      { routeId: "telemetry_performance_reports", routeClass: "performance" },
    ]);
  }
  // The grant now writes and echoes the exact body (201); the capability
  // reads back with the default dictionary (no v1.2 manifest: GATE-Q 1).
  {
    const { answer } = await exchange();
    assert.equal(answer.status, 201, answer.text);
    assert.equal(answer.text, validBody);
  }
  {
    const { answer } = await exchange({ method: "GET", path: CAPABILITIES, admission: "v1;device_sync;allowed" });
    assert.equal(answer.status, 200, answer.text);
    assert.equal(JSON.parse(answer.text).requiredConsent.fieldDictionaryVersion,
      "telemetry-performance-registry-2026-09-29.1");
  }
  assert.equal((await base.query(`SELECT count(*)::int AS n FROM ${t("accountless_telemetry_performance_authorizations")}`))
    .rows[0].n, 1);
  // A revoked device is the neutral 401 on the grant and the device routes.
  await base.query(`UPDATE ${t("device_credentials")} SET state = 'revoked', revoked_at = $2 WHERE id = $1`,
    [deviceId, new Date().toISOString()]);
  assert.deepEqual(await ask(), { status: 401, code: "DEVICE_AUTH_INVALID", retryAfter: null });
  assert.deepEqual(await device("GET", CAPABILITIES), { status: 401, code: "DEVICE_AUTH_INVALID", retryAfter: null });
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

// FIX-FUTURE-V12 (owner decision 2026-10-12, no new client): the released
// desktop client's own transport and accountless scheduler (origin/main =
// v0.1.28) against the composed origin. A day later than the server's UTC day
// plus one is the paced 429; the client classifies it as a retryable
// service_unavailable that honours retry-after, keeps its resumable day journal
// and the earlier staged days, and the scheduler waits instead of pausing.
// Once the day is admissible the same journal resumes and activates.
const DAY_MS = 86_400_000;
const ACCOUNTLESS_V12_AUTHORIZATION = Object.freeze({
  schemaVersion: "accountless-upload-owner-v1.2",
  policyVersion: "accountless-telemetry-v1.2-policy-v1",
  authorizationBasis: "accountless-policy-v1.2",
  telemetrySchemaVersion: "telemetry-contribution-v1.2",
});
const PUBLIC_ORIGIN = "https://tibotattle.com";

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");
const utcDay = (epoch) => new Date(epoch).toISOString().slice(0, 10);

/** One deterministic local v1.2 day in the client's wire form (edge-origin-e2e makeV12Day). */
function releasedClientDay(day, count, parserVersion) {
  const consent = telemetryV12RequiredConsent();
  const records = Array.from({ length: count }, (_, index) => ({
    schemaVersion: "usage-event-v1.2",
    eventId: `event:v2:${sha256Hex(`future-day-bound:${parserVersion}:${day}:${index}`)}`,
    eventTime: `${day}T12:${String(10 + index).padStart(2, "0")}:00.000Z`,
    sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b", provider: "openai_codex", modelId: "gpt-5.6-sol",
    speedMode: "standard", apiServiceTier: "default", surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription", reasoningEffort: "high", agentScope: "root", outcome: "completed",
    totalInputContextTokens: 1000,
    components: { inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0,
      outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: 75 },
    accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null, planBasis: "same_source_occurrence",
      planType: "pro", planEraId: null },
    boundaryFlags: null, tieOrder: null, cacheWriteTtl: null,
  }));
  const chunks = count === 0 ? [] : [{
    schemaVersion: "telemetry-contribution-v1.2", manifestDigest: "0".repeat(64), chunkId: `usage:${day}:0`,
    chunkRevision: 1, chunkDigest: sha256Hex(canonicalTelemetryV12Json(records)), parserVersion, consent, records,
  }];
  const manifest = {
    schemaVersion: "telemetry-day-manifest-v1.2", day, parserVersion, consent,
    chunks: chunks.map((chunk) => ({ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest,
      recordCount: chunk.records.length })),
    excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  for (const chunk of chunks) chunk.manifestDigest = manifest.manifestDigest;
  return { manifest, chunks };
}

/**
 * The released client's fetch, delivered as the edge forwards it: the public
 * origin to the local listener under the run.app Host, with the edge's
 * admission outcome for the route's purpose (src/edge-admission-policy.ts)
 * and an ID token minted at `tokenClock()`.
 */
function releasedClientFetch(port, log, tokenClock) {
  const admissionFor = (path) => {
    if (path === "/api/v1/contributions") return "v1;upload_ingress;allowed";
    if (path === "/api/v1/accountless/telemetry-v1.2-authorization") return "v1;accountless_ownership;allowed";
    if (["/api/v1/device/upload-authorizations", "/api/v1/envelope-key"].includes(path)) return null;
    return "v1;device_sync;allowed";
  };
  return async (url, init = {}) => {
    const target = new URL(url);
    assert.equal(target.origin, PUBLIC_ORIGIN);
    const headers = Object.fromEntries(new Headers(init.headers ?? {}));
    const body = init.body === undefined ? undefined : String(init.body);
    const answer = await send(port, { method: init.method ?? "GET", path: target.pathname + target.search, body,
      headers: { ...headers, ...edgeHeaders({ admission: admissionFor(target.pathname), tokenNowMs: tokenClock() }),
        ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }) } });
    log.push({ path: target.pathname, status: answer.status });
    return new Response([204, 205, 304].includes(answer.status) ? null : answer.text, {
      status: answer.status,
      headers: Object.entries(answer.headers).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value]).map((item) => [name, item])),
    });
  };
}

test("FIX-FUTURE-V12: the released client meets a future day as a paced 429, keeps its journal and resumes once admissible", {
  skip: SKIP, timeout: 300_000,
}, () => withProductionHost(async ({ base, t, port }) => {
  const realNow = Date.now();
  await base.query(`UPDATE ${t("telemetry_v12_runtime")} SET state='active', changed_at=$1 WHERE id=1`,
    [new Date(realNow).toISOString()]);
  await base.query(`UPDATE ${t("telemetry_v12_typed_runtime")} SET state='active', changed_at=$1 WHERE id=1`,
    [new Date(realNow).toISOString()]);
  // An accountless installation enrolls, binds its owner and takes the v1.2 grant, as Electron does.
  const log = [];
  // The edge mints its ID token on the real clock: EP-6 verifies it on the
  // clock the origin captured at start, which the Date mock below leaves real.
  const realClock = Date.now;
  const fetchImpl = releasedClientFetch(port, log, realClock);
  const deviceId = randomUUID();
  const secret = randomBytes(32);
  const deviceAuthorization = `Device um_device_${deviceId}.${secret.toString("base64url")}`;
  const post = (path, value, headers = {}) => fetchImpl(new URL(path, PUBLIC_ORIGIN), { method: "POST",
    headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
  const enrolled = await send(port, { method: "POST", path: "/api/v1/accountless/enrollment",
    headers: { ...edgeHeaders({ admission: "v1;enrollment;allowed" }), "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: "accountless-enrollment-v0.1", deviceId,
      deviceSecretHash: deviceSecretHash(deviceId, secret).toString("hex"),
      policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1" }) });
  assert.equal(enrolled.status, 201, enrolled.text);
  const owned = await send(port, { method: "POST", path: "/api/v1/accountless/ownership",
    headers: { ...edgeHeaders({ admission: "v1;accountless_ownership;allowed" }), "content-type": "application/json",
      authorization: deviceAuthorization },
    body: JSON.stringify({ schemaVersion: "accountless-upload-owner-v0.1", policyVersion: "accountless-opt-out-v1",
      authorizationBasis: "accountless-policy-v1", telemetrySchemaVersion: "telemetry-contribution-v1.1" }) });
  assert.equal(owned.status, 201, owned.text);
  const granted = await post("/api/v1/accountless/telemetry-v1.2-authorization", ACCOUNTLESS_V12_AUTHORIZATION,
    { authorization: deviceAuthorization });
  assert.equal(granted.status, 201, await granted.clone().text());
  const participantId = (await base.query(`SELECT participant_id FROM ${t("accountless_upload_owners")}
    WHERE enrollment_device_id = $1`, [deviceId])).rows[0].participant_id;

  // The local index holds yesterday, today and a day two days ahead of the server.
  const today = utcDay(realNow);
  const dayAt = (offset) => utcDay(Date.parse(`${today}T00:00:00.000Z`) + offset * DAY_MS);
  const records = new Map([[dayAt(-1), 2], [dayAt(0), 1], [dayAt(2), 3]]);
  const parserVersion = "synthetic-future-day-bound";
  const readDay = (day) => releasedClientDay(day, records.get(day) ?? 0, parserVersion);
  let saved = null;
  const progressStore = { read: async () => saved, write: async (value) => { saved = value; } };
  let envelopeKey;
  const createEnvelope = async (chunk) => {
    envelopeKey ??= await (await fetchImpl(new URL("/api/v1/envelope-key", PUBLIC_ORIGIN),
      { headers: { accept: "application/json" } })).json();
    return createTelemetryV12Envelope({ chunk, publicJwk: envelopeKey.publicJwk, keyId: envelopeKey.keyId,
      cryptoImpl: webcrypto });
  };
  const sync = (clock) => runTelemetryV12Sync({
    serverBaseUrl: PUBLIC_ORIGIN, deviceAuthorization, authorization: ACCOUNTLESS_V12_AUTHORIZATION,
    production: true, days: [...records.keys()].sort(), readDay, createEnvelope, fetchImpl, clock,
    progressStore, sourcePublication: { fingerprint: "synthetic-future-day-bound", parserVersion },
    maxDurationMs: 240_000,
  });
  const v12State = async () => (await base.query(`SELECT
      (SELECT COALESCE(jsonb_agg(to_char(chunk_day, 'YYYY-MM-DD') ORDER BY chunk_day), '[]'::jsonb)
         FROM ${t("telemetry_v12_day_manifests")} WHERE participant_id = $1) AS manifests,
      (SELECT count(*)::int FROM ${t("telemetry_v12_chunks")} WHERE participant_id = $1) AS chunks,
      (SELECT count(*)::int FROM ${t("telemetry_v12_domains")} WHERE participant_id = $1) AS domains`,
  [participantId])).rows[0];

  // First pass on the real clock: every day through tomorrow is staged, the
  // day two days ahead is refused, nothing activates.
  const first = await sync(() => Date.now());
  assert.equal(first.status, "failed", JSON.stringify(first));
  assert.equal(first.failure.code, "service_unavailable");
  assert.equal(first.failure.retryable, true);
  assert.equal(first.failure.deviceUnavailable, false);
  const admissibleAt = Date.parse(`${dayAt(1)}T00:00:00.000Z`);
  assert.ok(Number.isSafeInteger(first.failure.retryAfterMilliseconds));
  assert.ok(first.failure.retryAfterMilliseconds >= admissibleAt - Date.now() - 2_000
    && first.failure.retryAfterMilliseconds <= admissibleAt - realNow + 1_000,
  "retry-after names the instant the day becomes admissible");
  assert.equal(first.stagedDays, 3);
  assert.equal(first.chunksUploaded, 2);
  assert.equal(first.domainGenerationId, null);
  const refusal = log.filter((entry) => entry.path === "/api/v1/device/telemetry/v1.2/day-manifests"
    && entry.status === 429);
  assert.equal(refusal.length, 1, "one manifest refusal, and no chunk of the refused day was sent");
  assert.deepEqual(await v12State(), { manifests: [dayAt(-1), dayAt(0), dayAt(1)], chunks: 2, domains: 0 });
  assert.equal(saved?.days?.length, 3, "the resumable journal keeps the three staged days");

  // The released accountless scheduler waits for the retry-after: no pause.
  let scheduled = null;
  const scheduler = createAccountlessContributionScheduler({
    origin: PUBLIC_ORIGIN,
    readPreference: async () => ({ available: true, current: true, enabled: true,
      policyVersion: "accountless-opt-out-v1", destinationOrigin: PUBLIC_ORIGIN }),
    runner: async () => first,
    setTimer: (callback, delay) => { scheduled = delay; return { unref() {} }; },
    clearTimer: () => {},
  });
  scheduler.start();
  const waiting = await scheduler.runNow();
  assert.equal(waiting.state, "retry_wait", "the released scheduler waits; it does not pause sharing");
  assert.ok(scheduled >= first.failure.retryAfterMilliseconds);
  assert.equal(scheduler.inspectDiagnostics().lastFailureCode, "transient_failure");
  await scheduler.stop();

  // Once the server's UTC day is tomorrow, the day is admissible: the same
  // journal resumes, only the new day's chunk is uploaded, and the domain activates.
  mock.timers.enable({ apis: ["Date"], now: admissibleAt + 30_000 });
  try {
    const resumed = await sync(() => Date.now());
    assert.equal(resumed.status, "complete", JSON.stringify(resumed.failure));
    assert.equal(resumed.chunksUploaded, 1);
    assert.equal(resumed.acknowledgedThroughDay, dayAt(2));
    assert.ok(resumed.domainGenerationId);
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(await v12State(),
    { manifests: [dayAt(-1), dayAt(0), dayAt(1), dayAt(2)], chunks: 3, domains: 1 });
}));
