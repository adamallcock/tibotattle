import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto";
import { lstat, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import pg from "pg";
import {
  canonicalTelemetryV12Json,
  telemetryV11RequiredConsent,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
  telemetryV12DomainManifestDigestInput,
  telemetryV12DayManifestDigestInput,
  telemetryV12RequiredConsent,
  validateTelemetryV12Envelope,
} from "@app-usagemonitor/telemetry-contract";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./cloud-run-iam-test-target.mjs";
import {
  createPostgresTestCommunityDailyDispatch,
  createPostgresTestParticipantDevicesDispatch,
  createPostgresTestPersonalSessionDispatch,
  createPostgresTestV12DayManifestDispatch,
  createPostgresTestHealthDispatch,
  createPostgresTestStorageReceiptCheck,
  dispatchCloudRunHostRequest,
  isPrivatePostgresTestHost,
} from "./postgres-test-dispatch.mjs";
import {
  buildPublicGoogleRequestUrl,
  buildRequestUrl,
  createRequestOriginAllowlist,
  requestOriginForHost,
  sanitizeHeaders,
} from "./request-boundary.mjs";
import { createFilesystemAssets } from "./assets.mjs";
import { nodeTimingSafeEqual } from "./node-crypto-adapter.mjs";
// The shipped desktop client itself, so the dispatch is exercised in the
// client's request order rather than a hand-assembled sequence.
import { runTelemetryV12Sync } from "../../../src/contribution/telemetry-v12-sync.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD;
const WORKER_ROOT = resolve(ROOT, "..");

const ONE_MIGRATION = Object.freeze({
  primary: [{ version: 1, name: "0001_schema_metadata.sql", sha256: "a".repeat(64) }],
});

function quotedTable(schema, name) {
  return `"${schema}"."${name}"`;
}

function deviceSecretHash(deviceId, secret) {
  return createHash("sha256")
    .update(`app-usagemonitor/device/v1\0${deviceId}\0`)
    .update(Buffer.from(secret, "base64url"))
    .digest();
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hostV12UsageRecord(eventId, eventTime) {
  return {
    schemaVersion: "usage-event-v1.2",
    eventId,
    eventTime,
    sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    speedMode: "standard",
    apiServiceTier: "default",
    surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription",
    reasoningEffort: "high",
    agentScope: "root",
    outcome: "completed",
    totalInputContextTokens: 1000,
    components: {
      inputUncachedTokens: 100,
      inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0,
      outputTextTokens: 50,
      outputReasoningTokens: 25,
      outputCombinedTokens: 75,
    },
    accountPlanAttribution: {
      accountBasis: "unavailable",
      accountTrackId: null,
      planBasis: "same_source_occurrence",
      planType: "pro",
      planEraId: null,
    },
    boundaryFlags: null,
    tieOrder: null,
    cacheWriteTtl: null,
  };
}

/** One deterministic local v1.2 day as the desktop reader returns it. A day
 * without records is a complete manifest with no chunks. */
function hostV12ClientDay(day, count, parserVersion) {
  const consent = telemetryV12RequiredConsent();
  const records = Array.from({ length: count }, (_, index) => hostV12UsageRecord(
    `event:v2:${sha256Hex(`host-v12-client:${day}:${index}`)}`,
    `${day}T12:${String(10 + index).padStart(2, "0")}:00.000Z`,
  ));
  const chunks = count === 0 ? [] : [{
    schemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
    manifestDigest: "0".repeat(64),
    chunkId: `usage:${day}:0`,
    chunkRevision: 1,
    chunkDigest: sha256Hex(Buffer.from(canonicalTelemetryV12Json(records))),
    parserVersion,
    consent,
    records,
  }];
  const manifest = {
    schemaVersion: "telemetry-day-manifest-v1.2",
    day,
    parserVersion,
    consent,
    chunks: chunks.map((chunk) => ({
      chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: chunk.records.length,
    })),
    excluded: { quota: 0, session: 0, usage: 0 },
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = sha256Hex(Buffer.from(telemetryV12DayManifestDigestInput(manifest)));
  for (const chunk of chunks) chunk.manifestDigest = manifest.manifestDigest;
  return { manifest, chunks };
}

async function encryptHostV12(value, publicJwk, keyId) {
  const rsaJwk = { ...publicJwk };
  delete rsaJwk.kid;
  const rsa = await webcrypto.subtle.importKey(
    "jwk", rsaJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"],
  );
  const aes = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const rawKey = await webcrypto.subtle.exportKey("raw", aes);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const wrappedKey = await webcrypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, rawKey);
  const ciphertext = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aes,
    new TextEncoder().encode(canonicalTelemetryV12Json(value)),
  );
  new Uint8Array(rawKey).fill(0);
  return {
    schemaVersion: "telemetry-envelope-v1.2",
    synthetic: false,
    keyId,
    wrappedKey: Buffer.from(wrappedKey).toString("base64url"),
    iv: Buffer.from(iv).toString("base64url"),
    ciphertext: Buffer.from(ciphertext).toString("base64url"),
  };
}

function assertApiError(response, status, code) {
  assert.equal(response.status, status);
  return response.json().then((value) => {
    assert.equal(value?.error?.code, code);
    assert.match(value?.error?.requestId ?? "", /^[0-9a-f-]{36}$/u);
    return value;
  });
}

function receiptPool({ major = 17, primaryExists = true, primaryHistory, onConnect = () => {} } = {}) {
  const expectedFor = () => primaryHistory;
  const existsFor = () => primaryExists;
  return function createPool(role) {
    return {
      async connect() {
        onConnect(role);
        return {
          async query(sql) {
            if (sql.startsWith("SELECT current_setting")) {
              // The one shared reader's probe (src/postgres-schema-receipt.ts):
              // the history table's regclass, null when it is absent.
              return { rows: [{ server_version_num: major * 10_000, schema_exists: existsFor(role),
                history: existsFor(role) ? "_tibotattle_migration_history" : null }] };
            }
            if (sql.startsWith("SELECT version, name, checksum_sha256")) {
              const source = expectedFor(role) ?? ONE_MIGRATION[role];
              return {
                rows: source.map((receipt) => ({
                  version: receipt.version,
                  name: receipt.name,
                  checksum_sha256: receipt.checksum_sha256 ?? receipt.sha256,
                })),
              };
            }
            return { rows: [], rowCount: 0 };
          },
          release() {},
        };
      },
    };
  };
}

/**
 * The Worker's upload-ingress policy over the shared PostgreSQL budget, as
 * the origin composes it (D-CRB: the contributions preamble takes the lease
 * with the 60 s / 15 s body policy): the env keys and the injected authority.
 */
async function uploadIngressFixture(vite, primaryPool, primarySchema) {
  const [ingress, budgetModule] = await Promise.all([
    vite.ssrLoadModule("/src/upload-ingress-admission.ts"),
    vite.ssrLoadModule("/src/postgres-ingress-budget.ts"),
  ]);
  const budget = budgetModule.createPostgresUploadIngressBudget(primaryPool, { primarySchema });
  return Object.freeze({
    env: Object.freeze({
      UPLOAD_INGRESS_QUEUE_MODE: "disabled",
      UPLOAD_INGRESS_MAX_CONCURRENT: "8",
      UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE: "1200",
      UPLOAD_INGRESS_BURST: "1200",
      UPLOAD_INGRESS_LEASE_SECONDS: "90",
      UPLOAD_INGRESS_BODY_TOTAL_SECONDS: "60",
      UPLOAD_INGRESS_BODY_IDLE_SECONDS: "15",
      UPLOAD_INGRESS_BUDGET: Object.freeze({ getByName: () => budget }),
    }),
    uploadIngress: Object.freeze({
      assertConfiguration: ingress.assertUploadIngressConfiguration,
      bodyReadPolicy: ingress.uploadIngressBodyReadPolicy,
      acquireLease: ingress.acquireUploadIngressLease,
      startHeartbeat: ingress.startUploadIngressLeaseHeartbeat,
      releaseLease: ingress.releaseUploadIngressLease,
    }),
    budget,
  });
}

async function localPostgresEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "PostgreSQL host checks require a loopback host or private Unix socket");
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  if (PG_TEST_SOCKET) {
    assert.match(PG_TEST_SOCKET, /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
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
  if (PG_TEST_HOST) return { host: PG_TEST_HOST, port: PG_TEST_PORT };
  return null;
}

test("host URL uses the configured origin and rejects mismatched absolute URLs", () => {
  const url = buildRequestUrl("/api/ready?x=1", "test.example", "https://test.example");
  assert.equal(url.href, "https://test.example/api/ready?x=1");
  assert.throws(() => buildRequestUrl("https://evil.example/api/ready", "test.example", "https://test.example"), /REQUEST_HOST_INVALID/);
});

test("only exact Google enrollment paths are rebased to a configured public callback origin", () => {
  const rebased = buildPublicGoogleRequestUrl(
    "/api/v1/identity/google/callback",
    new URL(CLOUD_RUN_IAM_TEST_TARGET.origin).host,
    CLOUD_RUN_IAM_TEST_TARGET.origin,
    "https://tibotattle.example",
    "?state=opaque&code=opaque",
  );
  assert.equal(
    rebased.href,
    "https://tibotattle.example/api/v1/identity/google/callback?state=opaque&code=opaque",
  );
  for (const path of ["/api/health", "/api/v1/admin/action", "/api/v1/enroll/", "/api/v1/me/devices"]) {
    assert.equal(buildPublicGoogleRequestUrl(
      path,
      new URL(CLOUD_RUN_IAM_TEST_TARGET.origin).host,
      CLOUD_RUN_IAM_TEST_TARGET.origin,
      "https://tibotattle.example",
    ), null);
  }
  assert.throws(() => buildPublicGoogleRequestUrl(
    "/api/v1/enroll",
    "attacker.example",
    CLOUD_RUN_IAM_TEST_TARGET.origin,
    "https://tibotattle.example",
  ), /REQUEST_HOST_INVALID/);
  assert.throws(() => buildPublicGoogleRequestUrl(
    "/api/v1/enroll",
    new URL(CLOUD_RUN_IAM_TEST_TARGET.origin).host,
    CLOUD_RUN_IAM_TEST_TARGET.origin,
    CLOUD_RUN_IAM_TEST_TARGET.origin,
  ), /PUBLIC_ORIGIN_INVALID/);
  assert.throws(() => buildPublicGoogleRequestUrl(
    "/api/v1/identity/google/callback?state=raw&code=raw",
    new URL(CLOUD_RUN_IAM_TEST_TARGET.origin).host,
    CLOUD_RUN_IAM_TEST_TARGET.origin,
    "https://tibotattle.example",
  ), /OAUTH_CALLBACK_QUERY_INVALID/);
  assert.throws(() => buildPublicGoogleRequestUrl(
    "/api/v1/enroll",
    new URL(CLOUD_RUN_IAM_TEST_TARGET.origin).host,
    CLOUD_RUN_IAM_TEST_TARGET.origin,
    "https://tibotattle.example",
    "?state=opaque",
  ), /OAUTH_CALLBACK_QUERY_INVALID/);
  assert.equal(sanitizeHeaders({
    "x-tibotattle-google-callback-query": "?state=opaque&code=opaque",
  }).has("x-tibotattle-google-callback-query"), false);
});

test("host allowlist accepts only the configured public and Access admin authorities", () => {
  const allowlist = createRequestOriginAllowlist({
    publicHostOrigin: "https://tibotattle.example",
    canonicalPublicOrigin: "https://tibotattle.example",
    adminHostOrigin: "https://admin.tibotattle.example",
  });
  assert.equal(requestOriginForHost("tibotattle.example", allowlist).kind, "public");
  assert.equal(requestOriginForHost("ADMIN.TIBOTATTLE.EXAMPLE", allowlist).kind, "admin");
  for (const host of ["evil.example", "admin.evil.example", "tibotattle-test.run.app"]) {
    assert.throws(() => requestOriginForHost(host, allowlist), /REQUEST_HOST_INVALID/);
  }
  assert.throws(() => createRequestOriginAllowlist({
    publicHostOrigin: "https://tibotattle-test.run.app",
    canonicalPublicOrigin: "https://tibotattle.example",
    adminHostOrigin: "https://admin.tibotattle.example",
  }), /ADMIN_HOST_ORIGIN_INVALID/);
  assert.throws(() => createRequestOriginAllowlist({
    publicHostOrigin: "https://tibotattle.example",
    canonicalPublicOrigin: "https://tibotattle.example",
    adminHostOrigin: "https://tibotattle-test.run.app",
  }), /ADMIN_HOST_ORIGIN_INVALID/);
});

test("single-host test configuration still accepts only its explicitly configured run.app authority", () => {
  const allowlist = createRequestOriginAllowlist({
    publicHostOrigin: "https://tibotattle-test.run.app",
  });
  assert.equal(requestOriginForHost("tibotattle-test.run.app", allowlist).kind, "public");
  assert.throws(() => requestOriginForHost("other-service.run.app", allowlist), /REQUEST_HOST_INVALID/);
});

test("partial PostgreSQL health dispatch is pinned to an explicit private loopback origin", () => {
  assert.equal(isPrivatePostgresTestHost({
    listenHost: "127.0.0.1", hostOrigin: "http://127.0.0.1:8080", port: 8080,
  }), true);
  for (const value of [
    { listenHost: "0.0.0.0", hostOrigin: "http://127.0.0.1:8080", port: 8080 },
    { listenHost: "127.0.0.1", hostOrigin: "https://127.0.0.1:8080", port: 8080 },
    { listenHost: "127.0.0.1", hostOrigin: "http://tibotattle-test.run.app", port: 8080 },
    { listenHost: "127.0.0.1", hostOrigin: "http://127.0.0.1:8081", port: 8080 },
  ]) assert.equal(isPrivatePostgresTestHost(value), false);
});

test("the retired cloud-run-iam host predicate (OD-6) refuses even the former named service tuple", () => {
  const former = {
    mode: "cloud-run-iam",
    project: CLOUD_RUN_IAM_TEST_TARGET.project,
    region: CLOUD_RUN_IAM_TEST_TARGET.region,
    service: CLOUD_RUN_IAM_TEST_TARGET.service,
    listenHost: CLOUD_RUN_IAM_TEST_TARGET.listenHost,
    hostOrigin: CLOUD_RUN_IAM_TEST_TARGET.origin,
    port: CLOUD_RUN_IAM_TEST_TARGET.port,
  };
  assert.equal(isPrivatePostgresTestHost(former), false);
  for (const override of [
    { mode: "health-only" },
    { mode: undefined },
    { mode: "cloud-run-iam", listenHost: "127.0.0.1", hostOrigin: "http://127.0.0.1:8080" },
  ]) {
    assert.equal(isPrivatePostgresTestHost({ ...former, ...override }), false, JSON.stringify(override));
  }
});

test("Cloud Run IAM test target is pinned to the isolated A2 schema and bucket profile", () => {
  assert.equal(CLOUD_RUN_IAM_TEST_TARGET.postgres.primary.schema, "tibotattle_v12_a2_20260925");
  // The retired A2 ledger identity stays only as a frozen refusal identifier.
  assert.equal(CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger.schema, "tibotattle_ledger_v12_a2_20260925");
  assert.equal(CLOUD_RUN_IAM_TEST_TARGET.gcsBucket, "tibotattle-gcs-test-cleanup-20260925-a2");
});

test("Cloud Run test origin allowlist rejects alternate authorities and forwarded-header spoofing", async () => {
  const allowlist = createRequestOriginAllowlist({
    publicHostOrigin: CLOUD_RUN_IAM_TEST_TARGET.origin,
  });
  assert.equal(
    requestOriginForHost("tibotattle-test-app-5t5mehqi7a-ue.a.run.app", allowlist).origin,
    CLOUD_RUN_IAM_TEST_TARGET.origin,
  );
  for (const host of [
    "other-service-5t5mehqi7a-ue.a.run.app",
    "tibotattle-test-app-806510610397.us-east1.run.app",
    "tibotattle-test-app-5t5mehqi7a-ue.a.run.app:443",
    "tibotattle-test-app-5t5mehqi7a-ue.a.run.app.evil.example",
  ]) assert.throws(() => requestOriginForHost(host, allowlist), /REQUEST_HOST_INVALID/);

  const sanitized = sanitizeHeaders({
    "x-forwarded-host": "tibotattle-test-app-5t5mehqi7a-ue.a.run.app",
    "x-forwarded-proto": "https",
    "x-serverless-authorization": "Bearer caller-controlled",
  });
  assert.equal(sanitized.has("x-forwarded-host"), false);
  assert.equal(sanitized.has("x-forwarded-proto"), false);
  assert.equal(sanitized.has("x-serverless-authorization"), false);

  let connections = 0;
  const pools = receiptPool({ onConnect: () => { connections += 1; } });
  const loopback = "http://127.0.0.1:8080";
  const dispatch = createPostgresTestHealthDispatch({
    primaryPool: pools("primary"),
    expectedMigrations: ONE_MIGRATION,
    privateOrigin: loopback,
  });
  for (const request of [
    new Request("https://other-service-5t5mehqi7a-ue.a.run.app/api/health"),
    new Request(`${CLOUD_RUN_IAM_TEST_TARGET.origin}/api/health`),
    new Request(`${loopback}/api/not-implemented`),
    new Request(`${loopback}/api/health`, { method: "POST" }),
  ]) {
    assert.equal((await dispatch(request)).status, 503);
  }
  assert.equal(connections, 0, "wrong origins and unimplemented direct requests cannot touch PostgreSQL");

  // The retired cloud-run-iam service origin (OD-6) is no longer a private
  // test origin, like any other run.app origin.
  for (const privateOrigin of [CLOUD_RUN_IAM_TEST_TARGET.origin, "https://other-service-5t5mehqi7a-ue.a.run.app"]) {
    assert.throws(() => createPostgresTestHealthDispatch({
      primaryPool: pools("primary"),
      expectedMigrations: ONE_MIGRATION,
      privateOrigin,
    }), /POSTGRES_TEST_PRIVATE_ORIGIN_INVALID/, privateOrigin);
  }
});

test("partial HTTP dispatch serves only current read-only health and never calls the Worker or D1", async () => {
  let connections = 0;
  let d1Touched = 0;
  let workerHandlerCalls = 0;
  const pools = receiptPool({ onConnect: () => { connections += 1; } });
  const healthDispatch = createPostgresTestHealthDispatch({
    primaryPool: pools("primary"),
    schemaOptions: { primarySchema: "tibotattle_test" },
    expectedMigrations: ONE_MIGRATION,
    privateOrigin: "http://127.0.0.1:8080",
  });
  const runtime = {
    postgresTestHealthDispatch: healthDispatch,
    get env() {
      d1Touched += 1;
      throw new Error("D1 must remain unreachable in partial mode");
    },
  };
  const workerHandler = async () => {
    workerHandlerCalls += 1;
    throw new Error("Worker handler must remain unreachable in partial mode");
  };

  for (const request of [
    new Request("http://127.0.0.1:8080/api/v1/contribute", { method: "POST" }),
    new Request("http://127.0.0.1:8080/api/health", { method: "POST" }),
    new Request("http://127.0.0.1:8080/api/admin/action", { method: "POST" }),
    new Request("http://other-host:8080/api/health", { method: "GET" }),
  ]) {
    const response = await dispatchCloudRunHostRequest(request, runtime, workerHandler);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: "not_ready",
      error: "POSTGRES_TEST_ROUTE_UNSUPPORTED",
    });
  }
  assert.equal(connections, 0);
  assert.equal(workerHandlerCalls, 0);
  assert.equal(d1Touched, 0);

  const response = await dispatchCloudRunHostRequest(
    new Request("http://127.0.0.1:8080/api/health"), runtime, workerHandler,
  );
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.deepEqual(health, {
    schemaVersion: "gcp-postgres-test-health-v2",
    scope: "postgres_schema_and_migrations_only",
    status: "ready",
    workerApplicationReady: false,
    checks: {
      postgresMajor: 17,
      primaryMigrationReceipt: { status: "current", version: 1 },
    },
  });
  assert.equal(JSON.stringify(health).includes("tibotattle_test"), false);
  assert.equal(connections, 1, "one pool: there is no deletion-ledger receipt");
  assert.equal(workerHandlerCalls, 0);
  assert.equal(d1Touched, 0);
});

test("private community daily dispatch validates ranges and exposes only the fenced activity projection", async () => {
  let reads = 0;
  let healthChecks = 0;
  let d1Touched = 0;
  let workerCalls = 0;
  const primaryPool = { async connect() { throw new Error("the public reader facade owns PG access"); } };
  const dailyRead = async (pool, options) => {
    reads += 1;
    assert.equal(pool, primaryPool);
    assert.deepEqual(options, {
      sourceId: "synthetic-source",
      sourceNamespace: "synthetic-namespace",
      fromDay: "2026-09-24",
      throughDay: "2026-09-24",
      schema: { primarySchema: "daily_test" },
    });
    return {
      allowanceReadState: "confirmed",
      rows: [{
        day: "2026-09-24",
        revision: 4,
        released_at: "2026-09-25T12:00:00.000Z",
        payload_json: JSON.stringify({
          schemaVersion: "community-daily-aggregate-v1.0",
          day: "2026-09-24",
          revision: 4,
          totals: { usageEvents: 2 },
          allowance: { private: "must-not-cross" },
          capacityByPlanType: { private: "must-not-cross" },
        }),
      }],
    };
  };
  const healthDispatch = async (request) => {
    healthChecks += 1;
    assert.equal(request.url, "http://127.0.0.1:8080/api/health");
    return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
  };
  const dailyDispatch = createPostgresTestCommunityDailyDispatch({
    primaryPool,
    schemaOptions: { primarySchema: "daily_test" },
    sourceIdentity: { sourceId: "synthetic-source", sourceNamespace: "synthetic-namespace" },
    readPostgresPublishedCommunityDaily: dailyRead,
    healthDispatch,
    privateOrigin: "http://127.0.0.1:8080",
  });
  const runtime = {
    postgresTestDispatch: dailyDispatch,
    get env() { d1Touched += 1; throw new Error("D1 must remain unreachable"); },
  };
  const workerHandler = async () => { workerCalls += 1; throw new Error("Worker must not be called"); };

  for (const url of [
    "http://other-host:8080/api/v1/community/daily?from=2026-09-24&to=2026-09-24",
    "http://127.0.0.1:8080/api/v1/community/daily?from=2026-09-24&to=2026-09-24&extra=1",
    "http://127.0.0.1:8080/api/v1/community/daily?from=2026-09-24&from=2026-09-24&to=2026-09-24",
    "http://127.0.0.1:8080/api/v1/community/daily?from=2026-09-24&to=2027-09-25",
  ]) {
    const response = await dispatchCloudRunHostRequest(new Request(url), runtime, workerHandler);
    assert.notEqual(response.status, 200);
  }
  assert.equal(reads, 0);

  const wrongMethod = await dispatchCloudRunHostRequest(new Request(
    "http://127.0.0.1:8080/api/v1/community/daily?from=2026-09-24&to=2026-09-24",
    { method: "POST" },
  ), runtime, workerHandler);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");

  const response = await dispatchCloudRunHostRequest(new Request(
    "http://127.0.0.1:8080/api/v1/community/daily?from=2026-09-24&to=2026-09-24",
  ), runtime, workerHandler);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    schemaVersion: "community-daily-read-v1.0",
    from: "2026-09-24",
    to: "2026-09-24",
    allowanceState: "updating",
    allowanceReadState: "confirmed",
    days: [{
      day: "2026-09-24",
      revision: 4,
      releasedAt: "2026-09-25T12:00:00.000Z",
      payload: {
        schemaVersion: "community-daily-aggregate-v1.0",
        day: "2026-09-24",
        revision: 4,
        totals: { usageEvents: 2 },
      },
    }],
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(reads, 1);
  assert.equal(healthChecks, 1);
  assert.equal(workerCalls, 0);
  assert.equal(d1Touched, 0);
});

test("private community daily dispatch withholds unavailable PostgreSQL data and checks migration readiness", async () => {
  let reads = 0;
  const makeDispatch = (healthStatus, reader) => createPostgresTestCommunityDailyDispatch({
    primaryPool: { async connect() { throw new Error("reader facade owns PG access"); } },
    schemaOptions: { primarySchema: "daily_test" },
    sourceIdentity: { sourceId: "synthetic-source", sourceNamespace: "synthetic-namespace" },
    readPostgresPublishedCommunityDaily: reader,
    healthDispatch: async () => new Response(null, { status: healthStatus }),
    privateOrigin: "http://127.0.0.1:8080",
  });
  const request = new Request(
    "http://127.0.0.1:8080/api/v1/community/daily?from=2026-09-24&to=2026-09-24",
  );
  const stale = await makeDispatch(503, async () => { reads += 1; return { rows: [] }; })(request);
  assert.equal(stale.status, 503);
  assert.equal(reads, 0, "daily reader is not reached when migration health is stale");

  const unavailable = await makeDispatch(200, async () => {
    reads += 1;
    throw new Error("unavailable");
  })(request);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "BACKEND_STORAGE_UNAVAILABLE");
  assert.equal(reads, 1);
});

test("private participant-device dispatch preserves cookie auth, owner scope, and private readiness", async () => {
  let healthChecks = 0;
  let authCalls = 0;
  let deviceReads = 0;
  let csrfChecks = 0;
  let deviceRevocations = 0;
  let revocationResult = true;
  let workerCalls = 0;
  const primaryPool = { async connect() { throw new Error("the PostgreSQL facades own reads"); } };
  const healthDispatch = async () => {
    healthChecks += 1;
    return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
  };
  const dispatch = createPostgresTestParticipantDevicesDispatch({
    primaryPool,
    schemaOptions: { primarySchema: "devices_test" },
    authenticatePostgresPersonalSession: async (pool, cookie, options) => {
      authCalls += 1;
      assert.equal(pool, primaryPool);
      assert.equal(cookie, "__Host-usage_monitor_session=synthetic-session");
      assert.deepEqual(options, { schema: { primarySchema: "devices_test" } });
      return { participantId: "synthetic-owner-a", csrfToken: "synthetic-csrf-token" };
    },
    assertPostgresPersonalSessionCsrf: (request, csrfToken) => {
      csrfChecks += 1;
      if (new URL(request.url).origin !== request.headers.get("origin")
          || request.headers.get("sec-fetch-site") !== "same-origin"
          || request.headers.get("x-usage-monitor-csrf") !== csrfToken) {
        throw Object.assign(new Error("CSRF_INVALID"), { code: "CSRF_INVALID", status: 403 });
      }
    },
    listPostgresParticipantDevices: async (pool, participantId, options) => {
      deviceReads += 1;
      assert.equal(pool, primaryPool);
      assert.equal(participantId, "synthetic-owner-a");
      assert.deepEqual(options, { schema: { primarySchema: "devices_test" } });
      return [{
        deviceId: "synthetic-owner-a-device",
        state: "active",
        createdAt: "2026-09-25T12:00:00.000Z",
        expiresAt: "2026-10-25T12:00:00.000Z",
        lastUsedAt: "2026-09-25T12:30:00.000Z",
        revokedAt: null,
      }];
    },
    revokePostgresParticipantDevice: async (pool, participantId, deviceId, options) => {
      deviceRevocations += 1;
      assert.equal(pool, primaryPool);
      assert.equal(participantId, "synthetic-owner-a");
      assert.equal(typeof deviceId, "string");
      assert.deepEqual(options, { schema: { primarySchema: "devices_test" } });
      return revocationResult;
    },
    readBoundedRequestBody: async (request, maximumBytes) => {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > maximumBytes) {
        throw Object.assign(new Error("BODY_TOO_LARGE"), {
          code: "BODY_TOO_LARGE", status: 413,
        });
      }
      return bytes;
    },
    maxRequestBytes: 2 * 1024 * 1024,
    healthDispatch,
    privateOrigin: "http://127.0.0.1:8080",
  });
  const runtime = {
    postgresTestDispatch: dispatch,
    get env() { throw new Error("D1 must remain unreachable"); },
  };
  const workerHandler = async () => { workerCalls += 1; throw new Error("Worker must not be called"); };
  const path = "http://127.0.0.1:8080/api/v1/me/devices";
  const revokePath = "http://127.0.0.1:8080/api/v1/me/devices/revoke";

  const wrongOrigin = await dispatchCloudRunHostRequest(
    new Request("http://other-host:8080/api/v1/me/devices"), runtime, workerHandler,
  );
  assert.equal(wrongOrigin.status, 503);
  assert.equal(authCalls, 0);

  const wrongMethod = await dispatchCloudRunHostRequest(
    new Request(path, { method: "POST" }), runtime, workerHandler,
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");

  const wrongRevokeMethod = await dispatchCloudRunHostRequest(
    new Request(revokePath), runtime, workerHandler,
  );
  assert.equal(wrongRevokeMethod.status, 405);
  assert.equal(wrongRevokeMethod.headers.get("allow"), "POST");

  const revokeAuthorization = await dispatchCloudRunHostRequest(new Request(revokePath, {
    method: "POST",
    headers: {
      cookie: "__Host-usage_monitor_session=synthetic-session",
      authorization: "Bearer device-capability",
    },
  }), runtime, workerHandler);
  await assertApiError(revokeAuthorization, 401, "AUTH_INVALID");
  assert.equal(authCalls, 0, "capability Authorization is rejected before session or database reads");

  const authorization = await dispatchCloudRunHostRequest(new Request(path, {
    headers: {
      cookie: "__Host-usage_monitor_session=synthetic-session",
      authorization: "Bearer device-capability",
    },
  }), runtime, workerHandler);
  assert.equal((await assertApiError(authorization, 401, "AUTH_INVALID")).error.code, "AUTH_INVALID");
  assert.equal(authCalls, 0, "Authorization is rejected before session or database reads");

  const response = await dispatchCloudRunHostRequest(new Request(
    `${path}?participantId=synthetic-owner-b`,
    { headers: { cookie: "__Host-usage_monitor_session=synthetic-session" } },
  ), runtime, workerHandler);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("vary"), "Cookie");
  const body = await response.json();
  assert.equal(body.devices.length, 1);
  assert.equal(body.devices[0].deviceId, "synthetic-owner-a-device");
  assert.equal(JSON.stringify(body).includes("synthetic-owner-b"), false,
    "query parameters cannot choose or reveal another participant's devices");
  assert.equal(healthChecks, 1);
  assert.equal(authCalls, 1);
  assert.equal(deviceReads, 1);
  assert.equal(workerCalls, 0);

  const revokeRequest = (body, overrides = {}) => new Request(revokePath, {
    method: "POST",
    headers: {
      cookie: "__Host-usage_monitor_session=synthetic-session",
      origin: "http://127.0.0.1:8080",
      "sec-fetch-site": "same-origin",
      "x-usage-monitor-csrf": "synthetic-csrf-token",
      "content-type": "application/json",
      ...overrides,
    },
    body,
  });
  const csrfRejected = await dispatchCloudRunHostRequest(
    revokeRequest(JSON.stringify({ deviceId: "synthetic-owner-a-device" }), {
      "x-usage-monitor-csrf": "wrong-token",
    }),
    runtime,
    workerHandler,
  );
  await assertApiError(csrfRejected, 403, "CSRF_INVALID");
  assert.equal(deviceRevocations, 0, "the adapter must not mutate before valid CSRF");

  const invalidBody = await dispatchCloudRunHostRequest(
    revokeRequest(JSON.stringify({
      deviceId: "synthetic-owner-a-device",
      unexpected: true,
    })),
    runtime,
    workerHandler,
  );
  await assertApiError(invalidBody, 400, "BODY_INVALID");
  assert.equal(deviceRevocations, 0, "closed body validation precedes the mutation");

  const revoked = await dispatchCloudRunHostRequest(
    revokeRequest(JSON.stringify({ deviceId: "synthetic-owner-a-device" })),
    runtime,
    workerHandler,
  );
  assert.equal(revoked.status, 200);
  assert.equal(revoked.headers.get("vary"), "Cookie");
  assert.deepEqual(await revoked.json(), {
    revoked: true,
    deviceId: "synthetic-owner-a-device",
  });
  assert.equal(csrfChecks, 3);
  assert.equal(deviceRevocations, 1);

  revocationResult = false;
  const wrongOwner = await dispatchCloudRunHostRequest(
    revokeRequest(JSON.stringify({ deviceId: "synthetic-owner-b-device" })),
    runtime,
    workerHandler,
  );
  await assertApiError(wrongOwner, 404, "DEVICE_NOT_FOUND");
  assert.equal(deviceRevocations, 2);
  assert.equal(workerCalls, 0);

  const staleReadiness = createPostgresTestParticipantDevicesDispatch({
    primaryPool,
    schemaOptions: { primarySchema: "devices_test" },
    authenticatePostgresPersonalSession: async () => { throw new Error("must not authenticate when stale"); },
    assertPostgresPersonalSessionCsrf: () => { throw new Error("must not check CSRF when stale"); },
    listPostgresParticipantDevices: async () => { throw new Error("must not read when stale"); },
    revokePostgresParticipantDevice: async () => { throw new Error("must not mutate when stale"); },
    readBoundedRequestBody: async () => { throw new Error("must not read body when stale"); },
    maxRequestBytes: 2 * 1024 * 1024,
    healthDispatch: async () => new Response(null, { status: 503 }),
    privateOrigin: "http://127.0.0.1:8080",
  });
  const notReady = await staleReadiness(new Request(path, {
    headers: { cookie: "__Host-usage_monitor_session=synthetic-session" },
  }));
  assert.equal(notReady.status, 503);
  assert.equal((await notReady.json()).error.code, "BACKEND_STORAGE_UNAVAILABLE");
});

