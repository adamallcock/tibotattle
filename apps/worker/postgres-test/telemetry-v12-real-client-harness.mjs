import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createServer } from "vite";
import {
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
  telemetryV12DayManifestDigestInput,
  telemetryV11RequiredConsent,
  telemetryV12RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";
import { applyPostgresMigrations, renderPostgresSearchPath } from "../scripts/postgres-migrations.mjs";
import {
  createPostgresTestHealthDispatch,
  createPostgresTestV12DayManifestDispatch,
  dispatchCloudRunHostRequest,
} from "../cloud-run/postgres-test-dispatch.mjs";
import {
  readTelemetryV12Capabilities,
  runTelemetryV12Sync,
} from "../../../src/contribution/telemetry-v12-sync.js";
import { createTelemetryV12Day } from "../../../src/contribution/telemetry-v12-chunks.js";
import { createTelemetryV12Envelope } from "../../../src/platform/telemetry-v12-envelope.js";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT || "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD;
const OWNER_BRIDGE_MIGRATION = "0055_v12_owner_bridge.sql";
const OWNER_BRIDGE_MIGRATION_VERSION = 55;
// Exact reviewed staged file from OJ-2 follow-up 9735e759. If the SQL changes,
// update this only after reviewing the new migration identity and behavior.
const OWNER_BRIDGE_MIGRATION_SHA256 = "bd6027ef988dea6c9a34a9c8fb494c33bc8d820bdd77c5e165ada3bcdd627681";

function q(schema, name) {
  return '"' + schema + '"."' + name + '"';
}

function secretHash(deviceId, secret) {
  return createHash("sha256")
    .update("app-usagemonitor/device/v1\0" + deviceId + "\0")
    .update(Buffer.from(secret, "base64url"))
    .digest();
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function emptyDayManifest(day, parserVersion) {
  const manifest = {
    schemaVersion: "telemetry-day-manifest-v1.2",
    day,
    parserVersion,
    consent: telemetryV12RequiredConsent(),
    chunks: [],
    excluded: { quota: 0, session: 0, usage: 0 },
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = digest(telemetryV12DayManifestDigestInput(manifest));
  return manifest;
}

async function readOwnerBridgeMigration() {
  const paths = [
    resolve(WORKER_ROOT, "postgres/staged-migrations/primary", OWNER_BRIDGE_MIGRATION),
    resolve(WORKER_ROOT, "postgres/migrations/primary", OWNER_BRIDGE_MIGRATION),
  ];
  const found = [];
  for (const path of paths) {
    try {
      found.push({ path, sql: await readFile(path, "utf8") });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  assert.equal(found.length, 1, "the v1.2 owner bridge is exactly once staged or promoted");
  const item = found[0];
  const sha256 = createHash("sha256").update(item.sql).digest("hex");
  assert.equal(sha256, OWNER_BRIDGE_MIGRATION_SHA256,
    "only the reviewed OJ-2 staged/promoted migration may enter this harness");
  return { ...item, sha256, staged: item.path.includes("/staged-migrations/") };
}

async function applyOwnerBridgeMigration(poolRef, schema, expectedMigrations) {
  const migration = await readOwnerBridgeMigration();
  const expected = expectedMigrations.primary.filter((item) => item.name === OWNER_BRIDGE_MIGRATION);
  if (expected.length === 1) {
    assert.equal(expected[0].version, OWNER_BRIDGE_MIGRATION_VERSION);
    assert.equal(expected[0].sha256, migration.sha256,
      "the runtime receipt must name the exact reviewed owner bridge");
    return;
  }
  assert.equal(expected.length, 0, "the migration receipt must include the bridge once or omit it");
  assert.equal(migration.staged, true,
    "manual bridge application is limited to the exact reviewed staged migration");
  const client = await poolRef.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='30000ms'");
    await client.query("SET LOCAL lock_timeout='5000ms'");
    await client.query(renderPostgresSearchPath(schema));
    await client.query(migration.sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function localEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "v1.2 real-client qualification requires loopback or a private Unix socket");
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
  assert.ok(PG_TEST_HOST, "a local PostgreSQL endpoint is required; tests do not skip silently");
  return { host: PG_TEST_HOST, port: PG_TEST_PORT };
}

function pool(endpoint, max, applicationName) {
  return new pg.Pool({
    ...endpoint,
    user: PG_TEST_USER,
    password: PG_TEST_PASSWORD === undefined ? "synthetic-local-only" : PG_TEST_PASSWORD,
    database: PG_TEST_DATABASE,
    ssl: false,
    max,
    connectionTimeoutMillis: 5_000,
    application_name: applicationName,
  });
}

function usageRecord(day, label) {
  return {
    schemaVersion: "usage-event-v1.2",
    eventId: "event:v2:" + digest("v12-real-client:" + label + ":" + day),
    eventTime: day + "T12:00:00.000Z",
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

/**
 * Builds a private, disposable PG17 schema pair and a real Cloud Run v1.2
 * dispatch. The only remote-like boundary is an in-memory object store; no
 * Worker/D1 route is reachable. Every database row and telemetry event is
 * synthetic and content-free.
 */
export async function createTelemetryV12RealClientHarness({
  label = "journey",
  limits = {},
} = {}) {
  globalThis.crypto ||= webcrypto;
  const endpoint = await localEndpoint();
  const suffix = randomBytes(6).toString("hex");
  const primarySchema = "v12client_" + suffix;
  const ledgerSchema = "v12client_l_" + suffix;
  const schemaOptions = { primarySchema, ledgerSchema };
  const primaryPool = pool(endpoint, 4, "v12-real-client-primary");
  const ledgerPool = pool(endpoint, 3, "v12-real-client-ledger");
  const privateOrigin = "http://127.0.0.1:43817";
  let primaryCreated = false;
  let ledgerCreated = false;
  let vite = null;
  let closed = false;
  const storedObjects = new Map();
  const exchanges = [];
  const journal = { value: null };
  const queryCounters = { authenticationQueries: 0 };
  const authSql = /device_credentials|accountless_enrollment_ledger|accountless_upload_owners|accountless_v11_device_authorizations|accountless_v12_device_authorizations/iu;
  function observeSql(query) {
    const text = typeof query === "string" ? query : query && typeof query.text === "string" ? query.text : "";
    if (authSql.test(text)) queryCounters.authenticationQueries += 1;
  }
  const dispatchPrimaryPool = {
    async connect(...args) {
      const client = await primaryPool.connect(...args);
      return {
        query(query, ...queryArgs) {
          observeSql(query);
          return client.query(query, ...queryArgs);
        },
        release(...releaseArgs) { return client.release(...releaseArgs); },
      };
    },
    query(query, ...queryArgs) {
      observeSql(query);
      return primaryPool.query(query, ...queryArgs);
    },
  };

  async function cleanup() {
    if (closed) return;
    closed = true;
    if (vite) await vite.close();
    if (primaryCreated) {
      try { await primaryPool.query('DROP SCHEMA IF EXISTS "' + primarySchema + '" CASCADE'); } catch {}
    }
    if (ledgerCreated) {
      try { await ledgerPool.query('DROP SCHEMA IF EXISTS "' + ledgerSchema + '" CASCADE'); } catch {}
    }
    await Promise.all([primaryPool.end(), ledgerPool.end()]);
  }

  try {
    const version = await primaryPool.query(
      "SELECT current_setting('server_version_num')::integer AS version, inet_server_addr()::text AS address",
    );
    assert.equal(Math.floor(version.rows[0].version / 10_000), 17,
      "real-client qualification requires PostgreSQL 17");
    if (PG_TEST_SOCKET) assert.equal(version.rows[0].address, null,
      "the configured PG17 test endpoint must use its private Unix socket");
    await primaryPool.query('CREATE SCHEMA "' + primarySchema + '"');
    primaryCreated = true;
    await ledgerPool.query('CREATE SCHEMA "' + ledgerSchema + '"');
    ledgerCreated = true;
    await Promise.all([
      applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: primaryPool }),
      applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool: ledgerPool }),
    ]);

    vite = await createServer({
      root: WORKER_ROOT,
      configFile: false,
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "silent",
    });
    const names = [
      "postgres-typed-v12-transport",
      "postgres-device-disconnect",
      "postgres-typed-v12-admission",
      "postgres-ledger-authority",
      "admission",
      "postgres-rate-limiter",
      "bounded-body",
      "constants",
      "crypto",
      "telemetry-v12-repository",
      "postgres-device-sync",
      "typed-telemetry-codec",
      "postgres-typed-v12-effective-reader",
      "postgres-device-sync-reads",
      "postgres-device-sync-principal",
      "postgres-v12-manifest-candidates",
      "postgres-upload-authorization",
      "postgres-telemetry-format-authority",
      "postgres-typed-v12-domain",
    ];
    const modules = await Promise.all(names.map((name) => vite.ssrLoadModule("/src/" + name + ".ts")));
    const m = Object.fromEntries(names.map((name, index) => [name, modules[index]]));
    const runtimeSchema = await vite.ssrLoadModule("/src/postgres-runtime-schema.ts");
    const expectedMigrations = runtimeSchema.POSTGRES_RUNTIME_MIGRATIONS;
    await applyOwnerBridgeMigration(primaryPool, primarySchema, expectedMigrations);
    const schema = { primarySchema, ledgerSchema };
    const now = Date.now();
    const issuedAt = new Date(now - 60_000).toISOString();
    const expiresAt = new Date(now + 30 * 86_400_000).toISOString();
    const participantId = "participant:" + randomUUID();
    const deviceId = randomUUID();
    const deviceSecret = randomBytes(32).toString("base64url");
    const authorization = "Device um_device_" + deviceId + "." + deviceSecret;

    await primaryPool.query(
      "UPDATE " + q(primarySchema, "telemetry_v12_runtime")
        + " SET state='active', changed_at=$1::timestamptz WHERE id=1",
      [issuedAt],
    );
    await primaryPool.query(
      "UPDATE " + q(primarySchema, "telemetry_v12_typed_runtime")
        + " SET state='active', changed_at=$1::timestamptz WHERE id=1",
      [issuedAt],
    );
    await primaryPool.query(
      "UPDATE " + q(primarySchema, "collection_controls")
        + " SET revision=revision+1, control_state='degraded', enrollment_enabled=false,"
        + " upload_registration_enabled=true, processing_enabled=true, publication_enabled=true,"
        + " updated_at=$1::timestamptz WHERE singleton=1",
      [issuedAt],
    );
    await primaryPool.query(
      "INSERT INTO " + q(primarySchema, "storage_source_state")
        + " (singleton,source_id,authority_epoch) VALUES (1,$1,0)",
      ["synthetic-v12-real-client-" + suffix],
    );

    await primaryPool.query(
      "INSERT INTO " + q(primarySchema, "participants")
        + " (id,owner_kind,state,created_at) VALUES ($1,'accountless','active',$2::timestamptz)",
      [participantId, issuedAt],
    );
    await primaryPool.query(
      "INSERT INTO " + q(primarySchema, "attribution_enrollments")
        + " (participant_id,namespace,created_at) VALUES ($1,$2,$3::timestamptz)",
      [participantId, digest("synthetic-attribution:" + participantId), issuedAt],
    );
    await primaryPool.query(
      "INSERT INTO " + q(primarySchema, "accountless_enrollment_ledger")
        + " (device_id,device_secret_hash,installation_principal_id,schema_version,policy_version,"
        + " authorization_basis,state,issued_at,expires_at)"
        + " VALUES ($1,$2,$3,'accountless-enrollment-v0.1','accountless-opt-out-v1',"
        + " 'accountless-policy-v1','active',$4::timestamptz,$5::timestamptz)",
      [deviceId, secretHash(deviceId, deviceSecret), "synthetic-install-" + deviceId, issuedAt, expiresAt],
    );
    await primaryPool.query(
      "INSERT INTO " + q(primarySchema, "device_credentials")
        + " (id,participant_id,authority_kind,accountless_enrollment_device_id,secret_hash,state,"
        + " issued_at,expires_at,last_used_at,credential_generation)"
        + " VALUES ($1,$2,'accountless',$1,$3,'active',$4::timestamptz,$5::timestamptz,$4::timestamptz,1)",
      [deviceId, participantId, secretHash(deviceId, deviceSecret), issuedAt, expiresAt],
    );
    await primaryPool.query(
      "INSERT INTO " + q(primarySchema, "accountless_upload_owners")
        + " (enrollment_device_id,participant_id,device_credential_id,policy_version,authorization_basis,"
        + " authorized_at,expires_at,state)"
        + " VALUES ($1,$2,$1,'accountless-opt-out-v1','accountless-policy-v1',$3::timestamptz,$4::timestamptz,'active')",
      [deviceId, participantId, issuedAt, expiresAt],
    );
    const v11Consent = telemetryV11RequiredConsent();
    await primaryPool.query(
      "INSERT INTO " + q(primarySchema, "accountless_v11_device_authorizations")
        + " (enrollment_device_id,participant_id,device_credential_id,telemetry_schema_version,"
        + " field_dictionary_version,privacy_contract_version,authorized_at,expires_at,state)"
        + " VALUES ($1,$2,$1,'telemetry-contribution-v1.1',$3,$4,$5::timestamptz,$6::timestamptz,'active')",
      [deviceId, participantId, v11Consent.fieldDictionaryVersion, v11Consent.privacyContractVersion,
        issuedAt, expiresAt],
    );
    await primaryPool.query(
      "INSERT INTO " + q(primarySchema, "accountless_v12_device_authorizations")
        + " (enrollment_device_id,participant_id,device_credential_id,schema_version,policy_version,"
        + " authorization_basis,telemetry_schema_version,field_dictionary_version,privacy_contract_version,"
        + " authorized_at,expires_at,state)"
        + " VALUES ($1,$2,$1,'accountless-upload-owner-v1.2',"
        + " 'accountless-telemetry-v1.2-policy-v1','accountless-policy-v1.2',$3,$4,$5,"
        + " $6::timestamptz,$7::timestamptz,'active')",
      [deviceId, participantId, TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
        TELEMETRY_V12_FIELD_DICTIONARY_VERSION, TELEMETRY_V12_PRIVACY_CONTRACT_VERSION, issuedAt, expiresAt],
    );

    const sourceNamespace = "synthetic-v12-client-" + suffix;
    const encodedNamespace = Buffer.from(m["typed-telemetry-codec"].encodeTypedTelemetryId(sourceNamespace));
    await primaryPool.query(
      "INSERT INTO " + q(primarySchema, "typed_telemetry_namespaces") + " (id,original_id) VALUES (1,$1)",
      [encodedNamespace],
    );
    for (const table of ["typed_v1_admission_state", "typed_v11_admission_state"]) {
      await primaryPool.query(
        "INSERT INTO " + q(primarySchema, table)
          + " (id,source_namespace,namespace_id,runtime_contract_version,next_source_row_id)"
          + " VALUES (1,$1,1,1,1)",
        [sourceNamespace],
      );
    }

    const rateLimitNames = {
      ENROLLMENT_RATE_LIMIT: "ENROLLMENT",
      RECOVERY_RATE_LIMIT: "RECOVERY",
      CLIENT_ATTEMPT_RATE_LIMIT: "CLIENT_ATTEMPT",
      PUBLIC_READ_RATE_LIMIT: "PUBLIC_READ",
      UPLOAD_AUTHORIZATION_RATE_LIMIT: "UPLOAD_AUTHORIZATION",
      UPLOAD_PRINCIPAL_RATE_LIMIT: "UPLOAD_PRINCIPAL",
      DEVICE_SYNC_CLIENT_RATE_LIMIT: "DEVICE_SYNC_CLIENT",
      DEVICE_SYNC_RATE_LIMIT: "DEVICE_SYNC",
      DEVICE_SYNC_PRINCIPAL_RATE_LIMIT: "DEVICE_SYNC_PRINCIPAL",
    };
    const defaultLimits = {
      ENROLLMENT: 20,
      RECOVERY: 20,
      CLIENT_ATTEMPT: 5,
      PUBLIC_READ: 20,
      UPLOAD_AUTHORIZATION: 6000,
      UPLOAD_PRINCIPAL: 4200,
      DEVICE_SYNC_CLIENT: 4200,
      DEVICE_SYNC: 6000,
      DEVICE_SYNC_PRINCIPAL: 4200,
    };
    const admissionEnv = {
      ENVIRONMENT: "test",
      IDENTITY_LINK_SECRET: randomBytes(32).toString("base64url"),
    };
    const limiterSecrets = new Map();
    function createLimiter(name, limit) {
      let keyHashSecret = limiterSecrets.get(name);
      if (!keyHashSecret) {
        keyHashSecret = randomBytes(32);
        limiterSecrets.set(name, keyHashSecret);
      }
      return m["postgres-rate-limiter"].createPostgresRateLimiter(primaryPool, {
        primarySchema,
        ledgerSchema,
        name,
        limit,
        periodSeconds: 60,
        keyHashSecret,
      });
    }
    for (const [binding, name] of Object.entries(rateLimitNames)) {
      admissionEnv[binding] = createLimiter(name, limits[name] ?? defaultLimits[name]);
    }
    function setLimit(name, limit) {
      assert.ok(Object.values(rateLimitNames).includes(name), "unknown rate limiter name");
      assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit <= 10_000);
      const binding = Object.keys(rateLimitNames).find((key) => rateLimitNames[key] === name);
      admissionEnv[binding] = createLimiter(name, limit);
    }
    async function addDomainCheckConstraint() {
      await primaryPool.query(
        "ALTER TABLE " + q(primarySchema, "telemetry_v12_domains")
          + " ADD CONSTRAINT v12_real_client_invalid_domain CHECK (created_at IS NULL) NOT VALID",
      );
    }
    async function dropDomainCheckConstraint() {
      await primaryPool.query(
        "ALTER TABLE " + q(primarySchema, "telemetry_v12_domains")
          + " DROP CONSTRAINT IF EXISTS v12_real_client_invalid_domain",
      );
    }

    const envelopePair = await webcrypto.subtle.generateKey({
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    }, true, ["encrypt", "decrypt"]);
    const keyId = "key:v12-real-client-" + suffix;
    const envelopePublicJwk = { ...await webcrypto.subtle.exportKey("jwk", envelopePair.publicKey), kid: keyId };
    const envelopePrivateJwk = { ...await webcrypto.subtle.exportKey("jwk", envelopePair.privateKey), kid: keyId };
    const objectStore = {
      async put(key, value) { storedObjects.set(key, Uint8Array.from(value)); },
      async delete(key) { storedObjects.delete(key); },
    };
    const healthDispatch = createPostgresTestHealthDispatch({
      primaryPool,
      ledgerPool,
      schemaOptions,
      expectedMigrations,
      privateOrigin,
    });
    const dispatch = createPostgresTestV12DayManifestDispatch({
      primaryPool: dispatchPrimaryPool,
      ledgerPool,
      schemaOptions,
      expectedMigrations,
      privateOrigin,
      healthDispatch,
      admissionEnv,
      assertAdmissionBindings: m.admission.assertAdmissionBindings,
      assertAttemptAllowed: m.admission.assertAttemptAllowed,
      createPostgresDeviceSyncPrincipal: m["postgres-device-sync-principal"].createPostgresDeviceSyncPrincipal,
      assertUploadAuthorizationBindings: m.admission.assertUploadAuthorizationBindings,
      assertUploadAuthorizationAllowed: m.admission.assertUploadAuthorizationAllowed,
      authenticatePostgresDevice: m["postgres-typed-v12-transport"].authenticatePostgresDevice,
      disconnectPostgresAuthenticatedDevice:
        m["postgres-device-disconnect"].disconnectPostgresAuthenticatedDevice,
      hasPostgresDeletionTombstone: m["postgres-ledger-authority"].hasPostgresDeletionTombstone,
      readPostgresDeviceSyncState: m["postgres-device-sync-reads"].readPostgresDeviceSyncState,
      readPostgresDeviceSyncManifest: m["postgres-device-sync-reads"].readPostgresDeviceSyncManifest,
      readPostgresDeviceSyncCapabilities: m["postgres-device-sync"].readPostgresDeviceSyncCapabilities,
      readPostgresDeviceSyncV12Capabilities: m["postgres-device-sync"].readPostgresDeviceSyncV12Capabilities,
      readPostgresV12DayCandidates:
        m["postgres-v12-manifest-candidates"].readPostgresV12DayCandidates,
      readPostgresTelemetryV12EffectivePage:
        m["postgres-typed-v12-effective-reader"].readPostgresTelemetryV12EffectivePage,
      publicEnvelopeKey: m.crypto.publicEnvelopeKey,
      sourceNamespace,
      createPostgresTypedV12Domain: m["postgres-typed-v12-domain"].createPostgresTypedV12Domain,
      assertPostgresV12UploadAllowed: (poolRef, principal, nowEpoch, options) =>
        m["postgres-telemetry-format-authority"].assertPostgresTelemetryTransportWriteAllowed(
          poolRef, principal, TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
          { ...options, nowEpoch },
        ),
      createPostgresDeviceUploadAuthorization:
        m["postgres-upload-authorization"].createPostgresDeviceUploadAuthorization,
      registerPostgresTypedV12DayManifest:
        m["postgres-typed-v12-admission"].registerPostgresTypedV12DayManifest,
      claimPostgresDeviceUploadAuthorization:
        m["postgres-typed-v12-transport"].claimPostgresDeviceUploadAuthorization,
      abandonPostgresDeviceUploadAuthorization:
        m["postgres-typed-v12-transport"].abandonPostgresDeviceUploadAuthorization,
      persistPostgresTypedV12StagedChunk:
        m["postgres-typed-v12-admission"].persistPostgresTypedV12StagedChunk,
      decryptSyntheticEnvelope: m.crypto.decryptSyntheticEnvelope,
      validateTelemetryV12Envelope: (await import("@app-usagemonitor/telemetry-contract"))
        .validateTelemetryV12Envelope,
      validateTelemetryV12StagedChunk: m["telemetry-v12-repository"].validateTelemetryV12StagedChunk,
      sha256Hex: m.crypto.sha256Hex,
      objectStore,
      envelopePublicJwk: JSON.stringify(envelopePublicJwk),
      envelopePrivateJwk: JSON.stringify(envelopePrivateJwk),
      readBoundedRequestBody: m["bounded-body"].readBoundedRequestBody,
      maxRequestBytes: m.constants.MAX_REQUEST_BYTES,
    });

    const runtime = {
      postgresTestDispatch: dispatch,
      get env() { throw new Error("D1 must remain unreachable in the v1.2 real-client harness"); },
    };
    const workerHandler = async () => { throw new Error("Worker fallback must remain unreachable"); };
    const fetchImpl = async (url, init) => {
      const request = new Request(url, init);
      const response = await dispatchCloudRunHostRequest(request, runtime, workerHandler);
      let body = null;
      try { body = await response.clone().json(); } catch {}
      exchanges.push({ path: new URL(url).pathname, status: response.status, body });
      return response;
    };

    async function registerEmptyDayManifests(plan) {
      assert.ok(Array.isArray(plan) && plan.length > 0, "a non-empty synthetic manifest plan is required");
      const registered = new Array(plan.length);
      let next = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (next < plan.length) {
          const index = next;
          next += 1;
          const { day, parserVersion, createdEpoch } = plan[index];
          assert.match(day, /^\d{4}-\d{2}-\d{2}$/u);
          assert.equal(typeof parserVersion, "string");
          assert.ok(Number.isSafeInteger(createdEpoch));
          const candidate = await m["postgres-typed-v12-admission"].registerPostgresTypedV12DayManifest(
            primaryPool,
            { participantId, deviceId },
            emptyDayManifest(day, parserVersion),
            createdEpoch,
            { schema: schemaOptions },
          );
          assert.equal(candidate.state, "ready");
          assert.equal(candidate.expectedChunks, 0);
          assert.equal(candidate.day, day);
          registered[index] = {
            day,
            parserVersion,
            createdEpoch,
            manifestId: candidate.manifestId,
            manifestDigest: candidate.manifestDigest,
          };
        }
      }));
      return registered;
    }

    async function negotiateCapabilities() {
      const start = exchanges.length;
      const value = await readTelemetryV12Capabilities({
        serverBaseUrl: privateOrigin,
        deviceAuthorization: authorization,
        fetchImpl,
      });
      return { value, exchanges: exchanges.slice(start) };
    }

    async function runClient({
      days,
      parserVersion = "synthetic-v12-parser-v1",
      recordCount = 1,
      publicationFingerprint = "synthetic-v12-publication",
      authorizationTuple = {
        schemaVersion: "accountless-upload-owner-v1.2",
        policyVersion: "accountless-telemetry-v1.2-policy-v1",
        authorizationBasis: "accountless-policy-v1.2",
        telemetrySchemaVersion: "telemetry-contribution-v1.2",
      },
      useProgress = false,
    }) {
      const start = exchanges.length;
      const progressStore = useProgress ? {
        read: async () => journal.value,
        write: async (value) => { journal.value = value; },
      } : null;
      const result = await runTelemetryV12Sync({
        serverBaseUrl: privateOrigin,
        deviceAuthorization: authorization,
        laboratory: true,
        authorization: authorizationTuple,
        days,
        readDay: async (day) => createTelemetryV12Day({
          day,
          parserVersion,
          recordsByStream: {
            usage: Array.from({ length: recordCount }, (_, index) => usageRecord(day, label + ":" + index)),
          },
        }),
        createEnvelope: (chunk) => createTelemetryV12Envelope({
          chunk,
          publicJwk: envelopePublicJwk,
          keyId,
        }),
        progressStore,
        sourcePublication: { fingerprint: publicationFingerprint, parserVersion },
        fetchImpl,
      });
      return { result, exchanges: exchanges.slice(start) };
    }

    async function counts() {
      const tableCounts = {};
      for (const table of [
        "telemetry_v12_domains",
        "telemetry_v12_domain_days",
        "storage_v12_event_sources",
        "storage_ingestion_changes",
      ]) {
        const result = await primaryPool.query("SELECT count(*)::integer AS count FROM " + q(primarySchema, table));
        tableCounts[table] = result.rows[0].count;
      }
      const ownerActive = await primaryPool.query(
        "SELECT count(*)::integer AS count FROM " + q(primarySchema, "storage_ingestion_changes")
          + " WHERE kind='owner-active'",
      );
      tableCounts.ownerActive = ownerActive.rows[0].count;
      const head = await primaryPool.query(
        "SELECT generation_id,revision::integer AS revision FROM " + q(primarySchema, "telemetry_v12_domain_heads")
          + " WHERE participant_id=$1",
        [participantId],
      );
      tableCounts.head = head.rows[0] ?? null;
      return tableCounts;
    }

    async function request(path, init = {}) {
      return dispatchCloudRunHostRequest(
        new Request(privateOrigin + path, init),
        runtime,
        workerHandler,
      );
    }

    return {
      endpoint,
      primaryPool,
      ledgerPool,
      schemaOptions,
      primarySchema,
      ledgerSchema,
      participantId,
      deviceId,
      authorization,
      sourceNamespace,
      privateOrigin,
      envelopePublicJwk,
      keyId,
      storedObjects,
      exchanges,
      queryCounters,
      resetQueryCounters() { queryCounters.authenticationQueries = 0; },
      dispatch,
      request,
      fetchImpl,
      runClient,
      registerEmptyDayManifests,
      negotiateCapabilities,
      counts,
      setLimit,
      addDomainCheckConstraint,
      dropDomainCheckConstraint,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
