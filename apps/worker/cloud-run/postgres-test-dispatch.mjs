import {
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION,
  parseTelemetryV12ChunkId,
} from "@app-usagemonitor/telemetry-contract";
import {
  assertContributionEnvelopeFormats,
  contributionTransportSchemaVersion,
  createContributionEnvelopeRegistry,
  createUploadAuthorizationFormats,
  registerContributionEnvelope,
} from "./contribution-envelope-registry.mjs";

const SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const MIGRATION_HISTORY_TABLE = "_tibotattle_migration_history";
const POSTGRES_MAJOR_REQUIRED = 17;
const CONTRIBUTIONS_PATH = "/api/v1/contributions";
const COMMUNITY_DAILY_PATH = "/api/v1/community/daily";
const PARTICIPANT_DEVICES_PATH = "/api/v1/me/devices";
const PARTICIPANT_DEVICE_REVOKE_PATH = "/api/v1/me/devices/revoke";
const PERSONAL_SESSION_PATH = "/api/v1/session";
const PERSONAL_LOGOUT_PATH = "/api/v1/logout";
const PERSONAL_DEVICE_PAIRING_PATH = "/api/v1/me/device-pairings";
const PERSONAL_TELEMETRY_V12_CONSENT_PATH = "/api/v1/me/device-telemetry-v12-consents";
const DEVICE_PAIRING_CLAIM_PATH = "/api/v1/device-pairings/claim";
const COMMUNITY_DAILY_MAX_RANGE_DAYS = 366;
const TELEMETRY_CONSENT_VERSION = "privacy-safe-telemetry-v0.1";
const ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION = "privacy-safe-telemetry-v0.2";
const ONGOING_TELEMETRY_CONSENT_VERSION = "ongoing-privacy-safe-telemetry-v0.1";
const ONGOING_ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION = "ongoing-privacy-safe-telemetry-v0.2";
const ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION = "ongoing-privacy-safe-telemetry-v1.0";
// origin-edge-test-mode.mjs EDGE_TEST_PUBLIC_ORIGIN: the public origin the
// edge-test boundary rebuilds requests on, and so that composition's private
// origin. Plain JavaScript keeps this file free of the contract import; the
// edge-test check pins the two equal.
const EDGE_TEST_PUBLIC_ORIGIN = "https://tibotattle.test";
// src/constants.ts SESSION_COOKIE_NAME, read by src/session.ts
// hasSessionCookie (d43c8f92 index.ts:277); the edge-test check pins it.
const SESSION_COOKIE_NAME = "__Host-usage_monitor_session";
// d43c8f92 index.ts:613-614 DEVICE_UPLOAD_AUTHORIZATION_HEADER, byte for byte;
// the edge-test check pins the two literals equal.
const DEVICE_UPLOAD_AUTHORIZATION_HEADER =
  /^Upload um_device_upload_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/u;
const PAIRING_BODY_READ_POLICY = Object.freeze({
  maximumTotalMilliseconds: 15_000,
  maximumIdleMilliseconds: 5_000,
});
// The named A2 test deployment's identities. Its cloud-run-iam host mode is
// retired (owner decision OD-6, 2026-10-02): no host mode serves as this
// service any more, but its resources stay in the test project until owner
// action OA-4, so the production refusal lists keep naming every value here
// (and the shared test database remains the analytics-refresh Job's
// non-fast-path test target). The `postgres.ledger` entry is a frozen
// identity of the test estate's ledger instance (retired with the deletion
// ledger, decisions D2, D4 and D6): no runtime path reads it.
export const CLOUD_RUN_IAM_TEST_TARGET = Object.freeze({
  project: "tibotattle",
  region: "us-east1",
  service: "tibotattle-test-app",
  origin: "https://tibotattle-test-app-5t5mehqi7a-ue.a.run.app",
  listenHost: "0.0.0.0",
  port: 8080,
  postgres: Object.freeze({
    primary: Object.freeze({
      instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
      database: "tibotattle",
      schema: "tibotattle_v12_a2_20260925",
    }),
    ledger: Object.freeze({
      instanceConnectionName: "tibotattle:us-east1:tibotattle-test-ledger-20260922",
      database: "tibotattle_ledger",
      schema: "tibotattle_ledger_v12_a2_20260925",
    }),
    iamUser: "tibotattle-test-runtime@tibotattle.iam",
  }),
  gcsBucket: "tibotattle-gcs-test-cleanup-20260925-a2",
});

function configurationError(code) {
  throw Object.assign(new Error(code), { code });
}

function validateExpectedMigrations(migrations, role) {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    configurationError(`POSTGRES_TEST_${role.toUpperCase()}_MIGRATION_RECEIPT_INVALID`);
  }
  const expected = migrations.map((migration, index) => {
    if (migration === null || typeof migration !== "object"
        || migration.version !== index + 1
        || typeof migration.name !== "string"
        || !/^[0-9]{4}_[a-z0-9_]+\.sql$/u.test(migration.name)
        || typeof migration.sha256 !== "string"
        || !DIGEST.test(migration.sha256)) {
      configurationError(`POSTGRES_TEST_${role.toUpperCase()}_MIGRATION_RECEIPT_INVALID`);
    }
    return Object.freeze({
      version: migration.version,
      name: migration.name,
      sha256: migration.sha256,
    });
  });
  return Object.freeze(expected);
}

/**
 * The one application schema. Any other key (a stale caller's retired
 * second schema included) is refused instead of being ignored.
 */
function validatedSchemas(schemaOptions = {}) {
  if (schemaOptions === null || typeof schemaOptions !== "object"
      || Object.keys(schemaOptions).some((key) => key !== "primarySchema")) {
    configurationError("POSTGRES_TEST_SCHEMA_CONFIGURATION_INVALID");
  }
  const primary = schemaOptions.primarySchema ?? "tibotattle";
  const invalid = (value) => typeof value !== "string"
    || !SCHEMA_IDENTIFIER.test(value)
    || value.startsWith("pg_")
    || value === "information_schema";
  if (invalid(primary)) {
    configurationError("POSTGRES_TEST_SCHEMA_CONFIGURATION_INVALID");
  }
  return Object.freeze({ primary });
}

function validPool(pool) {
  return pool !== null && typeof pool === "object" && typeof pool.connect === "function";
}

function schemaTable(schema) {
  return `"${schema}"`;
}

/**
 * A private test host listens on loopback only. The former 0.0.0.0 exception
 * for the named Cloud Run test service (mode 'cloud-run-iam') is retired with
 * that host mode (owner decision OD-6): any mode is refused. (The edge-test
 * origin's pinned Cloud Run listen pair is validated separately, by
 * origin-edge-test-mode.mjs.)
 */
export function isPrivatePostgresTestHost({
  mode,
  listenHost,
  hostOrigin,
  port,
}) {
  if (mode !== undefined || listenHost !== "127.0.0.1"
      || !Number.isSafeInteger(port) || port < 1 || port > 65_535
      || typeof hostOrigin !== "string") return false;
  try {
    const origin = new URL(hostOrigin);
    return origin.origin === hostOrigin
      && origin.protocol === "http:"
      && origin.hostname === "127.0.0.1"
      && Number(origin.port || "80") === port;
  } catch {
    return false;
  }
}

function isAllowedPostgresTestOrigin(value) {
  if (typeof value !== "string") return false;
  try {
    const origin = new URL(value);
    if (origin.origin !== value) return false;
    return (origin.protocol === "http:" && origin.hostname === "127.0.0.1")
      || value === EDGE_TEST_PUBLIC_ORIGIN;
  } catch {
    return false;
  }
}

/** src/session.ts hasSessionCookie: only the session cookie counts, not any cookie. */
function hasSessionCookie(cookieHeader) {
  if (!cookieHeader) return false;
  return cookieHeader.split(";").some((part) => (
    part.slice(0, Math.max(0, part.indexOf("="))).trim() === SESSION_COOKIE_NAME
  ));
}

function isRateLimitBinding(limiter) {
  return limiter !== null && typeof limiter === "object" && typeof limiter.limit === "function";
}

/** Test-only dispatch bypasses the Worker handler entirely, including D1. */
export async function dispatchCloudRunHostRequest(request, runtime, workerHandler) {
  if (typeof runtime?.postgresTestDispatch === "function") {
    return runtime.postgresTestDispatch(request);
  }
  if (typeof runtime?.postgresTestHealthDispatch === "function") {
    return runtime.postgresTestHealthDispatch(request);
  }
  return workerHandler(request, runtime?.env);
}

function json(status, value, additionalHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...additionalHeaders,
    },
  });
}

async function readSchemaReceipt(pool, schema, expected) {
  let client;
  let transactionOpen = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '3000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    const schemaResult = await client.query(
      `SELECT current_setting('server_version_num')::integer AS server_version_num,
              EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS schema_exists`,
      [schema],
    );
    const schemaRow = schemaResult.rows[0];
    const serverMajor = Math.floor(Number(schemaRow?.server_version_num) / 10_000);
    if (serverMajor !== POSTGRES_MAJOR_REQUIRED) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return "unsupported_postgres_version";
    }
    if (schemaRow?.schema_exists !== true) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return "schema_missing";
    }
    const history = await client.query(
      `SELECT version, name, checksum_sha256
         FROM ${schemaTable(schema)}."${MIGRATION_HISTORY_TABLE}"
        ORDER BY version`,
    );
    const matches = history.rows.length === expected.length
      && expected.every((migration, index) => {
        const actual = history.rows[index];
        return actual?.version === migration.version
          && actual?.name === migration.name
          && actual?.checksum_sha256 === migration.sha256;
      });
    await client.query("COMMIT");
    transactionOpen = false;
    return matches ? "current" : "receipt_mismatch";
  } catch {
    if (transactionOpen) {
      try { await client.query("ROLLBACK"); } catch { /* Keep the safe health result. */ }
    }
    return "unavailable";
  } finally {
    client?.release();
  }
}

/**
 * The one migration manifest the test routes admit: the primary receipts of
 * the image (manifest v2). A manifest that still carries a second role is
 * refused, so a stale composition cannot pass a ledger expectation through.
 */
function validatedExpectedManifest(expectedMigrations) {
  if (expectedMigrations === null || typeof expectedMigrations !== "object"
      || Object.keys(expectedMigrations).join(",") !== "primary") {
    configurationError("POSTGRES_TEST_PRIMARY_MIGRATION_RECEIPT_INVALID");
  }
  return validateExpectedMigrations(expectedMigrations.primary, "primary");
}

/**
 * The storage gate every PostgreSQL test route runs before it touches a
 * pool: the primary migration receipt must equal the expected manifest,
 * read in a bounded read-only transaction. There is no ledger receipt
 * (decisions D2, D4 and D6). The returned assertStorageCurrent() resolves
 * when it is current and otherwise throws 503 BACKEND_STORAGE_UNAVAILABLE,
 * the refusal the v1.2 dispatch gives. Route modules composed beside the
 * dispatch (the upload-authorization route module, the v1.1 intake routes)
 * bind this check so a stale or newer schema refuses them exactly as it
 * refuses the built-in routes.
 */
export function createPostgresTestStorageReceiptCheck({
  primaryPool,
  schemaOptions,
  expectedMigrations,
  ...retired
}) {
  if (!validPool(primaryPool) || Object.keys(retired).length !== 0) {
    configurationError("POSTGRES_TEST_POOLS_INVALID");
  }
  const schemas = validatedSchemas(schemaOptions);
  const expected = validatedExpectedManifest(expectedMigrations);
  return async function assertStorageCurrent() {
    const primaryReceipt = await readSchemaReceipt(primaryPool, schemas.primary, expected);
    if (primaryReceipt !== "current") throw storageUnavailable();
  };
}

/**
 * Construct a read-only health dispatcher for a private local GCP test host.
 * It deliberately receives one pool only: unsupported requests cannot reach
 * the Worker handler or any D1 binding. Body schema
 * gcp-postgres-test-health-v2: the primary receipt only (v1 also carried the
 * retired ledger receipt).
 */
export function createPostgresTestHealthDispatch({
  primaryPool,
  schemaOptions,
  expectedMigrations,
  privateOrigin,
  ...retired
}) {
  if (!validPool(primaryPool) || Object.keys(retired).length !== 0) {
    configurationError("POSTGRES_TEST_POOLS_INVALID");
  }
  const schemas = validatedSchemas(schemaOptions);
  const expected = validatedExpectedManifest(expectedMigrations);
  if (!isAllowedPostgresTestOrigin(privateOrigin)) {
    configurationError("POSTGRES_TEST_PRIVATE_ORIGIN_INVALID");
  }

  return async function dispatchPostgresTestHealth(request) {
    let url;
    try { url = new URL(request.url); } catch {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }
    if (url.origin !== privateOrigin || request.method !== "GET"
        || url.pathname !== "/api/health") {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }

    const primary = await readSchemaReceipt(primaryPool, schemas.primary, expected);
    const ready = primary === "current";
    return json(ready ? 200 : 503, {
      schemaVersion: "gcp-postgres-test-health-v2",
      scope: "postgres_schema_and_migrations_only",
      status: ready ? "ready" : "not_ready",
      workerApplicationReady: false,
      checks: {
        postgresMajor: POSTGRES_MAJOR_REQUIRED,
        primaryMigrationReceipt: {
          status: primary,
          version: expected.length,
        },
      },
    });
  };
}

function communityDailyQuery(url) {
  const query = url.searchParams;
  if ([...query.keys()].some((key) => !["from", "to"].includes(key))
      || query.getAll("from").length !== 1 || query.getAll("to").length !== 1) {
    throw Object.assign(new Error("BODY_INVALID"), { code: "BODY_INVALID", status: 400 });
  }
  const from = query.get("from");
  const to = query.get("to");
  const validDay = (day) => typeof day === "string"
    && /^\d{4}-\d{2}-\d{2}$/u.test(day)
    && Number.isFinite(Date.parse(`${day}T00:00:00.000Z`))
    && new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) === day;
  if (!validDay(from) || !validDay(to)) {
    throw Object.assign(new Error("BODY_INVALID"), { code: "BODY_INVALID", status: 400 });
  }
  const rangeDays = (Date.parse(`${to}T00:00:00.000Z`)
    - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (rangeDays < 1 || rangeDays > COMMUNITY_DAILY_MAX_RANGE_DAYS) {
    throw Object.assign(new Error("BODY_INVALID"), { code: "BODY_INVALID", status: 400 });
  }
  return Object.freeze({ from, to });
}

