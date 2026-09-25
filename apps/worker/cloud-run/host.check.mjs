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
import {
  CLOUD_RUN_IAM_TEST_TARGET,
  createPostgresTestV12DayManifestDispatch,
  createPostgresTestHealthDispatch,
  dispatchCloudRunHostRequest,
  isPrivatePostgresTestHost,
} from "./postgres-test-dispatch.mjs";
import {
  buildRequestUrl,
  createRequestOriginAllowlist,
  requestOriginForHost,
  sanitizeHeaders,
} from "./request-boundary.mjs";
import { createFilesystemAssets } from "./assets.mjs";
import { nodeTimingSafeEqual } from "./node-crypto-adapter.mjs";

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
  ledger: [{ version: 1, name: "0001_schema_metadata.sql", sha256: "b".repeat(64) }],
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

function receiptPool({ major = 17, primaryExists = true, ledgerExists = true,
  primaryHistory, ledgerHistory, onConnect = () => {} } = {}) {
  const expectedFor = (role) => role === "primary" ? primaryHistory : ledgerHistory;
  const existsFor = (role) => role === "primary" ? primaryExists : ledgerExists;
  return function createPool(role) {
    return {
      async connect() {
        onConnect(role);
        return {
          async query(sql) {
            if (sql.startsWith("SELECT current_setting")) {
              return { rows: [{ server_version_num: major * 10_000, schema_exists: existsFor(role) }] };
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

test("cloud-run-iam host predicate accepts only the named service tuple and pinned origin", () => {
  const valid = {
    mode: "cloud-run-iam",
    project: CLOUD_RUN_IAM_TEST_TARGET.project,
    region: CLOUD_RUN_IAM_TEST_TARGET.region,
    service: CLOUD_RUN_IAM_TEST_TARGET.service,
    listenHost: CLOUD_RUN_IAM_TEST_TARGET.listenHost,
    hostOrigin: CLOUD_RUN_IAM_TEST_TARGET.origin,
    port: CLOUD_RUN_IAM_TEST_TARGET.port,
  };
  assert.equal(isPrivatePostgresTestHost(valid), true);
  for (const override of [
    { mode: "health-only" },
    { project: "other-project" },
    { region: "us-west1" },
    { service: "other-service" },
    { listenHost: "127.0.0.1" },
    { listenHost: "::1" },
    { port: 8081 },
    { hostOrigin: "https://tibotattle-test-app-806510610397.us-east1.run.app" },
    { hostOrigin: "https://other-service-5t5mehqi7a-ue.a.run.app" },
    { hostOrigin: "https://service.invalid" },
  ]) {
    assert.equal(isPrivatePostgresTestHost({ ...valid, ...override }), false);
  }
  assert.equal(isPrivatePostgresTestHost({
    ...valid,
    mode: undefined,
  }), false);
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
  const dispatch = createPostgresTestHealthDispatch({
    primaryPool: pools("primary"),
    ledgerPool: pools("ledger"),
    expectedMigrations: ONE_MIGRATION,
    privateOrigin: CLOUD_RUN_IAM_TEST_TARGET.origin,
  });
  for (const request of [
    new Request("https://other-service-5t5mehqi7a-ue.a.run.app/api/health"),
    new Request("https://tibotattle-test-app-806510610397.us-east1.run.app/api/health"),
    new Request(`${CLOUD_RUN_IAM_TEST_TARGET.origin}/api/not-implemented`),
    new Request(`${CLOUD_RUN_IAM_TEST_TARGET.origin}/api/health`, { method: "POST" }),
  ]) {
    assert.equal((await dispatch(request)).status, 503);
  }
  assert.equal(connections, 0, "wrong origins and unimplemented direct requests cannot touch PostgreSQL");

  assert.throws(() => createPostgresTestHealthDispatch({
    primaryPool: pools("primary"),
    ledgerPool: pools("ledger"),
    expectedMigrations: ONE_MIGRATION,
    privateOrigin: "https://other-service-5t5mehqi7a-ue.a.run.app",
  }), /POSTGRES_TEST_PRIVATE_ORIGIN_INVALID/);
});

test("partial HTTP dispatch serves only current read-only health and never calls the Worker or D1", async () => {
  let connections = 0;
  let d1Touched = 0;
  let workerHandlerCalls = 0;
  const pools = receiptPool({ onConnect: () => { connections += 1; } });
  const healthDispatch = createPostgresTestHealthDispatch({
    primaryPool: pools("primary"),
    ledgerPool: pools("ledger"),
    schemaOptions: { primarySchema: "tibotattle_test", ledgerSchema: "tibotattle_ledger_test" },
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
    schemaVersion: "gcp-postgres-test-health-v1",
    scope: "postgres_schema_and_migrations_only",
    status: "ready",
    workerApplicationReady: false,
    checks: {
      postgresMajor: 17,
      primaryMigrationReceipt: { status: "current", version: 1 },
      ledgerMigrationReceipt: { status: "current", version: 1 },
    },
  });
  assert.equal(JSON.stringify(health).includes("tibotattle_test"), false);
  assert.equal(connections, 2);
  assert.equal(workerHandlerCalls, 0);
  assert.equal(d1Touched, 0);
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
    ledgerPool: { async connect() { postgresConnections += 1; throw new Error("must not connect"); } },
    expectedMigrations: ONE_MIGRATION,
    privateOrigin: "http://127.0.0.1:8080",
    healthDispatch: async () => new Response(null, { status: 503 }),
    admissionEnv: {},
    assertAdmissionBindings() {},
    assertAttemptAllowed: async () => {},
    assertUploadAuthorizationBindings() {},
    assertUploadAuthorizationAllowed: async () => {},
    authenticatePostgresDevice: async () => { throw new Error("must not authenticate"); },
    hasPostgresDeletionTombstone: async () => { throw new Error("must not read ledger"); },
    readPostgresDeviceSyncState: async () => ({}),
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
  assert.equal(postgresConnections, 0);
  assert.equal(projectionCalls, 1);
  assert.equal(workerCalls, 0);
});

test("partial HTTP health fails closed when either database or receipt is unavailable or stale", async () => {
  const currentHistory = ONE_MIGRATION.primary;
  const staleHistory = [{ ...currentHistory[0], sha256: "c".repeat(64) }];
  const pools = receiptPool({ primaryHistory: currentHistory, ledgerHistory: staleHistory });
  const dispatch = createPostgresTestHealthDispatch({
    primaryPool: pools("primary"),
    ledgerPool: pools("ledger"),
    schemaOptions: { primarySchema: "health_primary", ledgerSchema: "health_ledger" },
    expectedMigrations: ONE_MIGRATION,
    privateOrigin: "http://127.0.0.1:8080",
  });
  const stale = await dispatch(new Request("http://127.0.0.1:8080/api/health"));
  assert.equal(stale.status, 503);
  assert.deepEqual((await stale.json()).checks, {
    postgresMajor: 17,
    primaryMigrationReceipt: { status: "current", version: 1 },
    ledgerMigrationReceipt: { status: "receipt_mismatch", version: 1 },
  });

  const missingPools = receiptPool({ primaryExists: false });
  const missing = createPostgresTestHealthDispatch({
    primaryPool: missingPools("primary"),
    ledgerPool: missingPools("ledger"),
    schemaOptions: { primarySchema: "health_primary", ledgerSchema: "health_ledger" },
    expectedMigrations: ONE_MIGRATION,
    privateOrigin: "http://127.0.0.1:8080",
  });
  const missingResponse = await missing(new Request("http://127.0.0.1:8080/api/health"));
  assert.equal(missingResponse.status, 503);
  assert.equal((await missingResponse.json()).checks.primaryMigrationReceipt.status, "schema_missing");
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
      "ADMIN_HOST_ORIGIN", "PORT", "K_SERVICE", "PRIMARY_DATABASE", "LEDGER_DATABASE",
      "PRIMARY_INSTANCE_CONNECTION_NAME", "LEDGER_INSTANCE_CONNECTION_NAME", "POSTGRES_IAM_USER"]) {
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

    const cloudRunEnv = {
      ...baseEnv,
      POSTGRES_TEST_HTTP_MODE: "cloud-run-iam",
      HOST: CLOUD_RUN_IAM_TEST_TARGET.listenHost,
      PORT: String(CLOUD_RUN_IAM_TEST_TARGET.port),
      HOST_ORIGIN: CLOUD_RUN_IAM_TEST_TARGET.origin,
      K_SERVICE: CLOUD_RUN_IAM_TEST_TARGET.service,
    };
    for (const override of [
      { K_SERVICE: undefined },
      { HOST: "127.0.0.1" },
      { HOST: "0.0.0.0", PORT: "8081" },
      { K_SERVICE: "other-service" },
      { HOST_ORIGIN: "https://service.invalid" },
      { HOST_ORIGIN: "https://other-service-5t5mehqi7a-ue.a.run.app" },
      { HOST_ORIGIN: "https://tibotattle-test-app-806510610397.us-east1.run.app" },
      { PUBLIC_ORIGIN: "https://tibotattle.example" },
      { ADMIN_HOST_ORIGIN: "https://admin.tibotattle.example" },
    ]) {
      const environment = { ...cloudRunEnv, ...override };
      if (Object.hasOwn(override, "K_SERVICE") && override.K_SERVICE === undefined) {
        delete environment.K_SERVICE;
      }
      const invalid = spawnSync(process.execPath, [bundlePath], {
        cwd: ROOT,
        env: environment,
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(invalid.status, 1);
      assert.deepEqual(JSON.parse(invalid.stderr.trim()), {
        status: "error",
        code: "POSTGRES_TEST_CLOUD_RUN_IAM_CONFIGURATION_INVALID",
      });
    }

    const configured = spawnSync(process.execPath, [bundlePath], {
      cwd: ROOT,
      env: cloudRunEnv,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(configured.status, 1);
    assert.deepEqual(JSON.parse(configured.stderr.trim()), {
      status: "error",
      code: "PRIMARY_DATABASE_MISSING",
    }, "a fully qualified IAM host passes host checks before database startup");

    const proof = (bucket) => JSON.stringify({
      bucket,
      bucketGeneration: "1",
      bucketMetageneration: "1",
      softDeleteRetentionDurationSeconds: "0",
    });
    const resourceEnv = {
      POSTGRES_TEST_HTTP_MODE: "cloud-run-iam",
      HOST: CLOUD_RUN_IAM_TEST_TARGET.listenHost,
      PORT: String(CLOUD_RUN_IAM_TEST_TARGET.port),
      HOST_ORIGIN: CLOUD_RUN_IAM_TEST_TARGET.origin,
      K_SERVICE: CLOUD_RUN_IAM_TEST_TARGET.service,
      PRIMARY_DATABASE: CLOUD_RUN_IAM_TEST_TARGET.postgres.primary.database,
      PRIMARY_SCHEMA: CLOUD_RUN_IAM_TEST_TARGET.postgres.primary.schema,
      PRIMARY_INSTANCE_CONNECTION_NAME:
        CLOUD_RUN_IAM_TEST_TARGET.postgres.primary.instanceConnectionName,
      LEDGER_DATABASE: CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger.database,
      LEDGER_SCHEMA: CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger.schema,
      LEDGER_INSTANCE_CONNECTION_NAME:
        CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger.instanceConnectionName,
      POSTGRES_IAM_USER: CLOUD_RUN_IAM_TEST_TARGET.postgres.iamUser,
      GCS_BUCKET_NAME: CLOUD_RUN_IAM_TEST_TARGET.gcsBucket,
      GCS_ERASURE_BUCKET_HISTORY_PROOF: proof(CLOUD_RUN_IAM_TEST_TARGET.gcsBucket),
    };
    const targetOverrides = [
      [{ PRIMARY_INSTANCE_CONNECTION_NAME: "other-project:us-east1:other-primary" },
        "POSTGRES_TEST_CLOUD_RUN_IAM_PRIMARY_TARGET_INVALID"],
      [{ PRIMARY_DATABASE: "other_primary" },
        "POSTGRES_TEST_CLOUD_RUN_IAM_PRIMARY_TARGET_INVALID"],
      [{ PRIMARY_SCHEMA: "other_primary" },
        "POSTGRES_TEST_CLOUD_RUN_IAM_PRIMARY_TARGET_INVALID"],
      [{ LEDGER_INSTANCE_CONNECTION_NAME: "other-project:us-east1:other-ledger" },
        "POSTGRES_TEST_CLOUD_RUN_IAM_LEDGER_TARGET_INVALID"],
      [{ LEDGER_DATABASE: "other_ledger" },
        "POSTGRES_TEST_CLOUD_RUN_IAM_LEDGER_TARGET_INVALID"],
      [{ LEDGER_SCHEMA: "other_ledger" },
        "POSTGRES_TEST_CLOUD_RUN_IAM_LEDGER_TARGET_INVALID"],
      [{ POSTGRES_IAM_USER: "other-runtime@tibotattle.iam" },
        "POSTGRES_TEST_CLOUD_RUN_IAM_USER_INVALID"],
      [{ GCS_BUCKET_NAME: "another-test-bucket" },
        "POSTGRES_TEST_CLOUD_RUN_IAM_BUCKET_INVALID"],
      [{ GCS_ERASURE_BUCKET_HISTORY_PROOF: proof("another-test-bucket") },
        "POSTGRES_TEST_CLOUD_RUN_IAM_BUCKET_HISTORY_PROOF_INVALID"],
    ];
    const environmentNames = new Set([
      ...Object.keys(resourceEnv),
      "POSTGRES_TEST_HTTP_MODE", "HOST", "PORT", "HOST_ORIGIN", "K_SERVICE",
      "PUBLIC_ORIGIN", "ADMIN_HOST_ORIGIN", "PRIMARY_DATABASE", "PRIMARY_SCHEMA",
      "PRIMARY_INSTANCE_CONNECTION_NAME", "LEDGER_DATABASE", "LEDGER_SCHEMA",
      "LEDGER_INSTANCE_CONNECTION_NAME", "POSTGRES_IAM_USER", "GCS_BUCKET_NAME",
      "GCS_ERASURE_BUCKET_HISTORY_PROOF",
    ]);
    const originalEnvironment = new Map([...environmentNames].map((name) => [name, process.env[name]]));
    try {
      for (const [overrides, expectedCode] of targetOverrides) {
        for (const name of environmentNames) delete process.env[name];
        Object.assign(process.env, resourceEnv, overrides);
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
        );
        assert.deepEqual(constructionCalls, [], `${expectedCode} must fail before DB/GCS construction`);
      }
    } finally {
      for (const [name, value] of originalEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("private health dispatch validates current primary and independent ledger PostgreSQL 17 receipts", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 90_000,
}, async () => {
  const endpoint = await localPostgresEndpoint();
  const suffix = randomBytes(6).toString("hex");
  const primarySchema = `host_health_${suffix}`;
  const ledgerSchema = `host_health_${suffix}_ledger`;
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
  const ledgerPool = new pg.Pool({
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 2,
    connectionTimeoutMillis: 3_000,
  });
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
    await primaryPool.query(`CREATE SCHEMA "${ledgerSchema}"`);
    createdSchemas.push(ledgerSchema);
    await Promise.all([
      applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: primaryPool }),
      applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool: ledgerPool }),
    ]);

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
    const { POSTGRES_RUNTIME_MIGRATIONS } = await import(pathToFileURL(manifestPath).href);

    const dispatch = createPostgresTestHealthDispatch({
      primaryPool,
      ledgerPool,
      schemaOptions: { primarySchema, ledgerSchema },
      expectedMigrations: POSTGRES_RUNTIME_MIGRATIONS,
      privateOrigin: "http://127.0.0.1:43817",
    });
    const response = await dispatch(new Request("http://127.0.0.1:43817/api/health"));
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.deepEqual(health, {
      schemaVersion: "gcp-postgres-test-health-v1",
      scope: "postgres_schema_and_migrations_only",
      status: "ready",
      workerApplicationReady: false,
      checks: {
        postgresMajor: 17,
        primaryMigrationReceipt: {
          status: "current",
          version: POSTGRES_RUNTIME_MIGRATIONS.primary.length,
        },
        ledgerMigrationReceipt: {
          status: "current",
          version: POSTGRES_RUNTIME_MIGRATIONS.ledger.length,
        },
      },
    });
    const [primaryBackend, ledgerBackend] = await Promise.all([
      primaryPool.query("SELECT pg_backend_pid() AS id"),
      ledgerPool.query("SELECT pg_backend_pid() AS id"),
    ]);
    assert.notEqual(primaryBackend.rows[0].id, ledgerBackend.rows[0].id,
      "the primary and ledger health checks must use independent pools/connections");
    assert.equal(JSON.stringify(health).includes(primarySchema), false);
    assert.equal(JSON.stringify(health).includes(ledgerSchema), false);
    assert.equal(Object.hasOwn(health.checks, "database"), false);
  } finally {
    for (const schema of createdSchemas.reverse()) {
      try { await primaryPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch {}
    }
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await Promise.all([primaryPool.end(), ledgerPool.end()]);
  }
});

test("loopback v1.2 manifest dispatch uses real PostgreSQL authority and never reaches D1", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  const endpoint = await localPostgresEndpoint();
  const suffix = randomBytes(6).toString("hex");
  const primarySchema = `host_v12_${suffix}`;
  const ledgerSchema = `host_v12_${suffix}_ledger`;
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
  const ledgerPool = new pg.Pool({
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 2,
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
    await primaryPool.query(`CREATE SCHEMA "${ledgerSchema}"`);
    createdSchemas.push(ledgerSchema);
    await Promise.all([
      applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: primaryPool }),
      applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool: ledgerPool }),
    ]);

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
    const [transport, v12Admission, ledgerAuthority, admission, rateLimit, bodyReader, constants,
      cryptoModule, telemetryV12Repository, deviceSync, typedCodec, typedV12EffectiveReader,
      accountlessAdapter, accountlessEnrollment, accountlessOwnership, transportPolicy]
      = await Promise.all([
        vite.ssrLoadModule("/src/postgres-typed-v12-transport.ts"),
        vite.ssrLoadModule("/src/postgres-typed-v12-admission.ts"),
        vite.ssrLoadModule("/src/postgres-ledger-authority.ts"),
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
        vite.ssrLoadModule("/src/accountless-enrollment.ts"),
        vite.ssrLoadModule("/src/accountless-ownership.ts"),
        vite.ssrLoadModule("/src/telemetry-transport-policy.ts"),
      ]);
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
    const schemaOptions = { primarySchema, ledgerSchema };
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
    await primaryPool.query(
      `INSERT INTO ${primaryTable("attribution_enrollments")} (participant_id, namespace, created_at)
       VALUES ($1, $2, $3)`,
      [participantId, sha256Hex(`synthetic-enrollment:${suffix}`), nowIso],
    );
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

    const admissionEnv = {
      ENVIRONMENT: "test",
      ACCOUNTLESS_ENROLLMENT_MODE: "enabled",
      ACCOUNTLESS_OWNERSHIP_MODE: "enabled",
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
    ]) {
      admissionEnv[binding] = rateLimit.createPostgresRateLimiter(primaryPool, {
        primarySchema,
        ledgerSchema,
        name,
        limit,
        periodSeconds: 60,
        keyHashSecret: randomBytes(32),
      });
    }
    const recoveryBoundary = rateLimit.createPostgresRateLimiter(primaryPool, {
      primarySchema,
      ledgerSchema,
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
      ledgerPool,
      schemaOptions,
      expectedMigrations: POSTGRES_RUNTIME_MIGRATIONS,
      privateOrigin: "http://127.0.0.1:43817",
    });
    let deviceSyncRateLimitCalls = 0;
    const manifestDispatchOptions = {
      primaryPool,
      ledgerPool,
      schemaOptions,
      expectedMigrations: POSTGRES_RUNTIME_MIGRATIONS,
      privateOrigin: "http://127.0.0.1:43817",
      healthDispatch,
      accountlessAuthority: Object.freeze({
        authenticateV12Grant: accountlessAdapter.authenticatePostgresAccountlessOwnerForV12Grant,
        enroll: accountlessAdapter.enrollPostgresAccountlessDevice,
        createOwner: accountlessAdapter.createPostgresAccountlessUploadOwner,
        grantV12: accountlessAdapter.grantPostgresTelemetryV12AccountlessAuthorization,
        parseEnrollmentJson: accountlessEnrollment.parseAccountlessEnrollmentJson,
        parseOwnershipJson: accountlessOwnership.parseAccountlessOwnershipJson,
        parseV12AuthorizationJson: transportPolicy.parseTelemetryV12AccountlessAuthorizationJson,
        maxEnrollmentBytes: accountlessEnrollment.ACCOUNTLESS_ENROLLMENT_MAX_REQUEST_BYTES,
        maxOwnershipBytes: accountlessOwnership.ACCOUNTLESS_UPLOAD_OWNER_MAX_REQUEST_BYTES,
      }),
      admissionEnv: Object.freeze(admissionEnv),
      assertAdmissionBindings: admission.assertAdmissionBindings,
      assertAttemptAllowed: (...args) => {
        if (args[4] === "device_sync") deviceSyncRateLimitCalls += 1;
        return admission.assertAttemptAllowed(...args);
      },
      assertUploadAuthorizationBindings: admission.assertUploadAuthorizationBindings,
      assertUploadAuthorizationAllowed: admission.assertUploadAuthorizationAllowed,
      authenticatePostgresDevice: transport.authenticatePostgresDevice,
      hasPostgresDeletionTombstone: ledgerAuthority.hasPostgresDeletionTombstone,
      readPostgresDeviceSyncState: deviceSync.readPostgresDeviceSyncState,
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
      throw new Error(`POSTGRES_TEST_HEALTH_NOT_READY:${status?.checks?.primaryMigrationReceipt?.status ?? "unknown"}:${status?.checks?.ledgerMigrationReceipt?.status ?? "unknown"}`);
    }
    assert.equal((await health.json()).workerApplicationReady, false);

    const syncStateUrl = "http://127.0.0.1:43817/api/v1/device/sync/state";
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
    const capabilitiesResponse = await dispatch(request({ url: syncCapabilitiesV12Url, method: "GET" }));
    assert.equal(capabilitiesResponse.status, 200);
    const capabilities = await capabilitiesResponse.json();
    assert.deepEqual(capabilities, {
      schemaVersion: "device-sync-capabilities-v1.2",
      destinationOrigin: "http://127.0.0.1:43817",
      enrollmentNamespace: sha256Hex(`synthetic-enrollment:${suffix}`),
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
    const wrongPredecessorMethod = await dispatch(request({
      url: domainPredecessorUrl, method: "GET",
    }));
    await assertApiError(wrongPredecessorMethod, 405, "METHOD_NOT_ALLOWED");
    assert.equal(wrongPredecessorMethod.headers.get("allow"), "POST");
    await assertApiError(await dispatch(request({
      url: syncStateUrl, method: "GET", headers: { cookie: "session=not-used" },
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
    await assertApiError(await dispatch(request({ url: chunkUploadUrl, body: " ".repeat(constants.MAX_REQUEST_BYTES + 1) })), 413, "BODY_TOO_LARGE");
    await assertApiError(await dispatch(request({ url: chunkUploadUrl, headers: { cookie: "session=not-used" } })), 401, "DEVICE_AUTH_INVALID");
    await assertApiError(await dispatch(request({ body: "{}" })), 400, "TELEMETRY_MANIFEST_INVALID");
    await assertApiError(await dispatch(request({
      url: domainPredecessorUrl, body: "{}",
    })), 409, "TELEMETRY_MANIFEST_INCOMPLETE");

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
    const consumedPredecessor = await primaryPool.query(
      `SELECT token_hash, consumed_at FROM ${primaryTable("telemetry_v12_domain_predecessors")}
        WHERE participant_id=$1 AND device_id=$2`,
      [participantId, deviceId],
    );
    assert.equal(consumedPredecessor.rowCount, 1);
    assert.equal(consumedPredecessor.rows[0].token_hash, sha256Hex(predecessor.token));
    assert.ok(consumedPredecessor.rows[0].consumed_at);

    await ledgerAuthority.recordPostgresDeletionTombstone(
      ledgerPool, participantId, Date.now(), { schema: schemaOptions },
    );
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
    // Exercise accountless enrollment and separate v1.2 authority through
    // private HTTP dispatch. All durable writes go through PostgreSQL.
    const accountlessEnrollmentUrl = "http://127.0.0.1:43817/api/v1/accountless/enrollment";
    const accountlessOwnershipUrl = "http://127.0.0.1:43817/api/v1/accountless/ownership";
    const accountlessV12AuthorizationUrl =
      "http://127.0.0.1:43817/api/v1/accountless/telemetry-v1.2-authorization";
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

    await assertApiError(await dispatch(enrollmentHttp(undefined, {}, "GET")), 405, "METHOD_NOT_ALLOWED");
    await assertApiError(await dispatch(enrollmentHttp(accountlessEnrollmentJson, {
      cookie: "session=synthetic",
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
    const concurrentV12Grants = await Promise.all([
      dispatch(authorizationHttp(JSON.stringify(accountlessV12Body))),
      dispatch(authorizationHttp(JSON.stringify(accountlessV12Body))),
    ]);
    assert.deepEqual(concurrentV12Grants.map((response) => response.status), [201, 201],
      `concurrent v1.2 grants must replay one stable active grant; received ${JSON.stringify(
        await Promise.all(concurrentV12Grants.map(async (response) => ({
          status: response.status, body: await response.clone().json(),
        }))),
      )}`);
    const grantReceipts = await Promise.all(concurrentV12Grants.map((response) => response.json()));
    assert.deepEqual(grantReceipts, [accountlessV12Body, accountlessV12Body],
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

    const tombstonedDeviceId = randomUUID();
    const tombstonedSecret = randomBytes(32).toString("base64url");
    const tombstonedAuth = `Device um_device_${tombstonedDeviceId}.${tombstonedSecret}`;
    const tombstonedEnrollmentBody = {
      ...accountlessEnrollmentBody,
      deviceId: tombstonedDeviceId,
      deviceSecretHash: deviceSecretHash(tombstonedDeviceId, tombstonedSecret).toString("hex"),
    };
    assert.equal((await dispatch(enrollmentHttp(JSON.stringify(tombstonedEnrollmentBody)))).status, 201);
    assert.equal((await dispatch(ownershipHttp(JSON.stringify(ownershipBody), {
      authorization: tombstonedAuth,
    }))).status, 201);
    const tombstonedOwner = await primaryPool.query(
      "SELECT participant_id FROM " + primaryTable("accountless_upload_owners")
        + " WHERE enrollment_device_id=$1",
      [tombstonedDeviceId],
    );
    assert.equal(tombstonedOwner.rowCount, 1);
    await ledgerAuthority.recordPostgresDeletionTombstone(
      ledgerPool, tombstonedOwner.rows[0].participant_id, Date.now(), { schema: schemaOptions },
    );
    await assertApiError(await dispatch(authorizationHttp(
      JSON.stringify(accountlessV12Body), {}, tombstonedAuth,
    )), 401, "DEVICE_AUTH_INVALID");
    const tombstonedGrant = await primaryPool.query(
      "SELECT count(*)::integer AS count FROM "
        + primaryTable("accountless_v12_device_authorizations") + " WHERE enrollment_device_id=$1",
      [tombstonedDeviceId],
    );
    assert.equal(tombstonedGrant.rows[0].count, 0,
      "a separately tombstoned owner cannot acquire a v1.2 grant");

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

    // Simulate the persisted result of an opt-out. The Cloud Run test host
    // does not expose disconnect until PostgreSQL v1.1 history-retention
    // semantics are implemented. All later authority requests must fail closed.
    const optedOutAt = new Date().toISOString();
    await primaryPool.query("BEGIN");
    try {
      const revocableTables = [
        ["accountless_enrollment_ledger", "device_id"],
        ["accountless_upload_owners", "enrollment_device_id"],
        ["accountless_v11_device_authorizations", "enrollment_device_id"],
        ["accountless_v12_device_authorizations", "enrollment_device_id"],
      ];
      for (const [name, idColumn] of revocableTables) {
        await primaryPool.query(
          "UPDATE " + primaryTable(name)
            + " SET state='revoked', revoked_at=$2::timestamptz, revocation_reason='user_opt_out' "
            + "WHERE " + idColumn + "=$1",
          [accountlessDeviceId, optedOutAt],
        );
      }
      await primaryPool.query(
        "UPDATE " + primaryTable("device_credentials")
          + " SET state='revoked', revoked_at=$2::timestamptz WHERE id=$1",
        [accountlessDeviceId, optedOutAt],
      );
      await primaryPool.query(
        "UPDATE " + primaryTable("device_upload_authorizations")
          + " SET state='revoked', revoked_at=$2::timestamptz, consume_lease_expires_at=NULL "
          + "WHERE issued_by_device_id=$1 AND state IN ('unused','consuming')",
        [accountlessDeviceId, optedOutAt],
      );
      await primaryPool.query("COMMIT");
    } catch (error) {
      await primaryPool.query("ROLLBACK");
      throw error;
    }
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
    await ledgerPool.end();
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
