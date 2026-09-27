import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

async function localEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "device-sync principal tests require loopback or a private Unix socket");
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
  return PG_TEST_HOST ? { host: PG_TEST_HOST, port: PG_TEST_PORT } : null;
}

function poolFor(endpoint, max = 4) {
  return new pg.Pool({
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined
      ? { password: "synthetic-local-only" }
      : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max,
    connectionTimeoutMillis: 3_000,
  });
}

function table(schema, name) {
  return `"${schema}"."${name}"`;
}

function deviceSecretHash(deviceId, value) {
  return createHash("sha256")
    .update(`app-usagemonitor/device/v1\0${deviceId}\0`)
    .update(Buffer.from(value, "base64url"))
    .digest();
}

function authorization(deviceId, value) {
  return `Device um_device_${deviceId}.${value}`;
}

function capture(promise) {
  return promise.then(() => null, (error) => error);
}

test("PostgreSQL device-sync principal enforces the ordered budgets", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 120_000,
}, async () => {
  const endpoint = await localEndpoint();
  const schema = `device_sync_principal_${randomBytes(6).toString("hex")}`;
  const suffix = randomBytes(5).toString("hex").toUpperCase();
  const now = Date.now();
  let pool;
  let vite;
  let schemaCreated = false;
  try {
    pool = poolFor(endpoint, 5);
    const server = await pool.query(
      "SELECT current_setting('server_version_num')::integer AS version, inet_server_addr()::text AS address",
    );
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17,
      "device-sync principal qualification requires PostgreSQL 17");
    if (PG_TEST_SOCKET) assert.equal(server.rows[0].address, null);
    else assert.ok(["127.0.0.1", "::1"].includes(server.rows[0].address));

    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await applyPostgresMigrations({ role: "primary", schema, pool });

    vite = await createServer({
      root: WORKER_ROOT,
      configFile: false,
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "silent",
    });
    const [principalModule, rateLimit, constants, errors, credentialRenewal] = await Promise.all([
      vite.ssrLoadModule("/src/postgres-device-sync-principal.ts"),
      vite.ssrLoadModule("/src/postgres-rate-limiter.ts"),
      vite.ssrLoadModule("/src/constants.ts"),
      vite.ssrLoadModule("/src/errors.ts"),
      vite.ssrLoadModule("/src/postgres-device-credential-renewal.ts"),
    ]);

    const participantId = `participant:${randomUUID()}`;
    const deviceId = randomUUID();
    const bearerSecret = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const pairingId = randomUUID();
    const issuedAt = now - DAY;
    const socialVerifiedAt = now - MINUTE;
    const expiresAt = now + 29 * DAY;
    await pool.query(
      `INSERT INTO ${table(schema, "participants")} (
         id, owner_kind, state, consent_version, created_at
       ) VALUES ($1, 'social', 'active', $2, $3::timestamptz)`,
      [participantId, constants.TELEMETRY_CONSENT_VERSION, new Date(issuedAt).toISOString()],
    );
    await pool.query(
      `INSERT INTO ${table(schema, "web_sessions")} (
         id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
       ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $5::timestamptz)`,
      [sessionId, participantId, randomBytes(32), randomBytes(32),
        new Date(issuedAt).toISOString(), new Date(issuedAt + DAY).toISOString()],
    );
    await pool.query(
      `INSERT INTO ${table(schema, "device_pairings")} (
         id, participant_id, issued_by_session_id, secret_hash, consent_version,
         transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
       ) VALUES ($1, $2, $3, $4, $5, $5, 'consumed', $6::timestamptz, $7::timestamptz,
         $6::timestamptz, $8)`,
      [pairingId, participantId, sessionId, randomBytes(32),
        constants.TELEMETRY_CONSENT_VERSION, new Date(issuedAt).toISOString(),
        new Date(issuedAt + MINUTE).toISOString(), deviceId],
    );
    await pool.query(
      `INSERT INTO ${table(schema, "device_credentials")} (
         id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
         state, issued_at, expires_at, last_used_at, social_verified_at
       ) VALUES ($1, $2, 'social', $3, $4, 'active', $5::timestamptz, $6::timestamptz,
         $7::timestamptz, $8::timestamptz)`,
      [deviceId, participantId, pairingId, deviceSecretHash(deviceId, bearerSecret),
        new Date(issuedAt).toISOString(), new Date(expiresAt).toISOString(),
        new Date(now - MINUTE).toISOString(), new Date(socialVerifiedAt).toISOString()],
    );

    const accountlessParticipantId = `participant:${randomUUID()}`;
    const accountlessDeviceId = randomUUID();
    const accountlessSecret = randomBytes(32).toString("base64url");
    await pool.query(
      `INSERT INTO ${table(schema, "participants")} (
         id, owner_kind, state, consent_version, created_at
       ) VALUES ($1, 'accountless', 'active', NULL, $2::timestamptz)`,
      [accountlessParticipantId, new Date(issuedAt).toISOString()],
    );
    await pool.query(
      `INSERT INTO ${table(schema, "accountless_enrollment_ledger")} (
         device_id, device_secret_hash, installation_principal_id, schema_version,
         policy_version, authorization_basis, state, issued_at, expires_at
       ) VALUES ($1, $2, $3, 'accountless-enrollment-v1', 'accountless-opt-out-v1',
         'accountless-policy-v1', 'active', $4::timestamptz, $5::timestamptz)`,
      [accountlessDeviceId, deviceSecretHash(accountlessDeviceId, accountlessSecret),
        `synthetic-install-${accountlessDeviceId}`, new Date(issuedAt).toISOString(),
        new Date(expiresAt).toISOString()],
    );
    await pool.query(
      `INSERT INTO ${table(schema, "device_credentials")} (
         id, participant_id, authority_kind, accountless_enrollment_device_id,
         secret_hash, state, issued_at, expires_at, last_used_at
       ) VALUES ($1, $2, 'accountless', $1, $3, 'active', $4::timestamptz,
         $5::timestamptz, $6::timestamptz)`,
      [accountlessDeviceId, accountlessParticipantId,
        deviceSecretHash(accountlessDeviceId, accountlessSecret),
        new Date(issuedAt).toISOString(), new Date(expiresAt).toISOString(),
        new Date(now - MINUTE).toISOString()],
    );
    await pool.query(
      `INSERT INTO ${table(schema, "accountless_upload_owners")} (
         enrollment_device_id, participant_id, device_credential_id, policy_version,
         authorization_basis, authorized_at, expires_at, state
       ) VALUES ($1, $2, $1, 'accountless-opt-out-v1', 'accountless-policy-v1',
         $3::timestamptz, $4::timestamptz, 'active')`,
      [accountlessDeviceId, accountlessParticipantId,
        new Date(issuedAt).toISOString(), new Date(expiresAt).toISOString()],
    );
    await pool.query(
      `INSERT INTO ${table(schema, "accountless_v11_device_authorizations")} (
         enrollment_device_id, participant_id, device_credential_id,
         telemetry_schema_version, field_dictionary_version, privacy_contract_version,
         authorized_at, expires_at, state
       ) VALUES ($1, $2, $1, 'telemetry-contribution-v1.1',
         'telemetry-v1.1-registry-2026-08-31.1', 'ongoing-privacy-safe-telemetry-v1.1',
         $3::timestamptz, $4::timestamptz, 'active')`,
      [accountlessDeviceId, accountlessParticipantId,
        new Date(issuedAt).toISOString(), new Date(expiresAt).toISOString()],
    );

    let credentialQueries = 0;
    const observedPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, values) {
            if (String(sql).includes(`${table(schema, "device_credentials")}`)) {
              credentialQueries += 1;
            }
            return client.query(sql, values);
          },
          release() { client.release(); },
        };
      },
    };

    let environmentIndex = 0;
    function admissionEnv({ clientAttemptLimit = 5, override } = {}) {
      const current = ++environmentIndex;
      const prefix = `SYNTHETIC_DSYNC_${suffix}_${current}`;
      const trace = [];
      const env = {
        ENVIRONMENT: "test",
        IDENTITY_LINK_SECRET: randomBytes(32).toString("base64url"),
      };
      for (const [binding, name, limit] of [
        ["ENROLLMENT_RATE_LIMIT", "ENROLLMENT", 20],
        ["RECOVERY_RATE_LIMIT", "RECOVERY", 20],
        ["CLIENT_ATTEMPT_RATE_LIMIT", "CLIENT_ATTEMPT", clientAttemptLimit],
        ["PUBLIC_READ_RATE_LIMIT", "PUBLIC_READ", 1_000],
        ["DEVICE_SYNC_CLIENT_RATE_LIMIT", "DEVICE_SYNC_CLIENT", 4_200],
        ["DEVICE_SYNC_RATE_LIMIT", "DEVICE_SYNC", 6_000],
        ["DEVICE_SYNC_PRINCIPAL_RATE_LIMIT", "DEVICE_SYNC_PRINCIPAL", 4_200],
      ]) {
        const raw = rateLimit.createPostgresRateLimiter(pool, {
          primarySchema: schema,
          name: `${prefix}_${name}`,
          limit,
          periodSeconds: 60,
          keyHashSecret: randomBytes(32),
        });
        env[binding] = {
          async limit(input) {
            trace.push(binding);
            if (override?.binding === binding) return override.run(raw, input);
            return raw.limit(input);
          },
        };
      }
      return { env, trace };
    }

    function principalFor(env) {
      return principalModule.createPostgresDeviceSyncPrincipal({
        pool: observedPool,
        schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
        env,
        clock: () => now,
      });
    }

    function request({ method = "GET", authorization: auth, cookie } = {}) {
      const headers = new Headers();
      if (auth !== undefined) headers.set("authorization", auth);
      if (cookie !== undefined) headers.set("cookie", cookie);
      return new Request("https://private.test/api/v1/me/device-sync/capabilities", {
        method,
        headers,
      });
    }

    function assertApiError(error, status, code) {
      assert.ok(error instanceof errors.ApiError, `expected ApiError; received ${error?.name ?? "success"}`);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
    }

    const validAuthorization = authorization(deviceId, bearerSecret);
    // Keep a second active principal available after the social bearer below
    // is deliberately rotated and revoked.
    const validAccountlessAuthorization = authorization(accountlessDeviceId, accountlessSecret);

    {
      const { env, trace } = admissionEnv();
      const beforeQueries = credentialQueries;
      const error = await capture(principalFor(env)(request({
        method: "POST", authorization: validAuthorization,
      })));
      assertApiError(error, 405, "METHOD_NOT_ALLOWED");
      assert.equal(error.responseHeaders.allow, "GET");
      assert.deepEqual(trace, [], "wrong method is rejected before every limiter");
      assert.equal(credentialQueries, beforeQueries, "wrong method does not authenticate");
    }

    for (const invalidRequest of [
      request({ authorization: validAuthorization, cookie: "session=synthetic" }),
      request(),
      request({ authorization: "Device malformed" }),
    ]) {
      const { env, trace } = admissionEnv();
      const error = await capture(principalFor(env)(invalidRequest));
      assertApiError(error, 401, "DEVICE_AUTH_INVALID");
      assert.deepEqual(trace, ["RECOVERY_RATE_LIMIT", "CLIENT_ATTEMPT_RATE_LIMIT"]);
    }

    {
      const { env, trace } = admissionEnv();
      const unknownAuthorization = authorization(randomUUID(), randomBytes(32).toString("base64url"));
      const beforeQueries = credentialQueries;
      const error = await capture(principalFor(env)(request({ authorization: unknownAuthorization })));
      assertApiError(error, 401, "DEVICE_AUTH_INVALID");
      assert.deepEqual(trace, [
        "DEVICE_SYNC_CLIENT_RATE_LIMIT", "DEVICE_SYNC_RATE_LIMIT",
        "RECOVERY_RATE_LIMIT", "CLIENT_ATTEMPT_RATE_LIMIT",
      ]);
      assert.equal(credentialQueries, beforeQueries + 1,
        "a well-formed unknown bearer reaches PostgreSQL after the credential budgets");
    }

    {
      const { env, trace } = admissionEnv();
      const result = await principalFor(env)(request({ authorization: validAuthorization }));
      assert.equal(result.participantId, participantId);
      assert.equal(result.deviceId, deviceId);
      assert.deepEqual(trace, [
        "DEVICE_SYNC_CLIENT_RATE_LIMIT", "DEVICE_SYNC_RATE_LIMIT",
        "DEVICE_SYNC_PRINCIPAL_RATE_LIMIT",
      ]);
    }

    {
      const { env, trace } = admissionEnv();
      const result = await principalFor(env)(request({
        authorization: validAccountlessAuthorization,
      }));
      assert.equal(result.participantId, accountlessParticipantId);
      assert.equal(result.deviceId, accountlessDeviceId);
      assert.equal(result.authorityKind, "accountless");
      assert.deepEqual(trace, [
        "DEVICE_SYNC_CLIENT_RATE_LIMIT", "DEVICE_SYNC_RATE_LIMIT",
        "DEVICE_SYNC_PRINCIPAL_RATE_LIMIT",
      ]);
    }

    {
      const nextSecret = randomBytes(32).toString("base64url");
      await credentialRenewal.renewPostgresDeviceCredential(pool, validAuthorization, {
        nextDeviceSecretHash: deviceSecretHash(deviceId, nextSecret).toString("hex"),
        rotationAttemptId: randomUUID(),
      }, {
        schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
        nowEpoch: now,
      });
      const { env, trace } = admissionEnv();
      const error = await capture(principalFor(env)(request({ authorization: validAuthorization })));
      assertApiError(error, 401, "DEVICE_AUTH_INVALID");
      assert.deepEqual(trace, [
        "DEVICE_SYNC_CLIENT_RATE_LIMIT", "DEVICE_SYNC_RATE_LIMIT",
        "RECOVERY_RATE_LIMIT", "CLIENT_ATTEMPT_RATE_LIMIT",
      ]);
      const committedRevocation = await pool.query(
        `SELECT state, revoked_at IS NOT NULL AS revoked
           FROM ${table(schema, "device_credentials")} WHERE id = $1`,
        [deviceId],
      );
      assert.deepEqual(committedRevocation.rows, [{ state: "revoked", revoked: true }],
        "reusing a rotated-out bearer commits revocation before returning the neutral 401");
    }

    {
      const { env, trace } = admissionEnv({ override: {
        binding: "DEVICE_SYNC_CLIENT_RATE_LIMIT",
        run: async () => ({ success: false }),
      } });
      const beforeQueries = credentialQueries;
      const error = await capture(principalFor(env)(request({ authorization: validAuthorization })));
      assertApiError(error, 429, "DEVICE_SYNC_LIMIT_REACHED");
      assert.deepEqual(trace, ["DEVICE_SYNC_CLIENT_RATE_LIMIT"]);
      assert.equal(credentialQueries, beforeQueries,
        "a refused credential budget performs no device-authentication query");
    }

    {
      const { env, trace } = admissionEnv({ override: {
        binding: "DEVICE_SYNC_PRINCIPAL_RATE_LIMIT",
        run: async () => ({ success: false }),
      } });
      const error = await capture(principalFor(env)(request({
        authorization: validAccountlessAuthorization,
      })));
      assertApiError(error, 429, "DEVICE_SYNC_LIMIT_REACHED");
      assert.deepEqual(trace, [
        "DEVICE_SYNC_CLIENT_RATE_LIMIT", "DEVICE_SYNC_RATE_LIMIT",
        "DEVICE_SYNC_PRINCIPAL_RATE_LIMIT",
      ]);
    }

    {
      const { env, trace } = admissionEnv();
      env.DEVICE_SYNC_RATE_LIMIT = undefined;
      const beforeQueries = credentialQueries;
      const error = await capture(principalFor(env)(request({ authorization: validAuthorization })));
      assertApiError(error, 503, "ADMISSION_CONFIGURATION_INVALID");
      assert.deepEqual(trace, [], "missing sync binding fails before limiter use");
      assert.equal(credentialQueries, beforeQueries);
    }

    {
      const { env, trace } = admissionEnv({ override: {
        binding: "CLIENT_ATTEMPT_RATE_LIMIT",
        run: async () => ({ success: false }),
      } });
      const error = await capture(principalFor(env)(request()));
      assertApiError(error, 429, "ATTEMPT_LIMIT_REACHED");
      assert.deepEqual(trace, ["RECOVERY_RATE_LIMIT", "CLIENT_ATTEMPT_RATE_LIMIT"]);
    }
  } finally {
    if (vite) await vite.close();
    if (pool) {
      try {
        if (schemaCreated) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    }
  }
});