/**
 * Private GCP test route for the PostgreSQL-backed daily reader. The public
 * projection is intentionally activity/spend only until PostgreSQL has the
 * current allowance fit producer and cache-retention lane.
 */
export function createPostgresTestCommunityDailyDispatch({
  primaryPool,
  schemaOptions,
  sourceIdentity,
  readPostgresPublishedCommunityDaily,
  healthDispatch,
  privateOrigin,
}) {
  if (primaryPool === null || typeof primaryPool !== "object"
      || typeof primaryPool.connect !== "function"
      || sourceIdentity === null || typeof sourceIdentity !== "object"
      || typeof sourceIdentity.sourceId !== "string" || sourceIdentity.sourceId.length < 1
      || sourceIdentity.sourceId.length > 200
      || !/^[\x21-\x7e]+$/u.test(sourceIdentity.sourceId)
      || typeof sourceIdentity.sourceNamespace !== "string"
      || sourceIdentity.sourceNamespace.length < 1 || sourceIdentity.sourceNamespace.length > 200
      || !/^[\x21-\x7e]+$/u.test(sourceIdentity.sourceNamespace)
      || typeof readPostgresPublishedCommunityDaily !== "function"
      || typeof healthDispatch !== "function") {
    configurationError("POSTGRES_TEST_COMMUNITY_DAILY_DISPATCH_CONFIGURATION_INVALID");
  }
  const schemas = validatedSchemas(schemaOptions);
  if (!isAllowedPostgresTestOrigin(privateOrigin)) {
    configurationError("POSTGRES_TEST_PRIVATE_ORIGIN_INVALID");
  }

  return async function dispatchPostgresTestCommunityDaily(request) {
    let url;
    try { url = new URL(request.url); } catch {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }
    if (url.origin !== privateOrigin || url.pathname !== COMMUNITY_DAILY_PATH) {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }
    if (request.method !== "GET") {
      return routeError(Object.assign(new Error("METHOD_NOT_ALLOWED"), {
        code: "METHOD_NOT_ALLOWED", status: 405, responseHeaders: { allow: "GET" },
      }), crypto.randomUUID());
    }

    const requestId = crypto.randomUUID();
    try {
      if (request.body !== null) {
        throw Object.assign(new Error("BODY_INVALID"), { code: "BODY_INVALID", status: 400 });
      }
      const { from, to } = communityDailyQuery(url);
      const health = await healthDispatch(new Request(`${privateOrigin}/api/health`));
      if (health?.status !== 200) throw storageUnavailable();

      let read;
      try {
        read = await readPostgresPublishedCommunityDaily(primaryPool, {
          sourceId: sourceIdentity.sourceId,
          sourceNamespace: sourceIdentity.sourceNamespace,
          fromDay: from,
          throughDay: to,
          schema: { primarySchema: schemas.primary },
        });
      } catch {
        throw storageUnavailable();
      }
      if (read === null || typeof read !== "object" || !Array.isArray(read.rows)
          || read.rows.length > COMMUNITY_DAILY_MAX_RANGE_DAYS
          || !["confirmed", "temporarily_unavailable"].includes(read.allowanceReadState)) {
        throw storageUnavailable();
      }
      const days = read.rows.map((row) => {
        if (row === null || typeof row !== "object"
            || typeof row.day !== "string" || row.day < from || row.day > to
            || !Number.isSafeInteger(row.revision) || row.revision < 1
            || typeof row.released_at !== "string"
            || !Number.isFinite(Date.parse(row.released_at))) throw storageUnavailable();
        let payload;
        try { payload = JSON.parse(row.payload_json); } catch { throw storageUnavailable(); }
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
          throw storageUnavailable();
        }
        if (payload.day !== row.day || payload.revision !== row.revision) {
          throw storageUnavailable();
        }
        // Fit readiness and allowance preview production have not been ported.
        // Keep the activity contract closed even if the table contains legacy
        // or externally-written fields.
        const publicPayload = { ...payload };
        delete publicPayload.allowance;
        delete publicPayload.capacityByPlanType;
        return {
          day: row.day,
          revision: row.revision,
          releasedAt: row.released_at,
          payload: publicPayload,
        };
      });
      return json(200, {
        schemaVersion: "community-daily-read-v1.0",
        from,
        to,
        allowanceState: "updating",
        allowanceReadState: read.allowanceReadState,
        days,
      });
    } catch (error) {
      return routeError(error, requestId);
    }
  };
}

function personalDevicesRequestError(status, code, responseHeaders) {
  return Object.assign(new Error(code), {
    code,
    status,
    ...(responseHeaders === undefined ? {} : { responseHeaders }),
  });
}

async function readPersonalDeviceRevocationId(request, readBoundedRequestBody, maxRequestBytes) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw personalDevicesRequestError(415, "CONTENT_TYPE_INVALID");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw personalDevicesRequestError(400, "BODY_INVALID");
    }
    if (length > maxRequestBytes) {
      throw personalDevicesRequestError(413, "BODY_TOO_LARGE");
    }
  }
  const bytes = await readBoundedRequestBody(request, maxRequestBytes, {
    maximumTotalMilliseconds: 15_000,
    maximumIdleMilliseconds: 5_000,
  });
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw personalDevicesRequestError(400, "BODY_INVALID");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)
      || Object.keys(value).length !== 1 || typeof value.deviceId !== "string") {
    throw personalDevicesRequestError(400, "BODY_INVALID");
  }
  return value.deviceId;
}

/** Private Cloud Run test routes for Worker-compatible personal device reads and revocation. */
export function createPostgresTestParticipantDevicesDispatch({
  primaryPool,
  schemaOptions,
  authenticatePostgresPersonalSession,
  assertPostgresPersonalSessionCsrf,
  listPostgresParticipantDevices,
  revokePostgresParticipantDevice,
  readBoundedRequestBody,
  maxRequestBytes,
  healthDispatch,
  privateOrigin,
}) {
  if (primaryPool === null || typeof primaryPool !== "object"
      || typeof primaryPool.connect !== "function"
      || typeof authenticatePostgresPersonalSession !== "function"
      || typeof assertPostgresPersonalSessionCsrf !== "function"
      || typeof listPostgresParticipantDevices !== "function"
      || typeof revokePostgresParticipantDevice !== "function"
      || typeof readBoundedRequestBody !== "function"
      || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1
      || typeof healthDispatch !== "function") {
    configurationError("POSTGRES_TEST_PARTICIPANT_DEVICES_DISPATCH_CONFIGURATION_INVALID");
  }
  const schemas = validatedSchemas(schemaOptions);
  if (!isAllowedPostgresTestOrigin(privateOrigin)) {
    configurationError("POSTGRES_TEST_PRIVATE_ORIGIN_INVALID");
  }

  return async function dispatchPostgresTestParticipantDevices(request) {
    let url;
    try { url = new URL(request.url); } catch {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }
    const isDeviceList = url.pathname === PARTICIPANT_DEVICES_PATH;
    const isDeviceRevocation = url.pathname === PARTICIPANT_DEVICE_REVOKE_PATH;
    if (url.origin !== privateOrigin || (!isDeviceList && !isDeviceRevocation)) {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }
    const requestId = crypto.randomUUID();
    const requiredMethod = isDeviceList ? "GET" : "POST";
    if (request.method !== requiredMethod) {
      return routeError(personalDevicesRequestError(405, "METHOD_NOT_ALLOWED", {
        allow: requiredMethod,
      }), requestId);
    }

    try {
      // Cloud Run carries its IAM assertion in x-serverless-authorization;
      // the Node boundary removes that header. Authorization remains reserved
      // for Worker capabilities and personalSession rejects it for these routes.
      if (request.headers.has("authorization")) {
        throw Object.assign(new Error("AUTH_INVALID"), { code: "AUTH_INVALID", status: 401 });
      }
      const health = await healthDispatch(new Request(`${privateOrigin}/api/health`));
      if (health?.status !== 200) throw storageUnavailable();

      const principal = await authenticatePostgresPersonalSession(
        primaryPool,
        request.headers.get("cookie"),
        { schema: { primarySchema: schemas.primary } },
      );
      if (principal === null || typeof principal !== "object"
          || typeof principal.participantId !== "string" || principal.participantId.length === 0) {
        throw storageUnavailable();
      }
      const schema = { primarySchema: schemas.primary };
      if (isDeviceList) {
        const devices = await listPostgresParticipantDevices(
          primaryPool,
          principal.participantId,
          { schema },
        );
        if (!Array.isArray(devices) || devices.length > 100) throw storageUnavailable();
        return json(200, { devices }, { vary: "Cookie" });
      }
      if (typeof principal.csrfToken !== "string" || principal.csrfToken.length === 0) {
        throw storageUnavailable();
      }
      assertPostgresPersonalSessionCsrf(request, principal.csrfToken);
      const deviceId = await readPersonalDeviceRevocationId(
        request,
        readBoundedRequestBody,
        maxRequestBytes,
      );
      const revoked = await revokePostgresParticipantDevice(
        primaryPool,
        principal.participantId,
        deviceId,
        { schema },
      );
      if (typeof revoked !== "boolean") throw storageUnavailable();
      if (!revoked) throw personalDevicesRequestError(404, "DEVICE_NOT_FOUND");
      return json(200, { revoked: true, deviceId }, { vary: "Cookie" });
    } catch (error) {
      if (Number.isSafeInteger(error?.status)
          && typeof error?.code === "string" && /^[A-Z0-9_]+$/u.test(error.code)) {
        return routeError(error, requestId);
      }
      // Never expose PostgreSQL driver errors or database object details.
      return routeError(storageUnavailable(), requestId);
    }
  };
}

/** Private Cloud Run test routes for Worker-compatible social session read and logout. */
export function createPostgresTestPersonalSessionDispatch({
  primaryPool,
  schemaOptions,
  authenticatePostgresPersonalSession,
  assertPostgresPersonalSessionCsrf,
  revokePostgresPersonalSession,
  healthDispatch,
  clearSessionCookie,
  privateOrigin,
}) {
  if (primaryPool === null || typeof primaryPool !== "object"
      || typeof primaryPool.connect !== "function"
      || typeof authenticatePostgresPersonalSession !== "function"
      || typeof assertPostgresPersonalSessionCsrf !== "function"
      || typeof revokePostgresPersonalSession !== "function"
      || typeof healthDispatch !== "function"
      || typeof clearSessionCookie !== "string"
      || clearSessionCookie.length === 0) {
    configurationError("POSTGRES_TEST_PERSONAL_SESSION_DISPATCH_CONFIGURATION_INVALID");
  }
  const schemas = validatedSchemas(schemaOptions);
  if (!isAllowedPostgresTestOrigin(privateOrigin)) {
    configurationError("POSTGRES_TEST_PRIVATE_ORIGIN_INVALID");
  }

  return async function dispatchPostgresTestPersonalSession(request) {
    let url;
    try { url = new URL(request.url); } catch {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }
    const isSessionRead = url.pathname === PERSONAL_SESSION_PATH;
    const isLogout = url.pathname === PERSONAL_LOGOUT_PATH;
    if (url.origin !== privateOrigin || (!isSessionRead && !isLogout)) {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }
    const requestId = crypto.randomUUID();
    const requiredMethod = isSessionRead ? "GET" : "POST";
    if (request.method !== requiredMethod) {
      return routeError(personalDevicesRequestError(405, "METHOD_NOT_ALLOWED", {
        allow: requiredMethod,
      }), requestId);
    }

    try {
      const health = await healthDispatch(new Request(`${privateOrigin}/api/health`));
      if (health?.status !== 200) throw storageUnavailable();

      const authenticate = async () => {
        if (request.headers.has("authorization")) {
          throw personalDevicesRequestError(401, "AUTH_INVALID");
        }
        const principal = await authenticatePostgresPersonalSession(
          primaryPool,
          request.headers.get("cookie"),
          { schema: { primarySchema: schemas.primary } },
        );
        if (principal === null || typeof principal !== "object"
            || typeof principal.participantId !== "string" || principal.participantId.length === 0
            || typeof principal.sessionId !== "string" || principal.sessionId.length === 0
            || typeof principal.participantCreatedAt !== "string"
            || typeof principal.expiresAt !== "string"
            || (principal.consentVersion !== null && typeof principal.consentVersion !== "string")
            || typeof principal.csrfToken !== "string" || principal.csrfToken.length === 0) {
          throw storageUnavailable();
        }
        return principal;
      };

      if (isSessionRead) {
        const principal = await authenticate();
        return json(200, {
          participantId: principal.participantId,
          createdAt: principal.participantCreatedAt,
          expiresAt: principal.expiresAt,
          csrfToken: principal.csrfToken,
          consentVersion: principal.consentVersion,
        }, { vary: "Cookie" });
      }

      let principal;
      try {
        principal = await authenticate();
      } catch (error) {
        if (error?.status !== 401) throw error;
        return json(200, { loggedOut: true }, {
          "set-cookie": clearSessionCookie,
          vary: "Cookie",
        });
      }
      assertPostgresPersonalSessionCsrf(request, principal.csrfToken);
      await revokePostgresPersonalSession(
        primaryPool,
        principal.participantId,
        principal.sessionId,
        { schema: { primarySchema: schemas.primary } },
      );
      return json(200, { loggedOut: true }, {
        "set-cookie": clearSessionCookie,
        vary: "Cookie",
      });
    } catch (error) {
      if (Number.isSafeInteger(error?.status)
          && typeof error?.code === "string" && /^[A-Z0-9_]+$/u.test(error.code)) {
        return routeError(error, requestId);
      }
      // Never expose PostgreSQL driver errors or database object details.
      return routeError(storageUnavailable(), requestId);
    }
  };
}