test("private-host envelope-key is public-only and bypasses PostgreSQL and Worker fallback", async () => {
  let postgresConnections = 0;
  let projectionCalls = 0;
  let workerCalls = 0;
  const pool = { async connect() { postgresConnections += 1; throw new Error("must not connect"); } };
  const projectedKey = {
    algorithm: "RSA-OAEP-256",
    keyId: "key:private-host-check",
    publicJwk: {
      alg: "RSA-OAEP-256", e: "AQAB", key_ops: ["encrypt"],
      kid: "key:private-host-check", kty: "RSA", n: "synthetic-public-modulus", use: "enc",
    },
  };
  const dispatch = createPostgresTestV12DayManifestDispatch({
    primaryPool: pool,
    expectedMigrations: ONE_MIGRATION,
    privateOrigin: "http://127.0.0.1:8080",
    healthDispatch: async () => new Response(null, { status: 503 }),
    admissionEnv: {},
    assertAdmissionBindings() {},
    assertAttemptAllowed: async () => {},
    assertUploadAuthorizationBindings() {},
    assertUploadAuthorizationAllowed: async () => {},
    authenticatePostgresDevice: async () => { throw new Error("must not authenticate"); },
    disconnectPostgresAuthenticatedDevice: async () => {
      throw new Error("must not disconnect");
    },
    readPostgresDeviceSyncState: async () => ({}),
    readPostgresDeviceSyncCapabilities: async () => ({}),
    readPostgresDeviceSyncV12Capabilities: async () => ({}),
    readPostgresV12DayCandidates: async () => ({}),
    createPostgresTypedV12Domain: () => ({
      async createPredecessor() { throw new Error("must not create predecessor"); },
      async activate() { throw new Error("must not activate domain"); },
    }),
    async readPostgresTelemetryV12EffectivePage() {
      throw new Error("must not read a page for envelope-key");
    },
    publicEnvelopeKey(raw) {
      projectionCalls += 1;
      assert.equal(raw, '{"synthetic":"public-key-config"}');
      return projectedKey;
    },
    sourceNamespace: "synthetic-host-source",
    assertPostgresV12UploadAllowed: async () => {},
    createPostgresDeviceUploadAuthorization: async () => ({}),
    registerPostgresTypedV12DayManifest: async () => ({}),
    claimPostgresDeviceUploadAuthorization: async () => ({}),
    abandonPostgresDeviceUploadAuthorization: async () => {},
    persistPostgresTypedV12StagedChunk: async () => ({}),
    decryptSyntheticEnvelope: async () => ({}),
    validateTelemetryV12Envelope() {},
    validateTelemetryV12StagedChunk: async () => ({}),
    sha256Hex: async () => "0".repeat(64),
    objectStore: { async put() {}, async delete() {} },
    envelopePublicJwk: '{"synthetic":"public-key-config"}',
    envelopePrivateJwk: "synthetic-private-key-config",
    readBoundedRequestBody: async () => new Uint8Array(),
    maxRequestBytes: 1_024,
  });
  const runtime = { postgresTestDispatch: dispatch };
  const workerHandler = async () => {
    workerCalls += 1;
    throw new Error("private host must not fall back to the Worker");
  };

  const response = await dispatchCloudRunHostRequest(
    new Request("http://127.0.0.1:8080/api/v1/envelope-key"), runtime, workerHandler,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), projectedKey);
  assert.equal(Object.hasOwn(projectedKey.publicJwk, "d"), false);
  const wrongMethod = await dispatch(new Request("http://127.0.0.1:8080/api/v1/envelope-key", {
    method: "POST",
  }));
  await assertApiError(wrongMethod, 405, "METHOD_NOT_ALLOWED");
  assert.equal(wrongMethod.headers.get("allow"), "GET");
  const wrongOrigin = await dispatch(new Request("http://127.0.0.2:8080/api/v1/envelope-key"));
  assert.equal(wrongOrigin.status, 503);
  const unconfiguredRenewal = await dispatch(new Request(
    "http://127.0.0.1:8080/api/v1/device/credential/renew",
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  ));
  assert.equal(unconfiguredRenewal.status, 503,
    "credential renewal stays closed unless its PostgreSQL authority adapter is wired");
  assert.deepEqual(await unconfiguredRenewal.json(), {
    status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED",
  });
  assert.equal(postgresConnections, 0);
  assert.equal(projectionCalls, 1);
  assert.equal(workerCalls, 0);
});

test("partial HTTP health fails closed when the database or its receipt is unavailable or stale", async () => {
  const currentHistory = ONE_MIGRATION.primary;
  const staleHistory = [{ ...currentHistory[0], sha256: "c".repeat(64) }];
  const pools = receiptPool({ primaryHistory: staleHistory });
  const dispatch = createPostgresTestHealthDispatch({
    primaryPool: pools("primary"),
    schemaOptions: { primarySchema: "health_primary" },
    expectedMigrations: ONE_MIGRATION,
    privateOrigin: "http://127.0.0.1:8080",
  });
  const stale = await dispatch(new Request("http://127.0.0.1:8080/api/health"));
  assert.equal(stale.status, 503);
  assert.deepEqual((await stale.json()).checks, {
    postgresMajor: 17,
    primaryMigrationReceipt: { status: "receipt_mismatch", version: 1 },
  });

  const missingPools = receiptPool({ primaryExists: false });
  const missing = createPostgresTestHealthDispatch({
    primaryPool: missingPools("primary"),
    schemaOptions: { primarySchema: "health_primary" },
    expectedMigrations: ONE_MIGRATION,
    privateOrigin: "http://127.0.0.1:8080",
  });
  const missingResponse = await missing(new Request("http://127.0.0.1:8080/api/health"));
  assert.equal(missingResponse.status, 503);
  assert.equal((await missingResponse.json()).checks.primaryMigrationReceipt.status, "schema_missing");

  // The health and storage gate take one pool and the primary manifest only:
  // a stale composition that passes a second pool, a second schema or a
  // second manifest role is refused at construction (LEAD-SIMP).
  const current = receiptPool({ primaryHistory: currentHistory });
  const base = {
    primaryPool: current("primary"),
    schemaOptions: { primarySchema: "health_primary" },
    expectedMigrations: ONE_MIGRATION,
    privateOrigin: "http://127.0.0.1:8080",
  };
  for (const [label, override, code] of [
    ["a second pool", { secondaryPool: current("primary") }, "POSTGRES_TEST_POOLS_INVALID"],
    ["a second schema", { schemaOptions: { primarySchema: "health_primary", secondarySchema: "health_other" } },
      "POSTGRES_TEST_SCHEMA_CONFIGURATION_INVALID"],
    ["a second manifest role", { expectedMigrations: { ...ONE_MIGRATION, secondary: ONE_MIGRATION.primary } },
      "POSTGRES_TEST_PRIMARY_MIGRATION_RECEIPT_INVALID"],
    ["no primary pool", { primaryPool: undefined }, "POSTGRES_TEST_POOLS_INVALID"],
  ]) {
    assert.throws(() => createPostgresTestHealthDispatch({ ...base, ...override }),
      (error) => error?.code === code, label);
    const { privateOrigin: _origin, ...gateBase } = base;
    assert.throws(() => createPostgresTestStorageReceiptCheck({ ...gateBase, ...override }),
      (error) => error?.code === code, `storage gate: ${label}`);
  }
});

