// End-to-end proofs for the restored accountless performance intake (owner
// decision 2026-10-10, decision 1) through the composed production host
// (cloud-run/server.mjs createRuntime + serve, HOST_MODE=production) over real
// HTTP on 127.0.0.1, against a disposable PostgreSQL 17 schema migrated
// through the promoted primary chain (0079 included).
//
// Requests arrive as Cloud Run's front end delivers them (a synthetic ID token
// whose signature segment is SIGNATURE_REMOVED_BY_GOOGLE, the run.app Host and
// the edge's admission header). Devices enroll and bind their accountless
// owner through the same origin, as Electron does. Nothing reaches Google,
// Cloudflare or any other network: the Access JWKS the admin chokepoint reads
// is served by a fetch stub that refuses every other URL, and every account,
// token, key, report and row is synthetic and content-free. Each fixture drops
// only the schema it created (prefix x1b_ph_).
//
// It proves:
// - staged runtime: the grant, capabilities and report upload each answer 403
//   TELEMETRY_TRANSPORT_BLOCKED and write no row;
// - the owner-only activation through POST /api/v1/admin/action
//   (run_maintenance telemetryRuntimeActivation) on the admin host, through the
//   Access chokepoint and the admin CSRF headers, with this image's
//   DEPLOYMENT_SOURCE_COMMIT threaded from the production environment;
// - grants: v1 with a v20 manifest names 2026-09-29.1, v1 with a v18 manifest
//   2026-09-21.1, v2 declaring 2026-10-10.1 names it; a v1.1-only device (no
//   v1.2 manifest) is served through v2 at its declared dictionary and, under
//   GATE-Q 1 (OVERRIDE), through v1 at 2026-09-29.1 (default_no_manifest);
// - reports: the released v2 client's interop fixture (copied from the client
//   line, postgres-test/fixtures/performance-report-client-v2.json) answers
//   202; a replay 202 idempotent with idempotency-replayed; a higher
//   sourceRevision replaces; a lower one 409; a dictionary that differs from
//   the capability 403; a malformed record 409 TELEMETRY_RECORD_INVALID whose
//   counter row carries the parser's closed detail; a report day outside the
//   server-time window (today - 10 through today + 1) 409 counted as
//   TELEMETRY_RECORD_INVALID_REPORT_DAY_OUT_OF_WINDOW (the fixture is
//   re-dated into the window); a replacement that changes
//   dictionary (09-29.1 -> 10-10.1 after a v2 re-grant, the C2a re-upload) is
//   accepted; GET reports is bounded; refusal counters increment; captured
//   logs carry no identifier or body;
// - the released-client flow: this line's shipped client transport
//   (createTelemetryPerformanceClient over runTelemetryPerformanceSync, the
//   envelope factory, and the exact grant v1 body of
//   apps/local/accountless-contribution.js) against the loopback host: grant
//   201, capability, report 202, then an idempotent re-run;
// - the refusal recorder against PostgreSQL: a second connection holding
//   ACCESS EXCLUSIVE on telemetry_performance_refusal_counts, or a counter
//   write that raises, never changes a refusal and delays it by at most the
//   recorder bound, and leaves no counter row; counter rows carry only day,
//   route id, closed code and status; and the hot counter row under
//   concurrent refused polls is measured against unrefused reads;
// - end to end for the admin reader (SPD-A1 RUN_PERFORMANCE_KEYS): reports
//   admitted through the host, then the in-process analytics-refresh Job with
//   the performance stage, then readPostgresAdminPerformanceIntake answers
//   with that run's four-key performance block.
//
// Registered in apps/worker/package.json's postgres:domain:check. Run:
//   PG_TEST_SOCKET=/private/tmp/tibotattle-pg-.../socket PG_TEST_PORT=<port> \
//     node --test --test-concurrency=1 ./postgres-test/postgres-performance-telemetry-host.spec.mjs
import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import http from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createServer } from "vite";
import { createTelemetryPerformanceClient } from "../../../src/application/telemetry-performance-client.js";
import {
  prepareTelemetryPerformanceDay,
  runTelemetryPerformanceSync,
} from "../../../src/contribution/telemetry-performance-sync.js";
import { createTelemetryPerformanceEnvelope } from "../../../src/platform/telemetry-performance-envelope.js";
import { PERFORMANCE_FIELD_DICTIONARIES } from "@app-usagemonitor/telemetry-contract";
import * as refreshJob from "../cloud-run/analytics-refresh.mjs";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import analyticsV2Config from "../vitest.analytics-v2.config.mjs";
import {
  PERFORMANCE_DICTIONARY_2026_09_21,
  PERFORMANCE_DICTIONARY_2026_09_29,
  PERFORMANCE_DICTIONARY_2026_10_10,
  insertPerformanceReport,
  seedPerformanceV12DayManifest,
  syntheticPerformanceRecord,
} from "./fixtures/performance-telemetry.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const SKIP = !PG_TEST_SOCKET;
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(HERE, "..");
const REPOSITORY_ROOT = resolve(WORKER_ROOT, "..", "..");
const COMMIT = "89abcdef0123456789abcdef0123456789abcdef";
const NAMESPACE = "synthetic-performance-host-namespace";
const KEY_ID = "key:synthetic-performance-host";
const INVOKER = "edge-invoker@synthetic-project.iam.gserviceaccount.com";
const AUDIENCE = "tibotattle-origin-audience";
const RUN_APP_ORIGIN = "https://tibotattle-origin-abc123def4-ue.a.run.app";
const RUN_APP_HOST = new URL(RUN_APP_ORIGIN).host;
const BUCKET = "synthetic-origin-quarantine";
const LOG_KEYS = Object.freeze(["level", "severity", "event", "requestId", "method", "routeClass", "code", "status"]);

const GRANT_PATH = "/api/v1/accountless/telemetry-performance-authorization";
const CAPABILITIES_PATH = "/api/v1/device/telemetry/performance/capabilities";
const REPORTS_PATH = "/api/v1/device/telemetry/performance/reports";
const ENVELOPE_KEY_PATH = "/api/v1/envelope-key";
const GRANT_ADMISSION = "v1;accountless_ownership;allowed";
const DEVICE_ADMISSION = "v1;device_sync;allowed";
const ROUTE_GRANT = "accountless_telemetry_performance_authorization";
const ROUTE_CAPABILITIES = "telemetry_performance_capabilities";
const ROUTE_REPORTS = "telemetry_performance_reports";
const BLOCKED = Object.freeze({ status: 403, code: "TELEMETRY_TRANSPORT_BLOCKED" });
// The route family's own wall-clock wait for the recorder
// (routes/performance-telemetry.mjs PERFORMANCE_TELEMETRY_REFUSAL_BOUND_MILLISECONDS).
const RECORDER_BOUND_MILLISECONDS = 1_000;
// Request work around the bound on a loaded test machine: a refusal that
// waits on a locked counter table must still answer well inside this.
const RECORDER_SLACK_MILLISECONDS = 1_500;

const V1_POLICY = Object.freeze({
  policyVersion: "accountless-telemetry-performance-policy-v1",
  authorizationBasis: "accountless-performance-policy-v1",
});
function v2GrantBody(fieldDictionaryVersion) {
  return JSON.stringify({ schemaVersion: "accountless-performance-owner-v2", ...V1_POLICY, fieldDictionaryVersion });
}
const V1_GRANT_BODY = JSON.stringify({ schemaVersion: "accountless-performance-owner-v1", ...V1_POLICY });

const CLIENT_V2_FIXTURE = Object.freeze(JSON.parse(
  await readFile(resolve(HERE, "fixtures", "performance-report-client-v2.json"), "utf8"),
));

const DAY_MS = 86_400_000;
/** The UTC day `offset` days from today at the real clock the composed host reads. */
function hostDay(offset) {
  return new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS + offset * DAY_MS).toISOString().slice(0, 10);
}
// Admission refuses report days outside today - 10 through today + 1 at the
// server's clock, so report days here are relative to today.
const REPORT_DAY = hostDay(-2);
const EARLIER_REPORT_DAY = hostDay(-3);
const EARLIEST_REPORT_DAY = hostDay(-4);
let clientV2ReportMemo = null;
/**
 * The copied client fixture, unchanged except re-dated to REPORT_DAY (its
 * records with it), with the client's revision recomputed. Memoized so every
 * upload in the run names the same bytes.
 */