/** Private Cloud Run test route for issuing a session-bound device pairing. */
export function createPostgresTestDevicePairingDispatch({
  primaryPool,
  schemaOptions,
  authenticatePostgresPersonalSession,
  assertPostgresPersonalSessionCsrf,
  assertAccountScopedLocalPreview,
  createPostgresDevicePairing,
  healthDispatch,
  readBoundedRequestBody,
  maxRequestBytes,
  admissionEnv,
  privateOrigin,
}) {
  if (primaryPool === null || typeof primaryPool !== "object"
      || typeof primaryPool.connect !== "function"
      || typeof authenticatePostgresPersonalSession !== "function"
      || typeof assertPostgresPersonalSessionCsrf !== "function"
      || typeof assertAccountScopedLocalPreview !== "function"
      || typeof createPostgresDevicePairing !== "function"
      || typeof healthDispatch !== "function"
      || typeof readBoundedRequestBody !== "function"
      || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) {
    configurationError("POSTGRES_TEST_DEVICE_PAIRING_DISPATCH_CONFIGURATION_INVALID");
  }
  const schemas = validatedSchemas(schemaOptions);
  if (!isAllowedPostgresTestOrigin(privateOrigin)) {
    configurationError("POSTGRES_TEST_PRIVATE_ORIGIN_INVALID");
  }

  return async function dispatchPostgresTestDevicePairing(request) {
    let url;
    try { url = new URL(request.url); } catch {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }
    if (url.origin !== privateOrigin || url.pathname !== PERSONAL_DEVICE_PAIRING_PATH) {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }
    const requestId = crypto.randomUUID();
    if (request.method !== "POST") {
      return routeError(personalDevicesRequestError(405, "METHOD_NOT_ALLOWED", {
        allow: "POST",
      }), requestId);
    }

    try {
      const health = await healthDispatch(new Request(`${privateOrigin}/api/health`));
      if (health?.status !== 200) throw storageUnavailable();
      await assertPostgresUploadRegistrationEnabled(primaryPool, schemas.primary);
      if (request.headers.has("authorization")) {
        throw personalDevicesRequestError(401, "AUTH_INVALID");
      }
      const principal = await authenticatePostgresPersonalSession(
        primaryPool,
        request.headers.get("cookie"),
        { schema: { primarySchema: schemas.primary } },
      );
      if (principal === null || typeof principal !== "object"
          || typeof principal.participantId !== "string" || principal.participantId.length === 0
          || typeof principal.sessionId !== "string" || principal.sessionId.length === 0
          || typeof principal.csrfToken !== "string" || principal.csrfToken.length === 0
          || (principal.consentVersion !== null && typeof principal.consentVersion !== "string")) {
        throw storageUnavailable();
      }
      assertPostgresPersonalSessionCsrf(request, principal.csrfToken);

      const accountScoped = principal.consentVersion
        === ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION;
      if (accountScoped) {
        assertAccountScopedLocalPreview(request, admissionEnv);
      } else if (principal.consentVersion !== TELEMETRY_CONSENT_VERSION) {
        throw personalDevicesRequestError(400, "TELEMETRY_REQUIRED");
      }

      const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (contentType !== "application/json") {
        throw personalDevicesRequestError(415, "CONTENT_TYPE_INVALID");
      }
      const declared = request.headers.get("content-length");
      if (declared !== null) {
        const length = Number(declared);
        if (!Number.isSafeInteger(length) || length < 0) {
          throw personalDevicesRequestError(400, "BODY_INVALID");
        }
        if (length > maxRequestBytes) {
          throw personalDevicesRequestError(413, "BODY_TOO_LARGE");
        }
      }
      const bytes = await readBoundedRequestBody(
        request,
        maxRequestBytes,
        PAIRING_BODY_READ_POLICY,
      );
      let body;
      try {
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
      } catch {
        throw personalDevicesRequestError(400, "BODY_INVALID");
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).length !== 2
          || typeof body.consentVersion !== "string"
          || body.ongoingUpload !== true) {
        throw personalDevicesRequestError(400, "BODY_INVALID");
      }
      const allowedConsentVersions = accountScoped
        ? [ONGOING_ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION]
        : [ONGOING_TELEMETRY_CONSENT_VERSION, ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION];
      if (!allowedConsentVersions.includes(body.consentVersion)) {
        throw personalDevicesRequestError(400, "BODY_INVALID");
      }
      const pairing = await createPostgresDevicePairing(
        primaryPool,
        principal.participantId,
        principal.sessionId,
        principal.consentVersion,
        body.consentVersion,
        { schema: { primarySchema: schemas.primary } },
      );
      if (pairing === null || typeof pairing !== "object"
          || typeof pairing.pairingCode !== "string"
          || typeof pairing.expiresAt !== "string") {
        throw storageUnavailable();
      }
      return json(201, pairing, { vary: "Cookie" });
    } catch (error) {
      if (Number.isSafeInteger(error?.status)
          && typeof error?.code === "string" && /^[A-Z0-9_]+$/u.test(error.code)) {
        return routeError(error, requestId);
      }
      return routeError(storageUnavailable(), requestId);
    }
  };
}

/** Private Cloud Run test route for granting social-device v1.2 consent. */
export function createPostgresTestTelemetryV12ConsentDispatch({
  primaryPool,
  schemaOptions,
  authenticatePostgresPersonalSession,
  assertPostgresPersonalSessionCsrf,
  grantPostgresTelemetryV12Consent,
  healthDispatch,
  readBoundedRequestBody,
  maxRequestBytes,
  privateOrigin,
}) {
  if (primaryPool === null || typeof primaryPool !== "object"
      || typeof primaryPool.connect !== "function"
      || typeof authenticatePostgresPersonalSession !== "function"
      || typeof assertPostgresPersonalSessionCsrf !== "function"
      || typeof grantPostgresTelemetryV12Consent !== "function"
      || typeof healthDispatch !== "function"
      || typeof readBoundedRequestBody !== "function"
      || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) {
    configurationError("POSTGRES_TEST_TELEMETRY_V12_CONSENT_DISPATCH_CONFIGURATION_INVALID");
  }
  const schemas = validatedSchemas(schemaOptions);
  if (!isAllowedPostgresTestOrigin(privateOrigin)) {
    configurationError("POSTGRES_TEST_PRIVATE_ORIGIN_INVALID");
  }

  return async function dispatchPostgresTestTelemetryV12Consent(request) {
    let url;
    try { url = new URL(request.url); } catch {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }
    if (url.origin !== privateOrigin || url.pathname !== PERSONAL_TELEMETRY_V12_CONSENT_PATH) {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }
    const requestId = crypto.randomUUID();
    if (request.method !== "POST") {
      return routeError(personalDevicesRequestError(405, "METHOD_NOT_ALLOWED", {
        allow: "POST",
      }), requestId);
    }
    if (url.search !== "") {
      return routeError(personalDevicesRequestError(400, "BODY_INVALID"), requestId);
    }

    try {
      const health = await healthDispatch(new Request(`${privateOrigin}/api/health`));
      if (health?.status !== 200) throw storageUnavailable();
      if (request.headers.has("authorization")) {
        throw personalDevicesRequestError(401, "AUTH_INVALID");
      }
      const principal = await authenticatePostgresPersonalSession(
        primaryPool,
        request.headers.get("cookie"),
        { schema: { primarySchema: schemas.primary } },
      );
      if (principal === null || typeof principal !== "object"
          || typeof principal.participantId !== "string" || principal.participantId.length === 0
          || typeof principal.sessionId !== "string" || principal.sessionId.length === 0
          || typeof principal.csrfToken !== "string" || principal.csrfToken.length === 0
          || (principal.consentVersion !== null && typeof principal.consentVersion !== "string")) {
        throw storageUnavailable();
      }
      assertPostgresPersonalSessionCsrf(request, principal.csrfToken);
      await assertPostgresUploadRegistrationEnabled(primaryPool, schemas.primary);
      if (principal.consentVersion !== TELEMETRY_CONSENT_VERSION) {
        throw personalDevicesRequestError(400, "TELEMETRY_REQUIRED");
      }

      const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (contentType !== "application/json") {
        throw personalDevicesRequestError(415, "CONTENT_TYPE_INVALID");
      }
      const declared = request.headers.get("content-length");
      if (declared !== null) {
        const length = Number(declared);
        if (!Number.isSafeInteger(length) || length < 0) {
          throw personalDevicesRequestError(400, "BODY_INVALID");
        }
        if (length > maxRequestBytes) {
          throw personalDevicesRequestError(413, "BODY_TOO_LARGE");
        }
      }
      const bytes = await readBoundedRequestBody(request, maxRequestBytes, {
        maximumTotalMilliseconds: 15_000,
        maximumIdleMilliseconds: 5_000,
      });
      let body;
      try {
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
      } catch {
        throw personalDevicesRequestError(400, "BODY_INVALID");
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).length !== 3
          || Object.keys(body).some((key) => !["deviceId", "consent", "ongoingUpload"].includes(key))
          || typeof body.deviceId !== "string"
          || body.ongoingUpload !== true) {
        throw personalDevicesRequestError(400, "BODY_INVALID");
      }
      const granted = await grantPostgresTelemetryV12Consent(
        primaryPool,
        {
          participantId: principal.participantId,
          sessionId: principal.sessionId,
          deviceId: body.deviceId,
        },
        body.consent,
        { schema: { primarySchema: schemas.primary } },
      );
      if (granted === null || typeof granted !== "object"
          || granted.schemaVersion !== "telemetry-contribution-v1.2"
          || granted.consent === null || typeof granted.consent !== "object") {
        throw storageUnavailable();
      }
      return json(201, granted, { vary: "Cookie" });
    } catch (error) {
      if (Number.isSafeInteger(error?.status)
          && typeof error?.code === "string" && /^[A-Z0-9_]+$/u.test(error.code)) {
        return routeError(error, requestId);
      }
      // Never expose PostgreSQL driver errors, SQL, or bind values.
      return routeError(storageUnavailable(), requestId);
    }
  };
}

/** Private Cloud Run test route for claiming a social device pairing. */
export function createPostgresTestDevicePairingClaimDispatch({
  primaryPool,
  schemaOptions,
  claimPostgresDevicePairing,
  healthDispatch,
  readBoundedRequestBody,
  maxRequestBytes,
  privateOrigin,
}) {
  if (primaryPool === null || typeof primaryPool !== "object"
      || typeof primaryPool.connect !== "function"
      || typeof claimPostgresDevicePairing !== "function"
      || typeof healthDispatch !== "function"
      || typeof readBoundedRequestBody !== "function"
      || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) {
    configurationError("POSTGRES_TEST_DEVICE_PAIRING_CLAIM_DISPATCH_CONFIGURATION_INVALID");
  }
  const schemas = validatedSchemas(schemaOptions);
  if (!isAllowedPostgresTestOrigin(privateOrigin)) {
    configurationError("POSTGRES_TEST_PRIVATE_ORIGIN_INVALID");
  }

  return async function dispatchPostgresTestDevicePairingClaim(request) {
    let url;
    try { url = new URL(request.url); } catch {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }
    if (url.origin !== privateOrigin || url.pathname !== DEVICE_PAIRING_CLAIM_PATH) {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }
    const requestId = crypto.randomUUID();
    if (request.method !== "POST") {
      return routeError(personalDevicesRequestError(405, "METHOD_NOT_ALLOWED", {
        allow: "POST",
      }), requestId);
    }

    try {
      const health = await healthDispatch(new Request(`${privateOrigin}/api/health`));
      if (health?.status !== 200) throw storageUnavailable();
      await assertPostgresUploadRegistrationEnabled(primaryPool, schemas.primary);
      if (request.headers.has("cookie")) {
        throw personalDevicesRequestError(401, "PAIRING_AUTH_INVALID");
      }
      const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (contentType !== "application/json") {
        throw personalDevicesRequestError(415, "CONTENT_TYPE_INVALID");
      }
      const declared = request.headers.get("content-length");
      if (declared !== null) {
        const length = Number(declared);
        if (!Number.isSafeInteger(length) || length < 0) {
          throw personalDevicesRequestError(400, "BODY_INVALID");
        }
        if (length > maxRequestBytes) {
          throw personalDevicesRequestError(413, "BODY_TOO_LARGE");
        }
      }
      const bytes = await readBoundedRequestBody(request, maxRequestBytes, PAIRING_BODY_READ_POLICY);
      let body;
      try {
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
      } catch {
        throw personalDevicesRequestError(400, "BODY_INVALID");
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).length !== 2
          || typeof body.deviceId !== "string"
          || typeof body.deviceSecretHash !== "string") {
        throw personalDevicesRequestError(400, "BODY_INVALID");
      }
      const result = await claimPostgresDevicePairing(
        primaryPool,
        request.headers.get("authorization"),
        body.deviceId,
        body.deviceSecretHash,
        request.headers.get("x-previous-device-authorization"),
        { schema: { primarySchema: schemas.primary } },
      );
      if (result === null || typeof result !== "object"
          || typeof result.deviceId !== "string"
          || result.state !== "active"
          || result.scope !== "upload_registration"
          || typeof result.expiresAt !== "string") {
        throw storageUnavailable();
      }
      return json(201, result);
    } catch (error) {
      if (Number.isSafeInteger(error?.status)
          && typeof error?.code === "string" && /^[A-Z0-9_]+$/u.test(error.code)) {
        return routeError(error, requestId);
      }
      return routeError(storageUnavailable(), requestId);
    }
  };
}

