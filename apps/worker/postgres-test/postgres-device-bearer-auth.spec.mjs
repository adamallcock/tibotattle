import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
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
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// A fixed synthetic clock keeps every bound exact; nothing reads wall time.
const T0 = Date.parse("2026-06-01T00:00:00.000Z");
const NEUTRAL_401 = Object.freeze({
  name: "ApiError",
  status: 401,
  code: "DEVICE_AUTH_INVALID",
  message: "DEVICE_AUTH_INVALID",
  publicDetails: null,
  responseHeaders: null,
});

async function localEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "device bearer tests require loopback or a private Unix socket");
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
    return { host, port: PG_TEST_PORT, socket: true };
  }
  if (PG_TEST_HOST) return { host: PG_TEST_HOST, port: PG_TEST_PORT, socket: false };
  return null;
}

function poolFor(endpoint, max) {
  return new pg.Pool({
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max,
    connectionTimeoutMillis: 3_000,
  });
}

function q(schema, name) {
  return `"${schema}"."${name}"`;
}

function iso(epoch) {
  return new Date(epoch).toISOString();
}

function secret() {
  return randomBytes(32).toString("base64url");
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

function errorShape(error) {
  return {
    name: error?.name,
    status: error?.status,
    code: error?.code,
    message: error?.message,
    publicDetails: error?.publicDetails,
    responseHeaders: error?.responseHeaders,
  };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

test("PostgreSQL device-bearer authentication matches the Worker and commits reuse revocation", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 120_000,
}, async (t) => {
  const endpoint = await localEndpoint();
  let pool;
  let observer;
  let vite;
  const schema = `device_bearer_${randomBytes(6).toString("hex")}`;
  let schemaCreated = false;
  try {
    pool = poolFor(endpoint, 4);
    // A separate pool proves effects are committed: it never shares a session
    // or a transaction with the code under test.
    observer = poolFor(endpoint, 1);
    const server = await pool.query(
      "SELECT current_setting('server_version_num')::integer AS version, inet_server_addr()::text AS address",
    );
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "this qualification test requires PostgreSQL 17");
    if (endpoint.socket) assert.equal(server.rows[0].address, null);
    else assert.ok(["127.0.0.1", "::1"].includes(server.rows[0].address));

    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await applyPostgresMigrations({ role: "primary", schema, pool });
    const options = { schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` } };

    vite = await createServer({
      root: WORKER_ROOT,
      configFile: false,
      server: { middlewareMode: true },
      appType: "custom",
    });
    const bearer = await vite.ssrLoadModule("/src/postgres-device-bearer-auth.ts");
    const transport = await vite.ssrLoadModule("/src/postgres-typed-v12-transport.ts");
    const renewal = await vite.ssrLoadModule("/src/postgres-device-credential-renewal.ts");
    const constants = await vite.ssrLoadModule("/src/constants.ts");
    const { ApiError } = await vite.ssrLoadModule("/src/errors.ts");

    async function assertNeutral401(promise, message) {
      const error = await rejection(promise);
      assert.ok(error instanceof ApiError, `${message}: expected ApiError, got ${error?.name ?? "success"}`);
      assert.deepEqual(errorShape(error), NEUTRAL_401, message);
    }

    async function freshRead(sql, values) {
      const client = await observer.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const result = await client.query(sql, values);
        await client.query("COMMIT");
        return result.rows;
      } finally {
        client.release();
      }
    }

    async function deviceRow(deviceId) {
      const rows = await freshRead(
        `SELECT state, revoked_at, last_used_at, expires_at, credential_generation
           FROM ${q(schema, "device_credentials")} WHERE id = $1`,
        [deviceId],
      );
      assert.equal(rows.length, 1);
      return {
        state: rows[0].state,
        revokedAt: rows[0].revoked_at === null ? null : rows[0].revoked_at.toISOString(),
        lastUsedAt: rows[0].last_used_at.toISOString(),
        expiresAt: rows[0].expires_at.toISOString(),
        generation: rows[0].credential_generation,
      };
    }

    async function grantRows(ids) {
      const rows = await freshRead(
        `SELECT id, state, revoked_at, consume_lease_expires_at
           FROM ${q(schema, "device_upload_authorizations")} WHERE id = ANY($1::text[])`,
        [ids],
      );
      return Object.fromEntries(rows.map((row) => [row.id, {
        state: row.state,
        revokedAt: row.revoked_at === null ? null : row.revoked_at.toISOString(),
        leaseExpiresAt: row.consume_lease_expires_at === null
          ? null : row.consume_lease_expires_at.toISOString(),
      }]));
    }

    async function seedSocial({
      issuedAt = T0 - DAY,
      socialVerifiedAt = issuedAt,
      lastUsedAt = T0 - HOUR,
      expiresAt = T0 + 29 * DAY,
      consentVersion = constants.TELEMETRY_CONSENT_VERSION,
      participantState = "active",
    } = {}) {
      const participantId = `participant:${randomUUID()}`;
      const deviceId = randomUUID();
      const sessionId = randomUUID();
      const pairingId = randomUUID();
      const value = secret();
      await pool.query(
        `INSERT INTO ${q(schema, "participants")} (id, owner_kind, state, consent_version, created_at)
         VALUES ($1, 'social', $2, $3, $4::timestamptz)`,
        [participantId, participantState, consentVersion, iso(issuedAt)],
      );
      await pool.query(
        `INSERT INTO ${q(schema, "web_sessions")} (
           id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
         ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $5::timestamptz)`,
        [sessionId, participantId, randomBytes(32), randomBytes(32), iso(issuedAt), iso(issuedAt + DAY)],
      );
      await pool.query(
        `INSERT INTO ${q(schema, "device_pairings")} (
           id, participant_id, issued_by_session_id, secret_hash, consent_version,
           transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
         ) VALUES ($1, $2, $3, $4, $5, $5, 'consumed', $6::timestamptz, $7::timestamptz,
           $6::timestamptz, $8)`,
        [pairingId, participantId, sessionId, randomBytes(32),
          consentVersion ?? constants.TELEMETRY_CONSENT_VERSION,
          iso(issuedAt), iso(issuedAt + HOUR), deviceId],
      );
      await pool.query(
        `INSERT INTO ${q(schema, "device_credentials")} (
           id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
           state, issued_at, expires_at, last_used_at, social_verified_at
         ) VALUES ($1, $2, 'social', $3, $4, 'active', $5::timestamptz, $6::timestamptz,
           $7::timestamptz, $8::timestamptz)`,
        [deviceId, participantId, pairingId, deviceSecretHash(deviceId, value), iso(issuedAt),
          iso(expiresAt), iso(lastUsedAt), socialVerifiedAt === null ? null : iso(socialVerifiedAt)],
      );
      return { participantId, deviceId, secret: value, authorization: authorization(deviceId, value) };
    }

    async function seedAccountless({
      issuedAt = T0 - DAY,
      lastUsedAt = T0 - HOUR,
      expiresAt = T0 + 29 * DAY,
      v11ExpiresAt = expiresAt,
      withV12 = false,
    } = {}) {
      const participantId = `participant:${randomUUID()}`;
      const deviceId = randomUUID();
      const value = secret();
      const hash = deviceSecretHash(deviceId, value);
      await pool.query(
        `INSERT INTO ${q(schema, "participants")} (id, owner_kind, state, consent_version, created_at)
         VALUES ($1, 'accountless', 'active', NULL, $2::timestamptz)`,
        [participantId, iso(issuedAt)],
      );
      await pool.query(
        `INSERT INTO ${q(schema, "accountless_enrollment_ledger")} (
           device_id, device_secret_hash, installation_principal_id, schema_version,
           policy_version, authorization_basis, state, issued_at, expires_at
         ) VALUES ($1, $2, $3, 'accountless-enrollment-v1', 'accountless-opt-out-v1',
           'accountless-policy-v1', 'active', $4::timestamptz, $5::timestamptz)`,
        [deviceId, hash, `synthetic-install-${deviceId}`, iso(issuedAt), iso(expiresAt)],
      );
      await pool.query(
        `INSERT INTO ${q(schema, "device_credentials")} (
           id, participant_id, authority_kind, accountless_enrollment_device_id,
           secret_hash, state, issued_at, expires_at, last_used_at
         ) VALUES ($1, $2, 'accountless', $1, $3, 'active', $4::timestamptz, $5::timestamptz,
           $6::timestamptz)`,
        [deviceId, participantId, hash, iso(issuedAt), iso(expiresAt), iso(lastUsedAt)],
      );
      await pool.query(
        `INSERT INTO ${q(schema, "accountless_upload_owners")} (
           enrollment_device_id, participant_id, device_credential_id, policy_version,
           authorization_basis, authorized_at, expires_at, state
         ) VALUES ($1, $2, $1, 'accountless-opt-out-v1', 'accountless-policy-v1',
           $3::timestamptz, $4::timestamptz, 'active')`,
        [deviceId, participantId, iso(issuedAt), iso(expiresAt)],
      );
      await pool.query(
        `INSERT INTO ${q(schema, "accountless_v11_device_authorizations")} (
           enrollment_device_id, participant_id, device_credential_id,
           telemetry_schema_version, field_dictionary_version, privacy_contract_version,
           authorized_at, expires_at, state
         ) VALUES ($1, $2, $1, 'telemetry-contribution-v1.1',
           'telemetry-v1.1-registry-2026-08-31.1', 'ongoing-privacy-safe-telemetry-v1.1',
           $3::timestamptz, $4::timestamptz, 'active')`,
        [deviceId, participantId, iso(issuedAt), iso(v11ExpiresAt)],
      );
      const device = { participantId, deviceId, secret: value, authorization: authorization(deviceId, value) };
      if (withV12) await grantV12(device, issuedAt, expiresAt);
      return device;
    }

    async function grantV12(device, authorizedAt, expiresAt) {
      await pool.query(
        `INSERT INTO ${q(schema, "accountless_v12_device_authorizations")} (
           enrollment_device_id, participant_id, device_credential_id,
           telemetry_schema_version, field_dictionary_version, privacy_contract_version,
           authorized_at, expires_at, state
         ) VALUES ($1, $2, $1, 'telemetry-contribution-v1.2',
           'telemetry-v1.2-registry-2026-09-20.1', 'ongoing-privacy-safe-telemetry-v1.2',
           $3::timestamptz, $4::timestamptz, 'active')`,
        [device.deviceId, device.participantId, iso(authorizedAt), iso(expiresAt)],
      );
    }

    async function seedGrant(device, state, { issuedAt = T0, leaseExpiresAt = null } = {}) {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO ${q(schema, "device_upload_authorizations")} (
           id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
           body_bytes, content_type, state, issued_at, expires_at, consumed_at,
           consume_lease_expires_at, consumed_contribution_id
         ) VALUES ($1, $2, $3, $4, $5, 1, 'application/json', $6, $7::timestamptz,
           $8::timestamptz, $9::timestamptz, $10::timestamptz, $11)`,
        [id, device.participantId, device.deviceId, randomBytes(32), "a".repeat(64), state,
          iso(issuedAt), iso(issuedAt + DAY), state === "consumed" ? iso(issuedAt + MINUTE) : null,
          leaseExpiresAt === null ? null : iso(leaseExpiresAt),
          state === "consumed" ? `synthetic-contribution-${id}` : null],
      );
      return id;
    }

    async function rotate(device, nowEpoch) {
      const next = secret();
      const receipt = await renewal.renewPostgresDeviceCredential(pool, device.authorization, {
        nextDeviceSecretHash: deviceSecretHash(device.deviceId, next).toString("hex"),
        rotationAttemptId: randomUUID(),
      }, { ...options, nowEpoch });
      assert.equal(receipt.commit, true);
      return { ...device, secret: next, authorization: authorization(device.deviceId, next),
        previousAuthorization: device.authorization };
    }

    const authenticators = [
      ["authenticatePostgresDeviceBearer",
        (header, extra) => bearer.authenticatePostgresDeviceBearer(pool, header, { ...options, ...extra })],
      ["authenticatePostgresDevice",
        (header, extra) => transport.authenticatePostgresDevice(pool, header, { ...options, ...extra })],
      ["authenticatePostgresAccountlessForV12Grant",
        (header, extra) => bearer.authenticatePostgresAccountlessForV12Grant(pool, header, { ...options, ...extra })],
    ];

    await t.test("a rotated-out social secret gives 401 and the revocation is committed", async () => {
      for (const [name, authenticate] of authenticators) {
        const seeded = await seedSocial();
        const rotated = await rotate(seeded, T0);
        if (name !== "authenticatePostgresAccountlessForV12Grant") {
          const principal = await authenticate(rotated.authorization, { nowEpoch: T0 + MINUTE });
          assert.equal(principal.credentialGeneration, 2, `${name}: current secret authenticates`);
        }
        const unused = await seedGrant(rotated, "unused");
        const consuming = await seedGrant(rotated, "consuming", { leaseExpiresAt: T0 + 5 * MINUTE });
        const consumed = await seedGrant(rotated, "consumed");
        const bystander = await seedSocial();
        const bystanderGrant = await seedGrant(bystander, "unused");

        const reuseAt = T0 + 2 * MINUTE;
        await assertNeutral401(
          authenticate(rotated.previousAuthorization, { nowEpoch: reuseAt }),
          `${name}: rotated-out secret`,
        );
        assert.deepEqual(await deviceRow(rotated.deviceId), {
          state: "revoked",
          revokedAt: iso(reuseAt),
          lastUsedAt: name === "authenticatePostgresAccountlessForV12Grant" ? iso(T0) : iso(T0 + MINUTE),
          expiresAt: name === "authenticatePostgresAccountlessForV12Grant"
            ? iso(T0 + 30 * DAY) : iso(T0 + MINUTE + 30 * DAY),
          generation: 2,
        }, `${name}: a fresh transaction sees the device revoked`);
        assert.deepEqual(await grantRows([unused, consuming, consumed, bystanderGrant]), {
          [unused]: { state: "revoked", revokedAt: iso(reuseAt), leaseExpiresAt: null },
          [consuming]: { state: "revoked", revokedAt: iso(reuseAt), leaseExpiresAt: null },
          [consumed]: { state: "consumed", revokedAt: null, leaseExpiresAt: null },
          [bystanderGrant]: { state: "unused", revokedAt: null, leaseExpiresAt: null },
        }, `${name}: only this device's pending grants are revoked`);
        assert.equal((await deviceRow(bystander.deviceId)).state, "active");

        // The revoked lineage is dead for the current secret as well, and a
        // repeated reuse keeps the first revocation instant.
        await assertNeutral401(
          authenticate(rotated.authorization, { nowEpoch: reuseAt + MINUTE }),
          `${name}: current secret after reuse revocation`,
        );
        await assertNeutral401(
          authenticate(rotated.previousAuthorization, { nowEpoch: reuseAt + 2 * MINUTE }),
          `${name}: repeated reuse`,
        );
        assert.equal((await deviceRow(rotated.deviceId)).revokedAt, iso(reuseAt));
      }
    });

    await t.test("a retired rotation no longer revokes and an uncommitted revocation is never a 401", async () => {
      const seeded = await seedSocial();
      const rotated = await rotate(seeded, T0);
      await pool.query(
        `UPDATE ${q(schema, "device_credential_rotations")} SET retire_at = $2::timestamptz
          WHERE device_id = $1`,
        [rotated.deviceId, iso(T0 + MINUTE)],
      );
      const grant = await seedGrant(rotated, "unused");
      await assertNeutral401(
        bearer.authenticatePostgresDeviceBearer(pool, rotated.previousAuthorization,
          { ...options, nowEpoch: T0 + MINUTE }),
        "retired prior secret",
      );
      assert.equal((await deviceRow(rotated.deviceId)).state, "active");
      assert.equal((await grantRows([grant]))[grant].state, "unused");
      const principal = await bearer.authenticatePostgresDeviceBearer(pool, rotated.authorization,
        { ...options, nowEpoch: T0 + 2 * MINUTE });
      assert.equal(principal.deviceId, rotated.deviceId);

      // If COMMIT itself fails the revocation outcome is unknown: the caller
      // gets a retryable 503, never a 401 that claims a durable revocation.
      const uncommitted = await rotate(await seedSocial(), T0);
      const commitFailingPool = {
        async connect() {
          const client = await pool.connect();
          return {
            query: (text, values) => (text === "COMMIT"
              ? Promise.reject(Object.assign(new Error("synthetic commit failure"), { code: "08006" }))
              : client.query(text, values)),
            release: (discard) => client.release(discard),
          };
        },
      };
      const failure = await rejection(bearer.authenticatePostgresDeviceBearer(
        commitFailingPool, uncommitted.previousAuthorization, { ...options, nowEpoch: T0 + MINUTE },
      ));
      assert.ok(failure instanceof ApiError);
      assert.deepEqual([failure.status, failure.code], [503, "BACKEND_STORAGE_UNAVAILABLE"]);
      assert.equal((await deviceRow(uncommitted.deviceId)).state, "active",
        "the discarded connection rolled the revocation back");
    });

    await t.test("an accountless device with only the v1.1 grant authenticates under v1.1 and fails under v1.2", async () => {
      const expiresAt = T0 + 10 * DAY;
      // Accountless bearers are leases: the Worker applies no idle bound.
      const device = await seedAccountless({
        issuedAt: T0 - 60 * DAY, lastUsedAt: T0 - 45 * DAY, expiresAt,
      });
      const expected = {
        deviceId: device.deviceId,
        participantId: device.participantId,
        participantConsentVersion: null,
        expiresAt: iso(expiresAt),
        credentialGeneration: 1,
        socialVerifiedAt: null,
        authorityKind: "accountless",
      };
      assert.deepEqual(
        await bearer.authenticatePostgresDeviceBearer(pool, device.authorization, { ...options, nowEpoch: T0 }),
        expected,
        "the shared helper defaults to the Worker's v1.1 gate",
      );
      assert.deepEqual(await deviceRow(device.deviceId), {
        state: "active", revokedAt: null, lastUsedAt: iso(T0), expiresAt: iso(expiresAt), generation: 1,
      }, "accountless use bumps last_used_at and never slides the lease");

      await assertNeutral401(
        bearer.authenticatePostgresDeviceBearer(pool, device.authorization,
          { ...options, nowEpoch: T0 + MINUTE, accountlessAuthorizationVersion: "v1.2" }),
        "v1.1-only device under v1.2",
      );
      await assertNeutral401(
        transport.authenticatePostgresDevice(pool, device.authorization, { ...options, nowEpoch: T0 + MINUTE }),
        "the legacy wrapper keeps its v1.2 default",
      );
      assert.equal((await deviceRow(device.deviceId)).lastUsedAt, iso(T0), "a refused attempt writes nothing");
      assert.deepEqual(
        await transport.authenticatePostgresDevice(pool, device.authorization,
          { ...options, nowEpoch: T0 + 2 * MINUTE, accountlessAuthorizationVersion: "v1.1" }),
        expected,
      );
      assert.deepEqual(
        await bearer.authenticatePostgresAccountlessForV12Grant(pool, device.authorization,
          { ...options, nowEpoch: T0 + 3 * MINUTE }),
        expected,
        "the v1.2 grant route authenticates before the grant exists",
      );
      assert.equal((await deviceRow(device.deviceId)).lastUsedAt, iso(T0 + 3 * MINUTE));

      await grantV12(device, T0 - 60 * DAY, expiresAt);
      assert.deepEqual(
        await bearer.authenticatePostgresDeviceBearer(pool, device.authorization,
          { ...options, nowEpoch: T0 + 4 * MINUTE, accountlessAuthorizationVersion: "v1.2" }),
        expected,
      );
      assert.deepEqual(
        await transport.authenticatePostgresDevice(pool, device.authorization, { ...options, nowEpoch: T0 + 5 * MINUTE }),
        expected,
      );
      await assert.rejects(
        bearer.authenticatePostgresDeviceBearer(pool, device.authorization,
          { ...options, nowEpoch: T0, accountlessAuthorizationVersion: "v1.3" }),
        TypeError,
      );
    });

    await t.test("every accountless failure is the neutral 401, including on the v1.2 grant route", async () => {
      const expiresAt = T0 + 10 * DAY;
      const failures = [
        ["revoked v1.1 grant", async (device) => pool.query(
          `UPDATE ${q(schema, "accountless_v11_device_authorizations")}
              SET state = 'revoked', revoked_at = $2::timestamptz, revocation_reason = 'user_opt_out'
            WHERE enrollment_device_id = $1`, [device.deviceId, iso(T0)])],
        ["revoked owner", async (device) => pool.query(
          `UPDATE ${q(schema, "accountless_upload_owners")}
              SET state = 'revoked', revoked_at = $2::timestamptz, revocation_reason = 'user_opt_out'
            WHERE enrollment_device_id = $1`, [device.deviceId, iso(T0)])],
        ["revoked ledger", async (device) => pool.query(
          `UPDATE ${q(schema, "accountless_enrollment_ledger")}
              SET state = 'revoked', revoked_at = $2::timestamptz, revocation_reason = 'user_opt_out'
            WHERE device_id = $1`, [device.deviceId, iso(T0)])],
        ["revoked device", async (device) => pool.query(
          `UPDATE ${q(schema, "device_credentials")} SET state = 'revoked', revoked_at = $2::timestamptz
            WHERE id = $1`, [device.deviceId, iso(T0)])],
        ["v1.1 grant expiry differs from the lease", async (device) => pool.query(
          `UPDATE ${q(schema, "accountless_v11_device_authorizations")}
              SET expires_at = $2::timestamptz WHERE enrollment_device_id = $1`,
          [device.deviceId, iso(expiresAt - DAY)])],
        ["owner expiry differs from the lease", async (device) => pool.query(
          `UPDATE ${q(schema, "accountless_upload_owners")}
              SET expires_at = $2::timestamptz WHERE enrollment_device_id = $1`,
          [device.deviceId, iso(expiresAt - DAY)])],
        ["device expiry differs from the ledger, owner and grants", async (device) => pool.query(
          `UPDATE ${q(schema, "device_credentials")} SET expires_at = $2::timestamptz WHERE id = $1`,
          [device.deviceId, iso(expiresAt + DAY)])],
        // The schema allows these corrupted states; D1 refuses the first by
        // trigger and the Worker's authenticateDevice refuses the other two.
        ["accountless participant carries a consent version", async (device) => pool.query(
          `UPDATE ${q(schema, "participants")} SET consent_version = $2 WHERE id = $1`,
          [device.participantId, constants.TELEMETRY_CONSENT_VERSION])],
        ["accountless device carries social_verified_at", async (device) => pool.query(
          `UPDATE ${q(schema, "device_credentials")} SET social_verified_at = $2::timestamptz WHERE id = $1`,
          [device.deviceId, iso(T0 - HOUR)])],
        ["participant owner kind differs from the device authority", async (device) => pool.query(
          `UPDATE ${q(schema, "participants")} SET owner_kind = 'social' WHERE id = $1`,
          [device.participantId])],
      ];
      for (const [label, damage] of failures) {
        const device = await seedAccountless({ expiresAt, withV12: true });
        const damaged = await damage(device);
        assert.equal(damaged.rowCount, 1, `${label}: exactly one row damaged`);
        for (const [name, authenticate] of authenticators) {
          await assertNeutral401(authenticate(device.authorization, { nowEpoch: T0 + MINUTE }), `${name}: ${label}`);
        }
        assert.equal((await deviceRow(device.deviceId)).lastUsedAt, iso(T0 - HOUR), `${label}: no write`);
      }

      // The v1.2 grant must share the lease expiry, but it is read only when
      // v1.2 is requested: the Worker's v1.1 gate and the grant route ignore it.
      const typedMismatch = await seedAccountless({ expiresAt, withV12: true });
      const typedDamage = await pool.query(
        `UPDATE ${q(schema, "accountless_v12_device_authorizations")}
            SET expires_at = $2::timestamptz WHERE enrollment_device_id = $1`,
        [typedMismatch.deviceId, iso(expiresAt - DAY)],
      );
      assert.equal(typedDamage.rowCount, 1);
      await assertNeutral401(
        bearer.authenticatePostgresDeviceBearer(pool, typedMismatch.authorization,
          { ...options, nowEpoch: T0 + MINUTE, accountlessAuthorizationVersion: "v1.2" }),
        "v1.2 grant expiry differs from the lease under 'v1.2'",
      );
      await assertNeutral401(
        transport.authenticatePostgresDevice(pool, typedMismatch.authorization, { ...options, nowEpoch: T0 + MINUTE }),
        "v1.2 grant expiry differs from the lease under the wrapper default",
      );
      assert.equal((await deviceRow(typedMismatch.deviceId)).lastUsedAt, iso(T0 - HOUR),
        "v1.2 grant expiry mismatch: no write");
      assert.equal((await bearer.authenticatePostgresDeviceBearer(pool, typedMismatch.authorization,
        { ...options, nowEpoch: T0 + 2 * MINUTE })).deviceId, typedMismatch.deviceId);
      assert.equal((await bearer.authenticatePostgresAccountlessForV12Grant(pool, typedMismatch.authorization,
        { ...options, nowEpoch: T0 + 3 * MINUTE })).deviceId, typedMismatch.deviceId);

      const expired = await seedAccountless({ expiresAt, withV12: true });
      for (const [name, authenticate] of authenticators) {
        await assertNeutral401(authenticate(expired.authorization, { nowEpoch: expiresAt }), `${name}: expired lease`);
        assert.equal((await authenticate(expired.authorization, { nowEpoch: expiresAt - 1 })).deviceId,
          expired.deviceId, `${name}: lease valid until its last millisecond`);
      }

      const wrongSecret = await seedAccountless({ expiresAt, withV12: true });
      for (const [name, authenticate] of authenticators) {
        await assertNeutral401(authenticate(authorization(wrongSecret.deviceId, secret()), { nowEpoch: T0 }),
          `${name}: wrong accountless secret`);
      }
      assert.equal((await deviceRow(wrongSecret.deviceId)).state, "active");

      const social = await seedSocial();
      await assertNeutral401(
        bearer.authenticatePostgresAccountlessForV12Grant(pool, social.authorization, { ...options, nowEpoch: T0 }),
        "social bearer on the accountless v1.2 grant route",
      );
      assert.equal(
        (await bearer.authenticatePostgresDeviceBearer(pool, social.authorization, { ...options, nowEpoch: T0 })).authorityKind,
        "social",
      );
    });

    await t.test("social bearers slide within the 30-day idle bound and the 180-day social cap", async () => {
      const device = await seedSocial({
        issuedAt: T0, socialVerifiedAt: T0, lastUsedAt: T0, expiresAt: T0 + 30 * DAY,
      });
      const first = await bearer.authenticatePostgresDeviceBearer(pool, device.authorization,
        { ...options, nowEpoch: T0 + 10 * DAY });
      assert.deepEqual(first, {
        deviceId: device.deviceId,
        participantId: device.participantId,
        participantConsentVersion: constants.TELEMETRY_CONSENT_VERSION,
        expiresAt: iso(T0 + 40 * DAY),
        credentialGeneration: 1,
        socialVerifiedAt: iso(T0),
        authorityKind: "social",
      });
      assert.deepEqual(await deviceRow(device.deviceId), {
        state: "active", revokedAt: null, lastUsedAt: iso(T0 + 10 * DAY),
        expiresAt: iso(T0 + 40 * DAY), generation: 1,
      });
      const second = await bearer.authenticatePostgresDeviceBearer(pool, device.authorization,
        { ...options, nowEpoch: T0 + 39 * DAY });
      assert.equal(second.expiresAt, iso(T0 + 69 * DAY), "active use keeps sliding");

      const now = T0;
      // Idle bound: exactly 30 days idle is too long; one millisecond less is not.
      const idle = await seedSocial({ lastUsedAt: now - 30 * DAY, issuedAt: now - 40 * DAY, expiresAt: now + DAY });
      await assertNeutral401(
        bearer.authenticatePostgresDeviceBearer(pool, idle.authorization, { ...options, nowEpoch: now }),
        "30 days idle",
      );
      assert.deepEqual(await deviceRow(idle.deviceId), {
        state: "active", revokedAt: null, lastUsedAt: iso(now - 30 * DAY), expiresAt: iso(now + DAY), generation: 1,
      }, "an idle refusal does not revive the device");
      const nearlyIdle = await seedSocial({ lastUsedAt: now - 30 * DAY + 1, issuedAt: now - 40 * DAY, expiresAt: now + DAY });
      assert.equal((await bearer.authenticatePostgresDeviceBearer(pool, nearlyIdle.authorization,
        { ...options, nowEpoch: now })).expiresAt, iso(now + 30 * DAY));
      const future = await seedSocial({ lastUsedAt: now + 1, expiresAt: now + DAY });
      await assertNeutral401(
        bearer.authenticatePostgresDeviceBearer(pool, future.authorization, { ...options, nowEpoch: now }),
        "last use in the future",
      );

      // Social cap: renewal never passes socialVerified + 180 days.
      const capped = await seedSocial({
        issuedAt: now - 170 * DAY, socialVerifiedAt: now - 170 * DAY, lastUsedAt: now - DAY, expiresAt: now + 5 * DAY,
      });
      const cappedPrincipal = await bearer.authenticatePostgresDeviceBearer(pool, capped.authorization,
        { ...options, nowEpoch: now });
      assert.equal(cappedPrincipal.expiresAt, iso(now + 10 * DAY));
      assert.equal((await deviceRow(capped.deviceId)).expiresAt, iso(now + 10 * DAY));
      const stale = await seedSocial({
        issuedAt: now - 180 * DAY, socialVerifiedAt: now - 180 * DAY, lastUsedAt: now - DAY, expiresAt: now + DAY,
      });
      await assertNeutral401(
        bearer.authenticatePostgresDeviceBearer(pool, stale.authorization, { ...options, nowEpoch: now }),
        "social verification 180 days old",
      );
      assert.equal((await deviceRow(stale.deviceId)).lastUsedAt, iso(now - DAY));
      // social_verified_at falls back to issued_at.
      const legacyStale = await seedSocial({
        issuedAt: now - 180 * DAY, socialVerifiedAt: null, lastUsedAt: now - DAY, expiresAt: now + DAY,
      });
      await assertNeutral401(
        bearer.authenticatePostgresDeviceBearer(pool, legacyStale.authorization, { ...options, nowEpoch: now }),
        "issued_at fallback past the social cap",
      );
      const legacy = await seedSocial({
        issuedAt: now - 179 * DAY, socialVerifiedAt: null, lastUsedAt: now - DAY, expiresAt: now + DAY,
      });
      const legacyPrincipal = await bearer.authenticatePostgresDeviceBearer(pool, legacy.authorization,
        { ...options, nowEpoch: now });
      assert.deepEqual([legacyPrincipal.socialVerifiedAt, legacyPrincipal.expiresAt],
        [iso(now - 179 * DAY), iso(now + DAY)]);
      // social_verified_at takes precedence over issued_at: a continuity re-pair
      // refreshes social_verified_at and keeps the original issued_at, so a
      // re-verified device is capped by its re-verification, not its issue.
      const repaired = await seedSocial({
        issuedAt: now - 200 * DAY, socialVerifiedAt: now - 160 * DAY, lastUsedAt: now - HOUR, expiresAt: now + DAY,
      });
      const repairedPrincipal = await bearer.authenticatePostgresDeviceBearer(pool, repaired.authorization,
        { ...options, nowEpoch: now });
      assert.deepEqual([repairedPrincipal.socialVerifiedAt, repairedPrincipal.expiresAt],
        [iso(now - 160 * DAY), iso(now + 20 * DAY)], "issued_at past the cap does not refuse a re-verified device");
      assert.equal((await deviceRow(repaired.deviceId)).expiresAt, iso(now + 20 * DAY));
      const staleVerification = await seedSocial({
        issuedAt: now - DAY, socialVerifiedAt: now - 180 * DAY, lastUsedAt: now - HOUR, expiresAt: now + DAY,
      });
      await assertNeutral401(
        bearer.authenticatePostgresDeviceBearer(pool, staleVerification.authorization, { ...options, nowEpoch: now }),
        "a recent issued_at does not rescue a stale social_verified_at",
      );
      assert.equal((await deviceRow(staleVerification.deviceId)).lastUsedAt, iso(now - HOUR));

      // Expiry, consent and participant state.
      const expiring = await seedSocial({ expiresAt: now + 1 });
      await assertNeutral401(
        bearer.authenticatePostgresDeviceBearer(pool, expiring.authorization, { ...options, nowEpoch: now + 1 }),
        "expired social bearer",
      );
      assert.equal((await bearer.authenticatePostgresDeviceBearer(pool, expiring.authorization,
        { ...options, nowEpoch: now })).deviceId, expiring.deviceId);
      const accountScoped = await seedSocial({ consentVersion: constants.ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION });
      assert.equal((await bearer.authenticatePostgresDeviceBearer(pool, accountScoped.authorization,
        { ...options, nowEpoch: now })).participantConsentVersion, constants.ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION);
      const unknownConsent = await seedSocial({ consentVersion: "synthetic-unknown-consent" });
      await assertNeutral401(
        bearer.authenticatePostgresDeviceBearer(pool, unknownConsent.authorization, { ...options, nowEpoch: now }),
        "non-ongoing consent",
      );
      const deleting = await seedSocial({ participantState: "deleting" });
      await assertNeutral401(
        bearer.authenticatePostgresDeviceBearer(pool, deleting.authorization, { ...options, nowEpoch: now }),
        "deleting participant",
      );
    });

    await t.test("the accountless write fence requires an exact authorization version", async () => {
      const leaseExpiresAt = T0 + 10 * DAY;
      const device = await seedAccountless({ expiresAt: leaseExpiresAt });
      // No authorizationVersion key: an omitted fence argument must not mean v1.1.
      const request = {
        schema: options.schema,
        participantId: device.participantId,
        deviceId: device.deviceId,
        enrollmentDeviceId: device.deviceId,
        deviceExpiresAt: iso(leaseExpiresAt),
        nowEpoch: T0,
      };
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        assert.equal(await bearer.readPostgresAccountlessDeviceAuthority(client,
          { ...request, authorizationVersion: "v1.1" }), true, "v1.1-only device holds the v1.1 graph");
        assert.equal(await bearer.readPostgresAccountlessDeviceAuthority(client,
          { ...request, authorizationVersion: "v1.2" }), false, "v1.1-only device lacks the v1.2 grant");
        await assert.rejects(bearer.readPostgresAccountlessDeviceAuthority(client, request), TypeError,
          "omitted authorizationVersion");
        for (const authorizationVersion of [undefined, null, "", "v1.3", "V1.1"]) {
          await assert.rejects(
            bearer.readPostgresAccountlessDeviceAuthority(client, { ...request, authorizationVersion }),
            TypeError,
            `authorizationVersion ${JSON.stringify(authorizationVersion)}`,
          );
        }
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    await t.test("malformed headers, unknown devices and wrong secrets give the identical 401", async () => {
      const device = await seedSocial();
      const unknownId = randomUUID();
      const valid = device.secret;
      const nonCanonical = `${valid.slice(0, 42)}B`;
      const headers = [
        null,
        "",
        "Device",
        "Device ",
        `device um_device_${device.deviceId}.${valid}`,
        `Bearer um_device_${device.deviceId}.${valid}`,
        `Upload um_device_upload_${device.deviceId}.${valid}`,
        `Device  um_device_${device.deviceId}.${valid}`,
        `Device um_device_${device.deviceId}.${valid} `,
        `Device um_device_${device.deviceId.toUpperCase()}.${valid}`,
        `Device um_device_${device.deviceId.replace(/^(.{14})4/u, "$11")}.${valid}`,
        `Device um_device_${device.deviceId}.${valid.slice(0, 42)}`,
        `Device um_device_${device.deviceId}.${valid}A`,
        `Device um_device_${device.deviceId}.${valid.slice(0, 42)}+`,
        `Device um_device_${device.deviceId}.${nonCanonical}`,
        authorization(unknownId, valid),
        authorization(device.deviceId, secret()),
      ];
      for (const [name, authenticate] of authenticators) {
        for (const header of headers) {
          await assertNeutral401(authenticate(header, { nowEpoch: T0 }), `${name}: ${JSON.stringify(header)?.slice(0, 40)}`);
        }
      }
      assert.deepEqual(await deviceRow(device.deviceId), {
        state: "active", revokedAt: null, lastUsedAt: iso(T0 - HOUR), expiresAt: iso(T0 + 29 * DAY), generation: 1,
      }, "refused attempts neither revoke nor bump the device");
      const unknownRows = await freshRead(
        `SELECT count(*)::integer AS count FROM ${q(schema, "device_credentials")} WHERE id = $1`, [unknownId],
      );
      assert.equal(unknownRows[0].count, 0);
    });

    await t.test("storage failures are 503, never an authentication verdict", async () => {
      const device = await seedSocial();
      const unavailable = { connect: async () => { throw new Error("synthetic connect failure"); } };
      for (const authenticate of [
        (header) => bearer.authenticatePostgresDeviceBearer(unavailable, header, { ...options, nowEpoch: T0 }),
        (header) => bearer.authenticatePostgresAccountlessForV12Grant(unavailable, header, { ...options, nowEpoch: T0 }),
        (header) => transport.authenticatePostgresDevice(unavailable, header, { ...options, nowEpoch: T0 }),
      ]) {
        const failure = await rejection(authenticate(device.authorization));
        assert.ok(failure instanceof ApiError);
        assert.deepEqual([failure.status, failure.code], [503, "BACKEND_STORAGE_UNAVAILABLE"]);
        // Header grammar is decided before any storage access.
        await assertNeutral401(authenticate("Device malformed"), "malformed header without storage");
      }
    });
  } finally {
    if (pool && schemaCreated) {
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch {}
    }
    if (observer) await observer.end();
    if (pool) await pool.end();
    if (vite) await vite.close();
  }
});
