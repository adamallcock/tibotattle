const SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const MIGRATION_HISTORY_TABLE = "_tibotattle_migration_history";
const POSTGRES_MAJOR_REQUIRED = 17;

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

function validatedSchemas(schemaOptions = {}) {
  const primary = schemaOptions.primarySchema ?? "tibotattle";
  const ledger = schemaOptions.ledgerSchema ?? "tibotattle_ledger";
  const invalid = (value) => typeof value !== "string"
    || !SCHEMA_IDENTIFIER.test(value)
    || value.startsWith("pg_")
    || value === "information_schema";
  if (invalid(primary) || invalid(ledger) || primary === ledger) {
    configurationError("POSTGRES_TEST_SCHEMA_CONFIGURATION_INVALID");
  }
  return Object.freeze({ primary, ledger });
}

function schemaTable(schema) {
  return `"${schema}"`;
}

/**
 * The partial GCP health host must remain loopback-only. Cloud Run's normal
 * 0.0.0.0 binding and public origins are deliberately not accepted here.
 */
export function isPrivatePostgresTestHost({ listenHost, hostOrigin, port }) {
  if (listenHost !== "127.0.0.1"
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

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
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
 * Construct a read-only health dispatcher for a private local GCP test host.
 * It deliberately receives pools only: unsupported requests cannot reach the
 * Worker handler or any D1 binding.
 */
export function createPostgresTestHealthDispatch({
  primaryPool,
  ledgerPool,
  schemaOptions,
  expectedMigrations,
  privateOrigin,
}) {
  if (primaryPool === null || typeof primaryPool !== "object"
      || typeof primaryPool.connect !== "function"
      || ledgerPool === null || typeof ledgerPool !== "object"
      || typeof ledgerPool.connect !== "function"
      || primaryPool === ledgerPool) {
    configurationError("POSTGRES_TEST_POOLS_INVALID");
  }
  const schemas = validatedSchemas(schemaOptions);
  const expected = Object.freeze({
    primary: validateExpectedMigrations(expectedMigrations?.primary, "primary"),
    ledger: validateExpectedMigrations(expectedMigrations?.ledger, "ledger"),
  });
  let privateUrl;
  try { privateUrl = new URL(privateOrigin); } catch {
    configurationError("POSTGRES_TEST_PRIVATE_ORIGIN_INVALID");
  }
  if (privateUrl.origin !== privateOrigin || privateUrl.protocol !== "http:"
      || privateUrl.hostname !== "127.0.0.1") {
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

    const [primary, ledger] = await Promise.all([
      readSchemaReceipt(primaryPool, schemas.primary, expected.primary),
      readSchemaReceipt(ledgerPool, schemas.ledger, expected.ledger),
    ]);
    const ready = primary === "current" && ledger === "current";
    return json(ready ? 200 : 503, {
      schemaVersion: "gcp-postgres-test-health-v1",
      scope: "postgres_schema_and_migrations_only",
      status: ready ? "ready" : "not_ready",
      workerApplicationReady: false,
      checks: {
        postgresMajor: POSTGRES_MAJOR_REQUIRED,
        primaryMigrationReceipt: {
          status: primary,
          version: expected.primary.length,
        },
        ledgerMigrationReceipt: {
          status: ledger,
          version: expected.ledger.length,
        },
      },
    });
  };
}

const V12_DAY_MANIFEST_PATH = "/api/v1/device/telemetry/v1.2/day-manifests";
const MAX_V12_DAY_CHUNKS = 4_096;

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

async function assertPostgresProcessingEnabled(pool, schema) {
  const table = `${schemaTable(schema)}."collection_controls"`;
  const controls = await withReadOnlyClient(pool, async (client) => {
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
  if (controls.processing_enabled !== true) {
    throw Object.assign(new Error("PROCESSING_DISABLED"), {
      code: "PROCESSING_DISABLED",
      status: 503,
    });
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
 * Private, deliberately partial test dispatch. It admits only the read-only
 * health proof and the manifest-registration POST; every other path bypasses
 * the Worker and fails closed before touching either PostgreSQL pool.
 */
export function createPostgresTestV12DayManifestDispatch({
  primaryPool,
  ledgerPool,
  schemaOptions,
  expectedMigrations,
  privateOrigin,
  healthDispatch,
  admissionEnv,
  assertAdmissionBindings,
  assertAttemptAllowed,
  authenticatePostgresDevice,
  hasPostgresDeletionTombstone,
  registerPostgresTypedV12DayManifest,
  readBoundedRequestBody,
  maxRequestBytes,
}) {
  if (primaryPool === null || typeof primaryPool !== "object"
      || typeof primaryPool.connect !== "function"
      || ledgerPool === null || typeof ledgerPool !== "object"
      || typeof ledgerPool.connect !== "function"
      || primaryPool === ledgerPool
      || typeof healthDispatch !== "function"
      || typeof assertAdmissionBindings !== "function"
      || typeof assertAttemptAllowed !== "function"
      || typeof authenticatePostgresDevice !== "function"
      || typeof hasPostgresDeletionTombstone !== "function"
      || typeof registerPostgresTypedV12DayManifest !== "function"
      || typeof readBoundedRequestBody !== "function"
      || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) {
    configurationError("POSTGRES_TEST_V12_DISPATCH_CONFIGURATION_INVALID");
  }
  const schemas = validatedSchemas(schemaOptions);
  const expected = Object.freeze({
    primary: validateExpectedMigrations(expectedMigrations?.primary, "primary"),
    ledger: validateExpectedMigrations(expectedMigrations?.ledger, "ledger"),
  });
  let privateUrl;
  try { privateUrl = new URL(privateOrigin); } catch {
    configurationError("POSTGRES_TEST_PRIVATE_ORIGIN_INVALID");
  }
  if (privateUrl.origin !== privateOrigin || privateUrl.protocol !== "http:"
      || privateUrl.hostname !== "127.0.0.1") {
    configurationError("POSTGRES_TEST_PRIVATE_ORIGIN_INVALID");
  }

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
    if (request.method !== "POST" || url.pathname !== V12_DAY_MANIFEST_PATH || url.search) {
      return json(503, { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
    }

    const requestId = crypto.randomUUID();
    try {
      const [primaryReceipt, ledgerReceipt] = await Promise.all([
        readSchemaReceipt(primaryPool, schemas.primary, expected.primary),
        readSchemaReceipt(ledgerPool, schemas.ledger, expected.ledger),
      ]);
      if (primaryReceipt !== "current" || ledgerReceipt !== "current") {
        throw storageUnavailable();
      }

      assertAdmissionBindings(admissionEnv);
      await assertAttemptAllowed(
        admissionEnv.RECOVERY_RATE_LIMIT,
        admissionEnv.CLIENT_ATTEMPT_RATE_LIMIT,
        request,
        admissionEnv,
        "device_sync",
      );
      if (request.headers.has("cookie")) {
        throw Object.assign(new Error("DEVICE_AUTH_INVALID"), {
          code: "DEVICE_AUTH_INVALID", status: 401,
        });
      }
      const schema = Object.freeze({
        primarySchema: schemas.primary,
        ledgerSchema: schemas.ledger,
      });
      const device = await authenticatePostgresDevice(
        primaryPool,
        request.headers.get("authorization"),
        { schema },
      );
      if (await hasPostgresDeletionTombstone(ledgerPool, device.participantId, Date.now(), { schema })) {
        throw Object.assign(new Error("DEVICE_AUTH_INVALID"), {
          code: "DEVICE_AUTH_INVALID", status: 401,
        });
      }

      await assertPostgresProcessingEnabled(primaryPool, schemas.primary);

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