const V12_DAY_MANIFEST_PATH = "/api/v1/device/telemetry/v1.2/day-manifests";
const ENVELOPE_KEY_PATH = "/api/v1/envelope-key";
const DEVICE_UPLOAD_AUTHORIZATION_PATH = "/api/v1/device/upload-authorizations";
const DEVICE_DISCONNECT_PATH = "/api/v1/device/disconnect";
const DEVICE_SYNC_STATE_PATH = "/api/v1/device/sync/state";
const DEVICE_SYNC_MANIFEST_PATH = "/api/v1/device/sync/manifest";
const DEVICE_SYNC_MANIFEST_MAX_RANGE_DAYS = 31;
const DEVICE_SYNC_CAPABILITIES_PATH = "/api/v1/device/sync-capabilities";
const DEVICE_SYNC_CAPABILITIES_V12_PATH = "/api/v1/device/sync-capabilities-v1.2";
const V12_DOMAIN_PREDECESSOR_PATH = "/api/v1/me/telemetry-v12/domain-predecessor";
const V12_DOMAIN_ACTIVATE_PATH = "/api/v1/me/telemetry-v12/domain-activate";
const V12_EFFECTIVE_PAGE_PATH = "/api/v1/me/telemetry-v12/effective-page";
const ACCOUNTLESS_ENROLLMENT_PATH = "/api/v1/accountless/enrollment";
const ACCOUNTLESS_OWNERSHIP_PATH = "/api/v1/accountless/ownership";
const ACCOUNTLESS_V12_AUTHORIZATION_PATH = "/api/v1/accountless/telemetry-v1.2-authorization";
const ACCOUNTLESS_RENEWAL_PATH = "/api/v1/accountless/renewal";
const DEVICE_CREDENTIAL_RENEWAL_PATH = "/api/v1/device/credential/renew";
const MAX_V12_DAY_CHUNKS = 4_096;
const MAX_V12_EFFECTIVE_PAGE_LIMIT = 200;
const MAX_V12_EFFECTIVE_TIME_MS = 8_640_000_000_000_000;
const V12_EFFECTIVE_OCCURRENCE = /^[A-Za-z0-9._:-]{8,128}$/u;

function invalidEffectivePageQuery() {
  return Object.assign(new Error("BODY_INVALID"), { code: "BODY_INVALID", status: 400 });
}

function parseV12EffectivePageQuery(url) {
  const allowed = new Set([
    "day", "stream", "limit", "afterObservedAtMs", "afterOccurrenceId",
  ]);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) {
    throw invalidEffectivePageQuery();
  }
  const single = (key, required = false) => {
    const values = url.searchParams.getAll(key);
    if (values.length > 1 || (required && values.length !== 1)) throw invalidEffectivePageQuery();
    return values[0];
  };
  const day = single("day", true);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)
      || !Number.isFinite(Date.parse(`${day}T00:00:00.000Z`))
      || new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day) {
    throw invalidEffectivePageQuery();
  }
  const stream = single("stream", true);
  if (stream !== "usage" && stream !== "quota" && stream !== "session") {
    throw invalidEffectivePageQuery();
  }
  const rawLimit = single("limit");
  const limit = rawLimit === undefined ? 100 : Number(rawLimit);
  if (rawLimit !== undefined && !/^[1-9]\d{0,2}$/u.test(rawLimit)) {
    throw invalidEffectivePageQuery();
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_V12_EFFECTIVE_PAGE_LIMIT) {
    throw invalidEffectivePageQuery();
  }
  const rawObservedAtMs = single("afterObservedAtMs");
  const occurrenceId = single("afterOccurrenceId");
  if ((rawObservedAtMs === undefined) !== (occurrenceId === undefined)) {
    throw invalidEffectivePageQuery();
  }
  let after;
  if (rawObservedAtMs !== undefined) {
    if (typeof occurrenceId !== "string" || !/^-?\d{1,16}$/u.test(rawObservedAtMs)
        || !V12_EFFECTIVE_OCCURRENCE.test(occurrenceId)) {
      throw invalidEffectivePageQuery();
    }
    const observedAtMs = Number(rawObservedAtMs);
    if (!Number.isSafeInteger(observedAtMs)
        || observedAtMs < -MAX_V12_EFFECTIVE_TIME_MS
        || observedAtMs > MAX_V12_EFFECTIVE_TIME_MS) {
      throw invalidEffectivePageQuery();
    }
    after = Object.freeze({ observedAtMs, occurrenceId });
  }
  return Object.freeze({ day, stream, limit, ...(after === undefined ? {} : { after }) });
}

function routeError(error, requestId) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/u.test(error.code)
    ? error.code : "INTERNAL_ERROR";
  const status = Number.isSafeInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status : 500;
  const body = {
    error: {
      code,
      requestId,
      ...(error?.publicDetails && typeof error.publicDetails === "object"
        ? { details: error.publicDetails } : {}),
    },
  };
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  if (error?.responseHeaders) {
    for (const [name, value] of new Headers(error.responseHeaders)) headers.set(name, value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function storageUnavailable() {
  return Object.assign(new Error("BACKEND_STORAGE_UNAVAILABLE"), {
    code: "BACKEND_STORAGE_UNAVAILABLE",
    status: 503,
  });
}

async function withReadOnlyClient(pool, work) {
  let client;
  let transactionOpen = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '3000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    const result = await work(client);
    await client.query("COMMIT");
    transactionOpen = false;
    return result;
  } catch {
    if (transactionOpen) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve the sanitized failure. */ }
    }
    throw storageUnavailable();
  } finally {
    client?.release();
  }
}

async function withMutationClient(pool, work) {
  let client;
  let transactionOpen = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '60000ms'");
    await client.query("SET LOCAL lock_timeout = '5000ms'");
    const result = await work(client);
    await client.query("COMMIT");
    transactionOpen = false;
    return result;
  } catch {
    if (transactionOpen) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve the sanitized failure. */ }
    }
    throw storageUnavailable();
  } finally {
    client?.release();
  }
}

function validPendingObject(row, contributionId, objectKey, state = "registered") {
  return row?.contribution_id === contributionId
    && row?.object_key === objectKey
    && row?.object_kind === "telemetry_v12"
    && row?.reconciliation_state === state;
}

async function readPendingV12Object(pool, schema, contributionId, objectKey, state = "registered") {
  const table = schemaTable(schema) + '."pending_objects"';
  return withReadOnlyClient(pool, async (client) => {
    const result = await client.query(
      "SELECT contribution_id, object_key, object_kind, reconciliation_state "
        + "FROM " + table + " WHERE contribution_id = $1",
      [contributionId],
    );
    return validPendingObject(result.rows[0], contributionId, objectKey, state);
  });
}

async function registerPendingV12Object(pool, schema, contributionId, objectKey, nowIso) {
  const table = schemaTable(schema) + '."pending_objects"';
  try {
    await withMutationClient(pool, async (client) => {
      const result = await client.query(
        "INSERT INTO " + table + " "
          + "(contribution_id, object_key, object_kind, registered_at, reconciliation_state) "
          + "VALUES ($1, $2, 'telemetry_v12', $3, 'registered') "
          + "ON CONFLICT (contribution_id) DO NOTHING RETURNING contribution_id",
        [contributionId, objectKey, nowIso],
      );
      if (result.rowCount !== 1) {
        const prior = await client.query(
          "SELECT contribution_id, object_key, object_kind, reconciliation_state "
            + "FROM " + table + " WHERE contribution_id = $1 FOR UPDATE",
          [contributionId],
        );
        if (!validPendingObject(prior.rows[0], contributionId, objectKey)) {
          throw storageUnavailable();
        }
      }
    });
    return;
  } catch {
    // A lost COMMIT acknowledgement may still have installed the journal row.
    // Proceed only when a fresh read proves the exact registration is durable.
    try {
      if (await readPendingV12Object(pool, schema, contributionId, objectKey)) return;
    } catch { /* The write outcome stays unknown; never write GCS without proof. */ }
    throw storageUnavailable();
  }
}

// The device principal and the active participant row the claimed upload
// authorization belongs to (the Worker preamble's participants read). The
// claim already proved both active; a participant that left 'active' since
// then is refused like a missing grant.
async function readClaimedContributionPrincipal(pool, schema, claim, envelopeDigest, bodyBytes) {
  const grants = schemaTable(schema) + '."device_upload_authorizations"';
  const participants = schemaTable(schema) + '."participants"';
  return withReadOnlyClient(pool, async (client) => {
    const result = await client.query(
      "SELECT upload.issued_by_device_id, participant.consent_version, participant.owner_kind "
        + "FROM " + grants + " upload JOIN " + participants + " participant "
        + "ON participant.id = upload.participant_id AND participant.state = 'active' "
        + "WHERE upload.id = $1 AND upload.participant_id = $2 AND upload.state = 'consuming' "
        + "AND upload.envelope_digest = $3 AND upload.body_bytes = $4 "
        + "AND upload.content_type = 'application/json'",
      [claim.authorizationId, claim.participantId, envelopeDigest, bodyBytes],
    );
    const row = result.rows[0];
    if (typeof row?.issued_by_device_id !== "string" || row.issued_by_device_id.length < 1
        || (row.consent_version !== null && typeof row.consent_version !== "string")
        || (row.owner_kind !== "social" && row.owner_kind !== "accountless")) {
      throw Object.assign(new Error("UPLOAD_AUTH_INVALID"), {
        code: "UPLOAD_AUTH_INVALID", status: 401,
      });
    }
    return Object.freeze({
      principal: Object.freeze({ participantId: claim.participantId, deviceId: row.issued_by_device_id }),
      participant: Object.freeze({
        id: claim.participantId,
        consentVersion: row.consent_version,
        ownerKind: row.owner_kind,
      }),
    });
  });
}

async function readV12UploadOutcome(pool, schema, claim, principal, input) {
  const grants = schemaTable(schema) + '."device_upload_authorizations"';
  const chunks = schemaTable(schema) + '."telemetry_v12_chunks"';
  const manifests = schemaTable(schema) + '."telemetry_v12_day_manifests"';
  const typedRecords = schemaTable(schema) + '."telemetry_v12_typed_records"';
  let client;
  let transactionOpen = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '10000ms'");
    await client.query("SET LOCAL lock_timeout = '5000ms'");
    // Persistence locks the manifest before the upload grant. Preserve that
    // order here so an uncertain-commit readback cannot deadlock with the
    // in-flight staging transaction while both need those rows.
    const manifestResult = await client.query(
      "SELECT id FROM " + manifests + " "
        + "WHERE participant_id = $1 AND device_id = $2 AND chunk_day = $3::date "
        + "AND manifest_digest = $4 FOR UPDATE",
      [principal.participantId, principal.deviceId, input.day, input.manifestDigest],
    );
    const manifest = manifestResult.rows[0];
    if (!manifest) {
      await client.query("COMMIT");
      transactionOpen = false;
      return Object.freeze({ outcome: "manifest_missing", row: null });
    }
    // Waiting on the same grant after the manifest establishes that an
    // in-flight writer has either committed or rolled back before source-row
    // classification.
    const grantResult = await client.query(
      "SELECT state, consumed_contribution_id FROM " + grants + " "
        + "WHERE id = $1 AND participant_id = $2 AND issued_by_device_id = $3 FOR UPDATE",
      [claim.authorizationId, claim.participantId, principal.deviceId],
    );
    const grant = grantResult.rows[0];
    if (!grant) throw storageUnavailable();
    const result = await client.query(
      "SELECT chunk.id, chunk.chunk_id, chunk.chunk_digest, chunk.record_count, "
        + "chunk.device_upload_authorization_id, chunk.r2_key, manifest.id AS manifest_id, "
        + "manifest.participant_id, manifest.device_id, manifest.chunk_day::text AS chunk_day, "
        + "manifest.manifest_digest FROM " + chunks + " chunk "
        + "JOIN " + manifests + " manifest ON manifest.id = chunk.manifest_id "
        + "WHERE chunk.manifest_id = $1 AND (chunk.device_upload_authorization_id = $2 "
        + "OR chunk.id = $3 OR chunk.chunk_id = $4)",
      [manifest.id, claim.authorizationId, input.chunkRowId, input.chunkId],
    );
    const rows = result.rows;
    const attemptRow = rows.find((row) => row.device_upload_authorization_id === claim.authorizationId
      || row.id === input.chunkRowId || row.r2_key === input.objectKey);
    const matchingChunk = rows.find((row) => row.participant_id === principal.participantId
      && row.device_id === principal.deviceId && row.chunk_day === input.day
      && row.manifest_digest === input.manifestDigest && row.chunk_id === input.chunkId);
    let outcome = "absent";
    let selected = null;
    if (attemptRow) {
      selected = attemptRow;
      const exact = attemptRow.participant_id === principal.participantId
        && attemptRow.device_id === principal.deviceId
        && attemptRow.chunk_day === input.day
        && attemptRow.manifest_digest === input.manifestDigest
        && attemptRow.chunk_id === input.chunkId
        && attemptRow.chunk_digest === input.chunkDigest
        && Number(attemptRow.record_count) === input.recordCount
        && attemptRow.id === input.chunkRowId
        && attemptRow.r2_key === input.objectKey
        && attemptRow.device_upload_authorization_id === claim.authorizationId;
      if (exact) {
        const count = await client.query(
          "SELECT count(*) AS total FROM " + typedRecords + " WHERE chunk_id = $1",
          [attemptRow.id],
        );
        if (Number(count.rows[0]?.total) === input.recordCount) outcome = "committed";
        else outcome = "unknown";
      } else {
        outcome = "unknown";
      }
    } else if (matchingChunk) {
      selected = matchingChunk;
      if (matchingChunk.chunk_digest === input.chunkDigest
          && Number(matchingChunk.record_count) === input.recordCount) {
        const count = await client.query(
          "SELECT count(*) AS total FROM " + typedRecords + " WHERE chunk_id = $1",
          [matchingChunk.id],
        );
        outcome = Number(count.rows[0]?.total) === input.recordCount ? "replay" : "unknown";
      } else {
        outcome = "conflict";
      }
    } else if (grant.state === "consumed" || grant.consumed_contribution_id !== null) {
      outcome = "unknown";
    }
    await client.query("COMMIT");
    transactionOpen = false;
    return Object.freeze({ outcome, row: selected });
  } catch {
    if (transactionOpen) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve the sanitized failure. */ }
    }
    throw storageUnavailable();
  } finally {
    client?.release();
  }
}

