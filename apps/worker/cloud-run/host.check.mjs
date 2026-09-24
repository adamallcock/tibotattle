import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import pg from "pg";
import {
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
  telemetryV12DayManifestDigestInput,
  telemetryV12RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import {
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

test("default host startup remains blocked and health-test mode rejects a public bind", async () => {
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
    const baseEnv = { ...process.env };
    for (const name of ["POSTGRES_TEST_HTTP_MODE", "HOST", "HOST_ORIGIN", "PUBLIC_ORIGIN",
      "ADMIN_HOST_ORIGIN", "PORT", "PRIMARY_DATABASE", "LEDGER_DATABASE",
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
    const [transport, v12Admission, ledgerAuthority, admission, rateLimit, bodyReader, constants]
      = await Promise.all([
        vite.ssrLoadModule("/src/postgres-typed-v12-transport.ts"),
        vite.ssrLoadModule("/src/postgres-typed-v12-admission.ts"),
        vite.ssrLoadModule("/src/postgres-ledger-authority.ts"),
        vite.ssrLoadModule("/src/admission.ts"),
        vite.ssrLoadModule("/src/postgres-rate-limiter.ts"),
        vite.ssrLoadModule("/src/bounded-body.ts"),
        vite.ssrLoadModule("/src/constants.ts"),
      ]);

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
    const auth = `Device um_device_${deviceId}.${deviceSecret}`;

    await primaryPool.query(
      `INSERT INTO ${primaryTable("participants")} (
         id, owner_kind, state, consent_version, created_at
       ) VALUES ($1, 'social', 'active', $2, $3)`,
      [participantId, constants.TELEMETRY_CONSENT_VERSION, nowIso],
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

    const admissionEnv = { ENVIRONMENT: "test" };
    for (const [binding, name, limit] of [
      ["ENROLLMENT_RATE_LIMIT", "ENROLLMENT", 20],
      ["RECOVERY_RATE_LIMIT", "RECOVERY", 20],
      ["CLIENT_ATTEMPT_RATE_LIMIT", "CLIENT_ATTEMPT", 1_000],
      ["PUBLIC_READ_RATE_LIMIT", "PUBLIC_READ", 1_000],
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
    const healthDispatch = createPostgresTestHealthDispatch({
      primaryPool,
      ledgerPool,
      schemaOptions,
      expectedMigrations: POSTGRES_RUNTIME_MIGRATIONS,
      privateOrigin: "http://127.0.0.1:43817",
    });
    const manifestDispatch = createPostgresTestV12DayManifestDispatch({
      primaryPool,
      ledgerPool,
      schemaOptions,
      expectedMigrations: POSTGRES_RUNTIME_MIGRATIONS,
      privateOrigin: "http://127.0.0.1:43817",
      healthDispatch,
      admissionEnv: Object.freeze(admissionEnv),
      assertAdmissionBindings: admission.assertAdmissionBindings,
      assertAttemptAllowed: admission.assertAttemptAllowed,
      authenticatePostgresDevice: transport.authenticatePostgresDevice,
      hasPostgresDeletionTombstone: ledgerAuthority.hasPostgresDeletionTombstone,
      registerPostgresTypedV12DayManifest: v12Admission.registerPostgresTypedV12DayManifest,
      readBoundedRequestBody: bodyReader.readBoundedRequestBody,
      maxRequestBytes: constants.MAX_REQUEST_BYTES,
    });
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
    const request = ({ body = "{}", headers = {}, method = "POST", url = manifestUrl } = {}) => new Request(url, {
      method,
      headers: { authorization: auth, "content-type": "application/json", ...headers },
      ...(method === "GET" || method === "HEAD" ? {} : { body }),
    });

    for (const unsupported of [
      request({ url: "http://127.0.0.2:43817/api/health", method: "GET" }),
      request({ url: "http://127.0.0.1:43817/api/v1/contribute" }),
      request({ method: "GET" }),
    ]) {
      const response = await dispatch(unsupported);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, "POSTGRES_TEST_ROUTE_UNSUPPORTED");
    }
    const health = await dispatch(request({ url: "http://127.0.0.1:43817/api/health", method: "GET" }));
    assert.equal(health.status, 200);
    assert.equal((await health.json()).workerApplicationReady, false);

    await assertApiError(await dispatch(request({ headers: { cookie: "session=not-used" } })), 401, "DEVICE_AUTH_INVALID");
    await assertApiError(await dispatch(request({ headers: {
      authorization: `Device um_device_${deviceId}.${randomBytes(32).toString("base64url")}`,
    } })), 401, "DEVICE_AUTH_INVALID");
    await assertApiError(await dispatch(request({ headers: { "content-type": "text/plain" } })), 415, "CONTENT_TYPE_INVALID");
    await assertApiError(await dispatch(request({ body: " ".repeat(constants.MAX_REQUEST_BYTES + 1) })), 413, "BODY_TOO_LARGE");
    await assertApiError(await dispatch(request({ body: "{}" })), 400, "TELEMETRY_MANIFEST_INVALID");

    await primaryPool.query(
      `UPDATE ${primaryTable("collection_controls")}
          SET revision=3, control_state='degraded', processing_enabled=false, updated_at=$1
        WHERE singleton=1`,
      [new Date().toISOString()],
    );
    await assertApiError(await dispatch(request()), 503, "PROCESSING_DISABLED");
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

    await ledgerAuthority.recordPostgresDeletionTombstone(
      ledgerPool, participantId, Date.now(), { schema: schemaOptions },
    );
    await assertApiError(await dispatch(request({ body: JSON.stringify(manifest) })), 401, "DEVICE_AUTH_INVALID");
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