function clientV2Report(m) {
  clientV2ReportMemo ??= revisedReport(m, { ...CLIENT_V2_FIXTURE, day: REPORT_DAY,
    records: CLIENT_V2_FIXTURE.records.map((record) => ({ ...record, day: REPORT_DAY })) });
  return clientV2ReportMemo;
}

let vite;
let modules;
let analyticsVite;
let analyticsModules;
after(async () => {
  await vite?.close();
  await analyticsVite?.close();
});

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
  const [server, codec, configuration, runtimeSchema, activation, canonical] = await Promise.all([
    load("/cloud-run/server.mjs"),
    load("/src/typed-telemetry-codec.ts"),
    load("/cloud-run/postgres-production-configuration.mjs"),
    load("/src/postgres-runtime-schema.ts"),
    load("/src/postgres-telemetry-runtime-activation.ts"),
    load("/src/canonical-json.ts"),
  ]);
  modules = { server, codec, configuration, runtimeSchema, activation, canonical };
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
    const publicJwk = { ...await webcrypto.subtle.exportKey("jwk", pair.publicKey), kid: KEY_ID };
    return {
      publicJwk,
      publicText: JSON.stringify(publicJwk),
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

/** The CR-3 production environment of the synthetic service. */
function productionEnvironment({ primarySchema, port, keys }) {
  return {
    HOST_MODE: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    K_SERVICE: "tibotattle-origin",
    HOST_ORIGIN: RUN_APP_ORIGIN,
    PUBLIC_ORIGIN: "https://tibotattle.com",
    EDGE_ORIGIN_MODE: "cloudflare-worker-iam",
    EDGE_ORIGIN_AUDIENCE: AUDIENCE,
    EDGE_INVOKER_SERVICE_ACCOUNT: INVOKER,
    EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS: "edge-verifier@synthetic-project.iam.gserviceaccount.com",
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
 * A HOST_MODE=production origin over a fresh, fully migrated "x1b_ph_*"
 * schema with operational controls and the typed v1/v1.1 pins naming the
 * configured namespace (as the bootstrap leaves them). The performance
 * runtime is 0079's seed: staged at policy revision 1.
 */
async function withProductionHost(run) {
  const m = await loadModules();
  const socket = await localSocket();
  const base = new pg.Pool(localPoolOptions(socket, 6, "x1b-performance-host"));
  base.on("error", () => {});
  const primarySchema = `x1b_ph_${randomBytes(5).toString("hex")}`;
  const pools = [];
  const lines = [];
  const consoleLines = [];
  let close = null;
  let created = false;
  const sigterm = process.listeners("SIGTERM");
  const sigint = process.listeners("SIGINT");
  const spies = ["log", "info", "warn", "error"].map((name) => mock.method(console, name, (...args) => {
    consoleLines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  }));
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
    const keys = await envelopeKeys();
    const env = productionEnvironment({ primarySchema, port, keys });
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
    return await run({ m, base, t, port, primarySchema, keys, lines, consoleLines });
  } finally {
    for (const spy of spies) spy.mock.restore();
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

function edgeHeaders({ hostKind = "apex", admission = null, requestId = randomUUID() } = {}) {
  return {
    "x-serverless-authorization": frontEndToken(`Bearer ${identityToken(INVOKER)}`),
    "x-tibotattle-edge-host": hostKind,
    "x-tibotattle-edge-request-id": requestId,
    ...(admission === null ? {} : { "x-tibotattle-edge-admission": admission }),
  };
}

/** One HTTP exchange with the served origin, under the run.app Host. */
function send(port, { method = "GET", path, headers = {}, body, deadlineMs = 15_000 }) {
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

function errorOf(answer) {
  try { return JSON.parse(answer.text)?.error ?? null; } catch { return null; }
}

function outcome(answer) {
  return { status: answer.status, code: errorOf(answer)?.code };
}

function assertNoStoreMarked(answer, label) {
  assert.equal(answer.headers["cache-control"], "no-store", label);
  assert.equal(answer.headers["x-tibotattle-origin"], "1", `${label}: marked by the boundary`);
}

/** src/device-auth.ts deviceHash: the stored hash of an enrolled bearer's secret. */
function deviceSecretHash(deviceId, secret) {
  return createHash("sha256").update(`app-usagemonitor/device/v1\0${deviceId}\0`).update(secret).digest();
}

/**
 * Enroll one accountless installation and bind its v1.1 upload owner through
 * the origin, as Electron does. Returns its bearer and the ids the fixtures
 * need (never printed).
 */
async function enrollAccountlessDevice({ base, t, port }) {
  const deviceId = randomUUID();
  const secret = randomBytes(32);
  const bearer = `Device um_device_${deviceId}.${secret.toString("base64url")}`;
  const enrolled = await send(port, { method: "POST", path: "/api/v1/accountless/enrollment",
    headers: { ...edgeHeaders({ admission: "v1;enrollment;allowed" }), "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: "accountless-enrollment-v0.1", deviceId,
      deviceSecretHash: deviceSecretHash(deviceId, secret).toString("hex"),
      policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1" }) });
  assert.equal(enrolled.status, 201, "enrollment");
  const owned = await send(port, { method: "POST", path: "/api/v1/accountless/ownership",
    headers: { ...edgeHeaders({ admission: GRANT_ADMISSION }), "content-type": "application/json",
      authorization: bearer },
    body: JSON.stringify({ schemaVersion: "accountless-upload-owner-v0.1", policyVersion: "accountless-opt-out-v1",
      authorizationBasis: "accountless-policy-v1", telemetrySchemaVersion: "telemetry-contribution-v1.1" }) });
  assert.equal(owned.status, 201, "ownership");
  const row = (await base.query(`SELECT participant_id FROM ${t("device_credentials")} WHERE id = $1`,
    [deviceId])).rows[0];
  return Object.freeze({ deviceId, participantId: row.participant_id, enrollmentDeviceId: deviceId,
    secretText: secret.toString("base64url"), bearer });
}

/** The performance routes as the edge forwards them for one device. */
function performanceClient(port, device) {
  const exchange = async ({ method, path, admission, body, contentType = "application/json", authorization }) => {
    const answer = await send(port, { method, path, ...(body === undefined ? {} : { body }),
      headers: { ...edgeHeaders({ admission }), authorization: authorization ?? device.bearer,
        ...(method === "POST" ? { "content-type": contentType } : {}) } });
    assertNoStoreMarked(answer, `${method} ${path} ${answer.status}`);
    return answer;
  };
  return Object.freeze({
    grant: (body = V1_GRANT_BODY) => exchange({ method: "POST", path: GRANT_PATH, admission: GRANT_ADMISSION, body }),
    capabilities: () => exchange({ method: "GET", path: CAPABILITIES_PATH, admission: DEVICE_ADMISSION }),
    readReports: (search = "") => exchange({ method: "GET", path: `${REPORTS_PATH}${search}`,
      admission: DEVICE_ADMISSION }),
    upload: (envelopeText) => exchange({ method: "POST", path: REPORTS_PATH, admission: DEVICE_ADMISSION,
      body: envelopeText }),
  });
}

/** A report with a fresh revision: the client's sha256 over the canonical body without reportRevision. */
function revisedReport(m, report, patch = {}) {
  const { reportRevision: _ignored, ...body } = { ...report, ...patch };
  const reportRevision = createHash("sha256").update(m.canonical.canonicalJson(body)).digest("hex");
  return Object.freeze({ ...body, reportRevision });
}

/** A one-record report under a dictionary, its records built by the shared fixture. */
function syntheticReport(m, { day, fieldDictionaryVersion, sourceRevision = 1, records } = {}) {
  const scheme = fieldDictionaryVersion === PERFORMANCE_DICTIONARY_2026_10_10
    ? "performance-histogram-v2" : "performance-histogram-v1";
  return revisedReport(m, {
    schemaVersion: "telemetry-performance-report-v1",
    day,
    sourceGeneration: "timing:synthetic-host-1",
    sourceDigest: createHash("sha256").update(`synthetic-source:${day}:${sourceRevision}`).digest("hex"),
    sourceRevision,
    methodVersion: "performance-daily-histogram-v1",
    parserVersion: "unified-rollout-typed-v20",
    fieldDictionaryVersion,
    privacyContractVersion: "privacy-safe-model-performance-v1",
    bucketSchemeVersion: scheme,
    measurementVersion: "model-performance-samples-v1",
    records: records ?? [syntheticPerformanceRecord({ day, fieldDictionaryVersion })],
  });
}

/** The released client's own envelope (RSA-OAEP + AES-GCM) under the origin's public key. */
async function sealedReport(keys, report) {
  return JSON.stringify(await createTelemetryPerformanceEnvelope({ report, publicJwk: keys.publicJwk, keyId: KEY_ID }));
}

async function refusalCounts(base, t) {
  return (await base.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, route_id, code, status,
      refusals::int AS refusals FROM ${t("telemetry_performance_refusal_counts")}
    ORDER BY route_id, code, status`)).rows;
}

function countsByKey(rows) {
  return Object.fromEntries(rows.map((row) => [`${row.route_id} ${row.code} ${row.status}`, row.refusals]));
}

async function tableCount(base, t, table) {
  return (await base.query(`SELECT count(*)::int AS n FROM ${t(table)}`)).rows[0].n;
}

/**
 * Every captured host and console line: the closed log shape for host lines,
 * and no identifier, bearer, revision or body anywhere.
 */
function assertCleanLogs({ lines, consoleLines }, secrets) {
  for (const line of lines) {
    assert.deepEqual(Object.keys(JSON.parse(line)), LOG_KEYS, "host line keys");
  }
  for (const line of [...lines, ...consoleLines]) {
    for (const secret of secrets) {
      assert.ok(typeof secret === "string" && secret.length >= 8, "a meaningful marker");
      assert.ok(!line.includes(secret), "a log line carries an identifier, bearer, revision or body");
    }
    for (const marker of ["um_device_", "participant", "ciphertext", "wrappedKey", "reportRevision",
      "sourceDigest", "gpt-5", "fieldDictionaryVersion"]) {
      assert.ok(!line.includes(marker), `a log line carries ${marker}`);
    }
  }
}

function deviceSecrets(device) {
  return [device.deviceId, device.participantId, device.secretText];
}

/**
 * The owner-only activation over the composed admin host: Cloudflare
 * Access's application token (verified against a synthetic JWKS that a fetch
 * stub serves for exactly the configured team's certs URL; any other fetch
 * throws), the owner pin, and the admin CSRF headers. The deployment block is
 * this image's DEPLOYMENT_SOURCE_COMMIT and the history digest of the
 * runtime migration manifest, as the runbook computes it from the migrate
 * receipt.
 */
// One synthetic Access signing key for the whole file: the chokepoint caches
// the team's JWKS per process (and refuses an unknown key id soon after a
// fetch), exactly as it does in production.
let accessKeys;
function syntheticAccessKeys() {
  accessKeys ??= (async () => {
    const pair = await webcrypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const kid = `synthetic-access-${randomBytes(6).toString("hex")}`;
    const jwks = JSON.stringify({ keys: [{ ...await webcrypto.subtle.exportKey("jwk", pair.publicKey), kid,
      alg: "RS256", use: "sig" }] });
    return { pair, kid, jwks };
  })();
  return accessKeys;
}

async function adminAccess(m) {
  const vars = m.configuration.PRODUCTION_VARS;
  const adminOrigin = m.configuration.PRODUCTION_ADMIN_ORIGIN;
  const { pair, kid, jwks } = await syntheticAccessKeys();
  const certsUrl = `https://${vars.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
  const assertion = async (email) => {
    const now = Math.floor(Date.now() / 1000);
    const head = base64UrlJson({ alg: "RS256", kid, typ: "JWT" });
    const claims = base64UrlJson({ aud: [vars.ACCESS_AUD], email, exp: now + 600, iat: now - 5, nbf: now - 5,
      iss: `https://${vars.ACCESS_TEAM_DOMAIN}`, sub: randomUUID(), type: "app" });
    const signature = await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey,
      new TextEncoder().encode(`${head}.${claims}`));
    return `${head}.${claims}.${Buffer.from(signature).toString("base64url")}`;
  };
  const fetched = [];
  const withAccessKeys = async (work) => {
    const stub = mock.method(globalThis, "fetch", async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);
      if (url !== certsUrl) throw new TypeError("network access refused in this spec");
      return new Response(jwks, { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      return await work();
    } finally {
      stub.mock.restore();
    }
  };
  const activationBody = async ({ expectedRevision = 1, idempotencyKey = randomUUID() } = {}) => JSON.stringify({
    action: "run_maintenance",
    telemetryRuntimeActivation: {
      confirmation: "activate_telemetry_performance_runtime",
      deployment: {
        historySha256: await m.activation.postgresRuntimeMigrationHistorySha256(
          m.runtimeSchema.POSTGRES_RUNTIME_MIGRATIONS.primary),
        sourceCommit: COMMIT,
      },
      expectedRevision,
      idempotencyKey,
      target: "performance",
    },
  });
  const act = async (port, { body, csrf = true, email = vars.ACCESS_ADMIN_EMAIL } = {}) => withAccessKeys(async () => {
    const token = await assertion(email);
    return send(port, { method: "POST", path: "/api/v1/admin/action", body: body ?? await activationBody(),
      headers: { ...edgeHeaders({ hostKind: "admin" }), "cf-access-jwt-assertion": token,
        "content-type": "application/json",
        ...(csrf ? { origin: adminOrigin, "sec-fetch-site": "same-origin", "x-usage-monitor-admin": "1" } : {}) } });
  });
  return Object.freeze({ act, activationBody, fetched, certsUrl, ownerEmail: vars.ACCESS_ADMIN_EMAIL });
}

async function activateThroughAdminHost(m, port) {
  const admin = await adminAccess(m);
  const answer = await admin.act(port);
  assert.equal(answer.status, 200, "activation");
  const body = JSON.parse(answer.text);
  assert.equal(body.result.state, "active");
  assert.ok(admin.fetched.every((url) => url === admin.certsUrl), "only the Access certs URL was fetched");
  return body;
}

test("staged: grant, capabilities and report upload answer 403 and write nothing; activation runs through the admin host", {
  skip: SKIP, timeout: 300_000,
}, () => withProductionHost(async (fixture) => {
  const { m, base, t, port, keys } = fixture;
  const device = await enrollAccountlessDevice(fixture);
  const client = performanceClient(port, device);
  const fixtureEnvelope = await sealedReport(keys, clientV2Report(m));
  // 0079's seed: staged at revision 1. Every route refuses after the device
  // authenticated (G2's staged answer), with no retry-after.
  assert.deepEqual((await base.query(`SELECT state, policy_revision FROM ${t("telemetry_performance_runtime")}`)).rows,
    [{ state: "staged", policy_revision: 1 }]);
  for (const answer of [await client.grant(), await client.grant(v2GrantBody(PERFORMANCE_DICTIONARY_2026_10_10)),
    await client.capabilities(), await client.upload(fixtureEnvelope)]) {
    assert.deepEqual(outcome(answer), BLOCKED);
    assert.equal(answer.headers["retry-after"], undefined);
  }
  const intakeTables = ["accountless_telemetry_performance_authorizations", "telemetry_performance_device_capabilities",
    "telemetry_performance_reports", "telemetry_performance_cohorts", "telemetry_performance_buckets",
    "telemetry_performance_receipts", "analytics_v2_published_performance"];
  for (const table of intakeTables) assert.equal(await tableCount(base, t, table), 0, table);
  assert.deepEqual(countsByKey(await refusalCounts(base, t)), {
    [`${ROUTE_GRANT} TELEMETRY_TRANSPORT_BLOCKED 403`]: 2,
    [`${ROUTE_CAPABILITIES} TELEMETRY_TRANSPORT_BLOCKED 403`]: 1,
    [`${ROUTE_REPORTS} TELEMETRY_TRANSPORT_BLOCKED 403`]: 1,
  });

  // The admin host: without the CSRF headers the Access-verified owner is
  // still refused, and nothing moves.
  const admin = await adminAccess(m);
  const noCsrf = await admin.act(port, { csrf: false });
  assert.deepEqual(outcome(noCsrf), { status: 403, code: "CSRF_INVALID" });
  // A verified Access user who is not the pinned owner is refused too.
  const stranger = await admin.act(port, { email: "someone-else@synthetic.example" });
  assert.deepEqual(outcome(stranger), { status: 403, code: "ADMIN_REQUIRED" });
  assert.deepEqual((await base.query(`SELECT state, policy_revision FROM ${t("telemetry_performance_runtime")}`)).rows,
    [{ state: "staged", policy_revision: 1 }]);
  // The owner with the CSRF headers activates (G5 through the production
  // composition, with DEPLOYMENT_SOURCE_COMMIT from the environment).
  const idempotencyKey = randomUUID();
  const body = await admin.activationBody({ idempotencyKey });
  const activated = await admin.act(port, { body });
  assert.equal(activated.status, 200, "activation");
  assertNoStoreMarked(activated, "activation");
  const result = JSON.parse(activated.text);
  assert.equal(result.schemaVersion, "admin-action-v0.1");
  assert.equal(result.action, "run_maintenance");
  assert.deepEqual({ ...result.result }, {
    task: "telemetry_runtime_activation", operationId: idempotencyKey, target: "performance", state: "active",
    fromRevision: 1, toRevision: 2, revision: 2, replayed: false, reconciled: false,
  });
  assert.deepEqual((await base.query(`SELECT state, policy_revision FROM ${t("telemetry_performance_runtime")}`)).rows,
    [{ state: "active", policy_revision: 2 }]);
  // The same request again replays the recorded result and changes nothing.
  const replayed = await admin.act(port, { body });
  assert.equal(replayed.status, 200);
  assert.equal(JSON.parse(replayed.text).result.replayed, true);
  assert.deepEqual((await base.query(`SELECT state, policy_revision FROM ${t("telemetry_performance_runtime")}`)).rows,
    [{ state: "active", policy_revision: 2 }]);
  assert.ok(admin.fetched.length >= 1 && admin.fetched.every((url) => url === admin.certsUrl),
    "the chokepoint fetched only the Access certs URL");
  // The audit trail holds one finished activation row (started, then
  // finished in place), content-free: the actor is stored only as a digest.
  const audit = await base.query(`SELECT action, outcome, details_json::text AS details
      FROM ${t("admin_action_audit")} WHERE action = 'run_maintenance' ORDER BY id`);
  assert.deepEqual(audit.rows.map((row) => [row.action, row.outcome]), [["run_maintenance", "success"]]);
  for (const row of audit.rows) assert.ok(!row.details.includes(admin.ownerEmail), "no owner email in the audit");
  // Now the device is granted.
  const granted = await client.grant();
  assert.equal(granted.status, 201);
  assert.equal(granted.text, V1_GRANT_BODY);
  assertCleanLogs(fixture, [...deviceSecrets(device), clientV2Report(m).reportRevision, admin.ownerEmail]);
}));

test("grants: the dictionary follows the v1.2 manifest, the declared v2 dictionary, or the default (GATE-Q 1)", {
  skip: SKIP, timeout: 300_000,
}, () => withProductionHost(async (fixture) => {
  const { m, base, t, port } = fixture;
  await activateThroughAdminHost(m, port);
  const capabilityOf = async (client) => {
    const answer = await client.capabilities();
    assert.equal(answer.status, 200);
    return JSON.parse(answer.text);
  };
  const basisOf = async (device) => (await base.query(`SELECT a.field_dictionary_version AS dictionary,
        a.dictionary_basis AS basis, a.schema_version, c.field_dictionary_version AS capability_dictionary
      FROM ${t("accountless_telemetry_performance_authorizations")} a
      JOIN ${t("telemetry_performance_device_capabilities")} c
        ON c.participant_id = a.participant_id AND c.device_id = a.device_credential_id
       AND c.capability_revision = a.capability_revision AND c.authority_epoch = a.authority_epoch
     WHERE a.enrollment_device_id = $1
     ORDER BY a.capability_revision DESC, a.authority_epoch DESC LIMIT 1`, [device.enrollmentDeviceId])).rows[0];

  // A 0.1.28 device (parser v20 on its newest v1.2 manifest) through v1.
  const v20 = await enrollAccountlessDevice(fixture);
  await seedPerformanceV12DayManifest(base, { schema: fixture.primarySchema, owner: v20, chunkDay: "2026-10-09",
    parserVersion: "unified-rollout-typed-v20" });
  const v20Client = performanceClient(port, v20);
  const v20Grant = await v20Client.grant();
  assert.equal(v20Grant.status, 201);
  assert.equal(v20Grant.text, V1_GRANT_BODY, "the exact v1 echo");
  const v20Capability = await capabilityOf(v20Client);
  assert.equal(v20Capability.requiredConsent.fieldDictionaryVersion, PERFORMANCE_DICTIONARY_2026_09_29);
  assert.equal(v20Capability.lifecycle, "accepted");
  assert.equal(v20Capability.authorizationCurrent, true);
  assert.deepEqual({ ...await basisOf(v20) }, { dictionary: PERFORMANCE_DICTIONARY_2026_09_29,
    basis: "v12_parser_inference", schema_version: "accountless-performance-owner-v1",
    capability_dictionary: PERFORMANCE_DICTIONARY_2026_09_29 });

  // A 0.1.24-0.1.26 device (parser v18) through v1.
  const v18 = await enrollAccountlessDevice(fixture);
  await seedPerformanceV12DayManifest(base, { schema: fixture.primarySchema, owner: v18, chunkDay: "2026-10-08",
    parserVersion: "unified-rollout-typed-v18" });
  const v18Client = performanceClient(port, v18);
  assert.equal((await v18Client.grant()).status, 201);
  assert.equal((await capabilityOf(v18Client)).requiredConsent.fieldDictionaryVersion,
    PERFORMANCE_DICTIONARY_2026_09_21);
  assert.equal((await basisOf(v18)).basis, "v12_parser_inference");

  // A v2 client declaring 2026-10-10.1 (with a v20 manifest: declared beats inferred).
  const declared = await enrollAccountlessDevice(fixture);
  await seedPerformanceV12DayManifest(base, { schema: fixture.primarySchema, owner: declared, chunkDay: "2026-10-09",
    parserVersion: "unified-rollout-typed-v20" });
  const declaredClient = performanceClient(port, declared);
  const v2Body = v2GrantBody(PERFORMANCE_DICTIONARY_2026_10_10);
  const declaredGrant = await declaredClient.grant(v2Body);
  assert.equal(declaredGrant.status, 201);
  assert.equal(declaredGrant.text, v2Body, "the exact 4-key v2 echo");
  assert.equal((await capabilityOf(declaredClient)).requiredConsent.fieldDictionaryVersion,
    PERFORMANCE_DICTIONARY_2026_10_10);
  assert.deepEqual({ ...await basisOf(declared) }, { dictionary: PERFORMANCE_DICTIONARY_2026_10_10,
    basis: "client_declared", schema_version: "accountless-performance-owner-v2",
    capability_dictionary: PERFORMANCE_DICTIONARY_2026_10_10 });
  // An unknown declared dictionary is refused and changes nothing.
  assert.deepEqual(outcome(await declaredClient.grant(v2GrantBody("telemetry-performance-registry-2099-01-01.1"))),
    { status: 403, code: "TELEMETRY_CONSENT_INVALID" });
  assert.equal((await capabilityOf(declaredClient)).requiredConsent.fieldDictionaryVersion,
    PERFORMANCE_DICTIONARY_2026_10_10);

  // A v1.1-only device (no v1.2 manifest at all). GATE-Q 1 (OVERRIDE): v1 is
  // served at 2026-09-29.1 with basis default_no_manifest, not refused; v2
  // serves its declared dictionary, and the latest grant wins.
  const v11Only = await enrollAccountlessDevice(fixture);
  const v11Client = performanceClient(port, v11Only);
  assert.equal((await v11Client.grant(v2Body)).status, 201);
  assert.equal((await capabilityOf(v11Client)).requiredConsent.fieldDictionaryVersion,
    PERFORMANCE_DICTIONARY_2026_10_10);
  assert.equal((await basisOf(v11Only)).basis, "client_declared");
  const v11V1 = await v11Client.grant();
  assert.equal(v11V1.status, 201);
  assert.equal(v11V1.text, V1_GRANT_BODY);
  assert.equal((await capabilityOf(v11Client)).requiredConsent.fieldDictionaryVersion,
    PERFORMANCE_DICTIONARY_2026_09_29);
  assert.equal((await basisOf(v11Only)).basis, "default_no_manifest");
  // Re-declaring v2 moves it back (a re-grant after a client upgrade).
  assert.equal((await v11Client.grant(v2Body)).status, 201);
  assert.equal((await capabilityOf(v11Client)).requiredConsent.fieldDictionaryVersion,
    PERFORMANCE_DICTIONARY_2026_10_10);
  // An identical repeated grant is idempotent: no new authorization row.
  const before = await tableCount(base, t, "accountless_telemetry_performance_authorizations");
  assert.equal((await v11Client.grant(v2Body)).status, 201);
  assert.equal(await tableCount(base, t, "accountless_telemetry_performance_authorizations"), before);
  assertCleanLogs(fixture, [v20, v18, declared, v11Only].flatMap(deviceSecrets));
}));

test("reports: the v2 client's fixture, replay, replacement order, dictionary fence, invalid records and bounded reads", {
  skip: SKIP, timeout: 300_000,
}, () => withProductionHost(async (fixture) => {
  const { m, base, t, port, keys } = fixture;
  await activateThroughAdminHost(m, port);
  // The copied fixture's revision is the client's sha256 over its canonical
  // body: the host and this spec agree on it before anything is sent.
  assert.equal(revisedReport(m, CLIENT_V2_FIXTURE).reportRevision, CLIENT_V2_FIXTURE.reportRevision);
  // Re-dating into the window changes only the day and the revision.
  const clientReport = clientV2Report(m);
  assert.deepEqual({ ...clientReport, day: CLIENT_V2_FIXTURE.day, reportRevision: CLIENT_V2_FIXTURE.reportRevision,
    records: clientReport.records.map((record) => ({ ...record, day: CLIENT_V2_FIXTURE.day })) }, CLIENT_V2_FIXTURE);
  const device = await enrollAccountlessDevice(fixture);
  const client = performanceClient(port, device);
  const v2Body = v2GrantBody(PERFORMANCE_DICTIONARY_2026_10_10);
  assert.equal((await client.grant(v2Body)).status, 201);

  const receipt = (answer) => {
    const body = JSON.parse(answer.text);
    assert.deepEqual(Object.keys(body), ["schemaVersion", "status", "reportId", "day", "reportRevision", "replayed"]);
    assert.equal(body.schemaVersion, "telemetry-performance-receipt-v1");
    return body;
  };
  // The released v2 client's report: 202 accepted.
  const accepted = await client.upload(await sealedReport(keys, clientV2Report(m)));
  assert.equal(accepted.status, 202);
  const first = receipt(accepted);
  assert.deepEqual({ status: first.status, day: first.day, reportRevision: first.reportRevision,
    replayed: first.replayed }, { status: "accepted", day: clientV2Report(m).day,
    reportRevision: clientV2Report(m).reportRevision, replayed: false });
  assert.equal(accepted.headers["idempotency-replayed"], undefined);
  const stored = (await base.query(`SELECT field_dictionary_version, bucket_scheme_version, record_count, source_revision
      FROM ${t("telemetry_performance_reports")} WHERE id = $1`, [first.reportId])).rows[0];
  assert.deepEqual({ ...stored }, { field_dictionary_version: PERFORMANCE_DICTIONARY_2026_10_10,
    bucket_scheme_version: "performance-histogram-v2", record_count: 5, source_revision: "7" });
  // The 408 tok/s turn is stored in v2 speed bucket 80 (v1 would overflow at 60).
  const bucket80 = await base.query(`SELECT count(*)::int AS n FROM ${t("telemetry_performance_buckets")}
    WHERE report_id = $1 AND metric = 'speed' AND bucket_index = 80`, [first.reportId]);
  assert.equal(bucket80.rows[0].n, 1);
  const receiptsAfterFirst = await tableCount(base, t, "telemetry_performance_receipts");
  assert.equal(receiptsAfterFirst, 1);

  // A replay (a fresh envelope of the same report): 202 idempotent, marked,
  // and no new receipt or report.
  const replay = await client.upload(await sealedReport(keys, clientV2Report(m)));
  assert.equal(replay.status, 202);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  const replayed = receipt(replay);
  assert.deepEqual({ status: replayed.status, reportId: replayed.reportId, replayed: replayed.replayed },
    { status: "idempotent", reportId: first.reportId, replayed: true });
  assert.equal(await tableCount(base, t, "telemetry_performance_receipts"), receiptsAfterFirst);
  assert.equal(await tableCount(base, t, "telemetry_performance_reports"), 1);

  // A higher sourceRevision replaces the current report.
  const higher = revisedReport(m, clientV2Report(m), { sourceRevision: 8 });
  const replaced = await client.upload(await sealedReport(keys, higher));
  assert.equal(replaced.status, 202);
  const replacement = receipt(replaced);
  assert.equal(replacement.status, "replaced");
  assert.deepEqual((await base.query(`SELECT state, source_revision::int AS revision FROM ${t("telemetry_performance_reports")}
      ORDER BY source_revision`)).rows, [{ state: "superseded", revision: 7 }, { state: "current", revision: 8 }]);
  // A lower one never displaces it.
  const lower = revisedReport(m, clientV2Report(m), { sourceRevision: 6 });
  assert.deepEqual(outcome(await client.upload(await sealedReport(keys, lower))),
    { status: 409, code: "TELEMETRY_MANIFEST_CONFLICT" });

  // A report whose dictionary differs from the capability: 403, nothing written.
  const otherDictionary = syntheticReport(m, { day: EARLIER_REPORT_DAY, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_29 });
  assert.deepEqual(outcome(await client.upload(await sealedReport(keys, otherDictionary))), BLOCKED);
  // A malformed record (a model the reviewed catalog does not name): 409
  // TELEMETRY_RECORD_INVALID; its counter row carries the closed detail.
  const unreviewed = revisedReport(m, clientV2Report(m), {
    day: EARLIER_REPORT_DAY,
    records: [{ ...clientV2Report(m).records[0], day: EARLIER_REPORT_DAY, modelId: "synthetic-unreviewed-model" }],
  });
  const invalid = await client.upload(await sealedReport(keys, unreviewed));
  assert.deepEqual(outcome(invalid), { status: 409, code: "TELEMETRY_RECORD_INVALID" });
  assert.ok(!invalid.text.includes("MODEL_UNREVIEWED"), "the detail never reaches the body");
  assert.equal(await tableCount(base, t, "telemetry_performance_reports"), 2);
  // A report day outside the server-time window (today - 10 through
  // today + 1): 409 TELEMETRY_RECORD_INVALID, counted with its closed detail,
  // nothing stored.
  for (const day of [hostDay(-11), hostDay(2)]) {
    const stale = revisedReport(m, clientV2Report(m), {
      day, records: clientV2Report(m).records.map((record) => ({ ...record, day })) });
    const refused = await client.upload(await sealedReport(keys, stale));
    assert.deepEqual(outcome(refused), { status: 409, code: "TELEMETRY_RECORD_INVALID" });
    assert.ok(!refused.text.includes("REPORT_DAY_OUT_OF_WINDOW"), "the detail never reaches the body");
  }
  assert.equal(await tableCount(base, t, "telemetry_performance_reports"), 2);

  // GET reports: the current report, the superseded one on request, a closed query.
  const current = JSON.parse((await client.readReports()).text);
  assert.equal(current.schemaVersion, "telemetry-performance-read-v1");
  assert.equal(current.reports.length, 1);
  const all = JSON.parse((await client.readReports("?includeSuperseded=true")).text);
  assert.equal(all.reports.length, 2);
  assert.deepEqual(outcome(await client.readReports("?includeSuperseded=yes")), { status: 400, code: "BODY_INVALID" });
  assert.deepEqual(outcome(await client.readReports("?unknown=1")), { status: 400, code: "BODY_INVALID" });
  // Bounded: past the read fence (256 reports) the unbounded read is
  // refused, and a ranged read of the same device answers.
  const head = (await base.query(`SELECT capability_revision, authority_epoch FROM ${t("telemetry_performance_device_capabilities")}
      WHERE device_id = $1 ORDER BY capability_revision DESC, authority_epoch DESC LIMIT 1`, [device.deviceId])).rows[0];
  const grant = { capabilityRevision: head.capability_revision, authorityEpoch: head.authority_epoch,
    fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_10_10 };
  const firstDay = Date.UTC(2025, 0, 1);
  for (let index = 0; index < 257; index += 1) {
    await insertPerformanceReport(base, { schema: fixture.primarySchema, owner: device, grant,
      reportDay: new Date(firstDay + index * 86_400_000).toISOString().slice(0, 10), records: [] });
  }
  assert.deepEqual(outcome(await client.readReports()), { status: 400, code: "SYNC_RANGE_TOO_LARGE" });
  const ranged = await client.readReports("?fromDay=2025-01-01&throughDay=2025-01-31");
  assert.equal(ranged.status, 200);
  assert.equal(JSON.parse(ranged.text).reports.length, 31);

  // Every refusal after authentication was counted, content-free.
  const counts = await refusalCounts(base, t);
  const today = new Date().toISOString().slice(0, 10);
  for (const row of counts) assert.equal(row.day, today);
  assert.deepEqual(countsByKey(counts), {
    [`${ROUTE_REPORTS} BODY_INVALID 400`]: 2,
    [`${ROUTE_REPORTS} SYNC_RANGE_TOO_LARGE 400`]: 1,
    [`${ROUTE_REPORTS} TELEMETRY_MANIFEST_CONFLICT 409`]: 1,
    [`${ROUTE_REPORTS} TELEMETRY_RECORD_INVALID_MODEL_UNREVIEWED 409`]: 1,
    [`${ROUTE_REPORTS} TELEMETRY_RECORD_INVALID_REPORT_DAY_OUT_OF_WINDOW 409`]: 2,
    [`${ROUTE_REPORTS} TELEMETRY_TRANSPORT_BLOCKED 403`]: 1,
  });
  assertCleanLogs(fixture, [...deviceSecrets(device), clientV2Report(m).reportRevision, higher.reportRevision,
    first.reportId]);
}));

test("a replacement that changes dictionary is accepted after a v2 re-grant (the C2a release-time re-upload)", {
  skip: SKIP, timeout: 300_000,
}, () => withProductionHost(async (fixture) => {
  const { m, base, t, port, keys } = fixture;
  await activateThroughAdminHost(m, port);
  // A 0.1.28 device: v20 manifest, v1 grant, 2026-09-29.1 capability.
  const device = await enrollAccountlessDevice(fixture);
  await seedPerformanceV12DayManifest(base, { schema: fixture.primarySchema, owner: device, chunkDay: "2026-10-09",
    parserVersion: "unified-rollout-typed-v20" });
  const client = performanceClient(port, device);
  assert.equal((await client.grant()).status, 201);
  // It reports the fixture's day under its old dictionary (v1 buckets).
  const old = syntheticReport(m, { day: clientV2Report(m).day, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_29,
    sourceRevision: 3 });
  const oldAnswer = await client.upload(await sealedReport(keys, old));
  assert.equal(oldAnswer.status, 202);
  assert.equal(JSON.parse(oldAnswer.text).status, "accepted");
  // Under the old capability the v2 client's report is the dictionary fence.
  assert.deepEqual(outcome(await client.upload(await sealedReport(keys, clientV2Report(m)))), BLOCKED);
  // The upgraded client re-grants v2 (declared 2026-10-10.1) and re-uploads
  // the re-prepared day: a replacement whose dictionary differs from the
  // prior revision's is accepted.
  assert.equal((await client.grant(v2GrantBody(PERFORMANCE_DICTIONARY_2026_10_10))).status, 201);
  const upgraded = await client.upload(await sealedReport(keys, clientV2Report(m)));
  assert.equal(upgraded.status, 202);
  assert.equal(JSON.parse(upgraded.text).status, "replaced");
  const rows = (await base.query(`SELECT state, field_dictionary_version, bucket_scheme_version,
        source_revision::int AS revision, capability_revision
      FROM ${t("telemetry_performance_reports")} WHERE device_id = $1 ORDER BY source_revision`, [device.deviceId])).rows;
  assert.deepEqual(rows.map((row) => [row.state, row.field_dictionary_version, row.bucket_scheme_version, row.revision]), [
    ["superseded", PERFORMANCE_DICTIONARY_2026_09_29, "performance-histogram-v1", 3],
    ["current", PERFORMANCE_DICTIONARY_2026_10_10, "performance-histogram-v2", 7],
  ]);
  assert.ok(rows[1].capability_revision > rows[0].capability_revision, "the replacement names the newer capability");
  const outcomes = (await base.query(`SELECT outcome FROM ${t("telemetry_performance_receipts")}
      WHERE device_id = $1 ORDER BY created_at`, [device.deviceId])).rows.map((row) => row.outcome);
  assert.deepEqual(outcomes, ["accepted", "replaced"]);
  // A late old-dictionary upload for another day is fenced now.
  const late = syntheticReport(m, { day: EARLIEST_REPORT_DAY, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_29 });
  assert.deepEqual(outcome(await client.upload(await sealedReport(keys, late))), BLOCKED);
  assertCleanLogs(fixture, [...deviceSecrets(device), old.reportRevision, clientV2Report(m).reportRevision]);
}));

/**
 * The exact grant body of this line's shipped client composition
 * (apps/local/accountless-contribution.js PERFORMANCE_AUTHORIZATION), read
 * from its source: the frozen literal, string values only.
 */
async function shippedGrantBody() {
  const source = await readFile(resolve(REPOSITORY_ROOT, "apps", "local", "accountless-contribution.js"), "utf8");
  const literal = /const PERFORMANCE_AUTHORIZATION = Object\.freeze\(\{\n((?:  [a-zA-Z]+: "[^"\n]+",\n)+)\}\);/u
    .exec(source);
  assert.ok(literal, "apps/local/accountless-contribution.js names a literal PERFORMANCE_AUTHORIZATION");
  const entries = [...literal[1].matchAll(/^ {2}([a-zA-Z]+): "([^"\n]+)",$/gmu)].map((match) => [match[1], match[2]]);
  return Object.freeze(Object.fromEntries(entries));
}

test("released-client flow: the shipped client transport is granted, reads its capability, reports, then re-runs idempotently", {
  skip: SKIP, timeout: 300_000,
}, () => withProductionHost(async (fixture) => {
  const { m, base, t, port } = fixture;
  await activateThroughAdminHost(m, port);
  const shippedBody = await shippedGrantBody();
  assert.equal(JSON.stringify(shippedBody), V1_GRANT_BODY, "this line's client sends grant v1");
  const device = await enrollAccountlessDevice(fixture);
  await seedPerformanceV12DayManifest(base, { schema: fixture.primarySchema, owner: device, chunkDay: "2026-10-09",
    parserVersion: "unified-rollout-typed-v20" });
  const publicOrigin = m.configuration.PRODUCTION_PUBLIC_ORIGIN;
  // The client's fetch, delivered through the edge: the public origin's URL
  // to the loopback host under the run.app Host with the edge's headers.
  const exchanges = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, publicOrigin);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    const admission = url.pathname === GRANT_PATH ? GRANT_ADMISSION
      : url.pathname === ENVELOPE_KEY_PATH ? null : DEVICE_ADMISSION;
    const answer = await send(port, { method, path: url.pathname + url.search, body: init.body,
      headers: { ...edgeHeaders({ admission }), ...headers } });
    exchanges.push({ method, path: url.pathname, status: answer.status,
      replayed: answer.headers["idempotency-replayed"] ?? null,
      receipt: url.pathname === REPORTS_PATH && answer.status === 202 ? JSON.parse(answer.text) : null });
    return new Response(answer.text, { status: answer.status,
      headers: Object.entries(answer.headers).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value]).map((item) => [name, item])) });
  };
  // The composition's grant step (accountless-contribution.js readAuthorization):
  // the exact body, 200 or 201, and an echo with the same keys and values.
  const grantResponse = await fetchImpl(new URL(GRANT_PATH, publicOrigin), {
    method: "POST", cache: "no-store", credentials: "omit", redirect: "error",
    headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: device.bearer },
    body: JSON.stringify(shippedBody),
  });
  assert.equal(grantResponse.status, 201);
  assert.equal(grantResponse.headers.get("cache-control"), "no-store");
  const echo = await grantResponse.json();
  assert.equal(Object.keys(echo).length, Object.keys(shippedBody).length);
  for (const [key, value] of Object.entries(shippedBody)) assert.equal(echo[key], value, key);
  // The composition's envelope key read, then the shipped envelope factory.
  const readEnvelopeKey = async () => {
    const response = await fetchImpl(new URL(ENVELOPE_KEY_PATH, publicOrigin), {
      method: "GET", headers: { Accept: "application/json" } });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.algorithm, "RSA-OAEP-256");
    assert.equal(value.keyId, KEY_ID);
    return { keyId: value.keyId, publicJwk: value.publicJwk };
  };
  const day = hostDay(-1);
  const records = [syntheticPerformanceRecord({ day, fieldDictionaryVersion: PERFORMANCE_DICTIONARY_2026_09_29 })];
  let state = null;
  const performanceClientTransport = createTelemetryPerformanceClient({
    origin: publicOrigin,
    fetchImpl,
    readAuthorization: async () => device.bearer,
    readPreparedDay: async ({ day: selectedDay }) => prepareTelemetryPerformanceDay({
      records, day: selectedDay, sourceGeneration: "timing:synthetic-released-1",
      sourceDigest: "6".repeat(64), sourceRevision: 1, parserVersion: "unified-rollout-typed-v20" }),
    readState: async () => state,
    saveState: async (value) => { state = value; },
    createEnvelope: async ({ report }) => createTelemetryPerformanceEnvelope({ report, ...await readEnvelopeKey() }),
    sync: runTelemetryPerformanceSync,
  });
  const firstRun = await performanceClientTransport.runDay({ day, nowEpoch: Date.now() });
  assert.equal(firstRun.status, "succeeded");
  assert.equal(firstRun.state.lastOutcome.code, "accepted");
  assert.equal(firstRun.state.cursorDay, day);
  assert.deepEqual(exchanges.map((exchange) => [exchange.method, exchange.path, exchange.status]), [
    ["POST", GRANT_PATH, 201],
    ["GET", CAPABILITIES_PATH, 200],
    ["GET", ENVELOPE_KEY_PATH, 200],
    ["POST", REPORTS_PATH, 202],
  ]);
  assert.equal(exchanges[3].receipt.status, "accepted");
  assert.equal(exchanges[3].receipt.reportRevision, firstRun.reportRevision);
  // The next pass re-sends the same day: the origin answers it idempotently.
  const secondRun = await performanceClientTransport.runDay({ day, nowEpoch: Date.now() });
  assert.equal(secondRun.status, "succeeded");
  assert.equal(secondRun.reportRevision, firstRun.reportRevision);
  const resend = exchanges.at(-1);
  assert.deepEqual([resend.path, resend.status, resend.replayed, resend.receipt.status, resend.receipt.replayed],
    [REPORTS_PATH, 202, "true", "idempotent", true]);
  assert.equal(await tableCount(base, t, "telemetry_performance_reports"), 1);
  assert.equal(await tableCount(base, t, "telemetry_performance_receipts"), 1);
  assert.deepEqual(await refusalCounts(base, t), [], "the released client met no refusal");
  assertCleanLogs(fixture, [...deviceSecrets(device), firstRun.reportRevision]);
}));

// Short timeouts: a lock-based case must fail fast rather than hang if the
// recorder bound were not enforced (each request also has its own deadline).
test("refusal recorder: a locked or failing counter table never changes or delays a refusal past the bound; rows are content-free", {
  skip: SKIP, timeout: 120_000,
}, (context) => withProductionHost(async (fixture) => {
  const { base, t, port } = fixture;
  // Staged: every capability poll is a refusal after authentication.
  const device = await enrollAccountlessDevice(fixture);
  const client = performanceClient(port, device);
  const timed = async () => {
    const started = performance.now();
    const answer = await client.capabilities();
    return { answer, elapsed: performance.now() - started };
  };
  const warm = await timed();
  assert.deepEqual(outcome(warm.answer), BLOCKED);
  const total = async () => (await base.query(`SELECT coalesce(sum(refusals), 0)::int AS n
    FROM ${t("telemetry_performance_refusal_counts")}`)).rows[0].n;
  assert.equal(await total(), 1);

  // A second connection holds ACCESS EXCLUSIVE on the counter table.
  const holder = await base.connect();
  let lockedElapsed;
  try {
    await holder.query("BEGIN");
    await holder.query(`LOCK TABLE ${t("telemetry_performance_refusal_counts")} IN ACCESS EXCLUSIVE MODE`);
    const locked = await timed();
    lockedElapsed = locked.elapsed;
    assert.deepEqual(outcome(locked.answer), BLOCKED, "the refusal is unchanged");
    assert.ok(locked.elapsed < RECORDER_BOUND_MILLISECONDS + RECORDER_SLACK_MILLISECONDS,
      `answered within the recorder bound (${Math.round(locked.elapsed)} ms)`);
    // Hold the lock past the counter's own lock and statement timeouts, so
    // its queued increment is cancelled rather than applied on release.
    await new Promise((wait) => setTimeout(wait, RECORDER_BOUND_MILLISECONDS + 500));
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
  }
  await new Promise((wait) => setTimeout(wait, 250));
  assert.equal(await total(), 1, "the locked refusal left no counter row");

  // A counter write that raises (a trigger standing in for any database
  // failure inside the recorder): the answer is unchanged, nothing counted.
  const trigger = `x1b_refuse_counts_${randomBytes(3).toString("hex")}`;
  await base.query(`CREATE FUNCTION ${t(trigger)}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic counter failure'; END $$`);
  await base.query(`CREATE TRIGGER ${trigger} BEFORE INSERT OR UPDATE ON ${t("telemetry_performance_refusal_counts")}
    FOR EACH ROW EXECUTE FUNCTION ${t(trigger)}()`);
  try {
    const failing = await timed();
    assert.deepEqual(outcome(failing.answer), BLOCKED, "a failing recorder does not change the answer");
    assert.ok(failing.elapsed < RECORDER_BOUND_MILLISECONDS + RECORDER_SLACK_MILLISECONDS);
    // A refusal on another route under the same failure.
    const grant = await client.grant();
    assert.deepEqual(outcome(grant), BLOCKED);
  } finally {
    await base.query(`DROP TRIGGER ${trigger} ON ${t("telemetry_performance_refusal_counts")}`);
    await base.query(`DROP FUNCTION ${t(trigger)}()`);
  }
  assert.equal(await total(), 1, "the failed recordings left no counter row");
  // Recording resumes once the table is healthy.
  assert.deepEqual(outcome((await timed()).answer), BLOCKED);
  assert.equal(await total(), 2);

  // Counter rows carry only day, route id, closed code and status (plus the count).
  const columns = await base.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = 'telemetry_performance_refusal_counts' ORDER BY ordinal_position`,
  [fixture.primarySchema]);
  assert.deepEqual(columns.rows.map((row) => row.column_name), ["day", "route_id", "code", "status", "refusals"]);
  for (const row of await refusalCounts(base, t)) {
    assert.match(row.day, /^\d{4}-\d{2}-\d{2}$/u);
    assert.ok([ROUTE_GRANT, ROUTE_CAPABILITIES, ROUTE_REPORTS].includes(row.route_id));
    assert.match(row.code, /^[A-Z][A-Z0-9_]{1,63}$/u);
    assert.ok(row.status >= 400 && row.status <= 599);
    for (const secret of deviceSecrets(device)) assert.ok(!JSON.stringify(row).includes(secret));
  }
  context.diagnostic(`recorder: unlocked ${Math.round(warm.elapsed)} ms, locked ${Math.round(lockedElapsed)} ms`);
  assertCleanLogs(fixture, deviceSecrets(device));
}));

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

test("hot counter row: concurrent refused capability polls against unrefused reads (measured, staged window)", {
  skip: SKIP, timeout: 120_000,
}, (context) => withProductionHost(async (fixture) => {
  const { base, t, port } = fixture;
  const devices = [];
  for (let index = 0; index < 4; index += 1) devices.push(await enrollAccountlessDevice(fixture));
  const clients = devices.map((device) => performanceClient(port, device));
  // Warm every path once (pool connections, module caches).
  for (const client of clients) {
    assert.deepEqual(outcome(await client.capabilities()), BLOCKED);
    assert.equal((await client.readReports()).status, 200);
  }
  const burst = async (concurrency, call) => {
    const started = performance.now();
    const answers = await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
      const begun = performance.now();
      const answer = await call(clients[index % clients.length]);
      return { answer, elapsed: performance.now() - begun };
    }));
    return { answers, wall: performance.now() - started };
  };
  const summarize = ({ answers, wall }) => {
    const elapsed = answers.map((item) => item.elapsed);
    return { p50: Math.round(percentile(elapsed, 0.5)), p95: Math.round(percentile(elapsed, 0.95)),
      max: Math.round(Math.max(...elapsed)), wall: Math.round(wall) };
  };
  for (const concurrency of [24, 64]) {
    await base.query(`DELETE FROM ${t("telemetry_performance_refusal_counts")}`);
    // Control: the same devices' report reads, which answer 200 and never record.
    const reads = await burst(concurrency, (client) => client.readReports());
    for (const { answer } of reads.answers) assert.equal(answer.status, 200);
    // Refused polls: every one upserts the same (day, route, code, status) row.
    const refused = await burst(concurrency, (client) => client.capabilities());
    for (const { answer } of refused.answers) {
      assert.deepEqual(outcome(answer), BLOCKED, "the same refusal under contention, never a 5xx");
    }
    // Let any increment still queued behind the pool finish or time out.
    await new Promise((wait) => setTimeout(wait, RECORDER_BOUND_MILLISECONDS * 2));
    const rows = await refusalCounts(base, t);
    assert.equal(rows.length, 1, "one hot row");
    assert.equal(rows[0].route_id, ROUTE_CAPABILITIES);
    const counted = rows[0].refusals;
    assert.ok(counted >= 1 && counted <= concurrency, `counted ${counted} of ${concurrency}`);
    const readStats = summarize(reads);
    const refusedStats = summarize(refused);
    // Each refusal waits at most the recorder bound beyond its own queueing.
    assert.ok(refusedStats.max < readStats.max * 4 + RECORDER_BOUND_MILLISECONDS + 2 * RECORDER_SLACK_MILLISECONDS,
      `refused max ${refusedStats.max} ms vs read max ${readStats.max} ms`);
    context.diagnostic(`hot-row measurement, concurrency ${concurrency} over a data pool of 3: `
      + `reads p50 ${readStats.p50} p95 ${readStats.p95} max ${readStats.max} wall ${readStats.wall} ms; `
      + `refused polls p50 ${refusedStats.p50} p95 ${refusedStats.p95} max ${refusedStats.max} `
      + `wall ${refusedStats.wall} ms; counted ${counted}/${concurrency}`);
  }
  assertCleanLogs(fixture, devices.flatMap(deviceSecrets));
}));

/**
 * The analytics-refresh Job's modules as the analytics-v2 gate loads them
 * (the vendored-kernel resolution), and registry entry 1's kernel identity:
 * the sources run unbundled, as in the refresh and model-performance specs.
 */
async function loadAnalyticsModules() {
  if (analyticsModules) return analyticsModules;
  analyticsVite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    plugins: analyticsV2Config.plugins,
    resolve: analyticsV2Config.resolve,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
    logLevel: "silent",
  });
  const load = (path) => analyticsVite.ssrLoadModule(path);
  const store = await load("/src/analytics-v2/store.ts");
  const kernel = store.analyticsV2KernelRegistry()[0];
  analyticsModules = Object.freeze({
    store,
    pipeline: refreshJob.createAnalyticsV2Pipeline({
      owners: await load("/src/analytics-v2/owners.ts"),
      occurrences: await load("/src/analytics-v2/occurrence-source.ts"),
      devices: await load("/src/analytics-v2/devices.ts"),
      queuedDays: await load("/src/analytics-v2/queued-days.ts"),
      ownerSets: await load("/src/analytics-v2/owner-sets.ts"),
      compute: await load("/src/analytics-v2/compute.ts"),
      performance: {
        source: await load("/src/analytics-v2/performance-source.ts"),
        compute: await load("/src/analytics-v2/compute-performance.ts"),
      },
    }),
    kernelIdentity: Object.freeze({ vendorManifestSha256: kernel.vendorManifestSha256,
      computeClosureSha256: kernel.computeClosureSha256, methodVersion: kernel.methodVersion }),
    intake: await load("/src/postgres-admin-performance-intake.ts"),
  });
  return analyticsModules;
}

function refreshEnvironment() {
  const env = { ANALYTICS_V2_TEST_CLOCK: "1", ANALYTICS_V2_MEMORY_BUDGET_MIB: "1024" };
  for (const name of ["PG_TEST_SOCKET", "PG_TEST_PORT", "PG_TEST_USER", "PG_TEST_DATABASE", "PG_TEST_PASSWORD"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function refreshPool(database) {
  assert.equal(database.kind, "local");
  return new pg.Pool({
    host: database.host,
    port: database.port,
    user: database.user,
    database: database.database,
    ...(database.password === undefined ? {} : { password: database.password }),
    ssl: false,
    max: 4,
    connectionTimeoutMillis: 5_000,
    application_name: "x1b-performance-host-refresh",
    options: "-c search_path=pg_catalog",
  });
}

test("admin intake reads a real refresh's performance block: host-admitted reports, the Job, then the admin reader", {
  skip: SKIP, timeout: 300_000,
}, () => withProductionHost(async (fixture) => {
  const { m, base, t, port, keys } = fixture;
  const analytics = await loadAnalyticsModules();
  await activateThroughAdminHost(m, port);
  const device = await enrollAccountlessDevice(fixture);
  const client = performanceClient(port, device);
  assert.equal((await client.grant(v2GrantBody(PERFORMANCE_DICTIONARY_2026_10_10))).status, 201);
  assert.equal((await client.upload(await sealedReport(keys, clientV2Report(m)))).status, 202);
  // The refresh Job (in process, the default pipeline with the performance
  // stage) over this schema at the current instant: the publication ends on
  // the latest completed UTC day, which holds the fixture's day or later.
  const nowIso = new Date().toISOString();
  const run = await refreshJob.runAnalyticsRefresh({
    argv: ["--mode=full", `--schema=${fixture.primarySchema}`, `--now=${nowIso}`],
    env: refreshEnvironment(),
    dependencies: { modules: { store: analytics.store, pipeline: analytics.pipeline }, createPool: refreshPool,
      kernelIdentity: analytics.kernelIdentity },
  });
  assert.equal(run.state, "complete", JSON.stringify(run.state));
  const slots = ["1", "7", "30", "all"].flatMap((period) =>
    ["standard", "fast", "ultrafast"].map((speedMode) => `${period}:${speedMode}`));
  assert.equal(run.performance.reports, 1);
  assert.equal(run.performance.withheld, null);
  assert.equal(run.performance.deferredEmpty, false);
  assert.deepEqual(run.performance.published, slots, "the first run with an included record publishes all 12 slots");
  // The run row's block carries exactly the four keys the admin reader
  // requires (RUN_PERFORMANCE_KEYS); one more key would make it 503.
  const runRow = (await base.query(`SELECT publication -> 'performance' AS performance FROM ${t("analytics_v2_runs")}
    WHERE run_id = $1::uuid`, [run.runId])).rows[0];
  assert.deepEqual(Object.keys(runRow.performance).sort(), ["deferredEmpty", "published", "unchanged", "withheld"]);
  assert.equal(await tableCount(base, t, "analytics_v2_published_performance"), 12);
  // The admin reader (SPD-A1) over the same schema answers, with the run.
  const historySha256 = await m.activation.postgresRuntimeMigrationHistorySha256(
    m.runtimeSchema.POSTGRES_RUNTIME_MIGRATIONS.primary);
  const intake = await analytics.intake.readPostgresAdminPerformanceIntake(base, {
    schema: { primarySchema: fixture.primarySchema },
    nowEpoch: Date.now(),
    routeClasses: { [ROUTE_GRANT]: "performance", [ROUTE_CAPABILITIES]: "performance", [ROUTE_REPORTS]: "performance",
      community_model_performance: "scope" },
    deployment: { sourceCommit: COMMIT, historySha256 },
    contractDictionaries: PERFORMANCE_FIELD_DICTIONARIES,
  });
  assert.equal(intake.schemaVersion, "admin-performance-intake-v0.1");
  assert.deepEqual({ ...intake.publication.lastRun, finishedAt: undefined }, {
    finishedAt: undefined, published: slots, unchanged: [], withheld: null, deferredEmpty: false });
  assert.equal(intake.publication.slots.length, 12);
  assert.equal(intake.reports.current, 1);
  assertCleanLogs(fixture, [...deviceSecrets(device), clientV2Report(m).reportRevision]);
}));