async function retireUnreferencedV12Object(pool, schema, objectStore, input) {
  const pending = schemaTable(schema) + '."pending_objects"';
  const chunks = schemaTable(schema) + '."telemetry_v12_chunks"';
  const leaseId = crypto.randomUUID();
  const claimed = await withMutationClient(pool, async (client) => {
    const pendingResult = await client.query(
      "SELECT contribution_id, object_key, object_kind, reconciliation_state "
        + "FROM " + pending + " WHERE contribution_id = $1 FOR UPDATE",
      [input.chunkRowId],
    );
    if (!validPendingObject(pendingResult.rows[0], input.chunkRowId, input.objectKey)) return false;
    const reference = await client.query(
      "SELECT EXISTS (SELECT 1 FROM " + chunks + " "
        + "WHERE id = $1 OR r2_key = $2 OR device_upload_authorization_id = $3) AS referenced",
      [input.chunkRowId, input.objectKey, input.authorizationId],
    );
    if (reference.rows[0]?.referenced !== false) return false;
    const updated = await client.query(
      "UPDATE " + pending + " SET reconciliation_state = 'deleting', reconciliation_lease_id = $2 "
        + "WHERE contribution_id = $1 AND object_key = $3 "
        + "AND object_kind = 'telemetry_v12' AND reconciliation_state = 'registered' "
        + "RETURNING contribution_id",
      [input.chunkRowId, leaseId, input.objectKey],
    );
    return updated.rowCount === 1;
  });
  if (!claimed) return false;
  // An uncertain provider delete leaves a durable deleting journal row so a
  // reconciler can safely resume it; do not clear the row on rejection.
  try { await objectStore.delete(input.objectKey); } catch { throw storageUnavailable(); }
  const removed = await withMutationClient(pool, async (client) => {
    const reference = await client.query(
      "SELECT EXISTS (SELECT 1 FROM " + chunks + " "
        + "WHERE id = $1 OR r2_key = $2 OR device_upload_authorization_id = $3) AS referenced",
      [input.chunkRowId, input.objectKey, input.authorizationId],
    );
    if (reference.rows[0]?.referenced !== false) return false;
    const result = await client.query(
      "DELETE FROM " + pending + " WHERE contribution_id = $1 AND object_key = $2 "
        + "AND object_kind = 'telemetry_v12' AND reconciliation_state = 'deleting' "
        + "AND reconciliation_lease_id = $3 RETURNING contribution_id",
      [input.chunkRowId, input.objectKey, leaseId],
    );
    return result.rowCount === 1;
  });
  return removed;
}

function hasExactV12EnvelopeKeyOccurrences(raw) {
  const keys = [...raw.matchAll(/"([^"\\]+)"\s*:/gu)].map((match) => match[1]);
  const expected = [
    "schemaVersion", "synthetic", "keyId", "wrappedKey", "iv", "ciphertext",
  ].sort();
  return keys.length === expected.length
    && keys.sort().every((key, index) => key === expected[index]);
}

function v12ChunkReceipt(contributionId, manifestId, chunk, replayed) {
  return json(202, {
    schemaVersion: "telemetry-chunk-receipt-v1.2",
    contributionId,
    manifestId,
    chunkId: chunk.chunkId,
    chunkRevision: 1,
    status: "staged",
    replayed,
    recordCounts: { declared: chunk.records.length, accepted: chunk.records.length },
  }, replayed ? { "idempotency-replayed": "true" } : undefined);
}

// The pre-claim envelope check of the v1.2-only origin: an exact six-key
// envelope (400 ENVELOPE_INVALID otherwise), then the closed v1.2 contract.
function validateV12EnvelopeBeforeClaim(envelope, raw, validateTelemetryV12Envelope) {
  if (!hasExactV12EnvelopeKeyOccurrences(raw)) {
    throw Object.assign(new Error("ENVELOPE_INVALID"), { code: "ENVELOPE_INVALID", status: 400 });
  }
  validateTelemetryV12Envelope(envelope);
}

/**
 * The telemetry-envelope-v1.2 handler: everything the v1.2-only origin did
 * after the transport floor, unchanged. It decrypts and validates the staged
 * chunk, journals and writes the object, and persists the chunk; the persist
 * transaction consumes the claimed upload authorization (the receipt), and a
 * replay abandons it explicitly. It is therefore registered with
 * ownsReceipt: true, and the preamble records no receipt after it.
 */
function createPostgresTestV12ContributionHandler({
  primaryPool,
  objectStore,
  abandonPostgresDeviceUploadAuthorization,
  persistPostgresTypedV12StagedChunk,
  decryptSyntheticEnvelope,
  validateTelemetryV12StagedChunk,
  envelopePublicJwk,
  envelopePrivateJwk,
}) {
  return async function handlePostgresTestV12Contribution(
    body,
    _participant,
    _sourceDeviceId,
    claim,
    { principal, envelopeDigest, schema, markPersistStarted },
  ) {
    let input = null;
    const plaintext = await decryptSyntheticEnvelope(
      body.value, envelopePublicJwk, envelopePrivateJwk,
    );
    const chunk = await validateTelemetryV12StagedChunk(plaintext);
    const { day } = parseTelemetryV12ChunkId(chunk.chunkId);
    const chunkRowId = "chunk:" + crypto.randomUUID();
    const objectKey = "telemetry/v12-" + crypto.randomUUID();
    input = Object.freeze({
      authorizationId: claim.authorizationId,
      chunkRowId,
      objectKey,
      day,
      manifestDigest: chunk.manifestDigest,
      chunkId: chunk.chunkId,
      chunkDigest: chunk.chunkDigest,
      recordCount: chunk.records.length,
    });

    const prior = await readV12UploadOutcome(primaryPool, schema.primarySchema, claim, principal, input);
    if (prior.outcome === "manifest_missing") {
      throw Object.assign(new Error("TELEMETRY_MANIFEST_INCOMPLETE"), {
        code: "TELEMETRY_MANIFEST_INCOMPLETE", status: 409,
      });
    }
    if (prior.outcome === "replay" && prior.row) {
      const abandoned = await abandonPostgresDeviceUploadAuthorization(
        primaryPool, claim, principal, { schema },
      );
      if (!abandoned.abandoned) throw storageUnavailable();
      return v12ChunkReceipt(prior.row.id, prior.row.manifest_id, chunk, true);
    }
    if (prior.outcome === "conflict") {
      throw Object.assign(new Error("TELEMETRY_MANIFEST_CONFLICT"), {
        code: "TELEMETRY_MANIFEST_CONFLICT", status: 409,
      });
    }
    if (prior.outcome !== "absent") throw storageUnavailable();

    await registerPendingV12Object(
      primaryPool, schema.primarySchema, chunkRowId, objectKey, new Date().toISOString(),
    );
    try {
      await objectStore.put(objectKey, body.bytes, {
        contentType: "application/json",
        customMetadata: {
          contributionId: chunkRowId,
          schemaVersion: TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION,
          plaintextSchemaVersion: chunk.schemaVersion,
          synthetic: "false",
        },
      });
    } catch {
      // A failed PUT may have reached GCS. Keep its durable journal row; the
      // eventual cleanup path, not this request, resolves object presence.
      throw storageUnavailable();
    }

    markPersistStarted();
    try {
      const result = await persistPostgresTypedV12StagedChunk(
        primaryPool,
        principal,
        chunk,
        {
          chunkRowId,
          r2Key: objectKey,
          envelopeDigest,
          deviceUploadAuthorizationId: claim.authorizationId,
        },
        Date.now(),
        { schema },
      );
      if (result.replay) {
        const abandoned = await abandonPostgresDeviceUploadAuthorization(
          primaryPool, claim, principal, { schema },
        );
        if (!abandoned.abandoned) throw storageUnavailable();
        if (result.contributionId !== chunkRowId) {
          try {
            const retired = await retireUnreferencedV12Object(
              primaryPool, schema.primarySchema, objectStore, input,
            );
            if (!retired) throw storageUnavailable();
          } catch { throw storageUnavailable(); }
        }
      }
      return v12ChunkReceipt(
        result.contributionId, result.manifestId, chunk, result.replay,
      );
    } catch (error) {
      let outcome;
      try {
        outcome = await readV12UploadOutcome(primaryPool, schema.primarySchema, claim, principal, input);
      } catch {
        // The transaction or the readback is still uncertain. Retain both
        // object and journal so a later reconciliation can decide safely.
        throw storageUnavailable();
      }
      if (outcome.outcome === "committed" && outcome.row) {
        return v12ChunkReceipt(outcome.row.id, outcome.row.manifest_id, chunk, false);
      }
      if (outcome.outcome === "replay" && outcome.row) {
        const abandoned = await abandonPostgresDeviceUploadAuthorization(
          primaryPool, claim, principal, { schema },
        );
        if (!abandoned.abandoned) throw storageUnavailable();
        try {
          const retired = await retireUnreferencedV12Object(
            primaryPool, schema.primarySchema, objectStore, input,
          );
          if (!retired) throw storageUnavailable();
        } catch { throw storageUnavailable(); }
        return v12ChunkReceipt(outcome.row.id, outcome.row.manifest_id, chunk, true);
      }
      if (outcome.outcome === "absent" || outcome.outcome === "conflict") {
        const abandoned = await abandonPostgresDeviceUploadAuthorization(
          primaryPool, claim, principal, { schema },
        );
        if (!abandoned.abandoned) throw storageUnavailable();
        try {
          const retired = await retireUnreferencedV12Object(
            primaryPool, schema.primarySchema, objectStore, input,
          );
          if (!retired) throw storageUnavailable();
        } catch { throw storageUnavailable(); }
        if (outcome.outcome === "conflict") {
          throw Object.assign(new Error("TELEMETRY_MANIFEST_CONFLICT"), {
            code: "TELEMETRY_MANIFEST_CONFLICT", status: 409,
          });
        }
        if (Number.isSafeInteger(error?.status) && error.status >= 400 && error.status < 500) {
          throw error;
        }
      }
      throw storageUnavailable();
    }
  };
}

/**
 * POST /api/v1/contributions. One route with a shared preamble, then a
 * dispatch on the envelope's schemaVersion through the envelope registry.
 *
 * Preamble, in d43c8f92 handleContribution's order (index.ts:3337-3347): the
 * upload-ingress bindings (503 ADMISSION_CONFIGURATION_INVALID), the
 * contributionRequestPreflight fence (index.ts:621-644: session cookie,
 * content type, declared length, missing body, Upload header shape), the
 * upload-ingress limiter (index.ts:3342, replayed from the edge behind the
 * edge-test boundary) before a byte of the body is read; then the bounded
 * body and fatal UTF-8 JSON; the envelope's registered pre-claim check
 * (an unregistered version gets the v1.2-only origin's refusal, before any
 * claim); then the upload-authorization claim, the claimed principal and
 * participant, the processing control and the format's transport floor
 * (there is no deletion-ledger tombstone read: a deleted participant has no
 * claimable authorization). Only then does the registered handler run. As in
 * d43c8f92 handleContribution, no upload draws the device_sync attempt
 * limiter (RECOVERY, one global 20-per-minute key shared with every sync
 * read): production meters this route with the upload-ingress limiters and
 * the per-device chunk windows, and a shipped client reads 429
 * ATTEMPT_LIMIT_REACHED here as a service failure that stalls its backfill.
 * After the handler returns, the preamble records the receipt
 * against the response's contributionId (d43c8f92 handleContribution's
 * recordDeviceUploadReceipt), unless the registration owns its receipt.
 * Until the handler marks its persist started, any failure abandons the
 * claim; a failure after the handler returned (reading or recording the
 * receipt) abandons it too, which the abandon makes a no-op once the claim
 * is consumed or a contribution references it.
 */
async function handlePostgresTestContribution({
  request,
  admissionEnv,
  assertUploadIngressRequestAllowed,
  primaryPool,
  schema,
  claimPostgresDeviceUploadAuthorization,
  abandonPostgresDeviceUploadAuthorization,
  recordPostgresDeviceUploadReceipt,
  sha256Hex,
  readBoundedRequestBody,
  maxRequestBytes,
  envelopes,
  formats,
  refuseUnregisteredEnvelope,
  handlerContext,
}) {
  let claim = null;
  let principal = null;
  let persistStarted = false;
  let handlerReturned = false;
  try {
    // d43c8f92 index.ts:3339 assertUploadIngressRateLimitBindings.
    if (typeof assertUploadIngressRequestAllowed !== "function"
        || !isRateLimitBinding(admissionEnv?.UPLOAD_INGRESS_REQUEST_RATE_LIMIT)
        || !isRateLimitBinding(admissionEnv?.UPLOAD_INGRESS_CLIENT_RATE_LIMIT)) {
      throw Object.assign(new Error("ADMISSION_CONFIGURATION_INVALID"), {
        code: "ADMISSION_CONFIGURATION_INVALID", status: 503,
      });
    }
    // d43c8f92 index.ts:621-644 contributionRequestPreflight.
    if (hasSessionCookie(request.headers.get("cookie"))) {
      throw Object.assign(new Error("UPLOAD_AUTH_INVALID"), {
        code: "UPLOAD_AUTH_INVALID", status: 401,
      });
    }
    const authorization = request.headers.get("authorization");
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "application/json") {
      throw Object.assign(new Error("CONTENT_TYPE_INVALID"), {
        code: "CONTENT_TYPE_INVALID", status: 415,
      });
    }
    const declared = request.headers.get("content-length");
    if (declared !== null) {
      const length = Number(declared);
      if (!Number.isSafeInteger(length) || length < 0) {
        throw Object.assign(new Error("BODY_INVALID"), { code: "BODY_INVALID", status: 400 });
      }
      if (length > maxRequestBytes) {
        throw Object.assign(new Error("BODY_TOO_LARGE"), { code: "BODY_TOO_LARGE", status: 413 });
      }
    }
    if (!request.body) {
      throw Object.assign(new Error("BODY_INVALID"), { code: "BODY_INVALID", status: 400 });
    }
    if (typeof authorization !== "string" || !DEVICE_UPLOAD_AUTHORIZATION_HEADER.test(authorization)) {
      throw Object.assign(new Error("UPLOAD_AUTH_INVALID"), {
        code: "UPLOAD_AUTH_INVALID", status: 401,
      });
    }
    // d43c8f92 index.ts:3342: the address-keyed ingress limiter, before the
    // body. As there, no upload draws the device_sync attempt limiter.
    await assertUploadIngressRequestAllowed(
      admissionEnv.UPLOAD_INGRESS_REQUEST_RATE_LIMIT,
      admissionEnv.UPLOAD_INGRESS_CLIENT_RATE_LIMIT,
      request,
      admissionEnv,
    );
    const bytes = await readBoundedRequestBody(request, maxRequestBytes, {
      maximumTotalMilliseconds: 15_000,
      maximumIdleMilliseconds: 5_000,
    });
    let raw;
    let envelope;
    try {
      raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
      envelope = JSON.parse(raw);
    } catch {
      throw Object.assign(new Error("BODY_INVALID"), { code: "BODY_INVALID", status: 400 });
    }
    const declaredVersion = envelope !== null && typeof envelope === "object"
      && !Array.isArray(envelope) && Object.hasOwn(envelope, "schemaVersion")
      ? envelope.schemaVersion : undefined;
    const registration = envelopes.resolveRegistration(declaredVersion);
    if (registration === null) {
      refuseUnregisteredEnvelope(envelope, raw);
      throw Object.assign(new Error("ENVELOPE_INVALID"), { code: "ENVELOPE_INVALID", status: 400 });
    }
    registration.validateEnvelope?.(envelope, raw);
    const format = formats.resolve(contributionTransportSchemaVersion(registration.schemaVersion));
    if (format === null) throw storageUnavailable();
    const envelopeDigest = await sha256Hex(bytes);
    const bodyBytes = bytes.byteLength;
    // d43c8f92 claims every envelope under the shared v1.1 accountless grant
    // chain (device-auth.ts claimDeviceUploadAuthorization). v1.2 keeps this
    // origin's stricter default, which also requires the typed-v1.2 grant;
    // any other registered envelope is claimed exactly as the Worker claims
    // it, so a shipped accountless client holding only the v1.1 grant chain
    // is not refused 401 UPLOAD_AUTH_INVALID.
    claim = await claimPostgresDeviceUploadAuthorization(
      primaryPool,
      authorization,
      { envelopeDigest, bodyBytes, contentType },
      registration.schemaVersion === TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION
        ? { schema }
        : { schema, accountlessAuthorizationVersion: "v1.1" },
    );
    const claimed = await readClaimedContributionPrincipal(
      primaryPool, schema.primarySchema, claim, envelopeDigest, bodyBytes,
    );
    principal = claimed.principal;
    await assertPostgresProcessingEnabled(primaryPool, schema.primarySchema);
    await format.assertUploadAllowed(primaryPool, principal, Date.now(), { schema });

    const response = await registration.handler(
      Object.freeze({ bytes, raw, value: envelope }),
      claimed.participant,
      principal.deviceId,
      claim,
      Object.freeze({
        ...handlerContext,
        request,
        envelopeDigest,
        bodyBytes,
        contentType,
        principal,
        schema,
        markPersistStarted() { persistStarted = true; },
      }),
    );
    if (registration.ownsReceipt) return response;
    handlerReturned = true;
    let contributionId;
    try {
      contributionId = (await response.clone().json())?.contributionId;
    } catch { /* A receipt without a JSON body has no contributionId. */ }
    if (typeof contributionId !== "string") {
      throw Object.assign(new Error("INTERNAL_ERROR"), { code: "INTERNAL_ERROR", status: 500 });
    }
    await recordPostgresDeviceUploadReceipt(
      primaryPool, claim.authorizationId, contributionId, { schema },
    );
    return response;
  } catch (error) {
    if (claim && principal && (!persistStarted || handlerReturned)) {
      try {
        await abandonPostgresDeviceUploadAuthorization(primaryPool, claim, principal, { schema });
      } catch { /* A failed revocation leaves the bounded claim lease to expire. */ }
      // Do not delete after a PUT error: the provider may have stored bytes
      // despite a lost response. Its registered row remains recoverable.
    }
    throw error;
  }
}