test("host startup keeps loopback modes and rejects missing or mismatched Cloud Run identity/config", async () => {
  const temporary = await mkdtemp(join(ROOT, ".tmp-postgres-health-host-"));
  try {
    const result = await build({
      entryPoints: [resolve(ROOT, "server.mjs")],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      write: false,
      external: ["@google-cloud/cloud-sql-connector", "google-auth-library", "jsonc-parser", "pg"],
      logLevel: "silent",
    });
    const output = result.outputFiles?.[0]?.contents;
    assert.ok(output instanceof Uint8Array);
    const bundlePath = join(temporary, "server.mjs");
    await writeFile(bundlePath, output);
    const serverModule = await import(`${pathToFileURL(bundlePath).href}?test=${randomUUID()}`);
    const baseEnv = { ...process.env };
    for (const name of ["POSTGRES_TEST_HTTP_MODE", "HOST", "HOST_ORIGIN", "PUBLIC_ORIGIN",
      "ADMIN_HOST_ORIGIN", "PORT", "K_SERVICE", "PRIMARY_DATABASE",
      "PRIMARY_INSTANCE_CONNECTION_NAME", "POSTGRES_IAM_USER",
      "POSTGRES_SCHEDULED_MAINTENANCE_ENABLED", "ENROLLMENT_MODE", "IDENTITY_LINK_SECRET",
      "IDENTITY_LINK_SECRET_VERSION", "GOOGLE_OIDC_CLIENT_ID", "GOOGLE_OIDC_CLIENT_SECRET",
      "SIGN_IN_START_MAX_PER_MINUTE", "HOST_MODE", "DEPLOYMENT_SOURCE_COMMIT", "LEDGER_DATABASE"]) {
      delete baseEnv[name];
    }
    const blocked = spawnSync(process.execPath, [bundlePath], {
      cwd: ROOT,
      env: baseEnv,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(blocked.status, 1);
    assert.deepEqual(JSON.parse(blocked.stderr.trim()), {
      status: "error",
      code: "POSTGRES_WORKER_REQUEST_PATH_UNSUPPORTED",
    });

    const scheduledDisabled = spawnSync(process.execPath, [bundlePath, "--scheduled"], {
      cwd: ROOT,
      env: { ...baseEnv, POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "disabled" },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(scheduledDisabled.status, 1);
    assert.deepEqual(JSON.parse(scheduledDisabled.stderr.trim()), {
      status: "error",
      code: "POSTGRES_SCHEDULED_MAINTENANCE_DISABLED",
    }, "the opt-in gate must stop the scheduled CLI before runtime configuration");

    // OD-4 (answered 2026-10-02) fixed the report shape, so the enabled
    // scheduled CLI no longer refuses on a policy: it goes on to compose its
    // one database and stops at the first missing setting. A stale ledger
    // setting is refused first.
    const scheduledEnabled = spawnSync(process.execPath, [bundlePath, "--scheduled"], {
      cwd: ROOT,
      env: { ...baseEnv, POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "enabled" },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(scheduledEnabled.status, 1);
    assert.deepEqual(JSON.parse(scheduledEnabled.stderr.trim()), {
      status: "error",
      code: "PRIMARY_DATABASE_MISSING",
    });
    assert.equal(Object.hasOwn(serverModule, "POSTGRES_MAINTENANCE_REPORT_POLICY"), false,
      "OD-4: the injected report policy is retired");
    const scheduledWithLedger = spawnSync(process.execPath, [bundlePath, "--scheduled"], {
      cwd: ROOT,
      env: { ...baseEnv, POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "enabled", LEDGER_DATABASE: "synthetic_ledger" },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(scheduledWithLedger.status, 1);
    assert.deepEqual(JSON.parse(scheduledWithLedger.stderr.trim()), {
      status: "error",
      code: "POSTGRES_LEDGER_CONFIGURATION_RETIRED",
    });

    for (const mode of ["health-only", "health-and-v12-day-manifest"]) {
      const publicBind = spawnSync(process.execPath, [bundlePath], {
        cwd: ROOT,
        env: {
          ...baseEnv,
          POSTGRES_TEST_HTTP_MODE: mode,
          HOST: "0.0.0.0",
          HOST_ORIGIN: "http://127.0.0.1:8080",
          PORT: "8080",
        },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(publicBind.status, 1);
      assert.deepEqual(JSON.parse(publicBind.stderr.trim()), {
        status: "error",
        code: "POSTGRES_TEST_PRIVATE_HOST_CONFIGURATION_INVALID",
      });
    }

    // The cloud-run-iam host mode is retired (owner decision OD-6): its former
    // fully qualified environment is refused like any unknown mode, before
    // any database setting is read.
    assert.equal(Object.hasOwn(serverModule, "validateCloudRunIamTestResources"), false);
    const formerCloudRunEnv = {
      ...baseEnv,
      POSTGRES_TEST_HTTP_MODE: "cloud-run-iam",
      HOST: CLOUD_RUN_IAM_TEST_TARGET.listenHost,
      PORT: String(CLOUD_RUN_IAM_TEST_TARGET.port),
      HOST_ORIGIN: CLOUD_RUN_IAM_TEST_TARGET.origin,
      K_SERVICE: CLOUD_RUN_IAM_TEST_TARGET.service,
    };
    for (const environment of [formerCloudRunEnv, { ...formerCloudRunEnv, PUBLIC_ORIGIN: "https://tibotattle.example" }]) {
      const retired = spawnSync(process.execPath, [bundlePath], {
        cwd: ROOT,
        env: environment,
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(retired.status, 1);
      assert.deepEqual(JSON.parse(retired.stderr.trim()), {
        status: "error",
        code: "POSTGRES_TEST_HTTP_MODE_INVALID",
      });
    }

    // HOST_MODE (D-CRB): an unknown value and a test mode beside it are
    // refused first; the maintenance CLI and the owner fixture commands are
    // never the request-serving origin's; with a valid mode, CR-3 alone
    // configures it and its codes pass through (a set-but-empty test mode,
    // a ledger setting, the first missing setting).
    for (const [label, args, environment, code] of [
      ["an unknown mode", [], { HOST_MODE: "preview" }, "HOST_MODE_INVALID"],
      ["a test mode beside it", [], { HOST_MODE: "production", POSTGRES_TEST_HTTP_MODE: "fastpath-test" },
        "HOST_MODE_CONFLICT"],
      ["the scheduled CLI", ["--scheduled"], { HOST_MODE: "production",
        POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "enabled" }, "POSTGRES_SCHEDULED_HOST_MODE_FORBIDDEN"],
      ["the owner bootstrap", ["--bootstrap-owner"], { HOST_MODE: "staging" }, "HOST_MODE_COMMAND_UNSUPPORTED"],
      ["the owner session refresh", ["--refresh-owner-session"], { HOST_MODE: "production" },
        "HOST_MODE_COMMAND_UNSUPPORTED"],
      ["an empty test mode", [], { HOST_MODE: "production", POSTGRES_TEST_HTTP_MODE: "" },
        "POSTGRES_TEST_HTTP_MODE_FORBIDDEN"],
      ["a ledger setting", [], { HOST_MODE: "production", LEDGER_DATABASE: "synthetic_ledger" },
        "LEDGER_DATABASE_FORBIDDEN"],
      ["no settings", [], { HOST_MODE: "production" }, "DEPLOYMENT_SOURCE_COMMIT_MISSING"],
    ]) {
      const refused = spawnSync(process.execPath, [bundlePath, ...args], {
        cwd: ROOT,
        env: { ...baseEnv, ...environment },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(refused.status, 1, label);
      assert.deepEqual(JSON.parse(refused.stderr.trim()), { status: "error", code }, label);
    }
    // Without a test mode or HOST_MODE no request path exists: the dispatch
    // answers the closed 503 and never reaches a Worker handler.
    const unsupported = await dispatchCloudRunHostRequest(
      new Request("http://127.0.0.1:8080/api/v1/community/daily"), {});
    assert.equal(unsupported.status, 503);
    const unsupportedBody = await unsupported.json();
    assert.equal(unsupportedBody.error.code, "POSTGRES_REQUEST_PATH_UNSUPPORTED");
    assert.match(unsupportedBody.error.requestId, /^[0-9a-f-]{36}$/u);

    const proof = (bucket, extra = {}) => JSON.stringify({
      bucket,
      bucketGeneration: "1",
      bucketMetageneration: "1",
      softDeleteRetentionDurationSeconds: "0",
      ...extra,
    });
    const resourceBucket = "synthetic-origin-quarantine";
    const resourceEnv = {
      POSTGRES_TEST_HTTP_MODE: "health-and-v12-day-manifest",
      HOST: "127.0.0.1",
      PORT: "8080",
      HOST_ORIGIN: "http://127.0.0.1:8080",
      PRIMARY_DATABASE: "synthetic_primary",
      PRIMARY_SCHEMA: "synthetic_origin_primary",
      PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:primary",
      POSTGRES_IAM_USER: "synthetic-runtime@synthetic.iam",
      GCS_BUCKET_NAME: resourceBucket,
      GCS_QUARANTINE_BUCKET_HISTORY_PROOF: proof(resourceBucket),
    };
    const targetOverrides = [
      // OD-2: the quarantine bucket's birth proof is required, closed and
      // bound to this bucket; the retired setting is refused even when empty.
      [{ GCS_QUARANTINE_BUCKET_HISTORY_PROOF: undefined }, "GCS_QUARANTINE_BUCKET_HISTORY_PROOF_MISSING"],
      [{ GCS_QUARANTINE_BUCKET_HISTORY_PROOF: "" }, "GCS_QUARANTINE_BUCKET_HISTORY_PROOF_MISSING"],
      [{ GCS_QUARANTINE_BUCKET_HISTORY_PROOF: proof("another-test-bucket") },
        "GCS_QUARANTINE_BUCKET_HISTORY_PROOF_INVALID"],
      [{ GCS_QUARANTINE_BUCKET_HISTORY_PROOF: JSON.stringify({ proof: JSON.parse(proof(resourceBucket)) }) },
        "GCS_QUARANTINE_BUCKET_HISTORY_PROOF_INVALID"],
      [{ GCS_QUARANTINE_BUCKET_HISTORY_PROOF: proof(resourceBucket, { schemaVersion: "tibotattle-gcp-bucket-birth-v1" }) },
        "GCS_QUARANTINE_BUCKET_HISTORY_PROOF_INVALID"],
      [{ GCS_QUARANTINE_BUCKET_HISTORY_PROOF: proof(resourceBucket, { softDeleteRetentionDurationSeconds: "604800" }) },
        "GCS_QUARANTINE_BUCKET_HISTORY_PROOF_INVALID"],
      [{ GCS_QUARANTINE_BUCKET_HISTORY_PROOF: proof(resourceBucket, { bucketGeneration: "0" }) },
        "GCS_QUARANTINE_BUCKET_HISTORY_PROOF_INVALID"],
      [{ GCS_QUARANTINE_BUCKET_HISTORY_PROOF: proof(resourceBucket, { bucketMetageneration: 1 }) },
        "GCS_QUARANTINE_BUCKET_HISTORY_PROOF_INVALID"],
      [{ GCS_QUARANTINE_BUCKET_HISTORY_PROOF: "not-json" }, "GCS_QUARANTINE_BUCKET_HISTORY_PROOF_INVALID"],
      [{ GCS_ERASURE_BUCKET_HISTORY_PROOF: proof(resourceBucket) }, "GCS_ERASURE_BUCKET_HISTORY_PROOF_RETIRED"],
      [{ GCS_ERASURE_BUCKET_HISTORY_PROOF: "" }, "GCS_ERASURE_BUCKET_HISTORY_PROOF_RETIRED"],
      [{ GCS_BUCKET_NAME: undefined }, "GCS_BUCKET_NAME_MISSING"],
      // The retired A2 ledger target, in any form, is refused before any
      // connector or pool exists (LEAD-SIMP).
      [{ LEDGER_INSTANCE_CONNECTION_NAME: CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger.instanceConnectionName },
        "POSTGRES_LEDGER_CONFIGURATION_RETIRED"],
      [{ LEDGER_DATABASE: CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger.database },
        "POSTGRES_LEDGER_CONFIGURATION_RETIRED"],
      [{ LEDGER_SCHEMA: CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger.schema },
        "POSTGRES_LEDGER_CONFIGURATION_RETIRED"],
      [{ LEDGER_SCHEMA: "tibotattle_ledger" },
        "POSTGRES_LEDGER_CONFIGURATION_RETIRED"],
      // The retired cloud-run-iam mode, with the A2 resources it served.
      [{ POSTGRES_TEST_HTTP_MODE: "cloud-run-iam", HOST: CLOUD_RUN_IAM_TEST_TARGET.listenHost,
        HOST_ORIGIN: CLOUD_RUN_IAM_TEST_TARGET.origin, K_SERVICE: CLOUD_RUN_IAM_TEST_TARGET.service,
        PRIMARY_DATABASE: CLOUD_RUN_IAM_TEST_TARGET.postgres.primary.database,
        PRIMARY_SCHEMA: CLOUD_RUN_IAM_TEST_TARGET.postgres.primary.schema,
        PRIMARY_INSTANCE_CONNECTION_NAME: CLOUD_RUN_IAM_TEST_TARGET.postgres.primary.instanceConnectionName,
        POSTGRES_IAM_USER: CLOUD_RUN_IAM_TEST_TARGET.postgres.iamUser,
        GCS_BUCKET_NAME: CLOUD_RUN_IAM_TEST_TARGET.gcsBucket,
        GCS_QUARANTINE_BUCKET_HISTORY_PROOF: proof(CLOUD_RUN_IAM_TEST_TARGET.gcsBucket) },
      "POSTGRES_TEST_HTTP_MODE_INVALID"],
    ];
    const environmentNames = new Set([
      ...Object.keys(resourceEnv),
      "POSTGRES_TEST_HTTP_MODE", "HOST", "PORT", "HOST_ORIGIN", "K_SERVICE",
      "PUBLIC_ORIGIN", "ADMIN_HOST_ORIGIN", "PRIMARY_DATABASE", "PRIMARY_SCHEMA",
      "PRIMARY_INSTANCE_CONNECTION_NAME", "LEDGER_DATABASE", "LEDGER_SCHEMA",
      "LEDGER_INSTANCE_CONNECTION_NAME", "POSTGRES_IAM_USER", "GCS_BUCKET_NAME",
      "GCS_QUARANTINE_BUCKET_HISTORY_PROOF", "GCS_ERASURE_BUCKET_HISTORY_PROOF", "ENROLLMENT_MODE",
      "IDENTITY_LINK_SECRET", "IDENTITY_LINK_SECRET_VERSION", "GOOGLE_OIDC_CLIENT_ID", "GOOGLE_OIDC_CLIENT_SECRET",
      "SIGN_IN_START_MAX_PER_MINUTE", "EDGE_ORIGIN_MODE",
    ]);
    const originalEnvironment = new Map([...environmentNames].map((name) => [name, process.env[name]]));
    try {
      for (const [overrides, expectedCode] of targetOverrides) {
        for (const name of environmentNames) delete process.env[name];
        Object.assign(process.env, resourceEnv);
        for (const [name, value] of Object.entries(overrides)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        const constructionCalls = [];
        await assert.rejects(
          serverModule.createRuntime({
            dependencies: {
              createConnector() {
                constructionCalls.push("connector");
                return {};
              },
              createIamPool() {
                constructionCalls.push("postgres-pool");
                throw new Error("test pool must not be reached");
              },
              createGoogleAccessTokenProvider() {
                constructionCalls.push("gcs-access-token");
                return async () => "synthetic-token";
              },
              createGcsQuarantineObjectStore() {
                constructionCalls.push("gcs-object-store");
                throw new Error("test object store must not be reached");
              },
            },
          }),
          (error) => error?.code === expectedCode,
          `${JSON.stringify(Object.keys(overrides))} -> ${expectedCode}`,
        );
        assert.deepEqual(constructionCalls, [], `${expectedCode} must fail before DB/GCS construction`);
      }
    } finally {
      for (const [name, value] of originalEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    const scheduledBucket = "synthetic-maintenance-bucket";
    const scheduledEnvironment = {
      PRIMARY_DATABASE: "synthetic_primary",
      PRIMARY_SCHEMA: "scheduled_primary",
      PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:primary",
      POSTGRES_IAM_USER: "scheduled-runtime@tibotattle.iam",
      GCS_BUCKET_NAME: scheduledBucket,
      GCS_QUARANTINE_BUCKET_HISTORY_PROOF: proof(scheduledBucket),
    };
    const scheduledEnvironmentNames = new Set([
      ...Object.keys(scheduledEnvironment),
      "GCS_ERASURE_BUCKET_HISTORY_PROOF",
      "LEDGER_DATABASE", "LEDGER_SCHEMA", "LEDGER_INSTANCE_CONNECTION_NAME",
      "POSTGRES_TEST_HTTP_MODE", "HOST", "HOST_ORIGIN", "PUBLIC_ORIGIN",
      "ADMIN_HOST_ORIGIN", "PORT", "K_SERVICE", "SOURCE_CONTENT_DIGEST",
      "POSTGRES_RATE_LIMIT_SECRET", "ENVELOPE_PUBLIC_JWK", "ENVELOPE_PRIVATE_JWK",
      "ASSET_ROOT",
    ]);
    const previousScheduledEnvironment = new Map(
      [...scheduledEnvironmentNames].map((name) => [name, process.env[name]]),
    );
    try {
      for (const name of scheduledEnvironmentNames) delete process.env[name];
      Object.assign(process.env, scheduledEnvironment);
      const connector = { close() {} };
      const poolInputs = [];
      const pools = [];
      const provider = async () => "synthetic-access-token";
      const objectStore = { head() {}, delete() {} };
      let objectStoreInput;
      const runtime = await serverModule.createScheduledMaintenanceRuntime({
        dependencies: {
          createConnector() { return connector; },
          createIamPool(options) {
            poolInputs.push(options);
            const pool = { end() {} };
            pools.push(pool);
            return pool;
          },
          async createGoogleAccessTokenProvider() { return provider; },
          createGcsQuarantineObjectStore(...args) {
            objectStoreInput = args;
            return objectStore;
          },
        },
      });
      assert.deepEqual(poolInputs.map(({ role, database, schema, max, user }) =>
        ({ role, database, schema, max, user })), [
        {
          role: "primary", database: "synthetic_primary", schema: "scheduled_primary",
          max: 3, user: "scheduled-runtime@tibotattle.iam",
        },
      ], "the scheduled job opens one primary pool and no ledger pool");
      assert.equal(runtime.primaryPool, pools[0]);
      assert.deepEqual(runtime.pools, [pools[0]]);
      assert.equal(runtime.connector, connector);
      assert.equal(runtime.objectStore, objectStore);
      assert.deepEqual(runtime.schemaOptions, {
        primarySchema: "scheduled_primary",
      });
      assert.equal(objectStoreInput[0], scheduledBucket);
      assert.equal(objectStoreInput[1], provider);
      // OD-2: the quarantine store reads the bucket's birth proof.
      assert.deepEqual(objectStoreInput[4], JSON.parse(proof(scheduledBucket)));

      // A proof for another bucket, a missing proof or the retired setting
      // refuses the scheduled composition before a connector or pool exists.
      for (const [overrides, code] of [
        [{ GCS_QUARANTINE_BUCKET_HISTORY_PROOF: proof("another-test-bucket") },
          "GCS_QUARANTINE_BUCKET_HISTORY_PROOF_INVALID"],
        [{ GCS_QUARANTINE_BUCKET_HISTORY_PROOF: undefined }, "GCS_QUARANTINE_BUCKET_HISTORY_PROOF_MISSING"],
        [{ GCS_ERASURE_BUCKET_HISTORY_PROOF: proof(scheduledBucket) }, "GCS_ERASURE_BUCKET_HISTORY_PROOF_RETIRED"],
      ]) {
        for (const [name, value] of Object.entries(overrides)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        const calls = [];
        await assert.rejects(serverModule.createScheduledMaintenanceRuntime({
          dependencies: {
            createConnector() { calls.push("connector"); return connector; },
            createIamPool() { calls.push("pool"); throw new Error("must not open a pool"); },
          },
        }), (error) => error?.code === code, code);
        assert.deepEqual(calls, [], code);
        delete process.env.GCS_ERASURE_BUCKET_HISTORY_PROOF;
        process.env.GCS_QUARANTINE_BUCKET_HISTORY_PROOF = proof(scheduledBucket);
      }

      // Any retired LEDGER_ setting refuses the scheduled composition before
      // a connector or pool exists.
      for (const [name, value] of [["LEDGER_DATABASE", "synthetic_ledger"], ["LEDGER_SCHEMA", "scheduled_ledger"],
        ["LEDGER_INSTANCE_CONNECTION_NAME", "synthetic-project:us-east1:ledger"]]) {
        process.env[name] = value;
        const calls = [];
        await assert.rejects(serverModule.createScheduledMaintenanceRuntime({
          dependencies: {
            createConnector() { calls.push("connector"); return connector; },
            createIamPool() { calls.push("pool"); throw new Error("must not open a pool"); },
          },
        }), (error) => error?.code === "POSTGRES_LEDGER_CONFIGURATION_RETIRED", name);
        assert.deepEqual(calls, [], name);
        delete process.env[name];
      }
    } finally {
      for (const [name, value] of previousScheduledEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PostgreSQL personal-device adapter validates Worker session bindings and maps the bounded projection", async () => {
  const vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
  });
  try {
    const [session, personalDevices] = await Promise.all([
      vite.ssrLoadModule("/src/session.ts"),
      vite.ssrLoadModule("/src/postgres-personal-devices.ts"),
    ]);
    const now = Date.now();
    const participantId = "synthetic-personal-device-owner";
    const makeMaterial = (scope = "personal", expiresAt = new Date(now + 60 * 60_000).toISOString()) =>
      session.createSessionMaterialFromSecret(
        participantId,
        randomUUID(),
        randomBytes(32).toString("base64url"),
        new Date(now - 5_000).toISOString(),
        expiresAt,
        scope,
      );
    const [valid, expired, deletionOnly, revoked, deletingParticipant] = await Promise.all([
      makeMaterial(),
      makeMaterial("personal", new Date(now - 60_000).toISOString()),
      makeMaterial("deletion_only"),
      makeMaterial(),
      makeMaterial(),
    ]);
    const rowFor = (material, overrides = {}) => ({
      session_id: material.id,
      participant_id: participantId,
      secret_hash: material.secretHash,
      csrf_hash: material.csrfHash,
      session_scope: material.scope,
      session_state: "active",
      expires_at: material.expiresAt,
      participant_created_at: "2026-09-25T11:59:00.000Z",
      participant_state: "active",
      consent_version: null,
      ...overrides,
    });
    const sessions = new Map([
      [valid.id, rowFor(valid)],
      [expired.id, rowFor(expired)],
      [deletionOnly.id, rowFor(deletionOnly)],
      [revoked.id, rowFor(revoked, { session_state: "revoked" })],
      [deletingParticipant.id, rowFor(deletingParticipant, { participant_state: "deleting" })],
    ]);
    const devices = [{
      id: "synthetic-revoked-device",
      state: "revoked",
      created_at: "2026-09-25T12:00:00.000Z",
      expires_at: "2026-09-24T12:00:00.000Z",
      last_used_at: "2026-09-25T12:30:00.000Z",
      revoked_at: "2026-09-25T12:45:00.000Z",
    }];
    const pool = {
      async connect() {
        return {
          async query(sql, values = []) {
            if (sql.startsWith("SELECT session.id AS session_id")) {
              const row = sessions.get(values[0]);
              return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
            }
            if (sql.includes('FROM "devices_test"."device_credentials"')) {
              const rows = values[0] === participantId ? devices : [];
              return { rows, rowCount: rows.length };
            }
            return { rows: [], rowCount: 0 };
          },
          release() {},
        };
      },
    };
    const schema = { primarySchema: "devices_test" };
    assert.deepEqual(
      await personalDevices.authenticatePostgresPersonalSession(
        pool,
        session.sessionCookie(valid),
        { schema, nowEpoch: now },
      ),
      {
        participantId,
        participantCreatedAt: "2026-09-25T11:59:00.000Z",
        consentVersion: null,
        sessionId: valid.id,
        expiresAt: valid.expiresAt,
        csrfToken: valid.csrfToken,
      },
      "a valid cookie remains readable without a consent-version requirement",
    );
    const csrfRequest = new Request("https://private.example.test/api/v1/me/devices/revoke", {
      method: "POST",
      headers: {
        origin: "https://private.example.test",
        "sec-fetch-site": "same-origin",
        "x-usage-monitor-csrf": valid.csrfToken,
      },
    });
    assert.doesNotThrow(() => personalDevices.assertPostgresPersonalSessionCsrf(
      csrfRequest,
      valid.csrfToken,
    ));
    for (const request of [
      new Request(csrfRequest.url, {
        method: "POST",
        headers: { origin: "https://attacker.example.test", "x-usage-monitor-csrf": valid.csrfToken },
      }),
      new Request(csrfRequest.url, {
        method: "POST",
        headers: { origin: "https://private.example.test", "x-usage-monitor-csrf": "wrong" },
      }),
      new Request(csrfRequest.url, {
        method: "POST",
        headers: {
          origin: "https://private.example.test",
          "sec-fetch-site": "cross-site",
          "x-usage-monitor-csrf": valid.csrfToken,
        },
      }),
    ]) {
      assert.throws(
        () => personalDevices.assertPostgresPersonalSessionCsrf(request, valid.csrfToken),
        { code: "CSRF_INVALID", status: 403 },
      );
    }
    assert.deepEqual(
      await personalDevices.listPostgresParticipantDevices(pool, participantId, { schema }),
      [{
        deviceId: "synthetic-revoked-device",
        state: "revoked",
        createdAt: "2026-09-25T12:00:00.000Z",
        expiresAt: "2026-09-24T12:00:00.000Z",
        lastUsedAt: "2026-09-25T12:30:00.000Z",
        revokedAt: "2026-09-25T12:45:00.000Z",
      }],
      "revoked and expired devices remain visible in the personal history",
    );
    for (const [material, code] of [
      [expired, "AUTH_INVALID"],
      [deletionOnly, "AUTH_INVALID"],
      [revoked, "AUTH_INVALID"],
    ]) {
      await assert.rejects(
        personalDevices.authenticatePostgresPersonalSession(pool, session.sessionCookie(material), {
          schema,
          nowEpoch: now,
        }),
        { code, status: 401 },
      );
    }
    await assert.rejects(
      personalDevices.authenticatePostgresPersonalSession(
        pool, session.sessionCookie(deletingParticipant), { schema, nowEpoch: now },
      ),
      { code: "PARTICIPANT_DELETING", status: 409 },
    );
    await assert.rejects(
      personalDevices.authenticatePostgresPersonalSession(pool, null, { schema }),
      { code: "AUTH_REQUIRED", status: 401 },
    );
  } finally {
    await vite.close();
  }
});

test("private health dispatch validates the current primary PostgreSQL 17 receipt with one pool", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 90_000,
}, async () => {
  const endpoint = await localPostgresEndpoint();
  const suffix = randomBytes(6).toString("hex");
  const primarySchema = `host_health_${suffix}`;
  let connections = 0;
  const primaryPool = new pg.Pool({
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 2,
    connectionTimeoutMillis: 3_000,
  });
  primaryPool.on("connect", () => { connections += 1; });
  const createdSchemas = [];
  let temporary;
  try {
    const server = await primaryPool.query(
      "SELECT current_setting('server_version_num')::integer AS version",
    );
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17,
      "the real integration check requires PostgreSQL 17");
    await primaryPool.query(`CREATE SCHEMA "${primarySchema}"`);
    createdSchemas.push(primarySchema);
    await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: primaryPool });

    temporary = await mkdtemp(join(ROOT, ".tmp-postgres-health-manifest-"));
    const manifestBundle = await build({
      entryPoints: [resolve(ROOT, "../src/postgres-runtime-schema.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      write: false,
      logLevel: "silent",
    });
    const manifestPath = join(temporary, "runtime-schema.mjs");
    await writeFile(manifestPath, manifestBundle.outputFiles[0].contents);
    const { POSTGRES_RUNTIME_MIGRATIONS, POSTGRES_RUNTIME_SCHEMA_VERSION } =
      await import(pathToFileURL(manifestPath).href);
    assert.equal(POSTGRES_RUNTIME_SCHEMA_VERSION, "tibotattle-postgres-migration-manifest-v2");
    assert.deepEqual(Object.keys(POSTGRES_RUNTIME_MIGRATIONS), ["primary"]);

    const dispatch = createPostgresTestHealthDispatch({
      primaryPool,
      schemaOptions: { primarySchema },
      expectedMigrations: POSTGRES_RUNTIME_MIGRATIONS,
      privateOrigin: "http://127.0.0.1:43817",
    });
    const response = await dispatch(new Request("http://127.0.0.1:43817/api/health"));
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.deepEqual(health, {
      schemaVersion: "gcp-postgres-test-health-v2",
      scope: "postgres_schema_and_migrations_only",
      status: "ready",
      workerApplicationReady: false,
      checks: {
        postgresMajor: 17,
        primaryMigrationReceipt: {
          status: "current",
          version: POSTGRES_RUNTIME_MIGRATIONS.primary.length,
        },
      },
    });
    assert.equal(POSTGRES_RUNTIME_MIGRATIONS.primary.length, 68);
    assert.equal(JSON.stringify(health).includes(primarySchema), false);
    assert.equal(Object.hasOwn(health.checks, "database"), false);
    assert.ok(connections >= 1);
  } finally {
    for (const schema of createdSchemas.reverse()) {
      try { await primaryPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch {}
    }
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await primaryPool.end();
  }
});

test("private PostgreSQL 17 participant-device routes preserve revocation effects and owner isolation", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 90_000,
}, async () => {
  const endpoint = await localPostgresEndpoint();
  const suffix = randomBytes(6).toString("hex");
  const primarySchema = `host_devices_${suffix}`;
  const primaryPool = new pg.Pool({
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 3,
    connectionTimeoutMillis: 3_000,
  });
  const createdSchemas = [];
  let vite;
  try {
    const server = await primaryPool.query(
      "SELECT current_setting('server_version_num')::integer AS version",
    );
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17,
      "the personal-device HTTP integration check requires PostgreSQL 17");
    await primaryPool.query(`CREATE SCHEMA "${primarySchema}"`);
    createdSchemas.push(primarySchema);
    await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: primaryPool });

    vite = await createServer({
      root: WORKER_ROOT,
      configFile: false,
      server: { middlewareMode: true },
      appType: "custom",
    });
    const [session, personalDevices, personalSession, runtimeSchema,
      bodyReader, workerConstants]
      = await Promise.all([
        vite.ssrLoadModule("/src/session.ts"),
        vite.ssrLoadModule("/src/postgres-personal-devices.ts"),
        vite.ssrLoadModule("/src/postgres-personal-session.ts"),
        vite.ssrLoadModule("/src/postgres-runtime-schema.ts"),
        vite.ssrLoadModule("/src/bounded-body.ts"),
        vite.ssrLoadModule("/src/constants.ts"),
      ]);
    const primaryTable = (name) => quotedTable(primarySchema, name);
    const schemas = { primarySchema };
    const now = Date.now();
    const participantCreatedAt = new Date(now - 60_000).toISOString();
    const participantA = `synthetic-devices-a-${suffix}`;
    const participantB = `synthetic-devices-b-${suffix}`;
    // A participant deleted after it signed in (the former tombstone case,
    // re-expressed without a deletion ledger: its rows are simply gone).
    const participantDeleted = `synthetic-devices-c-${suffix}`;
    await primaryPool.query(
      `INSERT INTO ${primaryTable("participants")} (id, owner_kind, state, consent_version, created_at)
       VALUES ($1, 'social', 'active', NULL, $2), ($3, 'social', 'active', $4, $2),
              ($5, 'social', 'active', NULL, $2)`,
      [participantA, participantCreatedAt, participantB, "telemetry-v3", participantDeleted],
    );

    async function insertSession(participantId, {
      issuedAt = new Date(now - 5_000).toISOString(),
      expiresAt = new Date(now + 60 * 60_000).toISOString(),
      state = "active",
      scope = "personal",
    } = {}) {
      const id = randomUUID();
      const secret = randomBytes(32).toString("base64url");
      const material = await session.createSessionMaterialFromSecret(
        participantId, id, secret, issuedAt, expiresAt, scope,
      );
      await primaryPool.query(
        `INSERT INTO ${primaryTable("web_sessions")} (
           id, participant_id, secret_hash, csrf_hash, scope, state,
           issued_at, expires_at, last_used_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7)`,
        [material.id, participantId, material.secretHash, material.csrfHash,
          material.scope, state, material.issuedAt, material.expiresAt],
      );
      return material;
    }

    async function insertDevice(participantId, sessionId, {
      issuedAt,
      state = "active",
      expiresAt = new Date(now + 30 * 24 * 60 * 60_000).toISOString(),
    }) {
      const deviceId = randomUUID();
      const pairingId = randomUUID();
      const issued = new Date(issuedAt).toISOString();
      const revokedAt = state === "revoked" ? new Date(now - 1_000).toISOString() : null;
      await primaryPool.query(
        `INSERT INTO ${primaryTable("device_pairings")} (
           id, participant_id, issued_by_session_id, secret_hash, consent_version,
           transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
         ) VALUES ($1,$2,$3,$4,'stored-device-consent-v1','stored-transport-consent-v1',
                   'consumed',$5,$6,$5,$7)`,
        [pairingId, participantId, sessionId, randomBytes(32), issued,
          expiresAt, deviceId],
      );
      await primaryPool.query(
        `INSERT INTO ${primaryTable("device_credentials")} (
           id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
           state, issued_at, expires_at, last_used_at, revoked_at
         ) VALUES ($1,$2,'social',$3,$4,$5,$6,$7,$8,$9)`,
        [deviceId, participantId, pairingId, randomBytes(32), state, issued,
          expiresAt, issued, revokedAt],
      );
      return {
        deviceId,
        state,
        createdAt: issued,
        expiresAt,
        lastUsedAt: issued,
        revokedAt,
      };
    }

    async function insertUploadAuthorization(deviceId, participantId, {
      state,
      leaseExpiresAt = null,
    }) {
      const id = `synthetic-device-upload-${randomUUID()}`;
      await primaryPool.query(
        `INSERT INTO ${primaryTable("device_upload_authorizations")} (
           id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
           body_bytes, content_type, state, issued_at, expires_at,
           consumed_at, revoked_at, consume_lease_expires_at
         ) VALUES ($1,$2,$3,$4,$5,1,'application/json',$6,$7,$8,
           CASE WHEN $6 = 'consumed' THEN $7::timestamptz ELSE NULL END,
           CASE WHEN $6 = 'revoked' THEN $7::timestamptz ELSE NULL END,
           $9::timestamptz)`,
        [id, participantId, deviceId, randomBytes(32), "a".repeat(64), state,
          new Date(now - 1_000).toISOString(), new Date(now + 60_000).toISOString(),
          leaseExpiresAt],
      );
      return id;
    }

    const sessionA = await insertSession(participantA);
    const sessionB = await insertSession(participantB);
    const logoutUploadAuthorization = `synthetic-session-upload-${randomUUID()}`;
    const logoutPairing = `synthetic-session-pairing-${randomUUID()}`;
    await primaryPool.query(
      `INSERT INTO ${primaryTable("upload_authorizations")} (
         id, participant_id, issued_by_session_id, secret_hash, envelope_digest,
         body_bytes, content_type, state, issued_at, expires_at
       ) VALUES ($1,$2,$3,$4,$5,1,'application/json','unused',$6,$7)`,
      [logoutUploadAuthorization, participantA, sessionA.id, randomBytes(32), "a".repeat(64),
        new Date(now - 1_000).toISOString(), new Date(now + 60_000).toISOString()],
    );
    await primaryPool.query(
      `INSERT INTO ${primaryTable("device_pairings")} (
         id, participant_id, issued_by_session_id, secret_hash, consent_version,
         transport_consent_version, state, issued_at, expires_at
       ) VALUES ($1,$2,$3,$4,'synthetic-consent-v1','synthetic-transport-v1','unused',$5,$6)`,
      [logoutPairing, participantA, sessionA.id, randomBytes(32),
        new Date(now - 1_000).toISOString(), new Date(now + 60_000).toISOString()],
    );
    const oldSessionA = await insertSession(participantA, {
      issuedAt: new Date(now - 120_000).toISOString(),
      expiresAt: new Date(now - 60_000).toISOString(),
    });
    const revokedSessionA = await insertSession(participantA, { state: "revoked" });
    const deletionOnlySessionA = await insertSession(participantA, { scope: "deletion_only" });
    const deviceAOld = await insertDevice(participantA, sessionA.id, {
      issuedAt: new Date(now - 120_000).toISOString(),
    });
    const deviceAOther = await insertDevice(participantA, sessionA.id, {
      issuedAt: new Date(now - 180_000).toISOString(),
    });
    const deviceARevokedExpired = await insertDevice(participantA, sessionA.id, {
      issuedAt: new Date(now - 60_000).toISOString(),
      state: "revoked",
      expiresAt: new Date(now - 30_000).toISOString(),
    });
    const deviceB = await insertDevice(participantB, sessionB.id, {
      issuedAt: new Date(now - 10_000).toISOString(),
    });
    const unusedGrant = await insertUploadAuthorization(deviceAOld.deviceId, participantA, {
      state: "unused",
    });
    const consumingGrant = await insertUploadAuthorization(deviceAOld.deviceId, participantA, {
      state: "consuming",
      leaseExpiresAt: new Date(now + 30_000).toISOString(),
    });
    const consumedGrant = await insertUploadAuthorization(deviceAOld.deviceId, participantA, {
      state: "consumed",
    });
    const unrelatedGrant = await insertUploadAuthorization(deviceAOther.deviceId, participantA, {
      state: "unused",
    });
    const crossOwnerGrant = await insertUploadAuthorization(deviceB.deviceId, participantB, {
      state: "unused",
    });

    const sessionDeleted = await insertSession(participantDeleted);
    await primaryPool.query(`DELETE FROM ${primaryTable("participants")} WHERE id = $1`, [participantDeleted]);

    const healthDispatch = createPostgresTestHealthDispatch({
      primaryPool,
      schemaOptions: schemas,
      expectedMigrations: runtimeSchema.POSTGRES_RUNTIME_MIGRATIONS,
      privateOrigin: "http://127.0.0.1:43818",
    });
    const deviceDispatch = createPostgresTestParticipantDevicesDispatch({
      primaryPool,
      schemaOptions: schemas,
      authenticatePostgresPersonalSession: personalDevices.authenticatePostgresPersonalSession,
      assertPostgresPersonalSessionCsrf: personalDevices.assertPostgresPersonalSessionCsrf,
      listPostgresParticipantDevices: personalDevices.listPostgresParticipantDevices,
      revokePostgresParticipantDevice: personalDevices.revokePostgresParticipantDevice,
      readBoundedRequestBody: bodyReader.readBoundedRequestBody,
      maxRequestBytes: workerConstants.MAX_REQUEST_BYTES,
      healthDispatch,
      privateOrigin: "http://127.0.0.1:43818",
    });
    const personalSessionDispatch = createPostgresTestPersonalSessionDispatch({
      primaryPool,
      schemaOptions: schemas,
      authenticatePostgresPersonalSession: personalSession.authenticatePostgresPersonalSessionForRead,
      assertPostgresPersonalSessionCsrf: personalDevices.assertPostgresPersonalSessionCsrf,
      revokePostgresPersonalSession: personalSession.revokePostgresPersonalSession,
      healthDispatch,
      clearSessionCookie: session.clearedSessionCookie(),
      privateOrigin: "http://127.0.0.1:43818",
    });
    const routeDispatch = async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/v1/session" || pathname === "/api/v1/logout") {
        return personalSessionDispatch(request);
      }
      return deviceDispatch(request);
    };
    const runtime = {
      postgresTestDispatch: routeDispatch,
      get env() { throw new Error("D1 must not be reachable from the PostgreSQL HTTP route"); },
    };
    const workerHandler = async () => { throw new Error("Worker fallback must not be called"); };
    const request = (material) => new Request(
      `http://127.0.0.1:43818/api/v1/me/devices?participantId=${encodeURIComponent(participantB)}`,
      { headers: { cookie: session.sessionCookie(material) } },
    );

    const sessionUrl = "http://127.0.0.1:43818/api/v1/session";
    const logoutUrl = "http://127.0.0.1:43818/api/v1/logout";
    const sessionRequest = (material, extraHeaders = {}) => new Request(sessionUrl, {
      headers: { cookie: session.sessionCookie(material), ...extraHeaders },
    });
    const logoutRequest = (material, extraHeaders = {}) => new Request(logoutUrl, {
      method: "POST",
      headers: {
        cookie: session.sessionCookie(material),
        origin: "http://127.0.0.1:43818",
        "sec-fetch-site": "same-origin",
        ...extraHeaders,
      },
    });

    const sessionRead = await dispatchCloudRunHostRequest(
      sessionRequest(sessionA), runtime, workerHandler,
    );
    assert.equal(sessionRead.status, 200);
    assert.equal(sessionRead.headers.get("cache-control"), "no-store");
    assert.equal(sessionRead.headers.get("vary"), "Cookie");
    assert.deepEqual(await sessionRead.json(), {
      participantId: participantA,
      createdAt: participantCreatedAt,
      expiresAt: sessionA.expiresAt,
      csrfToken: sessionA.csrfToken,
      consentVersion: null,
    });
    await assertApiError(
      await dispatchCloudRunHostRequest(
        sessionRequest(sessionA, { authorization: "Bearer synthetic-not-a-session" }),
        runtime,
        workerHandler,
      ),
      401,
      "AUTH_INVALID",
    );
    await assertApiError(
      await dispatchCloudRunHostRequest(new Request(sessionUrl), runtime, workerHandler),
      401,
      "AUTH_REQUIRED",
    );
    await assertApiError(
      await dispatchCloudRunHostRequest(new Request(sessionUrl, { method: "POST" }), runtime, workerHandler),
      405,
      "METHOD_NOT_ALLOWED",
    );
    await assertApiError(
      await dispatchCloudRunHostRequest(new Request(logoutUrl), runtime, workerHandler),
      405,
      "METHOD_NOT_ALLOWED",
    );

    const responseA = await dispatchCloudRunHostRequest(request(sessionA), runtime, workerHandler);
    assert.equal(responseA.status, 200);
    assert.equal(responseA.headers.get("vary"), "Cookie");
    const bodyA = await responseA.json();
    assert.deepEqual(bodyA, {
      devices: [
        {
          deviceId: deviceARevokedExpired.deviceId,
          state: "revoked",
          createdAt: deviceARevokedExpired.createdAt,
          expiresAt: deviceARevokedExpired.expiresAt,
          lastUsedAt: deviceARevokedExpired.lastUsedAt,
          revokedAt: deviceARevokedExpired.revokedAt,
        },
        {
          deviceId: deviceAOld.deviceId,
          state: "active",
          createdAt: deviceAOld.createdAt,
          expiresAt: deviceAOld.expiresAt,
          lastUsedAt: deviceAOld.lastUsedAt,
          revokedAt: null,
        },
        {
          deviceId: deviceAOther.deviceId,
          state: "active",
          createdAt: deviceAOther.createdAt,
          expiresAt: deviceAOther.expiresAt,
          lastUsedAt: deviceAOther.lastUsedAt,
          revokedAt: null,
        },
      ],
    }, "the route returns all of the authenticated owner's devices in Worker order");
    assert.equal(JSON.stringify(bodyA).includes(deviceB.deviceId), false,
      "a query parameter cannot select or disclose another participant's device");
    assert.equal(JSON.stringify(bodyA).includes(participantB), false);

    const revokeUrl = "http://127.0.0.1:43818/api/v1/me/devices/revoke";
    const revoke = (material, value, extraHeaders = {}) => new Request(revokeUrl, {
      method: "POST",
      headers: {
        cookie: session.sessionCookie(material),
        origin: "http://127.0.0.1:43818",
        "sec-fetch-site": "same-origin",
        "x-usage-monitor-csrf": material.csrfToken,
        "content-type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(value),
    });

    await assertApiError(
      await dispatchCloudRunHostRequest(
        revoke(sessionA, { deviceId: deviceAOld.deviceId }, {
          "x-usage-monitor-csrf": "um_csrf_invalid",
        }),
        runtime,
        workerHandler,
      ),
      403,
      "CSRF_INVALID",
    );
    await assertApiError(
      await dispatchCloudRunHostRequest(
        revoke(sessionA, { deviceId: deviceAOld.deviceId }, {
          origin: "http://attacker.invalid",
        }),
        runtime,
        workerHandler,
      ),
      403,
      "CSRF_INVALID",
    );
    await assertApiError(
      await dispatchCloudRunHostRequest(
        revoke(oldSessionA, { deviceId: deviceAOld.deviceId }),
        runtime,
        workerHandler,
      ),
      401,
      "AUTH_INVALID",
    );
    await assertApiError(
      await dispatchCloudRunHostRequest(
        revoke(sessionA, { deviceId: deviceAOld.deviceId, unexpected: true }),
        runtime,
        workerHandler,
      ),
      400,
      "BODY_INVALID",
    );
    await assertApiError(
      await dispatchCloudRunHostRequest(
        revoke(sessionA, { deviceId: deviceAOld.deviceId }, { "content-type": "text/plain" }),
        runtime,
        workerHandler,
      ),
      415,
      "CONTENT_TYPE_INVALID",
    );
    const unchangedAfterDeniedRequests = await primaryPool.query(
      `SELECT state FROM ${primaryTable("device_credentials")} WHERE id=$1`,
      [deviceAOld.deviceId],
    );
    assert.equal(unchangedAfterDeniedRequests.rows[0]?.state, "active",
      "failed CSRF, stale session, and body validation leave the credential untouched");

    const firstRevocation = await dispatchCloudRunHostRequest(
      revoke(sessionA, { deviceId: deviceAOld.deviceId }), runtime, workerHandler,
    );
    assert.equal(firstRevocation.status, 200);
    assert.equal(firstRevocation.headers.get("vary"), "Cookie");
    assert.deepEqual(await firstRevocation.json(), {
      revoked: true,
      deviceId: deviceAOld.deviceId,
    });

    const firstState = await primaryPool.query(
      `SELECT state, revoked_at FROM ${primaryTable("device_credentials")} WHERE id=$1`,
      [deviceAOld.deviceId],
    );
    assert.equal(firstState.rows[0]?.state, "revoked");
    assert.ok(firstState.rows[0]?.revoked_at instanceof Date);
    const revokedAt = firstState.rows[0].revoked_at.toISOString();
    const replay = await dispatchCloudRunHostRequest(
      revoke(sessionA, { deviceId: deviceAOld.deviceId }), runtime, workerHandler,
    );
    assert.equal(replay.status, 200, "owner revocation is idempotent for terminal devices");
    assert.deepEqual(await replay.json(), {
      revoked: true,
      deviceId: deviceAOld.deviceId,
    });
    const replayState = await primaryPool.query(
      `SELECT state, revoked_at FROM ${primaryTable("device_credentials")} WHERE id=$1`,
      [deviceAOld.deviceId],
    );
    assert.equal(replayState.rows[0]?.state, "revoked");
    assert.equal(replayState.rows[0]?.revoked_at.toISOString(), revokedAt,
      "replaying revocation preserves the terminal timestamp");

    const grantStates = await primaryPool.query(
      `SELECT id, state, revoked_at, consume_lease_expires_at
         FROM ${primaryTable("device_upload_authorizations")}
        WHERE id = ANY($1::text[])`,
      [[unusedGrant, consumingGrant, consumedGrant, unrelatedGrant]],
    );
    const grants = new Map(grantStates.rows.map((row) => [row.id, row]));
    assert.equal(grants.get(unusedGrant)?.state, "revoked");
    assert.equal(grants.get(consumingGrant)?.state, "revoked");
    assert.equal(grants.get(consumingGrant)?.consume_lease_expires_at, null,
      "revocation clears an interrupted upload lease");
    assert.ok(grants.get(unusedGrant)?.revoked_at instanceof Date);
    assert.equal(grants.get(consumedGrant)?.state, "consumed",
      "consumed upload receipts remain historical and immutable");
    assert.equal(grants.get(unrelatedGrant)?.state, "unused",
      "a sibling device's grant is unaffected");

    const crossOwner = await dispatchCloudRunHostRequest(
      revoke(sessionA, { deviceId: deviceB.deviceId }), runtime, workerHandler,
    );
    const crossOwnerBody = await assertApiError(crossOwner, 404, "DEVICE_NOT_FOUND");
    assert.equal(JSON.stringify(crossOwnerBody).includes(deviceB.deviceId), false,
      "cross-owner revocation returns a uniform not-found without echoing the target");
    const stillActiveB = await primaryPool.query(
      `SELECT state FROM ${primaryTable("device_credentials")} WHERE id=$1 AND participant_id=$2`,
      [deviceB.deviceId, participantB],
    );
    assert.equal(stillActiveB.rows[0]?.state, "active");
    const crossOwnerGrantState = await primaryPool.query(
      `SELECT state FROM ${primaryTable("device_upload_authorizations")} WHERE id=$1`,
      [crossOwnerGrant],
    );
    assert.equal(crossOwnerGrantState.rows[0]?.state, "unused",
      "a non-owner cannot revoke another participant's pending upload grant");
    await assertApiError(
      await dispatchCloudRunHostRequest(
        revoke(sessionA, { deviceId: "not-a-uuid" }), runtime, workerHandler,
      ),
      404,
      "DEVICE_NOT_FOUND",
    );

    const afterRevocation = await dispatchCloudRunHostRequest(
      request(sessionA), runtime, workerHandler,
    );
    const afterRevocationBody = await afterRevocation.json();
    assert.equal(afterRevocationBody.devices.find((device) => device.deviceId === deviceAOld.deviceId)?.state,
      "revoked", "the owner-visible device history reflects the committed revocation");

    await assertApiError(
      await dispatchCloudRunHostRequest(logoutRequest(sessionA), runtime, workerHandler),
      403,
      "CSRF_INVALID",
    );
    await assertApiError(
      await dispatchCloudRunHostRequest(
        logoutRequest(sessionA, {
          origin: "http://attacker.invalid",
          "x-usage-monitor-csrf": sessionA.csrfToken,
        }),
        runtime,
        workerHandler,
      ),
      403,
      "CSRF_INVALID",
    );
    const sessionAfterDeniedLogout = await primaryPool.query(
      `SELECT state FROM ${primaryTable("web_sessions")} WHERE id=$1 AND participant_id=$2`,
      [sessionA.id, participantA],
    );
    assert.equal(sessionAfterDeniedLogout.rows[0]?.state, "active",
      "CSRF failures cannot revoke a live session");

    const staleLogout = await dispatchCloudRunHostRequest(
      logoutRequest(oldSessionA), runtime, workerHandler,
    );
    assert.equal(staleLogout.status, 200);
    assert.deepEqual(await staleLogout.json(), { loggedOut: true });
    assert.equal(staleLogout.headers.get("set-cookie"), session.clearedSessionCookie());
    const deletedLogout = await dispatchCloudRunHostRequest(
      logoutRequest(sessionDeleted), runtime, workerHandler,
    );
    assert.equal(deletedLogout.status, 200,
      "a deleted participant can still clear its browser cookie without revealing that it was deleted");
    assert.deepEqual(await deletedLogout.json(), { loggedOut: true });
    assert.equal(deletedLogout.headers.get("set-cookie"), session.clearedSessionCookie());

    const logout = await dispatchCloudRunHostRequest(
      logoutRequest(sessionA, { "x-usage-monitor-csrf": sessionA.csrfToken }),
      runtime,
      workerHandler,
    );
    assert.equal(logout.status, 200);
    assert.equal(logout.headers.get("vary"), "Cookie");
    assert.equal(logout.headers.get("set-cookie"), session.clearedSessionCookie());
    assert.deepEqual(await logout.json(), { loggedOut: true });
    const logoutStates = await primaryPool.query(
      `SELECT session.state AS session_state, session.revoked_at,
              upload.state AS upload_state, upload.revoked_at AS upload_revoked_at,
              pairing.state AS pairing_state, pairing.revoked_at AS pairing_revoked_at
         FROM ${primaryTable("web_sessions")} session
         JOIN ${primaryTable("upload_authorizations")} upload
           ON upload.issued_by_session_id=session.id
         JOIN ${primaryTable("device_pairings")} pairing
           ON pairing.issued_by_session_id=session.id
        WHERE session.id=$1 AND session.participant_id=$2
          AND upload.id=$3 AND pairing.id=$4`,
      [sessionA.id, participantA, logoutUploadAuthorization, logoutPairing],
    );
    assert.equal(logoutStates.rows.length, 1);
    assert.equal(logoutStates.rows[0]?.session_state, "revoked");
    assert.equal(logoutStates.rows[0]?.upload_state, "revoked");
    assert.equal(logoutStates.rows[0]?.pairing_state, "revoked");
    assert.ok(logoutStates.rows[0]?.revoked_at instanceof Date);
    assert.equal(logoutStates.rows[0]?.upload_revoked_at.toISOString(),
      logoutStates.rows[0]?.revoked_at.toISOString());
    assert.equal(logoutStates.rows[0]?.pairing_revoked_at.toISOString(),
      logoutStates.rows[0]?.revoked_at.toISOString(),
      "session and pending grants share the atomic logout timestamp");
    const logoutReplay = await dispatchCloudRunHostRequest(
      logoutRequest(sessionA), runtime, workerHandler,
    );
    assert.equal(logoutReplay.status, 200, "logout remains idempotent after revocation");
    assert.deepEqual(await logoutReplay.json(), { loggedOut: true });
    assert.equal(logoutReplay.headers.get("set-cookie"), session.clearedSessionCookie());
    const missingLogoutCookie = await dispatchCloudRunHostRequest(
      new Request(logoutUrl, { method: "POST" }), runtime, workerHandler,
    );
    assert.equal(missingLogoutCookie.status, 200);
    assert.deepEqual(await missingLogoutCookie.json(), { loggedOut: true });
    assert.equal(missingLogoutCookie.headers.get("set-cookie"), session.clearedSessionCookie());
    await assertApiError(
      await dispatchCloudRunHostRequest(request(sessionA), runtime, workerHandler),
      401,
      "AUTH_INVALID",
    );

    for (const [material, code] of [
      [oldSessionA, "AUTH_INVALID"],
      [revokedSessionA, "AUTH_INVALID"],
      [deletionOnlySessionA, "AUTH_INVALID"],
    ]) {
      await assertApiError(
        await dispatchCloudRunHostRequest(request(material), runtime, workerHandler),
        401,
        code,
      );
    }
    // A deleted participant's former cookie fails ordinary authentication on
    // the device list and the session read.
    await assertApiError(
      await dispatchCloudRunHostRequest(request(sessionDeleted), runtime, workerHandler),
      401,
      "AUTH_INVALID",
    );
    await assertApiError(
      await dispatchCloudRunHostRequest(sessionRequest(sessionDeleted), runtime, workerHandler),
      401,
      "AUTH_INVALID",
    );
    const missingCookie = await dispatchCloudRunHostRequest(new Request(
      "http://127.0.0.1:43818/api/v1/me/devices",
    ), runtime, workerHandler);
    await assertApiError(missingCookie, 401, "AUTH_REQUIRED");
  } finally {
    if (vite) await vite.close();
    for (const schema of createdSchemas.reverse()) {
      try { await primaryPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch {}
    }
    await primaryPool.end();
  }
});

test("loopback device sync dispatch uses real PostgreSQL authority and never reaches D1", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  const endpoint = await localPostgresEndpoint();
  const suffix = randomBytes(6).toString("hex");
  const primarySchema = `host_v12_${suffix}`;
  const primaryPool = new pg.Pool({
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 3,
    connectionTimeoutMillis: 3_000,
  });
  const createdSchemas = [];
  let temporary;
  let vite;
  try {
    const server = await primaryPool.query(
      "SELECT current_setting('server_version_num')::integer AS version",
    );
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17,
      "the real dispatch check requires PostgreSQL 17");
    await primaryPool.query(`CREATE SCHEMA "${primarySchema}"`);
    createdSchemas.push(primarySchema);
    await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: primaryPool });

    temporary = await mkdtemp(join(ROOT, ".tmp-postgres-v12-host-"));
    const runtimeBundle = await build({
      entryPoints: [resolve(WORKER_ROOT, "src/postgres-runtime-schema.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      write: false,
      logLevel: "silent",
    });
    const runtimePath = join(temporary, "runtime-schema.mjs");
    await writeFile(runtimePath, runtimeBundle.outputFiles[0].contents);
    const { POSTGRES_RUNTIME_MIGRATIONS } = await import(pathToFileURL(runtimePath).href);

    vite = await createServer({
      root: WORKER_ROOT,
      configFile: false,
      server: { middlewareMode: true },
      appType: "custom",
    });
    const [transport, v12Admission, admission, rateLimit, bodyReader, constants,
      cryptoModule, telemetryV12Repository, deviceSync, typedCodec, typedV12EffectiveReader,
      accountlessAdapter, accountlessRenewalAdapter, accountlessEnrollment, accountlessOwnership,
      accountlessRenewal, transportPolicy, postgresCredentialRenewalAdapter,
      postgresDeviceDisconnectAdapter]
      = await Promise.all([
        vite.ssrLoadModule("/src/postgres-typed-v12-transport.ts"),
        vite.ssrLoadModule("/src/postgres-typed-v12-admission.ts"),
        vite.ssrLoadModule("/src/admission.ts"),
        vite.ssrLoadModule("/src/postgres-rate-limiter.ts"),
        vite.ssrLoadModule("/src/bounded-body.ts"),
        vite.ssrLoadModule("/src/constants.ts"),
        vite.ssrLoadModule("/src/crypto.ts"),
        vite.ssrLoadModule("/src/telemetry-v12-repository.ts"),
        vite.ssrLoadModule("/src/postgres-device-sync.ts"),
        vite.ssrLoadModule("/src/typed-telemetry-codec.ts"),
        vite.ssrLoadModule("/src/postgres-typed-v12-effective-reader.ts"),
        vite.ssrLoadModule("/src/postgres-accountless-enrollment.ts"),
        vite.ssrLoadModule("/src/postgres-accountless-renewal.ts"),
        vite.ssrLoadModule("/src/accountless-enrollment.ts"),
        vite.ssrLoadModule("/src/accountless-ownership.ts"),
        vite.ssrLoadModule("/src/accountless-renewal.ts"),
        vite.ssrLoadModule("/src/telemetry-transport-policy.ts"),
        vite.ssrLoadModule("/src/postgres-device-credential-renewal.ts"),
        vite.ssrLoadModule("/src/postgres-device-disconnect.ts"),
      ]);
    const deviceSyncReads = await vite.ssrLoadModule("/src/postgres-device-sync-reads.ts");
    const v12ManifestCandidates = await vite.ssrLoadModule("/src/postgres-v12-manifest-candidates.ts");
    const [uploadAuthorization, formatAuthority] = await Promise.all([
      vite.ssrLoadModule("/src/postgres-upload-authorization.ts"),
      vite.ssrLoadModule("/src/postgres-telemetry-format-authority.ts"),
    ]);
    const typedV12Domain = await vite.ssrLoadModule("/src/postgres-typed-v12-domain.ts");
    const keyPair = await webcrypto.subtle.generateKey({
      name: "RSA-OAEP", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
    }, true, ["encrypt", "decrypt"]);
    const envelopePublicJwk = {
      ...await webcrypto.subtle.exportKey("jwk", keyPair.publicKey),
      kid: "key:gcp-host-v12",
    };
    const envelopePrivateJwk = {
      ...await webcrypto.subtle.exportKey("jwk", keyPair.privateKey),
      kid: "key:gcp-host-v12",
    };
    const storedObjects = new Map();
    let objectPutCount = 0;
    let objectDeleteCount = 0;
    let failNextObjectPutAfterStore = false;
    let twoPutBarrier = null;
    let lastPut = null;
    const objectPuts = [];
    const objectStore = {
      async put(key, value, options) {
        objectPutCount += 1;
        assert.equal(options?.contentType, "application/json");
        const bytes = Uint8Array.from(value);
        lastPut = { key, bytes, metadata: options?.customMetadata };
        objectPuts.push(lastPut);
        storedObjects.set(key, lastPut);
        const barrier = twoPutBarrier;
        if (barrier) {
          barrier.waiting += 1;
          if (barrier.waiting === 2) {
            twoPutBarrier = null;
            barrier.release();
          }
          await barrier.promise;
        }
        if (failNextObjectPutAfterStore) {
          failNextObjectPutAfterStore = false;
          throw new Error("synthetic provider acknowledgement loss");
        }
      },
      async delete(key) {
        objectDeleteCount += 1;
        storedObjects.delete(key);
        if (lastPut?.key === key) lastPut = null;
      },
    };

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const expiry = new Date(now + 7 * 24 * 60 * 60_000).toISOString();
    const participantId = `synthetic-host-v12-${suffix}`;
    const deviceId = randomUUID();
    const pairingId = randomUUID();
    const sessionId = randomUUID();
    const deviceSecret = randomBytes(32).toString("base64url");
    const primaryTable = (name) => quotedTable(primarySchema, name);
    const schemaOptions = { primarySchema };
    const unknownEffectivePageSchema = `host_missing_v12_${suffix}`;
    let useUnknownEffectivePageSchema = false;
    const sourceNamespace = `synthetic-host-source-${suffix}`;
    const encodedSourceNamespace = Buffer.from(typedCodec.encodeTypedTelemetryId(sourceNamespace));
    const auth = `Device um_device_${deviceId}.${deviceSecret}`;

    await primaryPool.query(
      `INSERT INTO ${primaryTable("participants")} (
         id, owner_kind, state, consent_version, created_at
       ) VALUES ($1, 'social', 'active', $2, $3)`,
      [participantId, constants.TELEMETRY_CONSENT_VERSION, nowIso],
    );
    // Primary 0051 creates a social participant's enrollment namespace with
    // the participant (D1 0058 parity), so read it back instead of inserting.
    const enrollment = await primaryPool.query(
      `SELECT namespace FROM ${primaryTable("attribution_enrollments")} WHERE participant_id=$1`,
      [participantId],
    );
    assert.equal(enrollment.rowCount, 1);
    const enrollmentNamespace = enrollment.rows[0].namespace;
    assert.match(enrollmentNamespace, /^[0-9a-f]{64}$/u);
    await primaryPool.query(
      `INSERT INTO ${primaryTable("web_sessions")} (
         id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$5)`,
      [sessionId, participantId, randomBytes(32), randomBytes(32), nowIso, expiry],
    );
    await primaryPool.query(
      `INSERT INTO ${primaryTable("device_pairings")} (
         id, participant_id, issued_by_session_id, secret_hash, consent_version,
         transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
       ) VALUES ($1,$2,$3,$4,$5,$5,'consumed',$6,$7,$6,$8)`,
      [pairingId, participantId, sessionId, randomBytes(32), constants.TELEMETRY_CONSENT_VERSION,
        nowIso, expiry, deviceId],
    );
    await primaryPool.query(
      `INSERT INTO ${primaryTable("device_credentials")} (
         id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
         state, issued_at, expires_at, last_used_at, social_verified_at
       ) VALUES ($1,$2,'social',$3,$4,'active',$5,$6,$5,$5)`,
      [deviceId, participantId, pairingId, deviceSecretHash(deviceId, deviceSecret), nowIso, expiry],
    );
    await primaryPool.query(
      `INSERT INTO ${primaryTable("telemetry_v12_device_capabilities")} (
         participant_id, device_id, telemetry_schema_version, field_dictionary_version,
         privacy_contract_version, state, consented_at
       ) VALUES ($1,$2,$3,$4,$5,'accepted',$6)`,
      [participantId, deviceId, TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
        TELEMETRY_V12_FIELD_DICTIONARY_VERSION, TELEMETRY_V12_PRIVACY_CONTRACT_VERSION, nowIso],
    );
    await primaryPool.query(
      `INSERT INTO ${primaryTable("typed_telemetry_namespaces")} (id, original_id)
       VALUES (1, $1)`,
      [encodedSourceNamespace],
    );
    await primaryPool.query(
      `INSERT INTO ${primaryTable("typed_v1_admission_state")} (
         id, source_namespace, namespace_id, runtime_contract_version, next_source_row_id
       ) VALUES (1, $1, 1, 1, 1)`,
      [sourceNamespace],
    );
    await primaryPool.query(
      `INSERT INTO ${primaryTable("typed_v11_admission_state")} (
         id, source_namespace, namespace_id, runtime_contract_version, next_source_row_id
       ) VALUES (1, $1, 1, 1, 1)`,
      [sourceNamespace],
    );
    await primaryPool.query(
      `INSERT INTO ${primaryTable("storage_v11_owner_links")} (participant_id, owner_digest, state)
       VALUES ($1,$2,'active')`,
      [participantId, randomBytes(32).toString("hex")],
    );
    await primaryPool.query(
      `UPDATE ${primaryTable("telemetry_v12_runtime")} SET state='active', changed_at=$1 WHERE id=1`,
      [nowIso],
    );
    await primaryPool.query(
      `UPDATE ${primaryTable("telemetry_v12_typed_runtime")} SET state='active', changed_at=$1 WHERE id=1`,
      [nowIso],
    );
    await primaryPool.query(
      `UPDATE ${primaryTable("collection_controls")}
          SET revision=2, control_state='operational', enrollment_enabled=true,
              upload_registration_enabled=true, processing_enabled=true,
              publication_enabled=true, updated_at=$1
        WHERE singleton=1`,
      [nowIso],
    );

    const ingressFixture = await uploadIngressFixture(vite, primaryPool, primarySchema);
    const admissionEnv = {
      ENVIRONMENT: "test",
      ACCOUNTLESS_ENROLLMENT_MODE: "enabled",
      ACCOUNTLESS_OWNERSHIP_MODE: "enabled",
      ...ingressFixture.env,
    };
    for (const [binding, name, limit] of [
      ["ENROLLMENT_RATE_LIMIT", "ENROLLMENT", 20],
      // This end-to-end fixture exercises more than 20 authenticated sync
      // requests; cover the fixed-window boundary separately below.
      ["RECOVERY_RATE_LIMIT", "RECOVERY", 100],
      ["CLIENT_ATTEMPT_RATE_LIMIT", "CLIENT_ATTEMPT", 1_000],
      ["PUBLIC_READ_RATE_LIMIT", "PUBLIC_READ", 1_000],
      ["UPLOAD_AUTHORIZATION_RATE_LIMIT", "UPLOAD_AUTHORIZATION", 1_000],
      ["UPLOAD_PRINCIPAL_RATE_LIMIT", "UPLOAD_PRINCIPAL", 1_000],
      ["UPLOAD_INGRESS_REQUEST_RATE_LIMIT", "UPLOAD_INGRESS_REQUEST", 1_000],
      ["UPLOAD_INGRESS_CLIENT_RATE_LIMIT", "UPLOAD_INGRESS_CLIENT", 1_000],
    ]) {
      admissionEnv[binding] = rateLimit.createPostgresRateLimiter(primaryPool, {
        primarySchema,
        name,
        limit,
        periodSeconds: 60,
        keyHashSecret: randomBytes(32),
      });
    }
    const recoveryBoundary = rateLimit.createPostgresRateLimiter(primaryPool, {
      primarySchema,
      name: "HOST_RECOVERY_BOUNDARY",
      limit: 20,
      periodSeconds: 60,
      keyHashSecret: randomBytes(32),
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      assert.deepEqual(await recoveryBoundary.limit({ key: "synthetic-host-boundary" }), { success: true });
    }
    assert.deepEqual(await recoveryBoundary.limit({ key: "synthetic-host-boundary" }), { success: false });
    assert.deepEqual(await recoveryBoundary.limit({ key: "synthetic-other-device" }), { success: true });
    const healthDispatch = createPostgresTestHealthDispatch({
      primaryPool,
      schemaOptions,
      expectedMigrations: POSTGRES_RUNTIME_MIGRATIONS,
      privateOrigin: "http://127.0.0.1:43817",
    });
    let deviceSyncRateLimitCalls = 0;
    let deviceDisconnectRateLimitCalls = 0;
    const manifestDispatchOptions = {
      primaryPool,
      schemaOptions,
      expectedMigrations: POSTGRES_RUNTIME_MIGRATIONS,
      privateOrigin: "http://127.0.0.1:43817",
      healthDispatch,
      accountlessAuthority: Object.freeze({
        authenticateV12Grant: accountlessAdapter.authenticatePostgresAccountlessOwnerForV12Grant,
        enroll: accountlessAdapter.enrollPostgresAccountlessDevice,
        createOwner: accountlessAdapter.createPostgresAccountlessUploadOwner,
        grantV12: accountlessAdapter.grantPostgresTelemetryV12AccountlessAuthorization,
        renew: accountlessRenewalAdapter.renewPostgresAccountlessUploadOwner,
        parseEnrollmentJson: accountlessEnrollment.parseAccountlessEnrollmentJson,
        parseOwnershipJson: accountlessOwnership.parseAccountlessOwnershipJson,
        parseV12AuthorizationJson: transportPolicy.parseTelemetryV12AccountlessAuthorizationJson,
        parseRenewalJson: accountlessRenewal.parseAccountlessRenewalJson,
        maxEnrollmentBytes: accountlessEnrollment.ACCOUNTLESS_ENROLLMENT_MAX_REQUEST_BYTES,
        maxOwnershipBytes: accountlessOwnership.ACCOUNTLESS_UPLOAD_OWNER_MAX_REQUEST_BYTES,
        maxRenewalBytes: accountlessRenewal.ACCOUNTLESS_RENEWAL_MAX_REQUEST_BYTES,
      }),
      deviceCredentialRenewalAuthority: Object.freeze({
        renew: postgresCredentialRenewalAdapter.renewPostgresDeviceCredential,
        parseRequest: postgresCredentialRenewalAdapter.parsePostgresDeviceCredentialRenewalJson,
        maxRequestBytes:
          postgresCredentialRenewalAdapter.POSTGRES_DEVICE_CREDENTIAL_RENEWAL_MAX_REQUEST_BYTES,
      }),
      admissionEnv: Object.freeze(admissionEnv),
      assertAdmissionBindings: admission.assertAdmissionBindings,
      assertAttemptAllowed: (...args) => {
        if (args[4] === "device_sync") deviceSyncRateLimitCalls += 1;
        if (args[4] === "device_disconnect") deviceDisconnectRateLimitCalls += 1;
        return admission.assertAttemptAllowed(...args);
      },
      assertUploadAuthorizationBindings: admission.assertUploadAuthorizationBindings,
      assertUploadAuthorizationAllowed: admission.assertUploadAuthorizationAllowed,
      assertUploadIngressRequestAllowed: admission.assertUploadIngressRequestAllowed,
      uploadIngress: ingressFixture.uploadIngress,
      authenticatePostgresDevice: transport.authenticatePostgresDevice,
      disconnectPostgresAuthenticatedDevice:
        postgresDeviceDisconnectAdapter.disconnectPostgresAuthenticatedDevice,
      readPostgresDeviceSyncState: deviceSyncReads.readPostgresDeviceSyncState,
      readPostgresDeviceSyncManifest: deviceSyncReads.readPostgresDeviceSyncManifest,
      readPostgresDeviceSyncCapabilities: deviceSync.readPostgresDeviceSyncCapabilities,
      readPostgresDeviceSyncV12Capabilities: deviceSync.readPostgresDeviceSyncV12Capabilities,
      readPostgresV12DayCandidates: v12ManifestCandidates.readPostgresV12DayCandidates,
      readPostgresTelemetryV12EffectivePage:
        (pool, options, readerOptions) => typedV12EffectiveReader.readPostgresTelemetryV12EffectivePage(
          pool,
          options,
          {
            ...readerOptions,
            schema: useUnknownEffectivePageSchema
              ? { ...schemaOptions, primarySchema: unknownEffectivePageSchema }
              : readerOptions?.schema,
          },
        ),
      publicEnvelopeKey: cryptoModule.publicEnvelopeKey,
      sourceNamespace,
      createPostgresTypedV12Domain: typedV12Domain.createPostgresTypedV12Domain,
      assertPostgresV12UploadAllowed: (pool, principal, nowEpoch, options) =>
        formatAuthority.assertPostgresTelemetryTransportWriteAllowed(
          pool, principal, TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
          { ...options, nowEpoch },
        ),
      createPostgresDeviceUploadAuthorization: uploadAuthorization.createPostgresDeviceUploadAuthorization,
      registerPostgresTypedV12DayManifest: v12Admission.registerPostgresTypedV12DayManifest,
      claimPostgresDeviceUploadAuthorization: transport.claimPostgresDeviceUploadAuthorization,
      abandonPostgresDeviceUploadAuthorization: transport.abandonPostgresDeviceUploadAuthorization,
      persistPostgresTypedV12StagedChunk: v12Admission.persistPostgresTypedV12StagedChunk,
      decryptSyntheticEnvelope: cryptoModule.decryptSyntheticEnvelope,
      validateTelemetryV12Envelope,
      validateTelemetryV12StagedChunk: telemetryV12Repository.validateTelemetryV12StagedChunk,
      sha256Hex: cryptoModule.sha256Hex,
      objectStore,
      envelopePublicJwk: JSON.stringify(envelopePublicJwk),
      envelopePrivateJwk: JSON.stringify(envelopePrivateJwk),
      readBoundedRequestBody: bodyReader.readBoundedRequestBody,
      maxRequestBytes: constants.MAX_REQUEST_BYTES,
    };
    const manifestDispatch = createPostgresTestV12DayManifestDispatch(manifestDispatchOptions);
    let d1Touched = 0;
    let workerCalls = 0;
    const runtime = {
      postgresTestDispatch: manifestDispatch,
      get env() {
        d1Touched += 1;
        throw new Error("D1 must remain unreachable in partial v1.2 mode");
      },
    };
    const workerHandler = async () => {
      workerCalls += 1;
      throw new Error("the D1 Worker handler must remain unreachable in partial v1.2 mode");
    };
    const dispatch = (request) => dispatchCloudRunHostRequest(request, runtime, workerHandler);
    const manifestUrl = "http://127.0.0.1:43817/api/v1/device/telemetry/v1.2/day-manifests";
    const uploadAuthorizationUrl = "http://127.0.0.1:43817/api/v1/device/upload-authorizations";
    const request = ({ body = "{}", headers = {}, method = "POST", url = manifestUrl } = {}) => new Request(url, {
      method,
      headers: { authorization: auth, "content-type": "application/json", ...headers },
      ...(method === "GET" || method === "HEAD" ? {} : { body }),
    });

    for (const unsupported of [
      request({ url: "http://127.0.0.2:43817/api/health", method: "GET" }),
      request({ url: "http://127.0.0.1:43817/api/v1/contribute" }),
      request({ url: "http://127.0.0.1:43817/api/v1/unsupported-read", method: "GET" }),
    ]) {
      const response = await dispatch(unsupported);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, "POSTGRES_TEST_ROUTE_UNSUPPORTED");
    }
    const health = await dispatch(request({ url: "http://127.0.0.1:43817/api/health", method: "GET" }));
    if (health.status !== 200) {
      const status = await health.clone().json();
      throw new Error(`POSTGRES_TEST_HEALTH_NOT_READY:${status?.checks?.primaryMigrationReceipt?.status ?? "unknown"}`);
    }
    assert.equal((await health.json()).workerApplicationReady, false);

    const syncStateUrl = "http://127.0.0.1:43817/api/v1/device/sync/state";
    const syncManifestUrl = "http://127.0.0.1:43817/api/v1/device/sync/manifest";
    const syncCapabilitiesUrl = "http://127.0.0.1:43817/api/v1/device/sync-capabilities";
    const syncCapabilitiesV12Url = "http://127.0.0.1:43817/api/v1/device/sync-capabilities-v1.2";
    const envelopeKeyUrl = "http://127.0.0.1:43817/api/v1/envelope-key";
    const domainPredecessorUrl = "http://127.0.0.1:43817/api/v1/me/telemetry-v12/domain-predecessor";
    const domainActivateUrl = "http://127.0.0.1:43817/api/v1/me/telemetry-v12/domain-activate";
    const effectivePageUrl = "http://127.0.0.1:43817/api/v1/me/telemetry-v12/effective-page";
    const emptySyncStateResponse = await dispatch(request({ url: syncStateUrl, method: "GET" }));
    assert.equal(emptySyncStateResponse.status, 200);
    const emptySyncState = await emptySyncStateResponse.json();
    const { retryAt, ...admissionWithoutRetryAt } = emptySyncState.admission;
    assert.deepEqual({ ...emptySyncState, admission: admissionWithoutRetryAt }, {
      schemaVersion: "device-sync-state-v1.0",
      contractVersion: "telemetry-contribution-v1.0",
      acknowledgedThroughDay: null,
      historyDigest: null,
      dayCount: 0,
      chunkCount: 0,
      admission: {
        schemaVersion: "telemetry-chunk-admission-v1.0",
        state: "available",
        windowDay: nowIso.slice(0, 10),
        budget: "launch_week",
        acceptedChunks: 0,
        remainingChunks: 20_000,
        maximumChunks: 20_000,
      },
    });
    assert.match(retryAt, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u);
    const syncManifestRequestCount = deviceSyncRateLimitCalls;
    const emptySyncManifestResponse = await dispatch(request({
      url: `${syncManifestUrl}?fromDay=2026-08-01&toDay=2026-08-02&ignored=1`, method: "GET",
    }));
    assert.equal(emptySyncManifestResponse.status, 200);
    assert.deepEqual(await emptySyncManifestResponse.json(), {
      schemaVersion: "device-sync-manifest-v1.0",
      contractVersion: "telemetry-contribution-v1.0",
      fromDay: "2026-08-01",
      toDay: "2026-08-02",
      days: [],
    });
    assert.equal(deviceSyncRateLimitCalls, syncManifestRequestCount + 1,
      "legacy manifest reads must consume the authenticated device-sync limiter");
    const normalizedDayManifestResponse = await dispatch(request({
      url: `${syncManifestUrl}?fromDay=2026-02-30&toDay=2026-03-03`, method: "GET",
    }));
    assert.equal(normalizedDayManifestResponse.status, 200);
    assert.deepEqual(await normalizedDayManifestResponse.json(), {
      schemaVersion: "device-sync-manifest-v1.0",
      contractVersion: "telemetry-contribution-v1.0",
      fromDay: "2026-02-30",
      toDay: "2026-03-03",
      days: [],
    }, "the private PG route preserves D1's Date.parse-normalized day boundary");
    await assertApiError(await dispatch(request({
      url: syncManifestUrl, method: "GET",
    })), 400, "BODY_INVALID");
    await assertApiError(await dispatch(request({
      url: `${syncManifestUrl}?fromDay=2026-01-01&toDay=2026-02-01`, method: "GET",
    })), 400, "SYNC_RANGE_TOO_LARGE");
    await assertApiError(await dispatch(request({
      url: `${syncManifestUrl}?fromDay=2026-02-32&toDay=2026-03-01`, method: "GET",
    })), 400, "BODY_INVALID");
    const capabilitiesResponse = await dispatch(request({ url: syncCapabilitiesV12Url, method: "GET" }));
    assert.equal(capabilitiesResponse.status, 200);
    const capabilities = await capabilitiesResponse.json();
    assert.deepEqual(capabilities, {
      schemaVersion: "device-sync-capabilities-v1.2",
      destinationOrigin: "http://127.0.0.1:43817",
      enrollmentNamespace,
      identityVersion: "account-track-v2",
      authorityKind: "social",
      successor: {
        schemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
        envelopeSchemaVersion: "telemetry-envelope-v1.2",
        lifecycle: "accepted",
        requiredConsent: telemetryV12RequiredConsent(),
        consentCurrent: true,
        authorizationCurrent: true,
        activationTime: nowIso,
      },
    });

    // The frozen legacy capability response advertises exactly its four
    // schemas, even though PostgreSQL also contains the separately-negotiated
    // v1.2 format row. A missing participant floor fails closed. Primary 0051
    // creates the social participant floor and the device floor on insert
    // (D1 parity), so remove both to reach that fail-closed path.
    await primaryPool.query(
      `DELETE FROM ${primaryTable("telemetry_transport_device_floors")} WHERE participant_id=$1`,
      [participantId],
    );
    await primaryPool.query(
      `DELETE FROM ${primaryTable("telemetry_transport_participant_floors")} WHERE participant_id=$1`,
      [participantId],
    );
    const legacyCapabilitiesRequestCount = deviceSyncRateLimitCalls;
    const missingFloorResponse = await dispatch(request({ url: syncCapabilitiesUrl, method: "GET" }));
    assert.equal(missingFloorResponse.status, 401, JSON.stringify(await missingFloorResponse.clone().json()));
    await assertApiError(missingFloorResponse, 401, "DEVICE_AUTH_INVALID");
    assert.equal(deviceSyncRateLimitCalls, legacyCapabilitiesRequestCount + 1);
    await primaryPool.query(
      `INSERT INTO ${primaryTable("telemetry_transport_participant_floors")} (
         participant_id, minimum_rank, revision, changed_at
       ) VALUES ($1, 1, 7, $2)`,
      [participantId, nowIso],
    );
    await primaryPool.query(
      `INSERT INTO ${primaryTable("telemetry_transport_device_floors")} (
         participant_id, device_id, minimum_rank, revision, changed_at
       ) VALUES ($1, $2, 10, 3, $3)`,
      [participantId, deviceId, nowIso],
    );
    const legacyCapabilitiesResponse = await dispatch(request({
      url: syncCapabilitiesUrl,
      method: "GET",
    }));
    assert.equal(legacyCapabilitiesResponse.status, 200);
    assert.equal(legacyCapabilitiesResponse.headers.get("cache-control"), "no-store");
    assert.equal(deviceSyncRateLimitCalls, legacyCapabilitiesRequestCount + 2);
    const legacyCapabilities = await legacyCapabilitiesResponse.json();
    assert.deepEqual(legacyCapabilities, {
      schemaVersion: "device-sync-capabilities-v1.1",
      destinationOrigin: "http://127.0.0.1:43817",
      enrollmentNamespace,
      identityVersion: "account-track-v2",
      minimumWriteRank: 10,
      policyRevision: 7,
      requiredConsent: telemetryV11RequiredConsent(),
      formats: [
        { schemaVersion: "telemetry-contribution-v0.1", rank: 1, lifecycle: "accepted" },
        { schemaVersion: "telemetry-contribution-v0.2", rank: 2, lifecycle: "blocked" },
        { schemaVersion: "telemetry-contribution-v1.0", rank: 10, lifecycle: "accepted" },
        { schemaVersion: "telemetry-contribution-v1.1", rank: 11, lifecycle: "staged" },
      ],
      consentCurrent: false,
    });
    assert.equal(legacyCapabilities.formats.length, 4);
    assert.equal(legacyCapabilities.formats.some((format) => format.rank === 12), false);

    const cookiesOnDeviceRoute = await dispatch(request({
      url: syncCapabilitiesUrl,
      method: "GET",
      headers: { cookie: "session=synthetic" },
    }));
    await assertApiError(cookiesOnDeviceRoute, 401, "DEVICE_AUTH_INVALID");
    await assertApiError(await dispatch(request({
      url: syncCapabilitiesUrl,
      method: "GET",
      headers: { authorization: "Device um_device_invalid.invalid" },
    })), 401, "DEVICE_AUTH_INVALID");
    await assertApiError(await dispatch(request({
      url: syncCapabilitiesUrl,
      method: "POST",
    })), 405, "METHOD_NOT_ALLOWED");

    runtime.postgresTestDispatch = createPostgresTestV12DayManifestDispatch({
      ...manifestDispatchOptions,
      sourceNamespace: `${sourceNamespace}-mismatch`,
    });
    try {
      await assertApiError(await dispatch(request({
        url: syncCapabilitiesUrl,
        method: "GET",
      })), 503, "BACKEND_STORAGE_UNAVAILABLE");
    } finally {
      runtime.postgresTestDispatch = manifestDispatch;
    }

    await primaryPool.query(
      `UPDATE ${primaryTable("telemetry_transport_formats")}
          SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'`,
    );
    await primaryPool.query(
      `INSERT INTO ${primaryTable("telemetry_v11_device_consents")} (
         participant_id, device_id, telemetry_schema_version,
         field_dictionary_version, privacy_contract_version, consented_at
       ) VALUES ($1, $2, 'telemetry-contribution-v1.1',
         'telemetry-v1.1-registry-2026-08-31.1',
         'ongoing-privacy-safe-telemetry-v1.1', $3)`,
      [participantId, deviceId, nowIso],
    );
    // Primary 0051 (e): the v1.1 consent insert itself raises the device floor
    // and the participant floor to 11, each with revision + 1 (D1 parity), so
    // the floors this check used to raise by hand are asserted instead.
    assert.deepEqual((await primaryPool.query(
      `SELECT participant.minimum_rank AS participant_rank, participant.revision AS participant_revision,
              device.minimum_rank AS device_rank, device.revision AS device_revision
         FROM ${primaryTable("telemetry_transport_participant_floors")} participant
         JOIN ${primaryTable("telemetry_transport_device_floors")} device
           ON device.participant_id = participant.participant_id AND device.device_id = $2
        WHERE participant.participant_id = $1`,
      [participantId, deviceId],
    )).rows, [{ participant_rank: 11, participant_revision: 8, device_rank: 11, device_revision: 4 }]);
    const consentedCapabilities = await dispatch(request({
      url: syncCapabilitiesUrl,
      method: "GET",
    }));
    assert.equal(consentedCapabilities.status, 200);
    const consentedLegacyCapabilities = await consentedCapabilities.json();
    assert.equal(consentedLegacyCapabilities.minimumWriteRank, 11);
    assert.equal(consentedLegacyCapabilities.policyRevision, 8);
    assert.equal(consentedLegacyCapabilities.consentCurrent, true);
    assert.equal(consentedLegacyCapabilities.formats[3].lifecycle, "accepted");

    const incompatibleContributionId = `contribution:${randomUUID()}`;
    const legacyHistoryClient = await primaryPool.connect();
    try {
      await legacyHistoryClient.query("BEGIN");
      await legacyHistoryClient.query(
        `SET LOCAL search_path TO "${primarySchema}", pg_catalog`,
      );
      await legacyHistoryClient.query(
        `INSERT INTO ${primaryTable("telemetry_contributions")} (
           id, participant_id, plaintext_digest, envelope_digest, r2_key, status,
           schema_version, transport_schema_version, range_start, range_end,
           client_platform, provider_policy_epoch, priced_event_coverage_percent,
           unknown_model_event_count, unknown_billable_units, price_basis,
           declared_record_count, created_at
         ) VALUES ($1, $2, $3, $4, $5, 'accepted',
           'telemetry-contribution-v0.1', 'telemetry-contribution-v0.2',
           $6, $7, 'macos', 'unknown', 0, 0, 0, 'unavailable', 0, $7)`,
        [incompatibleContributionId, participantId, "a".repeat(64), "b".repeat(64),
          `synthetic/${suffix}/v02-history`, "2026-09-24T00:00:00.000Z", nowIso],
      );
      await legacyHistoryClient.query("COMMIT");
    } catch (error) {
      await legacyHistoryClient.query("ROLLBACK");
      throw error;
    } finally {
      legacyHistoryClient.release();
    }
    const blockedSuccessorResponse = await dispatch(request({
      url: syncCapabilitiesUrl,
      method: "GET",
    }));
    assert.equal(blockedSuccessorResponse.status, 200);
    const blockedSuccessorCapabilities = await blockedSuccessorResponse.json();
    assert.equal(blockedSuccessorCapabilities.consentCurrent, true);
    assert.equal(blockedSuccessorCapabilities.formats[3].lifecycle, "blocked",
      "accepted legacy v0.2 history blocks v1.1 lifecycle without erasing consent");
    await primaryPool.query(
      `DELETE FROM ${primaryTable("telemetry_contributions")} WHERE id=$1`,
      [incompatibleContributionId],
    );

    const envelopeKeyResponse = await dispatch(new Request(envelopeKeyUrl));
    assert.equal(envelopeKeyResponse.status, 200);
    const envelopeKey = await envelopeKeyResponse.json();
    assert.deepEqual(envelopeKey, {
      algorithm: "RSA-OAEP-256",
      keyId: "key:gcp-host-v12",
      publicJwk: {
        alg: "RSA-OAEP-256",
        e: envelopePublicJwk.e,
        key_ops: ["encrypt"],
        kid: "key:gcp-host-v12",
        kty: "RSA",
        n: envelopePublicJwk.n,
        use: "enc",
      },
    });
    assert.equal(Object.hasOwn(envelopeKey.publicJwk, "d"), false);

    const candidateFixtures = Array.from({ length: 205 }, (_, index) => ({
      id: randomUUID(),
      day: index % 3 === 0 ? "2020-01-02" : "2020-01-01",
      digest: sha256Hex(`synthetic-v12-candidate:${suffix}:${index}`),
      createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, Math.floor(index / 3))).toISOString(),
      expectedChunks: index % 5,
    }));
    const candidateValues = [];
    const candidateSqlRows = candidateFixtures.map((fixture, index) => {
      const offset = index * 10;
      candidateValues.push(
        fixture.id, participantId, deviceId, fixture.day, fixture.digest,
        "synthetic-manifest-candidate", "{}", fixture.expectedChunks, "staged", fixture.createdAt,
      );
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}::date,
        $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10})`;
    });
    await primaryPool.query(
      `INSERT INTO ${primaryTable("telemetry_v12_day_manifests")} (
         id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
         manifest_json, expected_chunk_count, state, created_at
       ) VALUES ${candidateSqlRows.join(",")}`,
      candidateValues,
    );
    const candidatesRequestCount = deviceSyncRateLimitCalls;
    const candidatesResponse = await dispatch(request({
      method: "GET",
      url: `${manifestUrl}?fromDay=2020-01-01&toDay=2020-01-31`,
    }));
    assert.equal(candidatesResponse.status, 200);
    assert.equal(deviceSyncRateLimitCalls, candidatesRequestCount + 1,
      "manifest reads must consume the authenticated device-sync limiter");
    const sortedCandidates = [...candidateFixtures].sort((left, right) =>
      left.day.localeCompare(right.day)
      || left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id));
    assert.deepEqual(await candidatesResponse.json(), {
      candidates: sortedCandidates.slice(0, 200).map((fixture) => ({
        manifestId: fixture.id,
        day: fixture.day,
        manifestDigest: fixture.digest,
        state: "staged",
        expectedChunks: fixture.expectedChunks,
      })),
      bounded: true,
    });
    await assertApiError(await dispatch(request({
      method: "GET",
      url: `${manifestUrl}?fromDay=2020-01-01&toDay=2020-01-02&extra=1`,
    })), 400, "BODY_INVALID");
    await assertApiError(await dispatch(request({
      method: "GET",
      url: `${manifestUrl}?fromDay=2020-01-01&fromDay=2020-01-02&toDay=2020-01-03`,
    })), 400, "BODY_INVALID");
    await assertApiError(await dispatch(request({
      method: "GET",
      url: `${manifestUrl}?fromDay=2020-01-01&toDay=2020-02-01`,
    })), 400, "SYNC_RANGE_TOO_LARGE");
    const wrongMethodResponse = await dispatch(request({ url: syncStateUrl }));
    await assertApiError(wrongMethodResponse, 405, "METHOD_NOT_ALLOWED");
    assert.equal(wrongMethodResponse.headers.get("allow"), "GET");
    const wrongSyncManifestMethodResponse = await dispatch(request({ url: syncManifestUrl }));
    await assertApiError(wrongSyncManifestMethodResponse, 405, "METHOD_NOT_ALLOWED");
    assert.equal(wrongSyncManifestMethodResponse.headers.get("allow"), "GET");
    const wrongPredecessorMethod = await dispatch(request({
      url: domainPredecessorUrl, method: "GET",
    }));
    await assertApiError(wrongPredecessorMethod, 405, "METHOD_NOT_ALLOWED");
    assert.equal(wrongPredecessorMethod.headers.get("allow"), "POST");
    await assertApiError(await dispatch(request({
      url: syncStateUrl, method: "GET", headers: { cookie: "session=not-used" },
    })), 401, "DEVICE_AUTH_INVALID");
    await assertApiError(await dispatch(request({
      url: syncManifestUrl, method: "GET", headers: { cookie: "session=not-used" },
    })), 401, "DEVICE_AUTH_INVALID");
    await assertApiError(await dispatch(request({
      url: manifestUrl, method: "GET", headers: { cookie: "session=not-used" },
    })), 401, "DEVICE_AUTH_INVALID");
    await assertApiError(await dispatch(request({
      url: domainPredecessorUrl, headers: { cookie: "session=not-used" }, body: "{}",
    })), 401, "DEVICE_AUTH_INVALID");
    await assertApiError(await dispatch(request({
      url: domainPredecessorUrl, body: JSON.stringify({ extra: true }),
    })), 400, "BODY_INVALID");
    await assertApiError(await dispatch(request({
      url: domainActivateUrl, body: "{}",
    })), 400, "TELEMETRY_MANIFEST_INVALID");

    await primaryPool.query(
      `UPDATE ${primaryTable("telemetry_v12_runtime")} SET state='staged' WHERE id=1`,
    );
    await primaryPool.query(
      `UPDATE ${primaryTable("telemetry_v12_typed_runtime")} SET state='staged' WHERE id=1`,
    );
    const stagedCapabilitiesResponse = await dispatch(request({
      url: syncCapabilitiesV12Url, method: "GET",
    }));
    assert.equal(stagedCapabilitiesResponse.status, 200);
    const stagedCapabilities = await stagedCapabilitiesResponse.json();
    assert.equal(stagedCapabilities.successor.lifecycle, "staged");
    assert.equal(stagedCapabilities.successor.authorizationCurrent, false);
    assert.equal(stagedCapabilities.successor.activationTime, nowIso);
    await primaryPool.query(
      `UPDATE ${primaryTable("telemetry_v12_runtime")} SET state='active' WHERE id=1`,
    );
    await primaryPool.query(
      `UPDATE ${primaryTable("telemetry_v12_typed_runtime")} SET state='active' WHERE id=1`,
    );

    await primaryPool.query(
      `DELETE FROM ${primaryTable("typed_v11_admission_state")} WHERE id=1`,
    );
    await assertApiError(await dispatch(request({
      url: syncCapabilitiesV12Url, method: "GET",
    })), 503, "BACKEND_STORAGE_UNAVAILABLE");
    await primaryPool.query(
      `INSERT INTO ${primaryTable("typed_v11_admission_state")} (
         id, source_namespace, namespace_id, runtime_contract_version, next_source_row_id
       ) VALUES (1, $1, 1, 1, 1)`,
      [sourceNamespace],
    );

    await assertApiError(await dispatch(request({ headers: { cookie: "session=not-used" } })), 401, "DEVICE_AUTH_INVALID");
    await assertApiError(await dispatch(request({ headers: {
      authorization: `Device um_device_${deviceId}.${randomBytes(32).toString("base64url")}`,
    } })), 401, "DEVICE_AUTH_INVALID");
    await assertApiError(await dispatch(request({ headers: { "content-type": "text/plain" } })), 415, "CONTENT_TYPE_INVALID");
    await assertApiError(await dispatch(request({ body: " ".repeat(constants.MAX_REQUEST_BYTES + 1) })), 413, "BODY_TOO_LARGE");
    const chunkUploadUrl = "http://127.0.0.1:43817/api/v1/contributions";
    // An oversize body behind a well-formed Upload header passes the d43c8f92
    // preflight (index.ts:621-644, which a Device bearer fails with 401) and
    // the ingress limiter, then the bounded read refuses it.
    const wellFormedUpload = `Upload um_device_upload_${randomUUID()}.${"A".repeat(43)}`;
    await assertApiError(await dispatch(request({
      url: chunkUploadUrl, headers: { authorization: wellFormedUpload },
      body: " ".repeat(constants.MAX_REQUEST_BYTES + 1),
    })), 413, "BODY_TOO_LARGE");
    // d43c8f92 contributionRequestPreflight (index.ts:621-644): only the
    // session cookie is refused, and a Device bearer fails the Upload shape.
    await assertApiError(await dispatch(request({ url: chunkUploadUrl, headers: { cookie: "session=not-used" } })), 401, "UPLOAD_AUTH_INVALID");
    await assertApiError(await dispatch(request({
      url: chunkUploadUrl,
      headers: { cookie: "__Host-usage_monitor_session=not-used", authorization: `Upload um_device_upload_${randomUUID()}.${"A".repeat(43)}` },
    })), 401, "UPLOAD_AUTH_INVALID");
    await assertApiError(await dispatch(request({ body: "{}" })), 400, "TELEMETRY_MANIFEST_INVALID");
    // The shipped client asks for its predecessor before it registers any
    // day. With nothing ready yet the range is seeded with the current day.
    const bootstrapPredecessorResponse = await dispatch(request({
      url: domainPredecessorUrl, body: "{}",
    }));
    assert.equal(bootstrapPredecessorResponse.status, 201);
    const bootstrapPredecessor = await bootstrapPredecessorResponse.json();
    assert.equal(bootstrapPredecessor.previousGenerationId, null);
    assert.equal(bootstrapPredecessor.fromDay, new Date().toISOString().slice(0, 10));
    assert.equal(bootstrapPredecessor.throughDay, bootstrapPredecessor.fromDay);

    await primaryPool.query(
      `UPDATE ${primaryTable("collection_controls")}
          SET revision=3, control_state='degraded', processing_enabled=false, updated_at=$1
        WHERE singleton=1`,
      [new Date().toISOString()],
    );
    await assertApiError(await dispatch(request()), 503, "PROCESSING_DISABLED");
    await assertApiError(await dispatch(request({
      url: domainPredecessorUrl, body: "{}",
    })), 503, "PROCESSING_DISABLED");
    await primaryPool.query(
      `UPDATE ${primaryTable("collection_controls")}
          SET revision=4, control_state='operational', processing_enabled=true, updated_at=$1
        WHERE singleton=1`,
      [new Date().toISOString()],
    );

    const consent = telemetryV12RequiredConsent();
    const manifest = {
      schemaVersion: "telemetry-day-manifest-v1.2",
      day: new Date().toISOString().slice(0, 10),
      parserVersion: "synthetic-cloud-run-v12-host-check",
      consent,
      chunks: [{
        chunkId: `usage:${new Date().toISOString().slice(0, 10)}:0`,
        chunkDigest: "a".repeat(64),
        recordCount: 1,
      }],
      excluded: { quota: 0, session: 0, usage: 0 },
      manifestDigest: "0".repeat(64),
    };
    manifest.manifestDigest = createHash("sha256")
      .update(telemetryV12DayManifestDigestInput(manifest))
      .digest("hex");
    const success = await dispatch(request({ body: JSON.stringify(manifest) }));
    assert.equal(success.status, 201);
    const accepted = await success.json();
    assert.equal(accepted.state, "staged");
    assert.equal(accepted.expectedChunks, 1);
    assert.deepEqual(accepted.stagedChunks, []);
    assert.equal(accepted.manifestDigest, manifest.manifestDigest);

    const replay = await dispatch(request({ body: JSON.stringify(manifest) }));
    assert.equal(replay.status, 201);
    const replayed = await replay.json();
    assert.equal(replayed.manifestId, accepted.manifestId);
    assert.deepEqual(replayed.stagedChunks, []);

    const uploadRequestBody = {
      envelopeDigest: "b".repeat(64),
      contentLengthBytes: 257,
      contentType: "application/json",
      telemetrySchemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
    };
    const uploadRequest = ({ body = JSON.stringify(uploadRequestBody), headers = {}, method = "POST", url = uploadAuthorizationUrl } = {}) => request({
      body,
      headers,
      method,
      url,
    });

    await primaryPool.query(
      `UPDATE ${primaryTable("collection_controls")}
          SET revision=5, control_state='degraded', upload_registration_enabled=false, updated_at=$1
        WHERE singleton=1`,
      [new Date().toISOString()],
    );
    await assertApiError(
      await dispatch(uploadRequest()), 503, "UPLOAD_REGISTRATION_DISABLED",
    );
    await primaryPool.query(
      `UPDATE ${primaryTable("collection_controls")}
          SET revision=6, control_state='operational', upload_registration_enabled=true, updated_at=$1
        WHERE singleton=1`,
      [new Date().toISOString()],
    );

    await assertApiError(await dispatch(uploadRequest({ body: JSON.stringify({
      ...uploadRequestBody,
      telemetrySchemaVersion: "telemetry-contribution-v1.1",
    }) })), 400, "BODY_INVALID");

    const v12Revocation = await primaryPool.query(
      `UPDATE ${primaryTable("telemetry_v12_device_capabilities")}
          SET state='revoked' WHERE participant_id=$1 AND device_id=$2`,
      [participantId, deviceId],
    );
    assert.equal(v12Revocation.rowCount, 1);
    await assertApiError(
      await dispatch(uploadRequest()), 403, "TELEMETRY_TRANSPORT_BLOCKED",
    );
    const v12Reacceptance = await primaryPool.query(
      `UPDATE ${primaryTable("telemetry_v12_device_capabilities")}
          SET state='accepted' WHERE participant_id=$1 AND device_id=$2`,
      [participantId, deviceId],
    );
    assert.equal(v12Reacceptance.rowCount, 1);

    const issued = await dispatch(uploadRequest());
    if (issued.status !== 201) {
      const failure = await issued.clone().json();
      throw new Error(`UPLOAD_AUTHORIZATION_ISSUE_FAILED:${failure?.error?.code ?? "UNKNOWN"}`);
    }
    const issuedValue = await issued.json();
    assert.equal(typeof issuedValue.expiresAt, "string");
    if (typeof issuedValue.uploadAuthorization !== "string") {
      throw new Error("UPLOAD_AUTHORIZATION_RESPONSE_INVALID");
    }
    const uploadClaim = {
      envelopeDigest: uploadRequestBody.envelopeDigest,
      bodyBytes: uploadRequestBody.contentLengthBytes,
      contentType: uploadRequestBody.contentType,
    };
    const claimed = await transport.claimPostgresDeviceUploadAuthorization(
      primaryPool,
      `Upload ${issuedValue.uploadAuthorization}`,
      uploadClaim,
      { schema: schemaOptions },
    );
    assert.equal(claimed.authorizationKind, "device");
    let replayCode;
    try {
      await transport.claimPostgresDeviceUploadAuthorization(
        primaryPool,
        `Upload ${issuedValue.uploadAuthorization}`,
        uploadClaim,
        { schema: schemaOptions },
      );
    } catch (error) {
      replayCode = error?.code;
    }
    assert.equal(replayCode, "UPLOAD_AUTH_INVALID");

    const revoked = await dispatch(uploadRequest({ body: JSON.stringify({
      ...uploadRequestBody,
      envelopeDigest: "c".repeat(64),
    }) }));
    assert.equal(revoked.status, 201);
    const revokedValue = await revoked.json();
    const revokedId = revokedValue.uploadAuthorization
      .slice("um_device_upload_".length).split(".", 1)[0];
    if (!/^[0-9a-f-]{36}$/u.test(revokedId)) {
      throw new Error("UPLOAD_AUTHORIZATION_RESPONSE_INVALID");
    }
    const revokedResult = await primaryPool.query(
      `UPDATE ${primaryTable("device_upload_authorizations")}
          SET state='revoked', revoked_at=$2 WHERE id=$1 AND state='unused'`,
      [revokedId, new Date().toISOString()],
    );
    assert.equal(revokedResult.rowCount, 1);
    let revokedClaimCode;
    try {
      await transport.claimPostgresDeviceUploadAuthorization(
        primaryPool,
        `Upload ${revokedValue.uploadAuthorization}`,
        { ...uploadClaim, envelopeDigest: "c".repeat(64) },
        { schema: schemaOptions },
      );
    } catch (error) {
      revokedClaimCode = error?.code;
    }
    assert.equal(revokedClaimCode, "UPLOAD_AUTH_INVALID");

    const uploadDay = new Date().toISOString().slice(0, 10);
    const uploadParserVersion = "synthetic-cloud-run-v12-host-check";
    const uploadConsent = telemetryV12RequiredConsent();
    const makeChunk = async (seq, fill, minute) => {
      const record = hostV12UsageRecord(
        `event:v2:${fill.repeat(64)}`,
        `${uploadDay}T12:${String(minute).padStart(2, "0")}:00.000Z`,
      );
      const records = [record];
      return {
        schemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
        manifestDigest: "0".repeat(64),
        chunkId: `usage:${uploadDay}:${seq}`,
        chunkRevision: 1,
        chunkDigest: sha256Hex(Buffer.from(canonicalTelemetryV12Json(records))),
        parserVersion: uploadParserVersion,
        consent: uploadConsent,
        records,
      };
    };
    const uploadChunks = [
      await makeChunk(0, "d", 10),
      await makeChunk(1, "e", 11),
      await makeChunk(2, "f", 12),
      await makeChunk(3, "1", 13),
    ];
    const uploadManifest = {
      schemaVersion: "telemetry-day-manifest-v1.2",
      day: uploadDay,
      parserVersion: uploadParserVersion,
      consent: uploadConsent,
      chunks: uploadChunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        chunkDigest: chunk.chunkDigest,
        recordCount: chunk.records.length,
      })),
      excluded: { quota: 0, session: 0, usage: 0 },
      manifestDigest: "0".repeat(64),
    };
    uploadManifest.manifestDigest = sha256Hex(Buffer.from(
      telemetryV12DayManifestDigestInput(uploadManifest),
    ));
    for (const chunk of uploadChunks) chunk.manifestDigest = uploadManifest.manifestDigest;
    const manifestResponse = await dispatch(request({ body: JSON.stringify(uploadManifest) }));
    assert.equal(manifestResponse.status, 201);
    const uploadManifestReceipt = await manifestResponse.json();
    assert.equal(uploadManifestReceipt.expectedChunks, uploadChunks.length);

    const uploadChunk = async (chunk) => {
      const envelope = await encryptHostV12(chunk, envelopePublicJwk, envelopePublicJwk.kid);
      const raw = JSON.stringify(envelope);
      const bytes = Buffer.from(raw);
      const envelopeDigest = sha256Hex(bytes);
      const authorizationResponse = await dispatch(uploadRequest({ body: JSON.stringify({
        envelopeDigest,
        contentLengthBytes: bytes.byteLength,
        contentType: "application/json",
        telemetrySchemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
      }) }));
      if (authorizationResponse.status !== 201) {
        const failure = await authorizationResponse.clone().json();
        throw new Error(`CHUNK_AUTHORIZATION_ISSUE_FAILED:${failure?.error?.code ?? "UNKNOWN"}`);
      }
      const authorization = await authorizationResponse.json();
      const authorizationId = authorization.uploadAuthorization
        .slice("um_device_upload_".length).split(".", 1)[0];
      const response = await dispatch(new Request(chunkUploadUrl, {
        method: "POST",
        headers: {
          authorization: `Upload ${authorization.uploadAuthorization}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: raw,
      }));
      return { authorizationId, bytes, response };
    };

    const initialPutCount = objectPutCount;
    const firstUpload = await uploadChunk(uploadChunks[0]);
    assert.equal(firstUpload.response.status, 202);
    const firstReceipt = await firstUpload.response.json();
    assert.equal(firstReceipt.schemaVersion, "telemetry-chunk-receipt-v1.2");
    assert.equal(firstReceipt.chunkId, uploadChunks[0].chunkId);
    assert.equal(firstReceipt.replayed, false);
    assert.equal(objectPutCount, initialPutCount + 1);
    assert.equal(Buffer.from(storedObjects.get(lastPut.key)?.bytes ?? []).equals(firstUpload.bytes), true);
    const firstChunkRows = await primaryPool.query(
      `SELECT id, manifest_id, r2_key, device_upload_authorization_id
         FROM ${primaryTable("telemetry_v12_chunks")} WHERE id=$1`,
      [firstReceipt.contributionId],
    );
    assert.equal(firstChunkRows.rowCount, 1);
    assert.equal(firstChunkRows.rows[0].manifest_id, uploadManifestReceipt.manifestId);
    const firstJournal = await primaryPool.query(
      `SELECT object_kind, reconciliation_state FROM ${primaryTable("pending_objects")}
        WHERE contribution_id=$1 AND object_key=$2`,
      [firstReceipt.contributionId, firstChunkRows.rows[0].r2_key],
    );
    assert.deepEqual(firstJournal.rows[0], {
      object_kind: "telemetry_v12", reconciliation_state: "registered",
    });
    const firstGrant = await primaryPool.query(
      `SELECT state FROM ${primaryTable("device_upload_authorizations")} WHERE id=$1`,
      [firstUpload.authorizationId],
    );
    assert.equal(firstGrant.rows[0]?.state, "consumed");

    const putsBeforeReplay = objectPutCount;
    const replayUpload = await uploadChunk(uploadChunks[0]);
    assert.equal(replayUpload.response.status, 202);
    const replayReceipt = await replayUpload.response.json();
    assert.equal(replayReceipt.replayed, true);
    assert.equal(replayReceipt.contributionId, firstReceipt.contributionId);
    assert.equal(objectPutCount, putsBeforeReplay);
    const replayGrant = await primaryPool.query(
      `SELECT state FROM ${primaryTable("device_upload_authorizations")} WHERE id=$1`,
      [replayUpload.authorizationId],
    );
    assert.equal(replayGrant.rows[0]?.state, "revoked");

    const conflictChunk = await makeChunk(0, "9", 13);
    conflictChunk.manifestDigest = uploadManifest.manifestDigest;
    const putsBeforeConflict = objectPutCount;
    const conflictingUpload = await uploadChunk(conflictChunk);
    await assertApiError(conflictingUpload.response, 409, "TELEMETRY_MANIFEST_CONFLICT");
    assert.equal(objectPutCount, putsBeforeConflict);
    const conflictGrant = await primaryPool.query(
      `SELECT state FROM ${primaryTable("device_upload_authorizations")} WHERE id=$1`,
      [conflictingUpload.authorizationId],
    );
    assert.equal(conflictGrant.rows[0]?.state, "revoked");

    const putsBeforeConcurrentReplay = objectPutCount;
    const deletesBeforeConcurrentReplay = objectDeleteCount;
    let releaseConcurrentPuts;
    let concurrentPutTimeout;
    const concurrentPutPromise = new Promise((resolvePromise) => {
      concurrentPutTimeout = setTimeout(resolvePromise, 5_000);
      releaseConcurrentPuts = () => {
        clearTimeout(concurrentPutTimeout);
        resolvePromise();
      };
    });
    twoPutBarrier = { waiting: 0, promise: concurrentPutPromise, release: releaseConcurrentPuts };
    const concurrentReplays = await Promise.all([
      uploadChunk(uploadChunks[3]),
      uploadChunk(uploadChunks[3]),
    ]);
    twoPutBarrier = null;
    releaseConcurrentPuts();
    for (const upload of concurrentReplays) assert.equal(upload.response.status, 202);
    assert.equal(objectPutCount, putsBeforeConcurrentReplay + 2);
    assert.equal(objectDeleteCount, deletesBeforeConcurrentReplay + 1);
    const concurrentReceipts = await Promise.all(
      concurrentReplays.map((upload) => upload.response.json()),
    );
    assert.deepEqual(concurrentReceipts.map((receipt) => receipt.replayed).sort(), [false, true]);
    assert.equal(concurrentReceipts[0].contributionId, concurrentReceipts[1].contributionId);
    const concurrentRows = await primaryPool.query(
      `SELECT id FROM ${primaryTable("telemetry_v12_chunks")}
        WHERE manifest_id=$1 AND chunk_id=$2`,
      [uploadManifestReceipt.manifestId, uploadChunks[3].chunkId],
    );
    assert.equal(concurrentRows.rowCount, 1);
    const duplicatePut = objectPuts.slice(-2).find((put) =>
      put.metadata.contributionId !== concurrentReceipts[0].contributionId);
    assert.ok(duplicatePut);
    assert.equal(storedObjects.has(duplicatePut.key), false);
    const duplicateJournal = await primaryPool.query(
      `SELECT contribution_id FROM ${primaryTable("pending_objects")} WHERE contribution_id=$1`,
      [duplicatePut.metadata.contributionId],
    );
    assert.equal(duplicateJournal.rowCount, 0);
    const concurrentGrantStates = await primaryPool.query(
      `SELECT state FROM ${primaryTable("device_upload_authorizations")}
        WHERE id = ANY($1::text[]) ORDER BY state`,
      [concurrentReplays.map((upload) => upload.authorizationId)],
    );
    assert.deepEqual(concurrentGrantStates.rows.map((row) => row.state), ["consumed", "revoked"]);

    failNextObjectPutAfterStore = true;
    const uncertainPut = await uploadChunk(uploadChunks[1]);
    await assertApiError(uncertainPut.response, 503, "BACKEND_STORAGE_UNAVAILABLE");
    assert.ok(lastPut);
    const uncertainPutMetadata = lastPut.metadata;
    const uncertainPutEntry = storedObjects.get(lastPut.key);
    assert.ok(uncertainPutEntry, "a provider that accepted bytes before losing its response may leave the object present");
    assert.equal(Buffer.from(uncertainPutEntry.bytes).equals(uncertainPut.bytes), true);
    assert.match(uncertainPutMetadata?.contributionId ?? "", /^chunk:[0-9a-f-]{36}$/u);
    const uncertainPutJournal = await primaryPool.query(
      `SELECT object_key, object_kind, reconciliation_state FROM ${primaryTable("pending_objects")}
        WHERE contribution_id=$1`,
      [uncertainPutMetadata.contributionId],
    );
    assert.deepEqual(uncertainPutJournal.rows[0], {
      object_key: lastPut.key,
      object_kind: "telemetry_v12",
      reconciliation_state: "registered",
    });
    const uncertainPutGrant = await primaryPool.query(
      `SELECT state FROM ${primaryTable("device_upload_authorizations")} WHERE id=$1`,
      [uncertainPut.authorizationId],
    );
    assert.equal(uncertainPutGrant.rows[0]?.state, "revoked");

    const regularPersist = manifestDispatchOptions.persistPostgresTypedV12StagedChunk;
    runtime.postgresTestDispatch = createPostgresTestV12DayManifestDispatch({
      ...manifestDispatchOptions,
      persistPostgresTypedV12StagedChunk: async (...args) => {
        await regularPersist(...args);
        throw Object.assign(new Error("synthetic lost PostgreSQL commit acknowledgement"), {
          code: "BACKEND_STORAGE_UNAVAILABLE", status: 503,
        });
      },
    });
    let uncertainCommit;
    try {
      uncertainCommit = await uploadChunk(uploadChunks[2]);
    } finally {
      runtime.postgresTestDispatch = manifestDispatch;
    }
    assert.equal(uncertainCommit.response.status, 202);
    const uncertainCommitReceipt = await uncertainCommit.response.json();
    assert.equal(uncertainCommitReceipt.replayed, false);
    const uncertainCommitGrant = await primaryPool.query(
      `SELECT state FROM ${primaryTable("device_upload_authorizations")} WHERE id=$1`,
      [uncertainCommit.authorizationId],
    );
    assert.equal(uncertainCommitGrant.rows[0]?.state, "consumed");
    const uncertainCommitSource = await primaryPool.query(
      `SELECT id FROM ${primaryTable("telemetry_v12_chunks")} WHERE id=$1`,
      [uncertainCommitReceipt.contributionId],
    );
    assert.equal(uncertainCommitSource.rowCount, 1);
    assert.equal(objectDeleteCount, 1);

    const recoveredChunk = await uploadChunk(uploadChunks[1]);
    assert.equal(recoveredChunk.response.status, 202);
    const recoveredReceipt = await recoveredChunk.response.json();
    assert.equal(recoveredReceipt.replayed, false);
    const readyManifest = await primaryPool.query(
      `SELECT state, expected_chunk_count,
              (SELECT count(*)::integer FROM ${primaryTable("telemetry_v12_chunks")} chunk
                WHERE chunk.manifest_id = manifest.id) AS staged_chunk_count
         FROM ${primaryTable("telemetry_v12_day_manifests")} manifest
        WHERE manifest.id=$1`,
      [uploadManifestReceipt.manifestId],
    );
    assert.deepEqual(readyManifest.rows[0], {
      state: "ready", expected_chunk_count: uploadChunks.length,
      staged_chunk_count: uploadChunks.length,
    });

    const syncRateBeforeDomain = deviceSyncRateLimitCalls;
    const predecessorResponse = await dispatch(request({
      url: domainPredecessorUrl, body: "{}",
    }));
    assert.equal(predecessorResponse.status, 201);
    const predecessor = await predecessorResponse.json();
    assert.equal(predecessor.schemaVersion, "telemetry-domain-predecessor-v1.2");
    assert.match(predecessor.token, /^[0-9a-f-]{36}$/u);
    assert.equal(predecessor.previousGenerationId, null);
    assert.match(predecessor.legacyFingerprint, /^[0-9a-f]{64}$/u);
    assert.equal(predecessor.legacyFingerprint, bootstrapPredecessor.legacyFingerprint,
      "the pin does not move because this device's own day became ready");
    assert.equal(predecessor.fromDay, uploadDay);
    assert.equal(predecessor.throughDay, uploadDay);
    assert.ok(Date.parse(predecessor.expiresAt) > Date.now());

    const domainManifest = {
      schemaVersion: "telemetry-domain-manifest-v1.2",
      fromDay: predecessor.fromDay,
      throughDay: predecessor.throughDay,
      predecessor: {
        token: predecessor.token,
        previousGenerationId: predecessor.previousGenerationId,
        legacyFingerprint: predecessor.legacyFingerprint,
      },
      days: [{
        day: uploadDay,
        manifestId: uploadManifestReceipt.manifestId,
        manifestDigest: uploadManifest.manifestDigest,
      }],
      manifestDigest: "0".repeat(64),
    };
    domainManifest.manifestDigest = sha256Hex(Buffer.from(
      telemetryV12DomainManifestDigestInput(domainManifest),
    ));
    const activationResponse = await dispatch(request({
      url: domainActivateUrl, body: JSON.stringify(domainManifest),
    }));
    assert.equal(activationResponse.status, 201);
    const activation = await activationResponse.json();
    assert.deepEqual(activation, {
      schemaVersion: "telemetry-domain-activation-v1.2",
      generationId: activation.generationId,
      manifestDigest: domainManifest.manifestDigest,
      fromDay: uploadDay,
      throughDay: uploadDay,
      replay: false,
    });
    assert.match(activation.generationId, /^[0-9a-f-]{36}$/u);

    const activationReplayResponse = await dispatch(request({
      url: domainActivateUrl, body: JSON.stringify(domainManifest),
    }));
    assert.equal(activationReplayResponse.status, 201);
    assert.deepEqual(await activationReplayResponse.json(), { ...activation, replay: true });
    assert.equal(deviceSyncRateLimitCalls, syncRateBeforeDomain + 3,
      "domain predecessor and activation requests must consume the authenticated device-sync limiter");

    const effectivePageQuery = new URLSearchParams({
      day: uploadDay,
      stream: "usage",
      limit: "2",
    });
    const firstEffectivePageResponse = await dispatch(request({
      method: "GET",
      url: `${effectivePageUrl}?${effectivePageQuery}`,
    }));
    assert.equal(firstEffectivePageResponse.status, 200);
    const firstEffectivePage = await firstEffectivePageResponse.json();
    assert.equal(firstEffectivePage.schemaVersion, "postgres-telemetry-v12-effective-page-v1");
    assert.equal(firstEffectivePage.available, true);
    assert.equal(firstEffectivePage.records.length, 2);
    assert.ok(firstEffectivePage.next);
    assert.equal(JSON.parse(firstEffectivePage.records[0].sourceRecordJson).schemaVersion, "usage-event-v1.2");
    assert.equal(JSON.parse(firstEffectivePage.records[0].recordJson).schemaVersion, "usage-event-v1.1");

    const nextEffectivePageQuery = new URLSearchParams({
      ...Object.fromEntries(effectivePageQuery),
      afterObservedAtMs: String(firstEffectivePage.next.observedAtMs),
      afterOccurrenceId: firstEffectivePage.next.occurrenceId,
    });
    const nextEffectivePageResponse = await dispatch(request({
      method: "GET",
      url: `${effectivePageUrl}?${nextEffectivePageQuery}`,
    }));
    assert.equal(nextEffectivePageResponse.status, 200);
    const nextEffectivePage = await nextEffectivePageResponse.json();
    assert.equal(nextEffectivePage.records.length, 2);
    assert.equal(nextEffectivePage.next, null);
    assert.equal(deviceSyncRateLimitCalls, syncRateBeforeDomain + 5,
      "each effective page must consume the authenticated device-sync limiter");
    const rateCallsBeforeUnauthenticatedPage = deviceSyncRateLimitCalls;
    await assertApiError(await dispatch(new Request(
      `${effectivePageUrl}?${effectivePageQuery}`, { method: "GET" },
    )), 401, "DEVICE_AUTH_INVALID");
    assert.equal(deviceSyncRateLimitCalls, rateCallsBeforeUnauthenticatedPage + 1,
      "a rejected effective-page bearer must consume the pre-auth device-sync limiter");

    for (const query of [
      `${effectivePageQuery}&limit=201`,
      `${effectivePageQuery}&limit=0`,
      `${effectivePageQuery}&participantId=some-other-owner`,
      `${effectivePageQuery}&afterOccurrenceId=event%3Av2%3A${"a".repeat(64)}`,
      `${effectivePageQuery}&afterObservedAtMs=8640000000000001&afterOccurrenceId=event%3Av2%3A${"a".repeat(64)}`,
    ]) {
      await assertApiError(await dispatch(request({
        method: "GET",
        url: `${effectivePageUrl}?${query}`,
      })), 400, "BODY_INVALID");
    }
    await assertApiError(await dispatch(new Request(
      `${effectivePageUrl}?${effectivePageQuery}`, { method: "GET" },
    )), 401, "DEVICE_AUTH_INVALID");

    useUnknownEffectivePageSchema = true;
    try {
      await assertApiError(await dispatch(request({
        method: "GET",
        url: `${effectivePageUrl}?${effectivePageQuery}`,
      })), 503, "BACKEND_STORAGE_UNAVAILABLE");
    } finally {
      useUnknownEffectivePageSchema = false;
    }

    const activeHead = await primaryPool.query(
      `SELECT head.generation_id, head.revision::text AS revision, domain.manifest_digest
         FROM ${primaryTable("telemetry_v12_domain_heads")} head
         JOIN ${primaryTable("telemetry_v12_domains")} domain
           ON domain.id = head.generation_id
        WHERE head.participant_id=$1`,
      [participantId],
    );
    assert.deepEqual(activeHead.rows, [{
      generation_id: activation.generationId,
      revision: "1",
      manifest_digest: domainManifest.manifestDigest,
    }]);
    // The earlier bootstrap predecessor stays outstanding until it expires;
    // only the token the activation presented is consumed.
    const consumedPredecessor = await primaryPool.query(
      `SELECT token_hash, consumed_at FROM ${primaryTable("telemetry_v12_domain_predecessors")}
        WHERE participant_id=$1 AND device_id=$2 AND consumed_at IS NOT NULL`,
      [participantId, deviceId],
    );
    assert.equal(consumedPredecessor.rowCount, 1);
    assert.equal(consumedPredecessor.rows[0].token_hash, sha256Hex(predecessor.token));
    assert.ok(consumedPredecessor.rows[0].consumed_at);

    // A participant removed by the offline purge (D2 Variant B) has no rows,
    // so every device route refuses it; there is no separate deletion ledger.
    const purgedParticipant = await primaryPool.query(
      `DELETE FROM ${primaryTable("participants")} WHERE id=$1`, [participantId],
    );
    assert.equal(purgedParticipant.rowCount, 1);
    await assertApiError(await dispatch(request({ body: JSON.stringify(manifest) })), 401, "DEVICE_AUTH_INVALID");
    await assertApiError(await dispatch(request({
      url: domainPredecessorUrl, body: "{}",
    })), 401, "DEVICE_AUTH_INVALID");
    await assertApiError(await dispatch(request({
      url: domainActivateUrl, body: JSON.stringify(domainManifest),
    })), 401, "DEVICE_AUTH_INVALID");
    await assertApiError(await dispatch(request({
      method: "GET",
      url: `${effectivePageUrl}?${effectivePageQuery}`,
    })), 401, "DEVICE_AUTH_INVALID");
    await assertApiError(await dispatch(request({
      method: "GET",
      url: `${manifestUrl}?fromDay=2020-01-01&toDay=2020-01-31`,
    })), 401, "DEVICE_AUTH_INVALID");
    const credentialRenewalUrl =
      "http://127.0.0.1:43817/api/v1/device/credential/renew";
    const credentialRenewalDeviceId = randomUUID();
    const credentialRenewalParticipantId = `synthetic-host-renewal-${randomUUID()}`;
    const credentialRenewalPairingId = randomUUID();
    const credentialRenewalSessionId = randomUUID();
    const credentialRenewalSecret = randomBytes(32).toString("base64url");
    const credentialRenewalAuth =
      `Device um_device_${credentialRenewalDeviceId}.${credentialRenewalSecret}`;
    const credentialRenewalIssuedAt = new Date().toISOString();
    const credentialRenewalExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
    await primaryPool.query(
      `INSERT INTO ${primaryTable("participants")} (
         id, owner_kind, state, consent_version, created_at
       ) VALUES ($1, 'social', 'active', $2, $3::timestamptz)`,
      [credentialRenewalParticipantId, constants.TELEMETRY_CONSENT_VERSION,
        credentialRenewalIssuedAt],
    );
    await primaryPool.query(
      `INSERT INTO ${primaryTable("web_sessions")} (
         id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
       ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $5::timestamptz)`,
      [credentialRenewalSessionId, credentialRenewalParticipantId, randomBytes(32), randomBytes(32),
        credentialRenewalIssuedAt, new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString()],
    );
    await primaryPool.query(
      `INSERT INTO ${primaryTable("device_pairings")} (
         id, participant_id, issued_by_session_id, secret_hash, consent_version,
         transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
       ) VALUES ($1, $2, $3, $4, $5, $5, 'consumed', $6::timestamptz,
         $7::timestamptz, $6::timestamptz, $8)`,
      [credentialRenewalPairingId, credentialRenewalParticipantId, credentialRenewalSessionId,
        randomBytes(32), constants.TELEMETRY_CONSENT_VERSION, credentialRenewalIssuedAt,
        credentialRenewalExpiresAt, credentialRenewalDeviceId],
    );
    await primaryPool.query(
      `INSERT INTO ${primaryTable("device_credentials")} (
         id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
         state, issued_at, expires_at, last_used_at, social_verified_at
       ) VALUES ($1, $2, 'social', $3, $4, 'active', $5::timestamptz,
         $6::timestamptz, $5::timestamptz, $5::timestamptz)`,
      [credentialRenewalDeviceId, credentialRenewalParticipantId, credentialRenewalPairingId,
        deviceSecretHash(credentialRenewalDeviceId, credentialRenewalSecret),
        credentialRenewalIssuedAt, credentialRenewalExpiresAt],
    );
    const replacementSecret = randomBytes(32).toString("base64url");
    const renewalAttemptId = randomUUID();
    const credentialRenewalBody = JSON.stringify({
      nextDeviceSecretHash:
        deviceSecretHash(credentialRenewalDeviceId, replacementSecret).toString("hex"),
      rotationAttemptId: renewalAttemptId,
    });
    const credentialRenewalRequest = (body = credentialRenewalBody, headers = {}, method = "POST") =>
      new Request(credentialRenewalUrl, {
        method,
        headers: { "content-type": "application/json", authorization: credentialRenewalAuth, ...headers },
        ...(method === "GET" || method === "HEAD" ? {} : { body }),
      });
    const credentialRenewalWrongMethod = await dispatch(credentialRenewalRequest("", {}, "GET"));
    await assertApiError(credentialRenewalWrongMethod, 405, "METHOD_NOT_ALLOWED");
    assert.equal(credentialRenewalWrongMethod.headers.get("allow"), "POST");
    await assertApiError(await dispatch(credentialRenewalRequest("{}")), 400, "BODY_INVALID");
    await assertApiError(await dispatch(credentialRenewalRequest(
      credentialRenewalBody, { cookie: "session=not-allowed" },
    )), 401, "DEVICE_AUTH_INVALID");
    const credentialRenewalStartedAt = Date.now();
    const credentialRenewalResponse = await dispatch(credentialRenewalRequest());
    assert.equal(credentialRenewalResponse.status, 200);
    const credentialRenewalReceipt = await credentialRenewalResponse.json();
    assert.equal(credentialRenewalReceipt.schemaVersion, "device-credential-renewal-v1.0");
    assert.equal(credentialRenewalReceipt.deviceId, credentialRenewalDeviceId);
    assert.equal(credentialRenewalReceipt.state, "active");
    assert.equal(credentialRenewalReceipt.scope, "upload_registration");
    assert.equal(credentialRenewalReceipt.credentialGeneration, 2);
    assert.equal(credentialRenewalReceipt.commit, true);
    assert.ok(Math.abs(Date.parse(credentialRenewalReceipt.expiresAt)
      - (credentialRenewalStartedAt + constants.DEVICE_CREDENTIAL_TTL_MILLISECONDS)) < 10_000);
    const credentialRenewalReplay = await dispatch(credentialRenewalRequest());
    assert.equal(credentialRenewalReplay.status, 200);
    assert.deepEqual(await credentialRenewalReplay.json(), credentialRenewalReceipt,
      "the same rotation attempt replays its committed result");
    // Exercise accountless enrollment and separate v1.2 authority through
    // private HTTP dispatch. All durable writes go through PostgreSQL.
    const accountlessEnrollmentUrl = "http://127.0.0.1:43817/api/v1/accountless/enrollment";
    const accountlessOwnershipUrl = "http://127.0.0.1:43817/api/v1/accountless/ownership";
    const accountlessV12AuthorizationUrl =
      "http://127.0.0.1:43817/api/v1/accountless/telemetry-v1.2-authorization";
    const accountlessRenewalUrl = "http://127.0.0.1:43817/api/v1/accountless/renewal";
    const accountlessDeviceId = randomUUID();
    const accountlessSecret = randomBytes(32).toString("base64url");
    const accountlessAuth = "Device um_device_" + accountlessDeviceId + "." + accountlessSecret;
    const accountlessEnrollmentBody = {
      schemaVersion: "accountless-enrollment-v0.1",
      deviceId: accountlessDeviceId,
      deviceSecretHash: deviceSecretHash(accountlessDeviceId, accountlessSecret).toString("hex"),
      policyVersion: "accountless-opt-out-v1",
      authorizationBasis: "accountless-policy-v1",
    };
    const accountlessEnrollmentJson = JSON.stringify(accountlessEnrollmentBody);
    assert.equal(accountlessEnrollment.parseAccountlessEnrollmentJson(accountlessEnrollmentJson).deviceId,
      accountlessDeviceId);
    const enrollmentHttp = (body = accountlessEnrollmentJson, headers = {}, method = "POST") =>
      new Request(accountlessEnrollmentUrl, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(method === "GET" || method === "HEAD" ? {} : { body }),
      });
    const ownershipHttp = (body, headers = {}) => new Request(accountlessOwnershipUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: accountlessAuth, ...headers },
      body,
    });
    const authorizationHttp = (body, headers = {}, authorization = accountlessAuth) =>
      new Request(accountlessV12AuthorizationUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization, ...headers },
        body,
      });
    const renewalBody = {
      schemaVersion: "accountless-renewal-v0.1",
      policyVersion: "accountless-opt-out-v1",
      authorizationBasis: "accountless-policy-v1",
      telemetrySchemaVersion: "telemetry-contribution-v1.1",
    };
    const renewalJson = JSON.stringify(renewalBody);
    const renewalHttp = (body = renewalJson, headers = {}, method = "POST") =>
      new Request(accountlessRenewalUrl, {
        method,
        headers: { "content-type": "application/json", authorization: accountlessAuth, ...headers },
        ...(method === "GET" || method === "HEAD" ? {} : { body }),
      });

    await assertApiError(await dispatch(enrollmentHttp(undefined, {}, "GET")), 405, "METHOD_NOT_ALLOWED");
    // d43c8f92 index.ts:710 refuses the browser session cookie, not any cookie.
    await assertApiError(await dispatch(enrollmentHttp(accountlessEnrollmentJson, {
      cookie: "other=1; __Host-usage_monitor_session=synthetic",
    })), 401, "AUTH_INVALID");
    await assertApiError(await dispatch(enrollmentHttp(JSON.stringify({
      ...accountlessEnrollmentBody, unexpected: true,
    }))), 400, "BODY_INVALID");
    await assertApiError(await dispatch(enrollmentHttp(
      '{"schemaVersion":"wrong","schemaVersion":"accountless-enrollment-v0.1"}',
    )), 400, "BODY_INVALID");

    const concurrentEnrollments = await Promise.all([
      dispatch(enrollmentHttp()),
      dispatch(enrollmentHttp()),
    ]);
    assert.deepEqual(concurrentEnrollments.map((response) => response.status).sort(), [200, 201],
      `concurrent retries issue one ledger row and return one stable replay; received ${JSON.stringify(
        await Promise.all(concurrentEnrollments.map(async (response) => ({
          status: response.status, body: await response.clone().json(),
        }))),
      )}`);
    const enrollmentReceipts = await Promise.all(concurrentEnrollments.map((response) => response.json()));
    assert.ok(enrollmentReceipts.every((receipt) => receipt.schemaVersion === "accountless-enrollment-v0.1"
      && receipt.deviceId === accountlessDeviceId
      && receipt.policyVersion === "accountless-opt-out-v1"
      && receipt.authorizationBasis === "accountless-policy-v1"
      && receipt.scope === "enrollment_only"));
    assert.ok(enrollmentReceipts.every((receipt) => receipt.expiresAt === enrollmentReceipts[0].expiresAt));
    const replayedEnrollment = await dispatch(enrollmentHttp());
    assert.equal(replayedEnrollment.status, 200);
    assert.equal((await replayedEnrollment.json()).state, "existing");
    await assertApiError(await dispatch(enrollmentHttp(JSON.stringify({
      ...accountlessEnrollmentBody,
      deviceSecretHash: "f".repeat(64),
    }))), 409, "ACCOUNTLESS_ENROLLMENT_CONFLICT");
    const issuance = await primaryPool.query(
      "SELECT daily_issued, lifetime_issued FROM " + primaryTable("accountless_enrollment_issuance")
        + " WHERE singleton=1",
    );
    assert.deepEqual(issuance.rows[0], { daily_issued: 1, lifetime_issued: 1 },
      "a duplicate insert rolls back its candidate issuance budget");
    const enrollmentRow = await primaryPool.query(
      "SELECT state, schema_version, policy_version, authorization_basis, "
        + "octet_length(device_secret_hash) AS secret_hash_bytes FROM "
        + primaryTable("accountless_enrollment_ledger") + " WHERE device_id=$1",
      [accountlessDeviceId],
    );
    assert.deepEqual(enrollmentRow.rows[0], {
      state: "active", schema_version: "accountless-enrollment-v0.1",
      policy_version: "accountless-opt-out-v1", authorization_basis: "accountless-policy-v1",
      secret_hash_bytes: 32,
    });

    const ownershipBody = {
      schemaVersion: "accountless-upload-owner-v0.1",
      policyVersion: "accountless-opt-out-v1",
      authorizationBasis: "accountless-policy-v1",
      telemetrySchemaVersion: "telemetry-contribution-v1.1",
    };
    await assertApiError(await dispatch(ownershipHttp(JSON.stringify(ownershipBody), {
      authorization: auth,
    })), 401, "DEVICE_AUTH_INVALID");
    const concurrentOwners = await Promise.all([
      dispatch(ownershipHttp(JSON.stringify(ownershipBody))),
      dispatch(ownershipHttp(JSON.stringify(ownershipBody))),
    ]);
    assert.deepEqual(concurrentOwners.map((response) => response.status).sort(), [200, 201],
      "owner graph creation and duplicate retry converge under PostgreSQL row locking");
    const ownerReceipts = await Promise.all(concurrentOwners.map((response) => response.json()));
    assert.ok(ownerReceipts.some((receipt) => receipt.state === "created"));
    assert.ok(ownerReceipts.some((receipt) => receipt.state === "existing"));
    assert.ok(ownerReceipts.every((receipt) => receipt.deviceId === accountlessDeviceId
      && receipt.scope === "upload_registration"
      && receipt.telemetrySchemaVersion === "telemetry-contribution-v1.1"));
    const accountlessOwner = await primaryPool.query(
      "SELECT owner.participant_id, owner.expires_at::text AS owner_expires_at, "
        + "participant.owner_kind, participant.consent_version, device.authority_kind, "
        + "device.paired_via_pairing_id, device.accountless_enrollment_device_id, "
        + "grant_row.telemetry_schema_version, grant_row.state AS v11_state FROM "
        + primaryTable("accountless_upload_owners") + " owner JOIN "
        + primaryTable("participants") + " participant ON participant.id=owner.participant_id JOIN "
        + primaryTable("device_credentials") + " device ON device.id=owner.device_credential_id JOIN "
        + primaryTable("accountless_v11_device_authorizations")
        + " grant_row ON grant_row.enrollment_device_id=owner.enrollment_device_id "
        + "WHERE owner.enrollment_device_id=$1",
      [accountlessDeviceId],
    );
    assert.equal(accountlessOwner.rowCount, 1);
    assert.equal(accountlessOwner.rows[0].owner_kind, "accountless");
    assert.equal(accountlessOwner.rows[0].consent_version, null,
      "accountless ownership does not synthesize social consent");
    assert.equal(accountlessOwner.rows[0].authority_kind, "accountless");
    assert.equal(accountlessOwner.rows[0].paired_via_pairing_id, null,
      "accountless authority has no social pairing");
    assert.equal(accountlessOwner.rows[0].accountless_enrollment_device_id, accountlessDeviceId);
    assert.equal(accountlessOwner.rows[0].telemetry_schema_version, "telemetry-contribution-v1.1");
    assert.equal(accountlessOwner.rows[0].v11_state, "active");
    const accountlessParticipantId = accountlessOwner.rows[0].participant_id;
    const accountlessNamespace = await primaryPool.query(
      `SELECT namespace FROM ${primaryTable("attribution_enrollments")} WHERE participant_id=$1`,
      [accountlessParticipantId],
    );
    assert.equal(accountlessNamespace.rowCount, 1);
    assert.match(accountlessNamespace.rows[0].namespace, /^[0-9a-f]{64}$/u);
    const accountlessFloor = await primaryPool.query(
      `SELECT minimum_rank, revision
         FROM ${primaryTable("telemetry_transport_participant_floors")}
        WHERE participant_id=$1`,
      [accountlessParticipantId],
    );
    assert.deepEqual(accountlessFloor.rows, [{ minimum_rank: 11, revision: 0 }],
      "PostgreSQL accountless participants receive D1's v1.1 transport-floor default");
    const replayedOwner = await dispatch(ownershipHttp(JSON.stringify(ownershipBody)));
    assert.equal(replayedOwner.status, 200);
    assert.equal((await replayedOwner.json()).state, "existing");
    const replayState = await primaryPool.query(
      `SELECT enrollment.namespace, floor.minimum_rank, floor.revision
         FROM ${primaryTable("attribution_enrollments")} enrollment
         JOIN ${primaryTable("telemetry_transport_participant_floors")} floor
           ON floor.participant_id = enrollment.participant_id
        WHERE enrollment.participant_id=$1`,
      [accountlessParticipantId],
    );
    assert.deepEqual(replayState.rows, [{
      namespace: accountlessNamespace.rows[0].namespace,
      minimum_rank: 11,
      revision: 0,
    }], "owner replay preserves its single namespace and participant floor");
    await assert.rejects(
      transport.authenticatePostgresDevice(primaryPool, accountlessAuth, { schema: schemaOptions }),
      (error) => error?.code === "DEVICE_AUTH_INVALID",
      "the generic device authenticator must retain the stricter v1.2 authority fence",
    );
    const accountlessAuthProbe = await transport.authenticatePostgresDevice(
      primaryPool, accountlessAuth,
      { schema: schemaOptions, accountlessAuthorizationVersion: "v1.1" },
    );
    assert.equal(accountlessAuthProbe.participantId, accountlessParticipantId);
    const accountlessCapabilitiesResponse = await dispatch(request({
      url: syncCapabilitiesUrl,
      method: "GET",
      headers: { authorization: accountlessAuth },
    }));
    assert.equal(accountlessCapabilitiesResponse.status, 200,
      JSON.stringify(await accountlessCapabilitiesResponse.clone().json()));
    const accountlessCapabilities = await accountlessCapabilitiesResponse.json();
    assert.equal(accountlessCapabilities.schemaVersion, "device-sync-capabilities-v1.1");
    assert.equal(accountlessCapabilities.destinationOrigin, "http://127.0.0.1:43817");
    assert.equal(accountlessCapabilities.enrollmentNamespace, accountlessNamespace.rows[0].namespace);
    assert.equal(accountlessCapabilities.identityVersion, "account-track-v2");
    assert.equal(accountlessCapabilities.minimumWriteRank, 11);
    assert.equal(accountlessCapabilities.authorityKind, "accountless");
    assert.equal(accountlessCapabilities.consentCurrent, false,
      "accountless authorization does not become social consent");
    assert.equal(accountlessCapabilities.authorizationCurrent, true);
    assert.deepEqual(accountlessCapabilities.formats.map((format) => format.lifecycle), [
      "blocked", "blocked", "blocked", "accepted",
    ]);
    assert.equal(accountlessCapabilities.formats.length, 4,
      "the legacy accountless response must not expose the separate v1.2 format");
    // Before it holds a v1.2 grant the install can still read the successor
    // capability; that is how the shipped client learns to request the grant
    // (D1 parity). It reports the grant as not current.
    const ungrantedV12Response = await dispatch(request({
      url: syncCapabilitiesV12Url,
      method: "GET",
      headers: { authorization: accountlessAuth },
    }));
    assert.equal(ungrantedV12Response.status, 200,
      JSON.stringify(await ungrantedV12Response.clone().json()));
    const ungrantedV12 = await ungrantedV12Response.json();
    assert.equal(ungrantedV12.authorityKind, "accountless");
    assert.equal(ungrantedV12.successor.consentCurrent, false);
    assert.equal(ungrantedV12.successor.authorizationCurrent, false);
    assert.equal(ungrantedV12.successor.activationTime, null);
    await primaryPool.query(
      `UPDATE ${primaryTable("accountless_v11_device_authorizations")}
          SET state='revoked', revoked_at=$2, revocation_reason='synthetic-test'
        WHERE enrollment_device_id=$1`,
      [accountlessDeviceId, nowIso],
    );
    await assertApiError(await dispatch(request({
      url: syncCapabilitiesUrl,
      method: "GET",
      headers: { authorization: accountlessAuth },
    })), 401, "DEVICE_AUTH_INVALID");
    await primaryPool.query(
      `UPDATE ${primaryTable("accountless_v11_device_authorizations")}
          SET state='active', revoked_at=NULL, revocation_reason=NULL
        WHERE enrollment_device_id=$1`,
      [accountlessDeviceId],
    );
    const socialSessionCount = await primaryPool.query(
      "SELECT count(*)::integer AS count FROM " + primaryTable("web_sessions")
        + " WHERE participant_id=$1",
      [accountlessOwner.rows[0].participant_id],
    );
    assert.equal(socialSessionCount.rows[0].count, 0);

    const accountlessV12Body = {
      schemaVersion: "accountless-upload-owner-v1.2",
      policyVersion: "accountless-telemetry-v1.2-policy-v1",
      authorizationBasis: "accountless-policy-v1.2",
      telemetrySchemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
    };
    await assertApiError(await dispatch(authorizationHttp(JSON.stringify({
      ...accountlessV12Body, unexpected: true,
    }))), 400, "BODY_INVALID");
    await assertApiError(await dispatch(authorizationHttp(
      '{"schemaVersion":"wrong","schemaVersion":"accountless-upload-owner-v1.2"}',
    )), 400, "BODY_INVALID");
    await assertApiError(await dispatch(authorizationHttp(
      JSON.stringify(accountlessV12Body), {}, auth,
    )), 401, "DEVICE_AUTH_INVALID");
    await assertApiError(await dispatch(authorizationHttp(
      JSON.stringify(accountlessV12Body), {},
      `Device um_device_${accountlessDeviceId}.${randomBytes(32).toString("base64url")}`,
    )), 401, "DEVICE_AUTH_INVALID");
    await primaryPool.query(
      "UPDATE " + primaryTable("telemetry_v12_runtime") + " SET state='staged' WHERE id=1",
    );
    await assertApiError(await dispatch(authorizationHttp(JSON.stringify(accountlessV12Body))),
      403, "TELEMETRY_TRANSPORT_BLOCKED");
    const stagedGrant = await primaryPool.query(
      "SELECT count(*)::integer AS count FROM "
        + primaryTable("accountless_v12_device_authorizations") + " WHERE enrollment_device_id=$1",
      [accountlessDeviceId],
    );
    assert.equal(stagedGrant.rows[0].count, 0,
      "v1.2 authority cannot be minted before runtime activation");
    await primaryPool.query(
      "UPDATE " + primaryTable("telemetry_v12_runtime") + " SET state='active' WHERE id=1",
    );
    // Four concurrent first grants: ON CONFLICT arbitrates only the device
    // key, so without the per-owner grant lock some raced the participant
    // key and answered 503.
    const concurrentV12Grants = await Promise.all(Array.from({ length: 4 }, () =>
      dispatch(authorizationHttp(JSON.stringify(accountlessV12Body)))));
    assert.deepEqual(concurrentV12Grants.map((response) => response.status), [201, 201, 201, 201],
      `concurrent v1.2 grants must replay one stable active grant; received ${JSON.stringify(
        await Promise.all(concurrentV12Grants.map(async (response) => ({
          status: response.status, body: await response.clone().json(),
        }))),
      )}`);
    const grantReceipts = await Promise.all(concurrentV12Grants.map((response) => response.json()));
    assert.deepEqual(grantReceipts, Array.from({ length: 4 }, () => accountlessV12Body),
      "the receipt includes only the closed v1.2 authorization tuple");
    const accountlessGrant = await primaryPool.query(
      "SELECT state, schema_version, policy_version, authorization_basis, "
        + "telemetry_schema_version, field_dictionary_version, privacy_contract_version, "
        + "authorized_at::text AS authorized_at, expires_at::text AS expires_at FROM "
        + primaryTable("accountless_v12_device_authorizations") + " WHERE enrollment_device_id=$1",
      [accountlessDeviceId],
    );
    assert.equal(accountlessGrant.rowCount, 1);
    assert.equal(accountlessGrant.rows[0].state, "active");
    assert.equal(accountlessGrant.rows[0].schema_version, "accountless-upload-owner-v1.2");
    assert.equal(accountlessGrant.rows[0].policy_version, "accountless-telemetry-v1.2-policy-v1");
    assert.equal(accountlessGrant.rows[0].authorization_basis, "accountless-policy-v1.2");
    assert.equal(accountlessGrant.rows[0].telemetry_schema_version, TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION);
    assert.equal(accountlessGrant.rows[0].field_dictionary_version, TELEMETRY_V12_FIELD_DICTIONARY_VERSION);
    assert.equal(accountlessGrant.rows[0].privacy_contract_version, TELEMETRY_V12_PRIVACY_CONTRACT_VERSION);
    assert.equal(Date.parse(accountlessGrant.rows[0].expires_at),
      Date.parse(accountlessOwner.rows[0].owner_expires_at));

    await assertApiError(await dispatch(renewalHttp(undefined, {}, "GET")),
      405, "METHOD_NOT_ALLOWED");
    // d43c8f92 index.ts:842 refuses the browser session cookie, not any cookie.
    await assertApiError(await dispatch(renewalHttp(renewalJson, { cookie: "__Host-usage_monitor_session=synthetic" })),
      401, "AUTH_INVALID");
    await assertApiError(await dispatch(renewalHttp(JSON.stringify({
      ...renewalBody, unexpected: true,
    }))), 400, "BODY_INVALID");
    await assertApiError(await dispatch(renewalHttp(
      '{"schemaVersion":"wrong","schemaVersion":"accountless-renewal-v0.1"}',
    )), 400, "BODY_INVALID");
    const existingRenewal = await dispatch(renewalHttp());
    assert.equal(existingRenewal.status, 200);
    assert.deepEqual(await existingRenewal.json(), {
      schemaVersion: "accountless-renewal-v0.1",
      state: "existing",
      deviceId: accountlessDeviceId,
      expiresAt: new Date(Date.parse(accountlessOwner.rows[0].owner_expires_at)).toISOString(),
      renewalGeneration: 0,
      policyVersion: "accountless-opt-out-v1",
      authorizationBasis: "accountless-policy-v1",
      scope: "upload_registration",
      telemetrySchemaVersion: "telemetry-contribution-v1.1",
    });

    // An accountless owner removed by the offline purge (D2 Variant B) cannot
    // acquire a v1.2 grant: its rows are gone and no deletion ledger exists.
    const purgedDeviceId = randomUUID();
    const purgedSecret = randomBytes(32).toString("base64url");
    const purgedAuth = `Device um_device_${purgedDeviceId}.${purgedSecret}`;
    const purgedEnrollmentBody = {
      ...accountlessEnrollmentBody,
      deviceId: purgedDeviceId,
      deviceSecretHash: deviceSecretHash(purgedDeviceId, purgedSecret).toString("hex"),
    };
    assert.equal((await dispatch(enrollmentHttp(JSON.stringify(purgedEnrollmentBody)))).status, 201);
    assert.equal((await dispatch(ownershipHttp(JSON.stringify(ownershipBody), {
      authorization: purgedAuth,
    }))).status, 201);
    const purgedOwner = await primaryPool.query(
      "SELECT participant_id FROM " + primaryTable("accountless_upload_owners")
        + " WHERE enrollment_device_id=$1",
      [purgedDeviceId],
    );
    assert.equal(purgedOwner.rowCount, 1);
    const purgedOwnerParticipant = await primaryPool.query(
      `DELETE FROM ${primaryTable("participants")} WHERE id=$1`, [purgedOwner.rows[0].participant_id],
    );
    assert.equal(purgedOwnerParticipant.rowCount, 1);
    await assertApiError(await dispatch(authorizationHttp(
      JSON.stringify(accountlessV12Body), {}, purgedAuth,
    )), 401, "DEVICE_AUTH_INVALID");
    const purgedGrant = await primaryPool.query(
      "SELECT count(*)::integer AS count FROM "
        + primaryTable("accountless_v12_device_authorizations") + " WHERE enrollment_device_id=$1",
      [purgedDeviceId],
    );
    assert.equal(purgedGrant.rows[0].count, 0,
      "a purged owner cannot acquire a v1.2 grant");

    const uploadAuthorizationReceipt = await dispatch(request({
      url: uploadAuthorizationUrl,
      headers: { authorization: accountlessAuth },
      body: JSON.stringify({
        envelopeDigest: "a".repeat(64), contentLengthBytes: 1,
        contentType: "application/json", telemetrySchemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
      }),
    }));
    assert.equal(uploadAuthorizationReceipt.status, 201,
      "an active accountless v1.2 grant admits upload authorization in PostgreSQL");

    // The shipped client on this v1.2-only install, which has never uploaded:
    // predecessor first, then every day in its range, including a day with no
    // records, then activation. It keeps a progress journal like the desktop.
    const clientParser = "synthetic-host-v12-accountless-client";
    const clientDay = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const clientRecords = new Map([[clientDay(-2), 1], [clientDay(0), 2]]);
    let clientJournal = null;
    const runAccountlessClient = async (label) => {
      const exchanges = [];
      const result = await runTelemetryV12Sync({
        serverBaseUrl: "http://127.0.0.1:43817",
        deviceAuthorization: accountlessAuth,
        laboratory: true,
        authorization: accountlessV12Body,
        days: [...clientRecords.keys()].sort(),
        readDay: (day) => hostV12ClientDay(day, clientRecords.get(day) ?? 0, clientParser),
        createEnvelope: (chunk) => encryptHostV12(chunk, envelopePublicJwk, envelopePublicJwk.kid),
        progressStore: {
          read: async () => clientJournal,
          write: async (value) => { clientJournal = value; },
        },
        sourcePublication: { fingerprint: `host-v12-client-${label}`, parserVersion: clientParser },
        fetchImpl: async (url, init) => {
          const response = await dispatch(new Request(url, init));
          exchanges.push({ path: new URL(url).pathname, status: response.status,
            body: await response.clone().json() });
          return response;
        },
      });
      return { result, exchanges };
    };
    const firstClientRun = await runAccountlessClient("first");
    assert.deepEqual(firstClientRun.exchanges.filter((exchange) => exchange.status >= 400), []);
    assert.equal(firstClientRun.result.status, "complete", JSON.stringify(firstClientRun.result));
    assert.equal(firstClientRun.result.failure, null);
    assert.equal(firstClientRun.result.daysSynced, 3);
    assert.equal(firstClientRun.result.chunksUploaded, 2);
    assert.equal(firstClientRun.result.acknowledgedThroughDay, clientDay(0));
    assert.equal(clientJournal, null);
    const firstClientPins = firstClientRun.exchanges
      .filter((exchange) => exchange.path === "/api/v1/me/telemetry-v12/domain-predecessor")
      .map((exchange) => exchange.body);
    assert.equal(firstClientPins.length, 2);
    assert.deepEqual([firstClientPins[0].fromDay, firstClientPins[0].throughDay], [clientDay(0), clientDay(0)]);
    assert.equal(firstClientPins[1].legacyFingerprint, firstClientPins[0].legacyFingerprint);
    const clientDomain = await primaryPool.query(
      `SELECT head.revision::integer AS revision, domain.device_id,
              to_char(domain.from_day, 'YYYY-MM-DD') AS from_day,
              to_char(domain.through_day, 'YYYY-MM-DD') AS through_day,
              (SELECT count(*)::integer FROM ${primaryTable("telemetry_v12_domain_days")} day_row
                JOIN ${primaryTable("telemetry_v12_day_manifests")} manifest ON manifest.id = day_row.manifest_id
               WHERE day_row.generation_id = domain.id AND manifest.state = 'ready'
                 AND manifest.expected_chunk_count = 0) AS empty_days,
              (SELECT count(*)::integer FROM ${primaryTable("telemetry_v11_domains")} legacy
                WHERE legacy.participant_id = head.participant_id) AS v11_domains
         FROM ${primaryTable("telemetry_v12_domain_heads")} head
         JOIN ${primaryTable("telemetry_v12_domains")} domain ON domain.id = head.generation_id
        WHERE head.participant_id = $1`,
      [accountlessParticipantId],
    );
    assert.deepEqual(clientDomain.rows, [{
      revision: 1, device_id: accountlessDeviceId, from_day: clientDay(-2), through_day: clientDay(0),
      empty_days: 1, v11_domains: 0,
    }]);

    const renewalNow = Date.now();
    const dueIssuedAt = new Date(renewalNow - 29 * 24 * 60 * 60_000).toISOString();
    const dueExpiresAt = new Date(renewalNow + 24 * 60 * 60_000).toISOString();
    await primaryPool.query("BEGIN");
    try {
      await primaryPool.query(
        "UPDATE " + primaryTable("accountless_enrollment_ledger")
          + " SET issued_at=$2::timestamptz, expires_at=$3::timestamptz, "
          + "renewed_at=NULL, renewal_generation=0 WHERE device_id=$1",
        [accountlessDeviceId, dueIssuedAt, dueExpiresAt],
      );
      for (const table of [
        "device_credentials", "accountless_upload_owners",
        "accountless_v11_device_authorizations", "accountless_v12_device_authorizations",
      ]) {
        const key = table === "device_credentials" ? "id" : "enrollment_device_id";
        await primaryPool.query(
          "UPDATE " + primaryTable(table) + " SET expires_at=$2::timestamptz WHERE " + key + "=$1",
          [accountlessDeviceId, dueExpiresAt],
        );
      }
      await primaryPool.query("COMMIT");
    } catch (error) {
      await primaryPool.query("ROLLBACK");
      throw error;
    }
    const renewedResponse = await dispatch(renewalHttp());
    assert.equal(renewedResponse.status, 200);
    const renewedReceipt = await renewedResponse.json();
    assert.equal(renewedReceipt.state, "renewed");
    assert.equal(renewedReceipt.renewalGeneration, 1);
    assert.ok(Date.parse(renewedReceipt.expiresAt) > Date.parse(dueExpiresAt));
    const renewedGraph = await primaryPool.query(
      "SELECT ledger.renewal_generation, ledger.renewed_at::text AS renewed_at, "
        + "ledger.expires_at::text AS ledger_expires_at, device.expires_at::text AS device_expires_at, "
        + "owner.expires_at::text AS owner_expires_at, v11.expires_at::text AS v11_expires_at, "
        + "v12.expires_at::text AS v12_expires_at FROM "
        + primaryTable("accountless_enrollment_ledger") + " ledger JOIN "
        + primaryTable("device_credentials") + " device ON device.id=ledger.device_id JOIN "
        + primaryTable("accountless_upload_owners") + " owner ON owner.enrollment_device_id=ledger.device_id JOIN "
        + primaryTable("accountless_v11_device_authorizations") + " v11 ON v11.enrollment_device_id=ledger.device_id JOIN "
        + primaryTable("accountless_v12_device_authorizations") + " v12 ON v12.enrollment_device_id=ledger.device_id "
        + "WHERE ledger.device_id=$1",
      [accountlessDeviceId],
    );
    assert.equal(renewedGraph.rowCount, 1);
    const renewedRow = renewedGraph.rows[0];
    assert.equal(renewedRow.renewal_generation, 1);
    assert.ok(renewedRow.renewed_at);
    assert.equal(new Set([
      renewedRow.ledger_expires_at, renewedRow.device_expires_at,
      renewedRow.owner_expires_at, renewedRow.v11_expires_at,
    ].map((value) => Date.parse(value))).size, 1,
    "ledger, device, owner, and v1.1 authorization renew atomically");
    assert.equal(Date.parse(renewedReceipt.expiresAt),
      Date.parse(renewedRow.renewed_at) + 30 * 24 * 60 * 60_000);
    assert.equal(Date.parse(renewedRow.v12_expires_at), Date.parse(renewedReceipt.expiresAt),
      "renewal extends the exact active matching v1.2 authorization with its owner lease");
    assert.equal(new Set([
      renewedRow.ledger_expires_at, renewedRow.device_expires_at,
      renewedRow.owner_expires_at, renewedRow.v11_expires_at, renewedRow.v12_expires_at,
    ].map((value) => Date.parse(value))).size, 1,
    "the exact active v1.2 grant advances in the same lease transaction");
    const renewedUploadAuthorization = await dispatch(request({
      url: uploadAuthorizationUrl,
      headers: { authorization: accountlessAuth },
      body: JSON.stringify({
        envelopeDigest: "b".repeat(64), contentLengthBytes: 1,
        contentType: "application/json", telemetrySchemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
      }),
    }));
    assert.equal(renewedUploadAuthorization.status, 201,
      "the exact active v1.2 authority remains usable after renewal");

    // The shipped client uploads again under the renewed lease: the v1.2 grant
    // moved with the lease, so it does not have to be requested again.
    clientRecords.set(clientDay(0), 3);
    const renewedClientRun = await runAccountlessClient("renewed");
    assert.deepEqual(renewedClientRun.exchanges.filter((exchange) => exchange.status >= 400), []);
    assert.equal(renewedClientRun.result.status, "complete", JSON.stringify(renewedClientRun.result));
    assert.equal(renewedClientRun.result.chunksUploaded, 1);

    // A grant left behind by the lease (as D1 grants were before isolation
    // 0010) is reported as not current, and the next grant request catches it
    // up to the lease instead of refusing it.
    const readV12Capability = async () => {
      const response = await dispatch(request({
        url: syncCapabilitiesV12Url, method: "GET", headers: { authorization: accountlessAuth },
      }));
      assert.equal(response.status, 200);
      return (await response.json()).successor.authorizationCurrent;
    };
    assert.equal(await readV12Capability(), true);
    await primaryPool.query(
      "UPDATE " + primaryTable("accountless_v12_device_authorizations")
        + " SET expires_at = expires_at - interval '1 day' WHERE enrollment_device_id=$1",
      [accountlessDeviceId],
    );
    assert.equal(await readV12Capability(), false,
      "a stale v1.2 grant is not reported as current authority");
    const caughtUpGrant = await dispatch(authorizationHttp(JSON.stringify(accountlessV12Body)));
    assert.equal(caughtUpGrant.status, 201, JSON.stringify(await caughtUpGrant.clone().json()));
    const caughtUpState = await primaryPool.query(
      "SELECT grant_row.state, grant_row.expires_at = ledger.expires_at AS current FROM "
        + primaryTable("accountless_v12_device_authorizations") + " grant_row JOIN "
        + primaryTable("accountless_enrollment_ledger")
        + " ledger ON ledger.device_id = grant_row.enrollment_device_id "
        + "WHERE grant_row.enrollment_device_id=$1",
      [accountlessDeviceId],
    );
    assert.deepEqual(caughtUpState.rows, [{ state: "active", current: true }]);
    assert.equal(await readV12Capability(), true);

    const noV12DeviceId = randomUUID();
    const noV12Secret = randomBytes(32).toString("base64url");
    const noV12Auth = `Device um_device_${noV12DeviceId}.${noV12Secret}`;
    const noV12EnrollmentBody = {
      ...accountlessEnrollmentBody,
      deviceId: noV12DeviceId,
      deviceSecretHash: deviceSecretHash(noV12DeviceId, noV12Secret).toString("hex"),
    };
    assert.equal((await dispatch(enrollmentHttp(JSON.stringify(noV12EnrollmentBody)))).status, 201);
    assert.equal((await dispatch(ownershipHttp(JSON.stringify(ownershipBody), {
      authorization: noV12Auth,
    }))).status, 201);
    const noV12DueAt = Date.now();
    const noV12IssuedAt = new Date(noV12DueAt - 29 * 24 * 60 * 60_000).toISOString();
    const noV12ExpiresAt = new Date(noV12DueAt + 24 * 60 * 60_000).toISOString();
    await primaryPool.query(
      "UPDATE " + primaryTable("accountless_enrollment_ledger")
        + " SET issued_at=$2::timestamptz, expires_at=$3::timestamptz, "
        + "renewed_at=NULL, renewal_generation=0 WHERE device_id=$1",
      [noV12DeviceId, noV12IssuedAt, noV12ExpiresAt],
    );
    for (const table of [
      "device_credentials", "accountless_upload_owners",
      "accountless_v11_device_authorizations",
    ]) {
      const key = table === "device_credentials" ? "id" : "enrollment_device_id";
      await primaryPool.query(
        "UPDATE " + primaryTable(table) + " SET expires_at=$2::timestamptz WHERE " + key + "=$1",
        [noV12DeviceId, noV12ExpiresAt],
      );
    }
    const noV12Renewal = await dispatch(renewalHttp(renewalJson, { authorization: noV12Auth }));
    assert.equal(noV12Renewal.status, 200);
    assert.equal((await noV12Renewal.json()).state, "renewed");
    assert.equal((await primaryPool.query(
      "SELECT count(*)::integer AS count FROM " + primaryTable("accountless_v12_device_authorizations")
        + " WHERE enrollment_device_id=$1 AND state='active'",
      [noV12DeviceId],
    )).rows[0].count, 0,
    "renewal never creates or reactivates a missing v1.2 grant");
    await assertApiError(await dispatch(request({
      url: uploadAuthorizationUrl,
      headers: { authorization: noV12Auth },
      body: JSON.stringify({
        envelopeDigest: "c".repeat(64), contentLengthBytes: 1,
        contentType: "application/json", telemetrySchemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
      }),
    })), 401, "DEVICE_AUTH_INVALID");
    const renewalReplay = await dispatch(renewalHttp());
    assert.equal(renewalReplay.status, 200);
    assert.equal((await renewalReplay.json()).state, "existing");
    assert.equal((await primaryPool.query(
      "SELECT renewal_generation FROM " + primaryTable("accountless_enrollment_ledger")
        + " WHERE device_id=$1", [accountlessDeviceId],
    )).rows[0].renewal_generation, 1, "replay does not create another generation");

    const disconnectUrl = "http://127.0.0.1:43817/api/v1/device/disconnect";
    const disconnectRequest = ({
      authorization = undefined,
      headers = {},
      method = "POST",
    } = {}) => new Request(disconnectUrl, {
      method,
      headers: {
        ...(authorization === undefined ? {} : { authorization }),
        ...headers,
      },
    });
    const disconnectRouteRateStart = deviceDisconnectRateLimitCalls;
    const readAccountlessDisconnectState = async (deviceId) => primaryPool.query(
      "SELECT ledger.state AS ledger_state, ledger.revoked_at::text AS ledger_revoked_at, "
        + "owner.state AS owner_state, owner.revoked_at::text AS owner_revoked_at, "
        + "v11.state AS v11_state, v11.revoked_at::text AS v11_revoked_at, "
        + "v12.state AS v12_state, v12.revoked_at::text AS v12_revoked_at, "
        + "device.state AS device_state, device.revoked_at::text AS device_revoked_at, "
        + "EXISTS (SELECT 1 FROM " + primaryTable("accountless_public_history_retention")
        + " marker WHERE marker.enrollment_device_id=$1) AS retained_marker, "
        + "(SELECT COALESCE(jsonb_agg(jsonb_build_array(upload.id, upload.state, "
        + "upload.revoked_at::text, upload.consume_lease_expires_at::text) ORDER BY upload.id), '[]'::jsonb) "
        + "FROM " + primaryTable("device_upload_authorizations")
        + " upload WHERE upload.issued_by_device_id=$1) AS upload_authorizations "
        + "FROM " + primaryTable("accountless_enrollment_ledger") + " ledger JOIN "
        + primaryTable("accountless_upload_owners") + " owner "
        + "ON owner.enrollment_device_id=ledger.device_id JOIN "
        + primaryTable("accountless_v11_device_authorizations") + " v11 "
        + "ON v11.enrollment_device_id=ledger.device_id LEFT JOIN "
        + primaryTable("accountless_v12_device_authorizations") + " v12 "
        + "ON v12.enrollment_device_id=ledger.device_id JOIN "
        + primaryTable("device_credentials") + " device ON device.id=ledger.device_id "
        + "WHERE ledger.device_id=$1",
      [deviceId],
    );
    const accountlessBeforeDisconnect = await readAccountlessDisconnectState(noV12DeviceId);
    assert.equal(accountlessBeforeDisconnect.rowCount, 1);
    const accountlessDisconnectResponse = await dispatch(disconnectRequest({
      authorization: noV12Auth,
    }));
    assert.equal(accountlessDisconnectResponse.status, 200,
      "accountless opt-out revokes upload authority when there is no accepted v1.1 head to retain");
    assert.deepEqual(await accountlessDisconnectResponse.json(), {
      schemaVersion: "device-disconnect-v0.1",
      disconnected: true,
      deviceId: noV12DeviceId,
    });
    const accountlessAfterDisconnect = await readAccountlessDisconnectState(noV12DeviceId);
    assert.equal(accountlessAfterDisconnect.rows.length, 1);
    const accountlessAfterRow = accountlessAfterDisconnect.rows[0];
    assert.deepEqual({
      ...accountlessAfterRow,
      ledger_revoked_at: null,
      owner_revoked_at: null,
      v11_revoked_at: null,
      device_revoked_at: null,
    }, {
      ...accountlessBeforeDisconnect.rows[0],
      ledger_state: "revoked",
      owner_state: "revoked",
      v11_state: "revoked",
      device_state: "revoked",
      retained_marker: false,
    });
    assert.equal(typeof accountlessAfterRow.ledger_revoked_at, "string");
    assert.equal(accountlessAfterRow.ledger_revoked_at,
      accountlessAfterRow.owner_revoked_at,
      "accountless opt-out uses one timestamp for retained-source authority state");
    assert.equal(accountlessAfterRow.ledger_revoked_at,
      accountlessAfterRow.v11_revoked_at);
    assert.equal(accountlessAfterRow.ledger_revoked_at,
      accountlessAfterRow.device_revoked_at);

    // The social stop route remains usable while collection and upload
    // registration controls are degraded. Unlike accountless opt-out, social
    // device revocation has no PostgreSQL public-source withdrawal side effect.
    const disconnectControlsOriginal = await primaryPool.query(
      `SELECT control_state, enrollment_enabled, upload_registration_enabled,
              processing_enabled, publication_enabled, reason_code
         FROM ${primaryTable("collection_controls")} WHERE singleton=1`,
    );
    const degradedAt = new Date().toISOString();
    await primaryPool.query(
      `UPDATE ${primaryTable("collection_controls")}
          SET revision=revision+1, control_state='degraded', enrollment_enabled=false,
              upload_registration_enabled=false, processing_enabled=false,
              updated_at=$1::timestamptz
        WHERE singleton=1`,
      [degradedAt],
    );
    const disconnectControlsBefore = await primaryPool.query(
      `SELECT revision, control_state, enrollment_enabled,
              upload_registration_enabled, processing_enabled
         FROM ${primaryTable("collection_controls")} WHERE singleton=1`,
    );
    assert.equal(disconnectControlsBefore.rows[0].control_state, "degraded");
    assert.equal(disconnectControlsBefore.rows[0].enrollment_enabled, false);
    assert.equal(disconnectControlsBefore.rows[0].upload_registration_enabled, false);
    assert.equal(disconnectControlsBefore.rows[0].processing_enabled, false);

    async function insertSyntheticSocialDevice(label) {
      const id = randomUUID();
      const session = randomUUID();
      const pairing = randomUUID();
      const participant = `synthetic-${label}-${randomUUID()}`;
      const secret = randomBytes(32).toString("base64url");
      const issuedAt = new Date().toISOString();
      // D1 accepts a valid device bearer for disconnect even after ordinary
      // upload expiry; the stop route must not strand an installation.
      const expiresAt = new Date(Date.now() - 60_000).toISOString();
      const sessionExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
      await primaryPool.query(
        `INSERT INTO ${primaryTable("participants")} (
           id, owner_kind, state, consent_version, created_at
         ) VALUES ($1, 'social', 'active', $2, $3::timestamptz)`,
        [participant, constants.TELEMETRY_CONSENT_VERSION, issuedAt],
      );
      await primaryPool.query(
        `INSERT INTO ${primaryTable("web_sessions")} (
           id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
         ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $5::timestamptz)`,
        [session, participant, randomBytes(32), randomBytes(32), issuedAt, sessionExpiresAt],
      );
      await primaryPool.query(
        `INSERT INTO ${primaryTable("device_pairings")} (
           id, participant_id, issued_by_session_id, secret_hash, consent_version,
           transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
         ) VALUES ($1, $2, $3, $4, $5, $5, 'consumed', $6::timestamptz,
           $7::timestamptz, $6::timestamptz, $8)`,
        [pairing, participant, session, randomBytes(32),
          constants.TELEMETRY_CONSENT_VERSION, issuedAt, sessionExpiresAt, id],
      );
      await primaryPool.query(
        `INSERT INTO ${primaryTable("device_credentials")} (
           id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
           state, issued_at, expires_at, last_used_at, social_verified_at
         ) VALUES ($1, $2, 'social', $3, $4, 'active', $5::timestamptz,
           $6::timestamptz, $5::timestamptz, $5::timestamptz)`,
        [id, participant, pairing, deviceSecretHash(id, secret), issuedAt, expiresAt],
      );
      return {
        id,
        participant,
        secret,
        auth: `Device um_device_${id}.${secret}`,
        issuedAt,
        expiresAt,
      };
    }
    async function insertSyntheticUpload(device, state) {
      const id = `synthetic-disconnect-upload-${randomUUID()}`;
      const issuedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      await primaryPool.query(
        `INSERT INTO ${primaryTable("device_upload_authorizations")} (
           id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
           body_bytes, content_type, state, issued_at, expires_at,
           consumed_at, revoked_at, consume_lease_expires_at
         ) VALUES ($1, $2, $3, $4, $5, 1, 'application/json', $6,
           $7::timestamptz, $8::timestamptz,
           CASE WHEN $6='consumed' THEN $7::timestamptz ELSE NULL END,
           CASE WHEN $6='revoked' THEN $7::timestamptz ELSE NULL END,
           CASE WHEN $6='consuming' THEN $8::timestamptz ELSE NULL END)`,
        [id, device.participant, device.id, randomBytes(32), "d".repeat(64), state,
          issuedAt, expiresAt],
      );
      return id;
    }
    const socialDisconnectDevice = await insertSyntheticSocialDevice("disconnect");
    assert.ok(Date.parse(socialDisconnectDevice.expiresAt) < Date.now(),
      "disconnect fixture has an expired but still valid credential");
    const disconnectUploadIds = await Promise.all([
      insertSyntheticUpload(socialDisconnectDevice, "unused"),
      insertSyntheticUpload(socialDisconnectDevice, "consuming"),
      insertSyntheticUpload(socialDisconnectDevice, "consumed"),
      insertSyntheticUpload(socialDisconnectDevice, "revoked"),
    ]);
    const methodRateCalls = deviceDisconnectRateLimitCalls;
    const disconnectWrongMethod = await dispatch(disconnectRequest({ method: "GET" }));
    await assertApiError(disconnectWrongMethod, 405, "METHOD_NOT_ALLOWED");
    assert.equal(disconnectWrongMethod.headers.get("allow"), "POST");
    assert.equal(deviceDisconnectRateLimitCalls, methodRateCalls,
      "method rejection happens before device-disconnect admission");
    const socialDeviceBeforeInvalid = await primaryPool.query(
      `SELECT state, revoked_at::text AS revoked_at
         FROM ${primaryTable("device_credentials")} WHERE id=$1`,
      [socialDisconnectDevice.id],
    );
    const uploadStatesBeforeInvalid = await primaryPool.query(
      `SELECT id, state, revoked_at::text AS revoked_at,
              consume_lease_expires_at::text AS consume_lease_expires_at
         FROM ${primaryTable("device_upload_authorizations")}
        WHERE id = ANY($1::text[]) ORDER BY id`,
      [disconnectUploadIds],
    );
    await assertApiError(await dispatch(disconnectRequest()), 401, "DEVICE_AUTH_INVALID");
    await assertApiError(await dispatch(disconnectRequest({
      authorization: socialDisconnectDevice.auth,
      headers: { cookie: "session=not-allowed" },
    })), 401, "DEVICE_AUTH_INVALID");
    await assertApiError(await dispatch(disconnectRequest({
      authorization: socialDisconnectDevice.auth,
      headers: { "content-length": "1" },
    })), 400, "BODY_INVALID");
    await assertApiError(await dispatch(disconnectRequest({
      authorization: `Device um_device_${socialDisconnectDevice.id}.${randomBytes(32).toString("base64url")}`,
    })), 401, "DEVICE_AUTH_INVALID");
    const unchangedSocialDevice = await primaryPool.query(
      `SELECT state, revoked_at::text AS revoked_at
         FROM ${primaryTable("device_credentials")} WHERE id=$1`,
      [socialDisconnectDevice.id],
    );
    assert.deepEqual(unchangedSocialDevice.rows, socialDeviceBeforeInvalid.rows,
      "cookie, body, and wrong-secret failures do not revoke a device");
    const unchangedUploadStates = await primaryPool.query(
      `SELECT id, state, revoked_at::text AS revoked_at,
              consume_lease_expires_at::text AS consume_lease_expires_at
         FROM ${primaryTable("device_upload_authorizations")}
        WHERE id = ANY($1::text[]) ORDER BY id`,
      [disconnectUploadIds],
    );
    assert.deepEqual(unchangedUploadStates.rows, uploadStatesBeforeInvalid.rows,
      "invalid credentials and request forms do not alter upload grants");

    const disconnectStartedAt = Date.now();
    const socialDisconnectResponse = await dispatch(disconnectRequest({
      authorization: socialDisconnectDevice.auth,
    }));
    assert.equal(socialDisconnectResponse.status, 200);
    assert.deepEqual(await socialDisconnectResponse.json(), {
      schemaVersion: "device-disconnect-v0.1",
      disconnected: true,
      deviceId: socialDisconnectDevice.id,
    });
    const disconnectedSocial = await primaryPool.query(
      `SELECT state, revoked_at::text AS revoked_at
         FROM ${primaryTable("device_credentials")} WHERE id=$1`,
      [socialDisconnectDevice.id],
    );
    assert.equal(disconnectedSocial.rows[0].state, "revoked");
    assert.ok(Date.parse(disconnectedSocial.rows[0].revoked_at) >= disconnectStartedAt);
    const disconnectedUploads = await primaryPool.query(
      `SELECT id, state, revoked_at::text AS revoked_at,
              consumed_at::text AS consumed_at,
              consume_lease_expires_at::text AS consume_lease_expires_at
         FROM ${primaryTable("device_upload_authorizations")}
        WHERE id = ANY($1::text[]) ORDER BY id`,
      [disconnectUploadIds],
    );
    assert.deepEqual(disconnectedUploads.rows.map((row) => ({
      id: row.id,
      state: row.state,
      revoked: row.revoked_at !== null,
      consumed: row.consumed_at !== null,
      lease: row.consume_lease_expires_at,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    disconnectUploadIds.map((id, index) => ({
      id,
      state: ["revoked", "revoked", "consumed", "revoked"][index],
      revoked: index !== 2,
      consumed: index === 2,
      lease: null,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    "disconnect revokes only pending unused/consuming grants and clears leases");
    const disconnectReplay = await dispatch(disconnectRequest({
      authorization: socialDisconnectDevice.auth,
    }));
    assert.equal(disconnectReplay.status, 200,
      "a valid bearer remains idempotently accepted after revocation");
    assert.deepEqual(await disconnectReplay.json(), {
      schemaVersion: "device-disconnect-v0.1",
      disconnected: true,
      deviceId: socialDisconnectDevice.id,
    });
    const replayedSocial = await primaryPool.query(
      `SELECT state, revoked_at::text AS revoked_at
         FROM ${primaryTable("device_credentials")} WHERE id=$1`,
      [socialDisconnectDevice.id],
    );
    assert.deepEqual(replayedSocial.rows, disconnectedSocial.rows,
      "disconnect replay preserves the original revocation receipt");

    const reuseDevice = await insertSyntheticSocialDevice("disconnect-reuse");
    const priorSecret = randomBytes(32).toString("base64url");
    const priorSecretHash = deviceSecretHash(reuseDevice.id, priorSecret);
    const reuseGrantIds = await Promise.all([
      insertSyntheticUpload(reuseDevice, "unused"),
      insertSyntheticUpload(reuseDevice, "consuming"),
    ]);
    await primaryPool.query(
      `INSERT INTO ${primaryTable("device_credential_rotations")} (
         id, device_id, participant_id, prior_secret_hash, replacement_secret_hash,
         attempt_id, generation, rotated_at, retire_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 2, $7::timestamptz, $8::timestamptz)`,
      [randomUUID(), reuseDevice.id, reuseDevice.participant, priorSecretHash,
        deviceSecretHash(reuseDevice.id, reuseDevice.secret), randomUUID(), reuseDevice.issuedAt,
        new Date(Date.now() + 60_000).toISOString()],
    );
    await assertApiError(await dispatch(disconnectRequest({
      authorization: `Device um_device_${reuseDevice.id}.${priorSecret}`,
    })), 401, "DEVICE_AUTH_INVALID");
    const reusedCredentialState = await primaryPool.query(
      `SELECT state, revoked_at IS NOT NULL AS revoked
         FROM ${primaryTable("device_credentials")} WHERE id=$1`,
      [reuseDevice.id],
    );
    assert.deepEqual(reusedCredentialState.rows, [{ state: "revoked", revoked: true }],
      "a retired bearer from a still-valid rotation revokes its social device lineage");
    const reusedUploadStates = await primaryPool.query(
      `SELECT state, revoked_at IS NOT NULL AS revoked,
              consume_lease_expires_at IS NULL AS lease_cleared
         FROM ${primaryTable("device_upload_authorizations")}
        WHERE id = ANY($1::text[]) ORDER BY state`,
      [reuseGrantIds],
    );
    assert.deepEqual(reusedUploadStates.rows, [
      { state: "revoked", revoked: true, lease_cleared: true },
      { state: "revoked", revoked: true, lease_cleared: true },
    ]);
    assert.equal(deviceDisconnectRateLimitCalls - disconnectRouteRateStart, 8,
      "missing/cookie/body/credential, success, replay, accountless opt-out, and credential-reuse requests are admitted");
    assert.deepEqual((await primaryPool.query(
      `SELECT revision, control_state, enrollment_enabled,
              upload_registration_enabled, processing_enabled
         FROM ${primaryTable("collection_controls")} WHERE singleton=1`,
    )).rows, disconnectControlsBefore.rows,
    "disconnect does not alter degraded enrollment, upload, or processing controls");
    const priorControls = disconnectControlsOriginal.rows[0];
    await primaryPool.query(
      `UPDATE ${primaryTable("collection_controls")}
          SET revision=revision+1, control_state=$1, enrollment_enabled=$2,
              upload_registration_enabled=$3, processing_enabled=$4,
              publication_enabled=$5, reason_code=$6, updated_at=clock_timestamp()
        WHERE singleton=1`,
      [priorControls.control_state, priorControls.enrollment_enabled,
        priorControls.upload_registration_enabled, priorControls.processing_enabled,
        priorControls.publication_enabled, priorControls.reason_code],
    );

    // The v1.2-only install above (no v1.1 domain) opts out through the real
    // route. Its eligible accepted v1.2 head is retained (D1 isolation 0011,
    // PostgreSQL 0045) and the successor grant is revoked with the whole
    // lease graph at the marker's instant.
    const v12OnlyHead = await primaryPool.query(
      "SELECT generation_id, revision::integer AS revision FROM "
        + primaryTable("telemetry_v12_domain_heads") + " WHERE participant_id=$1",
      [accountlessParticipantId],
    );
    assert.equal(v12OnlyHead.rowCount, 1);
    // The guard pins the exact accepted head: any other revision is refused.
    await assert.rejects(primaryPool.query(
      "INSERT INTO " + primaryTable("accountless_public_history_retention")
        + " (participant_id, enrollment_device_id, device_credential_id, generation_id,"
        + " head_revision, retained_at) VALUES ($1,$2,$2,$3,$4,clock_timestamp())",
      [accountlessParticipantId, accountlessDeviceId, v12OnlyHead.rows[0].generation_id,
        v12OnlyHead.rows[0].revision + 1],
    ), /accountless_history_retention_unavailable/u);
    const v12OnlyOptOut = await dispatch(disconnectRequest({ authorization: accountlessAuth }));
    assert.equal(v12OnlyOptOut.status, 200, JSON.stringify(await v12OnlyOptOut.clone().json()));
    const v12OnlyMarker = await primaryPool.query(
      "SELECT generation_id, head_revision::integer AS head_revision, retained_at::text AS retained_at FROM "
        + primaryTable("accountless_public_history_retention") + " WHERE enrollment_device_id=$1",
      [accountlessDeviceId],
    );
    assert.deepEqual(v12OnlyMarker.rows.map(({ generation_id: generationId, head_revision: headRevision }) =>
      ({ generationId, headRevision })), [{
      generationId: v12OnlyHead.rows[0].generation_id, headRevision: v12OnlyHead.rows[0].revision,
    }]);
    const optedOutAt = v12OnlyMarker.rows[0].retained_at;
    const readOptOutInstants = async () => (await primaryPool.query(
      "SELECT ledger.revoked_at::text AS ledger, owner.revoked_at::text AS owner, "
        + "v11.revoked_at::text AS v11, v12.revoked_at::text AS v12, "
        + "v12.revocation_reason AS v12_reason, device.revoked_at::text AS device FROM "
        + primaryTable("accountless_enrollment_ledger") + " ledger JOIN "
        + primaryTable("accountless_upload_owners") + " owner ON owner.enrollment_device_id=ledger.device_id JOIN "
        + primaryTable("accountless_v11_device_authorizations") + " v11 ON v11.enrollment_device_id=ledger.device_id JOIN "
        + primaryTable("accountless_v12_device_authorizations") + " v12 ON v12.enrollment_device_id=ledger.device_id JOIN "
        + primaryTable("device_credentials") + " device ON device.id=ledger.device_id WHERE ledger.device_id=$1",
      [accountlessDeviceId],
    )).rows;
    assert.deepEqual(await readOptOutInstants(), [{
      ledger: optedOutAt, owner: optedOutAt, v11: optedOutAt, v12: optedOutAt,
      v12_reason: "user_opt_out", device: optedOutAt,
    }]);
    const v12OnlyReplay = await dispatch(disconnectRequest({ authorization: accountlessAuth }));
    assert.equal(v12OnlyReplay.status, 200, "an exact retained v1.2 opt-out replays");
    // An opt-out committed before the successor grant joined this transaction
    // left it active. A replay revokes it at the ledger's own instant.
    await primaryPool.query(
      "UPDATE " + primaryTable("accountless_v12_device_authorizations")
        + " SET state='active', revoked_at=NULL, revocation_reason=NULL WHERE enrollment_device_id=$1",
      [accountlessDeviceId],
    );
    const repairedReplay = await dispatch(disconnectRequest({ authorization: accountlessAuth }));
    assert.equal(repairedReplay.status, 200, JSON.stringify(await repairedReplay.clone().json()));
    assert.deepEqual(await readOptOutInstants(), [{
      ledger: optedOutAt, owner: optedOutAt, v11: optedOutAt, v12: optedOutAt,
      v12_reason: "user_opt_out", device: optedOutAt,
    }]);
    await assertApiError(await dispatch(enrollmentHttp()), 401, "ACCOUNTLESS_ENROLLMENT_REVOKED");
    await assertApiError(await dispatch(ownershipHttp(JSON.stringify(ownershipBody))),
      401, "ACCOUNTLESS_OWNERSHIP_REVOKED");
    await assertApiError(await dispatch(authorizationHttp(JSON.stringify(accountlessV12Body))),
      401, "ACCOUNTLESS_OWNERSHIP_REVOKED");
    await assertApiError(await dispatch(request({
      url: uploadAuthorizationUrl,
      headers: { authorization: accountlessAuth },
      body: JSON.stringify({
        envelopeDigest: "b".repeat(64), contentLengthBytes: 1,
        contentType: "application/json", telemetrySchemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
      }),
    })), 401, "DEVICE_AUTH_INVALID");
    const optedOutState = await primaryPool.query(
      "SELECT ledger.state AS ledger_state, owner.state AS owner_state, "
        + "v11.state AS v11_state, v12.state AS v12_state, "
        + "v12.revocation_reason AS v12_revocation_reason, device.state AS device_state, "
        + "(SELECT count(*)::integer FROM " + primaryTable("device_upload_authorizations")
        + " WHERE issued_by_device_id=$1 AND state IN ('unused','consuming')) AS pending_uploads "
        + "FROM " + primaryTable("accountless_enrollment_ledger") + " ledger JOIN "
        + primaryTable("accountless_upload_owners") + " owner "
        + "ON owner.enrollment_device_id=ledger.device_id JOIN "
        + primaryTable("accountless_v11_device_authorizations") + " v11 "
        + "ON v11.enrollment_device_id=ledger.device_id JOIN "
        + primaryTable("accountless_v12_device_authorizations") + " v12 "
        + "ON v12.enrollment_device_id=ledger.device_id JOIN "
        + primaryTable("device_credentials") + " device ON device.id=ledger.device_id "
        + "WHERE ledger.device_id=$1",
      [accountlessDeviceId],
    );
    assert.deepEqual(optedOutState.rows[0], {
      ledger_state: "revoked", owner_state: "revoked", v11_state: "revoked",
      v12_state: "revoked", v12_revocation_reason: "user_opt_out",
      device_state: "revoked", pending_uploads: 0,
    });

    assert.equal(d1Touched, 0);
    assert.equal(workerCalls, 0);
  } finally {
    await vite?.close();
    for (const schema of createdSchemas.reverse()) {
      try { await primaryPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch {}
    }
    await primaryPool.end();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
});

test("host strips spoofed forwarding data and forwards the Access assertion only for the admin host", () => {
  const rawHeaders = {
    Host: "test.example",
    Cookie: "session=test",
    Origin: "https://test.example",
    "cf-access-jwt-assertion": "signed-access-jwt",
    "cf-ray": "spoofed-ray",
    "x-forwarded-host": "evil.example",
    "x-forwarded-proto": "http",
    "x-serverless-authorization": "private-token",
  };
  const publicHeaders = sanitizeHeaders(rawHeaders);
  assert.equal(publicHeaders.get("cookie"), "session=test");
  assert.equal(publicHeaders.get("origin"), "https://test.example");
  assert.equal(publicHeaders.get("cf-access-jwt-assertion"), null);
  assert.equal(publicHeaders.get("cf-ray"), null);
  assert.equal(publicHeaders.get("x-forwarded-host"), null);
  assert.equal(publicHeaders.get("x-forwarded-proto"), null);
  assert.equal(publicHeaders.get("x-serverless-authorization"), null);

  const adminHeaders = sanitizeHeaders(rawHeaders, { preserveAccessAssertion: true });
  assert.equal(adminHeaders.get("cf-access-jwt-assertion"), "signed-access-jwt");
  assert.equal(adminHeaders.get("cf-ray"), null);
  assert.equal(adminHeaders.get("x-forwarded-host"), null);
});

test("host asset adapter serves the audited directory and refuses traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-cloud-run-assets-"));
  try {
    await writeFile(join(root, "index.html"), "synthetic index", "utf8");
    const assets = await createFilesystemAssets(root);
    const ok = await assets.fetch(new Request("https://test.example/"));
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "synthetic index");
    const escaped = await assets.fetch(new Request("https://test.example/%2e%2e%2findex.html"));
    assert.equal(escaped.status, 404);
    const head = await assets.fetch(new Request("https://test.example/", { method: "HEAD" }));
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("built Node host installs native timing comparison before session authentication", async () => {
  const left = new Uint8Array([1, 2, 3, 4]);
  assert.equal(nodeTimingSafeEqual(left, new Uint8Array([1, 2, 3, 4])), true);
  assert.equal(nodeTimingSafeEqual(left, new Uint8Array([1, 2, 3, 5])), false);
  assert.equal(nodeTimingSafeEqual(left, new Uint8Array([1, 2, 3])), false);

  const temporary = await mkdtemp(join(ROOT, ".tmp-node-host-crypto-"));
  try {
    const cryptoSource = resolve(ROOT, "../src/crypto.ts");
    const sessionSource = resolve(ROOT, "../src/session.ts");
    const adapterSource = resolve(ROOT, "node-crypto-adapter.mjs");
    const ownerBootstrapSource = resolve(ROOT, "owner-bootstrap.mjs");
    const entry = `
      import { setTimingSafeEqualImplementation } from ${JSON.stringify(cryptoSource)};
      import { authenticateSession, createSessionMaterialFromSecret, sessionCookie } from ${JSON.stringify(sessionSource)};
      import { installNodeTimingSafeEqual } from ${JSON.stringify(adapterSource)};
      import { bootstrapOwnerFixture, parseOwnerFixture, refreshOwnerSessionFixture } from ${JSON.stringify(ownerBootstrapSource)};

      installNodeTimingSafeEqual(setTimingSafeEqualImplementation);

      export async function run() {
        const now = Date.now();
        const participantId = "participant:node-host-check";
        const sessionId = "00000000-0000-4000-8000-000000000001";
        const secret = "A".repeat(43);
        const issuedAt = new Date(now - 1_000).toISOString();
        const expiresAt = new Date(now + 60_000).toISOString();
        const material = await createSessionMaterialFromSecret(
          participantId, sessionId, secret, issuedAt, expiresAt,
        );
        const row = {
          session_id: material.id,
          participant_id: material.participantId,
          secret_hash: material.secretHash.slice().buffer,
          csrf_hash: material.csrfHash.slice().buffer,
          session_scope: material.scope,
          expires_at: material.expiresAt,
          session_state: "active",
          participant_created_at: issuedAt,
          participant_state: "active",
          consent_version: "privacy-safe-telemetry-v0.1",
        };
        const backend = {
          prepare: () => ({
            bind: () => ({ first: async () => row }),
          }),
        };
        const principal = await authenticateSession(backend, sessionCookie(material));
        const invalidCookie = sessionCookie({
          ...material,
          token: material.token.slice(0, -1) + "B",
        });
        let invalidCode = null;
        try {
          await authenticateSession(backend, invalidCookie);
        } catch (error) {
          invalidCode = error?.code ?? null;
        }
        const ownerNow = Date.now();
        const ownerIssuedAt = new Date(ownerNow - 1_000).toISOString();
        const ownerExpiresAt = new Date(ownerNow + 60_000).toISOString();
        const ownerFixture = parseOwnerFixture(JSON.stringify({
          schemaVersion: "gcp-test-owner-fixture-v1",
          participantId: "participant:node-host-owner",
          identityLinkKey: "1".repeat(64),
          ownerDigest: "2".repeat(64),
          attributionNamespace: "3".repeat(64),
          accessTokenId: "access:node-host-owner",
          accessTokenSecret: "B".repeat(43),
          recoveryTokenId: "recovery:node-host-owner",
          recoveryTokenSecret: "C".repeat(43),
          sessionId: "00000000-0000-4000-8000-000000000002",
          sessionSecret: "D".repeat(43),
          issuedAt: ownerIssuedAt,
          expiresAt: ownerExpiresAt,
          consentVersion: "privacy-safe-telemetry-v0.1",
        }));
        const bootstrapCalls = [];
        const ownerBackend = {
          provider: "postgres",
          sourceIdentity: {
            sourceId: "source:node-host-check",
            sourceNamespace: "4".repeat(64),
          },
          authority: {
            identity: { readByLinkKey: async () => null },
            enrollment: {
              enroll: async (input) => {
                bootstrapCalls.push(input);
                return { id: ownerFixture.participantId, state: "active" };
              },
            },
          },
          application: { ownerDigest: async () => ownerFixture.ownerDigest },
        };
        const ownerReceipt = await bootstrapOwnerFixture({ backend: ownerBackend, fixture: ownerFixture });
        const refreshNow = Date.now();
        const refreshIssuedAt = new Date(refreshNow - 1_000).toISOString();
        const refreshExpiresAt = new Date(refreshNow - 1_000 + 30 * 60 * 1_000).toISOString();
        const refreshFixture = parseOwnerFixture(JSON.stringify({
          ...JSON.parse(JSON.stringify(ownerFixture)),
          sessionId: "00000000-0000-4000-8000-000000000003",
          sessionSecret: "E".repeat(43),
          issuedAt: refreshIssuedAt,
          expiresAt: refreshExpiresAt,
        }), { requireStandardSessionTtl: true });
        const refreshMaterial = await createSessionMaterialFromSecret(
          refreshFixture.participantId,
          refreshFixture.sessionId,
          refreshFixture.sessionSecret,
          refreshFixture.issuedAt,
          refreshFixture.expiresAt,
        );
        const previousNow = refreshNow - (30 * 60 * 1_000) - 1_000;
        const previousFixture = parseOwnerFixture(JSON.stringify({
          ...JSON.parse(JSON.stringify(ownerFixture)),
          sessionId: "00000000-0000-4000-8000-000000000004",
          sessionSecret: "F".repeat(43),
          issuedAt: new Date(previousNow).toISOString(),
          expiresAt: new Date(previousNow + 30 * 60 * 1_000).toISOString(),
        }), { allowExpired: true });
        const previousMaterial = await createSessionMaterialFromSecret(
          previousFixture.participantId,
          previousFixture.sessionId,
          previousFixture.sessionSecret,
          previousFixture.issuedAt,
          previousFixture.expiresAt,
        );
        const refreshCalls = [];
        let refreshInserted = false;
        const sessionRows = new Map([[previousFixture.sessionId, {
          participantId: previousFixture.participantId,
          participantState: "active",
          scope: "personal",
          state: "active",
          secretHash: previousMaterial.secretHash,
          csrfHash: previousMaterial.csrfHash,
          issuedAt: previousFixture.issuedAt,
          expiresAt: previousFixture.expiresAt,
          consentVersion: previousFixture.consentVersion,
        }]]);
        const refreshBackend = {
          provider: "postgres",
          authority: {
            identity: {
              readByLinkKey: async (linkKey) => linkKey === refreshFixture.identityLinkKey
                ? { id: refreshFixture.participantId, state: "active" }
                : null,
            },
            sessions: {
              read: async (id) => sessionRows.get(id) ?? null,
              insert: async (input) => {
                refreshCalls.push(input);
                refreshInserted = true;
                sessionRows.set(input.id, {
                  ...input,
                  participantState: "active",
                  state: "active",
                  consentVersion: refreshFixture.consentVersion,
                });
              },
            },
          },
          application: { ownerDigest: async () => refreshFixture.ownerDigest },
        };
        const refreshReceipt = await refreshOwnerSessionFixture({
          backend: refreshBackend,
          fixture: refreshFixture,
          previousFixture,
        });
        let wrongPriorCode = null;
        try {
          await refreshOwnerSessionFixture({
            backend: refreshBackend,
            fixture: {
              ...refreshFixture,
              sessionId: "00000000-0000-4000-8000-000000000005",
              sessionSecret: "G".repeat(43),
            },
            previousFixture: { ...previousFixture, sessionSecret: "H".repeat(43) },
          });
        } catch (error) {
          wrongPriorCode = error?.code ?? null;
        }
        const revokedRows = new Map(sessionRows);
        revokedRows.set(previousFixture.sessionId, {
          ...sessionRows.get(previousFixture.sessionId),
          state: "revoked",
        });
        let revokedPriorCode = null;
        try {
          await refreshOwnerSessionFixture({
            backend: {
              ...refreshBackend,
              authority: {
                ...refreshBackend.authority,
                sessions: {
                  ...refreshBackend.authority.sessions,
                  read: async (id) => revokedRows.get(id) ?? null,
                },
              },
            },
            fixture: {
              ...refreshFixture,
              sessionId: "00000000-0000-4000-8000-000000000006",
              sessionSecret: "I".repeat(43),
            },
            previousFixture,
          });
        } catch (error) {
          revokedPriorCode = error?.code ?? null;
        }
        const replay = await refreshOwnerSessionFixture({
          backend: refreshBackend,
          fixture: refreshFixture,
          previousFixture,
        });
        return {
          participantId: principal.participantId,
          sessionId: principal.sessionId,
          invalidCode,
          ownerCreated: ownerReceipt.created,
          ownerSessionIdInReceipt: Object.hasOwn(ownerReceipt, "sessionId"),
          ownerBootstrapCalls: bootstrapCalls.length,
          ownerBootstrapDigest: bootstrapCalls[0]?.bootstrap?.ownerDigest ?? null,
          ownerRefreshCreated: refreshReceipt.created,
          ownerRefreshCalls: refreshCalls.length,
          ownerRefreshReplayCreated: replay.created,
          ownerRefreshUsedReattach: Object.hasOwn(refreshBackend.authority, "enrollment"),
          ownerRefreshPreviousState: sessionRows.get(previousFixture.sessionId)?.state ?? null,
          ownerRefreshWrongPriorCode: wrongPriorCode,
          ownerRefreshRevokedPriorCode: revokedPriorCode,
        };
      }
    `;
    const result = await build({
      stdin: { contents: entry, resolveDir: ROOT, sourcefile: "node-host-session-check.mjs" },
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      write: false,
      external: ["jsonc-parser"],
      logLevel: "silent",
    });
    const output = result.outputFiles?.[0]?.contents;
    assert.ok(output instanceof Uint8Array);
    const outputPath = join(temporary, "check.mjs");
    await writeFile(outputPath, output);
    const built = await import(pathToFileURL(outputPath).href);
    const value = await built.run();
    assert.deepEqual(value, {
      participantId: "participant:node-host-check",
      sessionId: "00000000-0000-4000-8000-000000000001",
      invalidCode: "AUTH_INVALID",
      ownerCreated: true,
      ownerSessionIdInReceipt: false,
      ownerBootstrapCalls: 1,
      ownerBootstrapDigest: "2".repeat(64),
      ownerRefreshCreated: true,
      ownerRefreshCalls: 1,
      ownerRefreshReplayCreated: false,
      ownerRefreshUsedReattach: false,
      ownerRefreshPreviousState: "active",
      ownerRefreshWrongPriorCode: "ADMIN_OWNER_PREVIOUS_SESSION_INVALID",
      ownerRefreshRevokedPriorCode: "ADMIN_OWNER_PREVIOUS_SESSION_INVALID",
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