async function readPostgresCollectionControls(pool, schema) {
  const table = `${schemaTable(schema)}."collection_controls"`;
  return withReadOnlyClient(pool, async (client) => {
    const result = await client.query(
      `SELECT revision, control_state, enrollment_enabled, upload_registration_enabled,
              processing_enabled, publication_enabled
         FROM ${table}
        WHERE singleton = 1`,
    );
    if (result.rows.length !== 1) throw storageUnavailable();
    const row = result.rows[0];
    const revision = typeof row.revision === "number" ? row.revision : Number(row.revision);
    const flags = [row.enrollment_enabled, row.upload_registration_enabled,
      row.processing_enabled, row.publication_enabled];
    if (!Number.isSafeInteger(revision) || revision < 1
        || !["operational", "degraded", "contained"].includes(row.control_state)
        || flags.some((flag) => typeof flag !== "boolean")) {
      throw storageUnavailable();
    }
    const enabledCount = flags.filter(Boolean).length;
    if ((row.control_state === "operational" && enabledCount !== 4)
        || (row.control_state === "contained" && enabledCount !== 0)
        || (row.control_state === "degraded" && (enabledCount === 0 || enabledCount === 4))) {
      throw storageUnavailable();
    }
    return row;
  });
}

async function assertPostgresProcessingEnabled(pool, schema) {
  const controls = await readPostgresCollectionControls(pool, schema);
  if (controls.processing_enabled !== true) {
    throw Object.assign(new Error("PROCESSING_DISABLED"), {
      code: "PROCESSING_DISABLED",
      status: 503,
    });
  }
}

async function assertPostgresUploadRegistrationEnabled(pool, schema) {
  const controls = await readPostgresCollectionControls(pool, schema);
  if (controls.upload_registration_enabled !== true) {
    throw Object.assign(new Error("UPLOAD_REGISTRATION_DISABLED"), {
      code: "UPLOAD_REGISTRATION_DISABLED",
      status: 503,
    });
  }
}

async function assertPostgresEnrollmentEnabled(pool, schema) {
  const controls = await readPostgresCollectionControls(pool, schema);
  if (controls.enrollment_enabled !== true) {
    throw Object.assign(new Error("COLLECTION_ENROLLMENT_DISABLED"), {
      code: "COLLECTION_ENROLLMENT_DISABLED",
      status: 503,
    });
  }
}

async function readAccountlessJson(request, maximumBytes, readBody, parse) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw Object.assign(new Error("CONTENT_TYPE_INVALID"), {
      code: "CONTENT_TYPE_INVALID", status: 415,
    });
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw Object.assign(new Error("BODY_INVALID"), { code: "BODY_INVALID", status: 400 });
    }
    if (length > maximumBytes) {
      throw Object.assign(new Error("BODY_TOO_LARGE"), { code: "BODY_TOO_LARGE", status: 413 });
    }
  }
  const bytes = await readBody(request, maximumBytes, {
    maximumTotalMilliseconds: 15_000,
    maximumIdleMilliseconds: 5_000,
  });
  try {
    return parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch (error) {
    if (Number.isSafeInteger(error?.status) && typeof error?.code === "string") throw error;
    throw Object.assign(new Error("BODY_INVALID"), { code: "BODY_INVALID", status: 400 });
  }
}

async function readV12StagedChunkVector(pool, schema, principal, manifestId) {
  const table = `${schemaTable(schema)}."telemetry_v12_chunks"`;
  const manifests = `${schemaTable(schema)}."telemetry_v12_day_manifests"`;
  return withReadOnlyClient(pool, async (client) => {
    const result = await client.query(
      `SELECT chunk.chunk_id, chunk.chunk_digest, chunk.record_count
         FROM ${table} chunk
         JOIN ${manifests} manifest ON manifest.id = chunk.manifest_id
        WHERE manifest.id = $1 AND manifest.participant_id = $2 AND manifest.device_id = $3
        ORDER BY chunk.stream, chunk.chunk_seq
        LIMIT $4`,
      [manifestId, principal.participantId, principal.deviceId, MAX_V12_DAY_CHUNKS + 1],
    );
    if (result.rows.length > MAX_V12_DAY_CHUNKS) throw storageUnavailable();
    return result.rows.map((row) => {
      if (typeof row.chunk_id !== "string" || !DIGEST.test(row.chunk_digest)
          || !Number.isSafeInteger(row.record_count) || row.record_count < 1 || row.record_count > 200) {
        throw storageUnavailable();
      }
      return {
        chunkId: row.chunk_id,
        chunkDigest: row.chunk_digest,
        recordCount: row.record_count,
      };
    });
  });
}

/**
 * Private test dispatch. It admits the health proof and bounded v1/v1.2 sync
 * paths: legacy cursor reads, capabilities, day candidates, domain
 * predecessor/activation, manifest registration, upload grants, and chunk writes.
 */
export function createPostgresTestV12DayManifestDispatch({
  primaryPool,
  schemaOptions,
  expectedMigrations,
  privateOrigin,
  healthDispatch,
  accountlessAuthority,
  deviceCredentialRenewalAuthority,
  admissionEnv,
  assertAdmissionBindings,
  assertAttemptAllowed,
  assertUploadAuthorizationBindings,
  assertUploadAuthorizationAllowed,
  assertUploadIngressRequestAllowed = null,
  authenticatePostgresDevice,
  disconnectPostgresAuthenticatedDevice,
  readPostgresDeviceSyncState,
  readPostgresDeviceSyncManifest,
  readPostgresDeviceSyncCapabilities,
  readPostgresDeviceSyncV12Capabilities,
  readPostgresV12DayCandidates,
  readPostgresTelemetryV12EffectivePage,
  publicEnvelopeKey,
  sourceNamespace,
  createPostgresTypedV12Domain,
  assertPostgresV12UploadAllowed,
  createPostgresDeviceUploadAuthorization,
  registerPostgresTypedV12DayManifest,
  claimPostgresDeviceUploadAuthorization,
  abandonPostgresDeviceUploadAuthorization,
  persistPostgresTypedV12StagedChunk,
  decryptSyntheticEnvelope,
  validateTelemetryV12Envelope,
  validateTelemetryV12StagedChunk,
  sha256Hex,
  objectStore,
  envelopePublicJwk,
  envelopePrivateJwk,
  readBoundedRequestBody,
  maxRequestBytes,
  contributionEnvelopes = [],
  uploadAuthorizationFormats = {},
  recordPostgresDeviceUploadReceipt = null,
}) {
  if (primaryPool === null || typeof primaryPool !== "object"
      || typeof primaryPool.connect !== "function"
      || typeof healthDispatch !== "function"
      || typeof assertAdmissionBindings !== "function"
      || typeof assertAttemptAllowed !== "function"
      || typeof assertUploadAuthorizationBindings !== "function"
      || typeof assertUploadAuthorizationAllowed !== "function"
      || (assertUploadIngressRequestAllowed !== null
        && typeof assertUploadIngressRequestAllowed !== "function")
      || typeof authenticatePostgresDevice !== "function"
      || typeof disconnectPostgresAuthenticatedDevice !== "function"
      || typeof readPostgresDeviceSyncCapabilities !== "function"
      || typeof assertPostgresV12UploadAllowed !== "function"
      || typeof createPostgresDeviceUploadAuthorization !== "function"
      || typeof registerPostgresTypedV12DayManifest !== "function"
      || typeof claimPostgresDeviceUploadAuthorization !== "function"
      || typeof abandonPostgresDeviceUploadAuthorization !== "function"
      || typeof persistPostgresTypedV12StagedChunk !== "function"
      || typeof decryptSyntheticEnvelope !== "function"
      || typeof validateTelemetryV12Envelope !== "function"
      || typeof validateTelemetryV12StagedChunk !== "function"
      || typeof sha256Hex !== "function"
      || objectStore === null || typeof objectStore !== "object"
      || typeof objectStore.put !== "function"
      || typeof objectStore.delete !== "function"
      || typeof envelopePublicJwk !== "string" || envelopePublicJwk.length < 1
      || typeof envelopePrivateJwk !== "string" || envelopePrivateJwk.length < 1
      || typeof readBoundedRequestBody !== "function"
      || typeof readPostgresV12DayCandidates !== "function"
      || typeof publicEnvelopeKey !== "function"
      || typeof createPostgresTypedV12Domain !== "function"
      || typeof readPostgresTelemetryV12EffectivePage !== "function"
      || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) {
    configurationError("POSTGRES_TEST_V12_DISPATCH_CONFIGURATION_INVALID");
  }
  const schemas = validatedSchemas(schemaOptions);
  const expected = validatedExpectedManifest(expectedMigrations);
  if (!isAllowedPostgresTestOrigin(privateOrigin)) {
    configurationError("POSTGRES_TEST_PRIVATE_ORIGIN_INVALID");
  }
  if (accountlessAuthority !== undefined
      && (accountlessAuthority === null || typeof accountlessAuthority !== "object"
        || typeof accountlessAuthority.authenticateV12Grant !== "function"
        || typeof accountlessAuthority.enroll !== "function"
        || typeof accountlessAuthority.createOwner !== "function"
        || typeof accountlessAuthority.grantV12 !== "function"
        || typeof accountlessAuthority.renew !== "function"
        || typeof accountlessAuthority.parseEnrollmentJson !== "function"
        || typeof accountlessAuthority.parseOwnershipJson !== "function"
        || typeof accountlessAuthority.parseV12AuthorizationJson !== "function"
        || typeof accountlessAuthority.parseRenewalJson !== "function"
        || accountlessAuthority.maxEnrollmentBytes !== 512
        || accountlessAuthority.maxOwnershipBytes !== 512
        || accountlessAuthority.maxRenewalBytes !== 512)) {
    configurationError("POSTGRES_TEST_ACCOUNTLESS_AUTHORITY_CONFIGURATION_INVALID");
  }
  if (deviceCredentialRenewalAuthority !== undefined
      && (deviceCredentialRenewalAuthority === null
        || typeof deviceCredentialRenewalAuthority !== "object"
        || typeof deviceCredentialRenewalAuthority.renew !== "function"
        || typeof deviceCredentialRenewalAuthority.parseRequest !== "function"
        || deviceCredentialRenewalAuthority.maxRequestBytes !== 2 * 1024 * 1024)) {
    configurationError("POSTGRES_TEST_DEVICE_CREDENTIAL_RENEWAL_CONFIGURATION_INVALID");
  }
  // POST /api/v1/contributions dispatches on the envelope schemaVersion and
  // POST /api/v1/device/upload-authorizations on telemetrySchemaVersion. This
  // origin registers v1.2 itself; contributionEnvelopes and
  // uploadAuthorizationFormats add other versions, never replace v1.2, and
  // must pair exactly (assertContributionEnvelopeFormats).
  if (!Array.isArray(contributionEnvelopes)
      || uploadAuthorizationFormats === null || typeof uploadAuthorizationFormats !== "object"
      || Array.isArray(uploadAuthorizationFormats)
      || (uploadAuthorizationFormats instanceof Map
        ? uploadAuthorizationFormats.has(TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION)
        : Object.hasOwn(uploadAuthorizationFormats, TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION))) {
    configurationError("POSTGRES_TEST_CONTRIBUTION_REGISTRY_CONFIGURATION_INVALID");
  }
  const envelopes = createContributionEnvelopeRegistry([
    registerContributionEnvelope(
      TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION,
      createPostgresTestV12ContributionHandler({
        primaryPool,
        objectStore,
        abandonPostgresDeviceUploadAuthorization,
        persistPostgresTypedV12StagedChunk,
        decryptSyntheticEnvelope,
        validateTelemetryV12StagedChunk,
        envelopePublicJwk,
        envelopePrivateJwk,
      }),
      {
        validateEnvelope: (envelope, raw) =>
          validateV12EnvelopeBeforeClaim(envelope, raw, validateTelemetryV12Envelope),
        ownsReceipt: true,
      },
    ),
    ...contributionEnvelopes,
  ]);
  const formats = createUploadAuthorizationFormats(new Map([
    [TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION, { assertUploadAllowed: assertPostgresV12UploadAllowed }],
    ...(uploadAuthorizationFormats instanceof Map
      ? uploadAuthorizationFormats.entries()
      : Object.entries(uploadAuthorizationFormats)),
  ]));
  assertContributionEnvelopeFormats(envelopes, formats);
  // Every registration that leaves the receipt to the preamble needs the
  // recorder, recordPostgresDeviceUploadReceipt(pool, authorizationId,
  // contributionId, { schema }) (d43c8f92 recordDeviceUploadReceipt); v1.2
  // owns its receipt, so the v1.2-only origin needs none.
  if ((recordPostgresDeviceUploadReceipt !== null
        && typeof recordPostgresDeviceUploadReceipt !== "function")
      || (recordPostgresDeviceUploadReceipt === null
        && envelopes.schemaVersions.some(
          (version) => !envelopes.resolveRegistration(version).ownsReceipt,
        ))) {
    configurationError("POSTGRES_TEST_CONTRIBUTION_RECEIPT_CONFIGURATION_INVALID");
  }
  // The v1.2-only origin refused every other envelope inside its pre-claim
  // v1.2 check, before any claim; an unregistered version keeps exactly that
  // refusal (status, code and body).
  const refuseUnregisteredEnvelope = (envelope, raw) =>
    validateV12EnvelopeBeforeClaim(envelope, raw, validateTelemetryV12Envelope);
  const contributionHandlerContext = Object.freeze({
    primaryPool,
    objectStore,
    envelopePublicJwk,
    envelopePrivateJwk,
    sourceNamespace,
  });

  return async function dispatchPostgresTestV12DayManifest(request) {
    let url;
    try { url = new URL(request.url); } catch {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }
    if (url.origin !== privateOrigin) {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      return healthDispatch(request);
    }
    const envelopeKeyPath = url.pathname === ENVELOPE_KEY_PATH;
    const envelopeKeyRoute = envelopeKeyPath && request.method === "GET";
    const manifestPath = url.pathname === V12_DAY_MANIFEST_PATH;
    const manifestRoute = manifestPath && request.method === "POST";
    const manifestReadRoute = manifestPath && request.method === "GET";
    const uploadAuthorizationRoute = request.method === "POST"
      && url.pathname === DEVICE_UPLOAD_AUTHORIZATION_PATH;
    const disconnectPath = url.pathname === DEVICE_DISCONNECT_PATH;
    const disconnectRoute = disconnectPath && request.method === "POST";
    const contributionRoute = request.method === "POST"
      && url.pathname === CONTRIBUTIONS_PATH;
    const syncStatePath = url.pathname === DEVICE_SYNC_STATE_PATH;
    const syncManifestPath = url.pathname === DEVICE_SYNC_MANIFEST_PATH;
    const syncCapabilitiesPath = url.pathname === DEVICE_SYNC_CAPABILITIES_PATH;
    const syncCapabilitiesV12Path = url.pathname === DEVICE_SYNC_CAPABILITIES_V12_PATH;
    const v12DomainPredecessorPath = url.pathname === V12_DOMAIN_PREDECESSOR_PATH;
    const v12DomainActivatePath = url.pathname === V12_DOMAIN_ACTIVATE_PATH;
    const v12EffectivePagePath = url.pathname === V12_EFFECTIVE_PAGE_PATH;
    const accountlessEnrollmentPath = url.pathname === ACCOUNTLESS_ENROLLMENT_PATH;
    const accountlessOwnershipPath = url.pathname === ACCOUNTLESS_OWNERSHIP_PATH;
    const accountlessV12AuthorizationPath = url.pathname === ACCOUNTLESS_V12_AUTHORIZATION_PATH;
    const accountlessRenewalPath = url.pathname === ACCOUNTLESS_RENEWAL_PATH;
    const deviceCredentialRenewalPath = url.pathname === DEVICE_CREDENTIAL_RENEWAL_PATH;
    const accountlessEnrollmentRoute = accountlessEnrollmentPath && request.method === "POST";
    const accountlessOwnershipRoute = accountlessOwnershipPath && request.method === "POST";
    const accountlessV12AuthorizationRoute = accountlessV12AuthorizationPath
      && request.method === "POST";
    const accountlessRenewalRoute = accountlessRenewalPath && request.method === "POST";
    const deviceCredentialRenewalRoute = deviceCredentialRenewalPath && request.method === "POST";
    const syncStateRoute = syncStatePath && request.method === "GET";
    const syncManifestRoute = syncManifestPath && request.method === "GET";
    const syncCapabilitiesRoute = syncCapabilitiesPath && request.method === "GET";
    const syncCapabilitiesV12Route = syncCapabilitiesV12Path && request.method === "GET";
    const v12DomainPredecessorRoute = v12DomainPredecessorPath && request.method === "POST";
    const v12DomainActivateRoute = v12DomainActivatePath && request.method === "POST";
    const v12EffectivePageRoute = v12EffectivePagePath && request.method === "GET";
    if (envelopeKeyPath && request.method !== "GET") {
      return routeError(Object.assign(new Error("METHOD_NOT_ALLOWED"), {
        code: "METHOD_NOT_ALLOWED", status: 405, responseHeaders: { allow: "GET" },
      }), crypto.randomUUID());
    }
    if (manifestPath && !manifestRoute && !manifestReadRoute) {
      return routeError(Object.assign(new Error("METHOD_NOT_ALLOWED"), {
        code: "METHOD_NOT_ALLOWED", status: 405, responseHeaders: { allow: "GET, POST" },
      }), crypto.randomUUID());
    }
    if ((syncStatePath || syncManifestPath || syncCapabilitiesPath || syncCapabilitiesV12Path)
        && request.method !== "GET") {
      return routeError(Object.assign(new Error("METHOD_NOT_ALLOWED"), {
        code: "METHOD_NOT_ALLOWED", status: 405, responseHeaders: { allow: "GET" },
      }), crypto.randomUUID());
    }
    if (disconnectPath && request.method !== "POST") {
      return routeError(Object.assign(new Error("METHOD_NOT_ALLOWED"), {
        code: "METHOD_NOT_ALLOWED", status: 405, responseHeaders: { allow: "POST" },
      }), crypto.randomUUID());
    }
    if ((v12DomainPredecessorPath || v12DomainActivatePath)
        && request.method !== "POST") {
      return routeError(Object.assign(new Error("METHOD_NOT_ALLOWED"), {
        code: "METHOD_NOT_ALLOWED", status: 405, responseHeaders: { allow: "POST" },
      }), crypto.randomUUID());
    }
    if (v12EffectivePagePath && request.method !== "GET") {
      return routeError(Object.assign(new Error("METHOD_NOT_ALLOWED"), {
        code: "METHOD_NOT_ALLOWED", status: 405, responseHeaders: { allow: "GET" },
      }), crypto.randomUUID());
    }
    if ((accountlessEnrollmentPath || accountlessOwnershipPath || accountlessV12AuthorizationPath
      || accountlessRenewalPath)
        && request.method !== "POST") {
      return routeError(Object.assign(new Error("METHOD_NOT_ALLOWED"), {
        code: "METHOD_NOT_ALLOWED", status: 405, responseHeaders: { allow: "POST" },
      }), crypto.randomUUID());
    }
    if (deviceCredentialRenewalPath && request.method !== "POST") {
      return routeError(Object.assign(new Error("METHOD_NOT_ALLOWED"), {
        code: "METHOD_NOT_ALLOWED", status: 405, responseHeaders: { allow: "POST" },
      }), crypto.randomUUID());
    }
    // d43c8f92 index.ts:710, 740, 767 and 842: every accountless route
    // refuses a browser session cookie (not any cookie) with AUTH_INVALID.
    if ((accountlessEnrollmentPath || accountlessOwnershipPath || accountlessV12AuthorizationPath
      || accountlessRenewalPath)
        && hasSessionCookie(request.headers.get("cookie"))) {
      return routeError(Object.assign(new Error("AUTH_INVALID"), {
        code: "AUTH_INVALID", status: 401,
      }), crypto.randomUUID());
    }
    if ((!envelopeKeyRoute && !manifestRoute && !manifestReadRoute
        && !uploadAuthorizationRoute && !disconnectRoute && !contributionRoute
        && !syncStateRoute && !syncManifestRoute && !syncCapabilitiesRoute && !syncCapabilitiesV12Route
        && !v12DomainPredecessorRoute && !v12DomainActivateRoute
        && !v12EffectivePageRoute && !accountlessEnrollmentRoute
        && !accountlessOwnershipRoute && !accountlessV12AuthorizationRoute
        && !accountlessRenewalRoute && !deviceCredentialRenewalRoute)
        || (url.search && !envelopeKeyRoute && !manifestReadRoute
          && !disconnectPath && !syncStatePath && !syncManifestPath
          && !syncCapabilitiesPath && !syncCapabilitiesV12Path
          && !v12EffectivePageRoute)) {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }
    if ((accountlessEnrollmentRoute || accountlessOwnershipRoute || accountlessV12AuthorizationRoute
      || accountlessRenewalRoute)
        && !accountlessAuthority) {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }
    if (deviceCredentialRenewalRoute && !deviceCredentialRenewalAuthority) {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }

    const requestId = crypto.randomUUID();
    try {
      // Like the Worker route, envelope-key is public configuration projection
      // and must remain available without opening the database pool.
      if (envelopeKeyRoute) return json(200, publicEnvelopeKey(envelopePublicJwk));

      const primaryReceipt = await readSchemaReceipt(primaryPool, schemas.primary, expected);
      if (primaryReceipt !== "current") {
        throw storageUnavailable();
      }

      assertAdmissionBindings(admissionEnv);
      const schema = Object.freeze({
        primarySchema: schemas.primary,
      });
      if (accountlessEnrollmentRoute) {
        const mode = admissionEnv.ACCOUNTLESS_ENROLLMENT_MODE;
        if (mode === undefined || mode === "disabled") {
          throw Object.assign(new Error("ACCOUNTLESS_ENROLLMENT_DISABLED"), {
            code: "ACCOUNTLESS_ENROLLMENT_DISABLED", status: 503,
          });
        }
        if (mode !== "enabled") {
          throw Object.assign(new Error("ADMISSION_CONFIGURATION_INVALID"), {
            code: "ADMISSION_CONFIGURATION_INVALID", status: 503,
          });
        }
        await assertPostgresEnrollmentEnabled(primaryPool, schemas.primary);
        await assertAttemptAllowed(
          admissionEnv.ENROLLMENT_RATE_LIMIT,
          admissionEnv.CLIENT_ATTEMPT_RATE_LIMIT,
          request,
          admissionEnv,
          "enrollment",
        );
        const body = await readAccountlessJson(
          request, accountlessAuthority.maxEnrollmentBytes, readBoundedRequestBody,
          accountlessAuthority.parseEnrollmentJson,
        );
        const result = await accountlessAuthority.enroll(primaryPool, body, { schema });
        return json(result.status, result.response);
      }
      if (accountlessRenewalRoute) {
        const enrollmentMode = admissionEnv.ACCOUNTLESS_ENROLLMENT_MODE;
        if (enrollmentMode === undefined || enrollmentMode === "disabled") {
          throw Object.assign(new Error("ACCOUNTLESS_ENROLLMENT_DISABLED"), {
            code: "ACCOUNTLESS_ENROLLMENT_DISABLED", status: 503,
          });
        }
        if (enrollmentMode !== "enabled") {
          throw Object.assign(new Error("ADMISSION_CONFIGURATION_INVALID"), {
            code: "ADMISSION_CONFIGURATION_INVALID", status: 503,
          });
        }
        const ownershipMode = admissionEnv.ACCOUNTLESS_OWNERSHIP_MODE;
        if (ownershipMode === undefined || ownershipMode === "disabled") {
          throw Object.assign(new Error("ACCOUNTLESS_OWNERSHIP_DISABLED"), {
            code: "ACCOUNTLESS_OWNERSHIP_DISABLED", status: 503,
          });
        }
        if (ownershipMode !== "enabled") {
          throw Object.assign(new Error("ACCOUNTLESS_OWNERSHIP_CONFIGURATION_INVALID"), {
            code: "ACCOUNTLESS_OWNERSHIP_CONFIGURATION_INVALID", status: 503,
          });
        }
        await assertPostgresUploadRegistrationEnabled(primaryPool, schemas.primary);
        await assertAttemptAllowed(
          admissionEnv.RECOVERY_RATE_LIMIT,
          admissionEnv.CLIENT_ATTEMPT_RATE_LIMIT,
          request,
          admissionEnv,
          "accountless_renewal",
        );
        const body = await readAccountlessJson(
          request,
          accountlessAuthority.maxRenewalBytes,
          readBoundedRequestBody,
          accountlessAuthority.parseRenewalJson,
        );
        return json(200, await accountlessAuthority.renew(
          primaryPool, request.headers.get("authorization"), body, { schema },
        ));
      }
      if (deviceCredentialRenewalRoute) {
        // d43c8f92 index.ts:2224-2236: limiter, upload-registration control,
        // then any cookie refused.
        await assertAttemptAllowed(
          admissionEnv.RECOVERY_RATE_LIMIT,
          admissionEnv.CLIENT_ATTEMPT_RATE_LIMIT,
          request,
          admissionEnv,
          "device_credential_renew",
        );
        await assertPostgresUploadRegistrationEnabled(primaryPool, schemas.primary);
        if (request.headers.has("cookie")) {
          throw Object.assign(new Error("DEVICE_AUTH_INVALID"), {
            code: "DEVICE_AUTH_INVALID", status: 401,
          });
        }
        const body = await readAccountlessJson(
          request,
          deviceCredentialRenewalAuthority.maxRequestBytes,
          readBoundedRequestBody,
          deviceCredentialRenewalAuthority.parseRequest,
        );
        const rotated = await deviceCredentialRenewalAuthority.renew(
          primaryPool, request.headers.get("authorization"), body, { schema },
        );
        return json(200, {
          schemaVersion: "device-credential-renewal-v1.0",
          deviceId: rotated.deviceId,
          state: rotated.state,
          scope: rotated.scope,
          expiresAt: rotated.expiresAt,
          credentialGeneration: rotated.credentialGeneration,
          commit: rotated.commit,
        });
      }
      if (accountlessOwnershipRoute || accountlessV12AuthorizationRoute) {
        const mode = admissionEnv.ACCOUNTLESS_OWNERSHIP_MODE;
        if (mode === undefined || mode === "disabled") {
          throw Object.assign(new Error("ACCOUNTLESS_OWNERSHIP_DISABLED"), {
            code: "ACCOUNTLESS_OWNERSHIP_DISABLED", status: 503,
          });
        }
        if (mode !== "enabled") {
          throw Object.assign(new Error("ACCOUNTLESS_OWNERSHIP_CONFIGURATION_INVALID"), {
            code: "ACCOUNTLESS_OWNERSHIP_CONFIGURATION_INVALID", status: 503,
          });
        }
        await assertPostgresUploadRegistrationEnabled(primaryPool, schemas.primary);
        await assertAttemptAllowed(
          admissionEnv.RECOVERY_RATE_LIMIT,
          admissionEnv.CLIENT_ATTEMPT_RATE_LIMIT,
          request,
          admissionEnv,
          "accountless_ownership",
        );
        if (accountlessOwnershipRoute) {
          const body = await readAccountlessJson(
            request,
            accountlessAuthority.maxOwnershipBytes,
            readBoundedRequestBody,
            accountlessAuthority.parseOwnershipJson,
          );
          const result = await accountlessAuthority.createOwner(
            primaryPool, request.headers.get("authorization"), body, { schema },
          );
          return json(result.status, result.response);
        }
        // d43c8f92 index.ts:780-789: the v1.2 grant authenticates the device
        // before it reads the body, so an unknown credential, including a
        // deleted owner's (there is no deletion-ledger tombstone read), is
        // 401 DEVICE_AUTH_INVALID whatever the body holds.
        const principal = await accountlessAuthority.authenticateV12Grant(
          primaryPool, request.headers.get("authorization"), { schema },
        );
        const body = await readAccountlessJson(
          request,
          accountlessAuthority.maxOwnershipBytes,
          readBoundedRequestBody,
          accountlessAuthority.parseV12AuthorizationJson,
        );
        await accountlessAuthority.grantV12(
          primaryPool,
          principal,
          body,
          { schema },
        );
        return json(201, body);
      }
      // d43c8f92 handleContribution answers its own session-cookie refusal
      // (UPLOAD_AUTH_INVALID), so it precedes the device-bearer cookie
      // refusal below.
      if (contributionRoute) {
        return await handlePostgresTestContribution({
          request,
          admissionEnv,
          assertUploadIngressRequestAllowed,
          primaryPool,
          schema,
          claimPostgresDeviceUploadAuthorization,
          abandonPostgresDeviceUploadAuthorization,
          recordPostgresDeviceUploadReceipt,
          sha256Hex,
          readBoundedRequestBody,
          maxRequestBytes,
          envelopes,
          formats,
          refuseUnregisteredEnvelope,
          handlerContext: contributionHandlerContext,
        });
      }
      if (disconnectRoute) {
        await assertAttemptAllowed(
          admissionEnv.RECOVERY_RATE_LIMIT,
          admissionEnv.CLIENT_ATTEMPT_RATE_LIMIT,
          request,
          admissionEnv,
          "device_disconnect",
        );
      }
      // d43c8f92 deviceSyncPrincipal (index.ts:3016-3030): every device
      // bearer read, the v1.2 day-manifest POST and both v1.2 domain routes
      // charge device_sync before the cookie refusal and authentication.
      if (syncStateRoute || syncManifestRoute || syncCapabilitiesRoute || syncCapabilitiesV12Route
          || manifestReadRoute || manifestRoute || v12DomainPredecessorRoute
          || v12DomainActivateRoute || v12EffectivePageRoute) {
        await assertAttemptAllowed(
          admissionEnv.RECOVERY_RATE_LIMIT,
          admissionEnv.CLIENT_ATTEMPT_RATE_LIMIT,
          request,
          admissionEnv,
          "device_sync",
        );
      }
      if (request.headers.has("cookie")) {
        throw Object.assign(new Error("DEVICE_AUTH_INVALID"), {
          code: "DEVICE_AUTH_INVALID", status: 401,
        });
      }
      if (disconnectRoute) {
        const contentLength = request.headers.get("content-length");
        if (contentLength !== null && contentLength !== "0") {
          throw Object.assign(new Error("BODY_INVALID"), {
            code: "BODY_INVALID", status: 400,
          });
        }
        const disconnected = await disconnectPostgresAuthenticatedDevice(
          primaryPool,
          request.headers.get("authorization"),
          { schema },
        );
        return json(200, {
          schemaVersion: "device-disconnect-v0.1",
          disconnected: true,
          deviceId: disconnected.deviceId,
        });
      }
      // The v1.2 capability read is how an accountless install learns that
      // it has no current v1.2 grant and must request one, so, like the D1
      // route, it authenticates the base accountless lease graph rather than
      // requiring the v1.2 grant it reports on. Every v1.2 write still
      // authenticates against the v1.2 grant.
      const device = await authenticatePostgresDevice(
        primaryPool,
        request.headers.get("authorization"),
        {
          schema,
          ...(syncCapabilitiesRoute || syncCapabilitiesV12Route
            ? { accountlessAuthorizationVersion: "v1.1" } : {}),
        },
      );

      if (syncStateRoute) {
        if (device.authorityKind !== "social") {
          throw Object.assign(new Error("TELEMETRY_TRANSPORT_BLOCKED"), {
            code: "TELEMETRY_TRANSPORT_BLOCKED", status: 403,
          });
        }
        if (typeof readPostgresDeviceSyncState !== "function") throw storageUnavailable();
        return json(200, await readPostgresDeviceSyncState(
          primaryPool,
          device.participantId,
          device.deviceId,
          { schema, nowEpoch: Date.now() },
        ));
      }
      if (syncManifestRoute) {
        if (device.authorityKind !== "social") {
          throw Object.assign(new Error("TELEMETRY_TRANSPORT_BLOCKED"), {
            code: "TELEMETRY_TRANSPORT_BLOCKED", status: 403,
          });
        }
        const fromDay = url.searchParams.get("fromDay");
        const toDay = url.searchParams.get("toDay");
        const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;
        if (fromDay === null || toDay === null
            || !dayPattern.test(fromDay) || !dayPattern.test(toDay)) {
          throw Object.assign(new Error("BODY_INVALID"), { code: "BODY_INVALID", status: 400 });
        }
        const dayMilliseconds = 24 * 60 * 60 * 1000;
        const fromEpoch = Date.parse(`${fromDay}T00:00:00.000Z`);
        const toEpoch = Date.parse(`${toDay}T00:00:00.000Z`);
        if (!Number.isFinite(fromEpoch) || !Number.isFinite(toEpoch) || fromEpoch > toEpoch) {
          throw Object.assign(new Error("BODY_INVALID"), { code: "BODY_INVALID", status: 400 });
        }
        if ((toEpoch - fromEpoch) / dayMilliseconds + 1 > DEVICE_SYNC_MANIFEST_MAX_RANGE_DAYS) {
          throw Object.assign(new Error("SYNC_RANGE_TOO_LARGE"), {
            code: "SYNC_RANGE_TOO_LARGE", status: 400,
          });
        }
        if (typeof readPostgresDeviceSyncManifest !== "function") throw storageUnavailable();
        return json(200, await readPostgresDeviceSyncManifest(
          primaryPool,
          device.participantId,
          device.deviceId,
          fromDay,
          toDay,
          { schema },
        ));
      }
      if (syncCapabilitiesRoute) {
        return json(200, await readPostgresDeviceSyncCapabilities(
          primaryPool,
          device.participantId,
          device.deviceId,
          url.origin,
          { schema, sourceNamespace, nowEpoch: Date.now() },
        ));
      }
      if (syncCapabilitiesV12Route) {
        if (typeof readPostgresDeviceSyncV12Capabilities !== "function") throw storageUnavailable();
        return json(200, await readPostgresDeviceSyncV12Capabilities(
          primaryPool,
          device.participantId,
          device.deviceId,
          url.origin,
          { schema, sourceNamespace, nowEpoch: Date.now() },
        ));
      }
      if (manifestReadRoute) {
        const query = url.searchParams;
        if ([...query.keys()].some((key) => !["fromDay", "toDay"].includes(key))
            || query.getAll("fromDay").length !== 1 || query.getAll("toDay").length !== 1) {
          throw Object.assign(new Error("BODY_INVALID"), { code: "BODY_INVALID", status: 400 });
        }
        return json(200, await readPostgresV12DayCandidates(
          primaryPool,
          device,
          {
            fromDay: query.get("fromDay"),
            toDay: query.get("toDay"),
            schema,
            sourceNamespace,
          },
        ));
      }
      if (v12EffectivePageRoute) {
        if (request.body !== null) throw invalidEffectivePageQuery();
        const query = parseV12EffectivePageQuery(url);
        let page;
        try {
          page = await readPostgresTelemetryV12EffectivePage(primaryPool, {
            participantId: device.participantId,
            ...query,
          }, { schema });
        } catch {
          throw storageUnavailable();
        }
        if (page?.available !== true || !Array.isArray(page.records)
            || page.records.length > query.limit) {
          throw storageUnavailable();
        }
        return json(200, {
          schemaVersion: "postgres-telemetry-v12-effective-page-v1",
          ...page,
        });
      }

      if (uploadAuthorizationRoute) {
        assertUploadAuthorizationBindings(admissionEnv);
        await assertPostgresUploadRegistrationEnabled(primaryPool, schemas.primary);
        await assertUploadAuthorizationAllowed(
          admissionEnv.UPLOAD_AUTHORIZATION_RATE_LIMIT,
          admissionEnv.UPLOAD_PRINCIPAL_RATE_LIMIT,
          device.participantId,
          admissionEnv,
        );
      } else {
        // device_sync was charged before authentication, as deviceSyncPrincipal
        // does; the processing control follows it (index.ts:3261, 3280).
        await assertPostgresProcessingEnabled(primaryPool, schemas.primary);
      }

      const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (contentType !== "application/json") {
        throw Object.assign(new Error("CONTENT_TYPE_INVALID"), {
          code: "CONTENT_TYPE_INVALID", status: 415,
        });
      }
      const declared = request.headers.get("content-length");
      if (declared !== null) {
        const length = Number(declared);
        if (!Number.isSafeInteger(length) || length < 0) {
          throw Object.assign(new Error("BODY_INVALID"), { code: "BODY_INVALID", status: 400 });
        }
        if (length > maxRequestBytes) {
          throw Object.assign(new Error("BODY_TOO_LARGE"), { code: "BODY_TOO_LARGE", status: 413 });
        }
      }
      const bytes = await readBoundedRequestBody(request, maxRequestBytes, {
        maximumTotalMilliseconds: 15_000,
        maximumIdleMilliseconds: 5_000,
      });
      let value;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
      } catch {
        throw Object.assign(new Error("BODY_INVALID"), { code: "BODY_INVALID", status: 400 });
      }

      if (uploadAuthorizationRoute) {
        const expectedKeys = new Set([
          "envelopeDigest", "contentLengthBytes", "contentType", "telemetrySchemaVersion",
        ]);
        if (value === null || typeof value !== "object" || Array.isArray(value)
            || Object.keys(value).length !== expectedKeys.size
            || Object.keys(value).some((key) => !expectedKeys.has(key))
            || typeof value.envelopeDigest !== "string" || !DIGEST.test(value.envelopeDigest)
            || !Number.isSafeInteger(value.contentLengthBytes)
            || value.contentLengthBytes < 1 || value.contentLengthBytes > maxRequestBytes
            || value.contentType !== "application/json"
            || !formats.has(value.telemetrySchemaVersion)) {
          throw Object.assign(new Error("BODY_INVALID"), { code: "BODY_INVALID", status: 400 });
        }

        await formats.resolve(value.telemetrySchemaVersion)
          .assertUploadAllowed(primaryPool, device, Date.now(), { schema });
        return json(201, await createPostgresDeviceUploadAuthorization(
          primaryPool,
          device,
          { envelopeDigest: value.envelopeDigest, bodyBytes: value.contentLengthBytes },
          { schema },
        ));
      }

      if (v12DomainPredecessorRoute) {
        if (value === null || typeof value !== "object" || Array.isArray(value)
            || Object.keys(value).length !== 0) {
          throw Object.assign(new Error("BODY_INVALID"), {
            code: "BODY_INVALID", status: 400,
          });
        }
        const domain = createPostgresTypedV12Domain(primaryPool, { schema });
        return json(201, await domain.createPredecessor(device, Date.now()));
      }
      if (v12DomainActivateRoute) {
        const domain = createPostgresTypedV12Domain(primaryPool, { schema });
        return json(201, await domain.activate(device, value, Date.now()));
      }

      const candidate = await registerPostgresTypedV12DayManifest(
        primaryPool,
        device,
        value,
        Date.now(),
        { schema },
      );
      const stagedChunks = await readV12StagedChunkVector(
        primaryPool, schemas.primary, device, candidate.manifestId,
      );
      return json(201, { ...candidate, stagedChunks });
    } catch (error) {
      return routeError(error, requestId);
    }
  };
}
