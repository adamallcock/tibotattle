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

async function localEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "PostgreSQL telemetry-format tests require a loopback host or a private Unix socket");
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65535);
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
  return PG_TEST_HOST ? { host: PG_TEST_HOST, port: PG_TEST_PORT, socket: false } : null;
}

function q(schema, name) {
  return `"${schema}"."${name}"`;
}

function deviceSecretHash(deviceId, secret) {
  return createHash("sha256")
    .update(`app-usagemonitor/device/v1\0${deviceId}\0`)
    .update(Buffer.from(secret, "base64url"))
    .digest();
}

async function seedSocialDevice({ pool, schema, nowEpoch, consentVersion }) {
  const now = new Date(nowEpoch).toISOString();
  const expiresAt = new Date(nowEpoch + 30 * 24 * 60 * 60_000).toISOString();
  const participantId = `synthetic-format-${randomBytes(6).toString("hex")}`;
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const pairingId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO ${q(schema, "participants")} (id, owner_kind, state, consent_version, created_at)
     VALUES ($1,'social','active',$2,$3)`,
    [participantId, consentVersion, now],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "web_sessions")} (
       id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$5)`,
    [sessionId, participantId, randomBytes(32), randomBytes(32), now, expiresAt],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "device_pairings")} (
       id, participant_id, issued_by_session_id, secret_hash, consent_version,
       transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
     ) VALUES ($1,$2,$3,$4,$5,$5,'consumed',$6,$7,$6,$8)`,
    [pairingId, participantId, sessionId, randomBytes(32), consentVersion,
      now, expiresAt, deviceId],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "device_credentials")} (
       id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
       state, issued_at, expires_at, last_used_at, social_verified_at
     ) VALUES ($1,$2,'social',$3,$4,'active',$5,$6,$5,$5)`,
    [deviceId, participantId, pairingId, deviceSecretHash(deviceId, secret), now, expiresAt],
  );
  // Primary 0051 (D1 parity) gives a social participant its creation floor
  // (rank 1, revision 0) on insert; the fixture only checks it.
  assert.deepEqual((await pool.query(
    `SELECT minimum_rank, revision FROM ${q(schema, "telemetry_transport_participant_floors")}
      WHERE participant_id=$1`,
    [participantId],
  )).rows, [{ minimum_rank: 1, revision: 0 }]);
  return {
    participantId,
    deviceId,
    bearer: `Device um_device_${deviceId}.${secret}`,
    expiresAt,
  };
}

async function seedAccountlessDevice({ pool, schema, nowEpoch, withSharedV11 = false }) {
  const now = new Date(nowEpoch).toISOString();
  const expiresAt = new Date(nowEpoch + 30 * 24 * 60 * 60_000).toISOString();
  const participantId = `synthetic-format-accountless-${randomBytes(6).toString("hex")}`;
  const deviceId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO ${q(schema, "participants")} (id, owner_kind, state, consent_version, created_at)
     VALUES ($1,'accountless','active',NULL,$2)`,
    [participantId, now],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "telemetry_transport_participant_floors")} (
       participant_id, minimum_rank, changed_at
     ) VALUES ($1,11,$2)`,
    [participantId, now],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "accountless_enrollment_ledger")} (
       device_id, device_secret_hash, installation_principal_id, schema_version,
       policy_version, authorization_basis, state, issued_at, expires_at
     ) VALUES ($1,$2,$3,'accountless-enrollment-v1','accountless-opt-out-v1',
       'accountless-policy-v1','active',$4,$5)`,
    [deviceId, deviceSecretHash(deviceId, secret), `synthetic-install-${deviceId}`, now, expiresAt],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "device_credentials")} (
       id, participant_id, authority_kind, accountless_enrollment_device_id,
       secret_hash, state, issued_at, expires_at, last_used_at
     ) VALUES ($1,$2,'accountless',$1,$3,'active',$4,$5,$4)`,
    [deviceId, participantId, deviceSecretHash(deviceId, secret), now, expiresAt],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "accountless_upload_owners")} (
       enrollment_device_id, participant_id, device_credential_id, policy_version,
       authorization_basis, authorized_at, expires_at, state
     ) VALUES ($1,$2,$1,'accountless-opt-out-v1','accountless-policy-v1',$3,$4,'active')`,
    [deviceId, participantId, now, expiresAt],
  );
  if (withSharedV11) {
    await insertAccountlessV11Grant({ pool, schema, participantId, deviceId, now, expiresAt });
  }
  await pool.query(
    `INSERT INTO ${q(schema, "accountless_v12_device_authorizations")} (
       enrollment_device_id, participant_id, device_credential_id,
       telemetry_schema_version, field_dictionary_version, privacy_contract_version,
       authorized_at, expires_at, state
     ) VALUES ($1,$2,$1,'telemetry-contribution-v1.2',
       'telemetry-v1.2-registry-2026-09-20.1',
       'ongoing-privacy-safe-telemetry-v1.2',$3,$4,'active')`,
    [deviceId, participantId, now, expiresAt],
  );
  return {
    participantId,
    deviceId,
    bearer: `Device um_device_${deviceId}.${secret}`,
    expiresAt,
  };
}

function insertAccountlessV11Grant({ pool, schema, participantId, deviceId, now, expiresAt }) {
  return pool.query(
    `INSERT INTO ${q(schema, "accountless_v11_device_authorizations")} (
       enrollment_device_id, participant_id, device_credential_id,
       telemetry_schema_version, field_dictionary_version, privacy_contract_version,
       authorized_at, expires_at, state
     ) VALUES ($1,$2,$1,'telemetry-contribution-v1.1',
       'telemetry-v1.1-registry-2026-08-31.1',
       'ongoing-privacy-safe-telemetry-v1.1',$3,$4,'active')`,
    [deviceId, participantId, now, expiresAt],
  );
}

async function insertV11Consent({ pool, schema, participantId, deviceId, now }) {
  return pool.query(
    `INSERT INTO ${q(schema, "telemetry_v11_device_consents")} (
       participant_id, device_id, telemetry_schema_version, field_dictionary_version,
       privacy_contract_version, consented_at
     ) VALUES ($1,$2,'telemetry-contribution-v1.1',
       'telemetry-v1.1-registry-2026-08-31.1',
       'ongoing-privacy-safe-telemetry-v1.1',$3)`,
    [participantId, deviceId, now],
  );
}

async function insertV02History({ pool, schema, participantId, now }) {
  const id = `synthetic-history-${randomBytes(5).toString("hex")}`;
  const digest = randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO ${q(schema, "telemetry_contributions")} (
       id, participant_id, plaintext_digest, envelope_digest, r2_key, status,
       schema_version, transport_schema_version, range_start, range_end,
       client_platform, provider_policy_epoch, priced_event_coverage_percent,
       unknown_model_event_count, unknown_billable_units, price_basis,
       declared_record_count, created_at
     ) VALUES ($1,$2,$3,$4,$5,'accepted','telemetry-contribution-v0.1',
       'telemetry-contribution-v0.2',$6,$6,'synthetic','synthetic-policy',
       0,0,0,'synthetic',0,$6)`,
    [id, participantId, digest, randomBytes(32).toString("hex"), `synthetic/${id}`, now],
  );
}

test("PostgreSQL enforces per-format lifecycle, floors, consent, and successor authorities", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 60_000,
}, async () => {
  const endpoint = await localEndpoint();
  let pool;
  let vite;
  const schema = `format_auth_${randomBytes(6).toString("hex")}`;
  let schemaCreated = false;
  try {
    pool = new pg.Pool({
      host: endpoint.host,
      port: endpoint.port,
      user: PG_TEST_USER,
      ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
      database: PG_TEST_DATABASE,
      ssl: false,
      options: `-c search_path=${schema},public`,
      max: 3,
      connectionTimeoutMillis: 3_000,
    });
    const server = await pool.query(
      "SELECT current_setting('server_version_num')::integer AS version, inet_server_addr()::text AS address",
    );
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17,
      "this qualification test requires PostgreSQL 17");
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
    const authority = await vite.ssrLoadModule("/src/postgres-telemetry-format-authority.ts");
    const transport = await vite.ssrLoadModule("/src/postgres-typed-v12-transport.ts");
    const constants = await vite.ssrLoadModule("/src/constants.ts");
    const nowEpoch = Date.now();
    const now = new Date(nowEpoch).toISOString();
    const social = await seedSocialDevice({
      pool, schema, nowEpoch, consentVersion: constants.TELEMETRY_CONSENT_VERSION,
    });
    const principal = { participantId: social.participantId, deviceId: social.deviceId };

    await authority.assertPostgresTelemetryTransportWriteAllowed(
      pool, principal, "telemetry-contribution-v0.1", { ...options, nowEpoch },
    );
    await authority.assertPostgresTelemetryTransportWriteAllowed(
      pool, principal, "telemetry-contribution-v1.0", { ...options, nowEpoch },
    );
    await assert.rejects(
      authority.assertPostgresTelemetryTransportWriteAllowed(
        pool, principal, "telemetry-contribution-v0.2", { ...options, nowEpoch },
      ),
      { code: "TELEMETRY_TRANSPORT_BLOCKED" },
    );
    await assert.rejects(
      authority.assertPostgresTelemetryTransportWriteAllowed(
        pool, principal, "telemetry-contribution-v2.0", { ...options, nowEpoch },
      ),
      { code: "TELEMETRY_TRANSPORT_BLOCKED" },
    );

    await pool.query(
      `UPDATE ${q(schema, "telemetry_transport_formats")}
          SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'`,
    );
    await assert.rejects(
      authority.assertPostgresTelemetryTransportWriteAllowed(
        pool, principal, "telemetry-contribution-v1.1", { ...options, nowEpoch },
      ),
      { code: "TELEMETRY_CONSENT_INVALID" },
    );
    await insertV11Consent({ pool, schema, participantId: social.participantId, deviceId: social.deviceId, now });
    await authority.assertPostgresTelemetryTransportWriteAllowed(
      pool, principal, "telemetry-contribution-v1.1", { ...options, nowEpoch },
    );

    await pool.query(
      `UPDATE ${q(schema, "telemetry_transport_participant_floors")}
          SET minimum_rank=11, revision=revision+1, changed_at=$2 WHERE participant_id=$1`,
      [social.participantId, now],
    );
    // Primary 0051 (D1 parity) created this device's floor with the device and
    // raised it with the v1.1 consent; the scenario needs a rank-10 device
    // floor under a rank-11 participant floor, so the row is replaced.
    await pool.query(
      `DELETE FROM ${q(schema, "telemetry_transport_device_floors")} WHERE participant_id=$1 AND device_id=$2`,
      [social.participantId, social.deviceId],
    );
    await pool.query(
      `INSERT INTO ${q(schema, "telemetry_transport_device_floors")} (
         participant_id, device_id, minimum_rank, revision, changed_at
       ) VALUES ($1,$2,10,1,$3)`,
      [social.participantId, social.deviceId, now],
    );
    await assert.rejects(
      authority.assertPostgresTelemetryTransportWriteAllowed(
        pool, principal, "telemetry-contribution-v1.0", { ...options, nowEpoch },
      ),
      { code: "POSTGRES_REQUEST_PATH_UNSUPPORTED" },
      "D1's device-first floor admits v1.0 at rank 10, but the PostgreSQL writer's GREATEST floor rejects it",
    );
    await authority.assertPostgresTelemetryTransportWriteAllowed(
      pool, principal, "telemetry-contribution-v1.1", { ...options, nowEpoch },
    );
    await insertV02History({ pool, schema, participantId: social.participantId, now });
    await assert.rejects(
      authority.assertPostgresTelemetryTransportWriteAllowed(
        pool, principal, "telemetry-contribution-v1.1", { ...options, nowEpoch },
      ),
      { code: "TELEMETRY_TRANSPORT_BLOCKED" },
    );

    const accountless = await seedAccountlessDevice({ pool, schema, nowEpoch });
    const accountlessPrincipal = {
      participantId: accountless.participantId,
      deviceId: accountless.deviceId,
    };
    await assert.rejects(
      authority.assertPostgresTelemetryTransportWriteAllowed(
        pool, accountlessPrincipal, "telemetry-contribution-v0.1", { ...options, nowEpoch },
      ),
      { code: "TELEMETRY_TRANSPORT_BLOCKED" },
    );
    await assert.rejects(
      authority.assertPostgresTelemetryTransportWriteAllowed(
        pool, accountlessPrincipal, "telemetry-contribution-v1.1", { ...options, nowEpoch },
      ),
      { code: "TELEMETRY_CONSENT_INVALID" },
    );
    await insertAccountlessV11Grant({
      pool, schema, participantId: accountless.participantId,
      deviceId: accountless.deviceId, now, expiresAt: accountless.expiresAt,
    });
    await authority.assertPostgresTelemetryTransportWriteAllowed(
      pool, accountlessPrincipal, "telemetry-contribution-v1.1", { ...options, nowEpoch },
    );

    await assert.rejects(
      authority.assertPostgresTelemetryTransportWriteAllowed(
        pool, principal, "telemetry-contribution-v1.2", { ...options, nowEpoch },
      ),
      { code: "TELEMETRY_TRANSPORT_BLOCKED" },
    );
    await pool.query(`UPDATE ${q(schema, "telemetry_v12_runtime")} SET state='active', revision=revision+1 WHERE id=1`);
    await pool.query(`UPDATE ${q(schema, "telemetry_v12_typed_runtime")} SET state='active', policy_revision=policy_revision+1 WHERE id=1`);
    await pool.query(
      `INSERT INTO ${q(schema, "telemetry_v12_device_capabilities")} (
         participant_id, device_id, telemetry_schema_version, field_dictionary_version,
         privacy_contract_version, state, consented_at
       ) VALUES ($1,$2,'telemetry-contribution-v1.2',
         'telemetry-v1.2-registry-2026-09-20.1',
         'ongoing-privacy-safe-telemetry-v1.2','accepted',$3)`,
      [social.participantId, social.deviceId, now],
    );
    await authority.assertPostgresTelemetryTransportWriteAllowed(
      pool, principal, "telemetry-contribution-v1.2", { ...options, nowEpoch },
    );
    await transport.authenticatePostgresDevice(pool, accountless.bearer, { ...options, nowEpoch });
    await authority.assertPostgresTelemetryTransportWriteAllowed(
      pool, accountlessPrincipal, "telemetry-contribution-v1.2", { ...options, nowEpoch },
    );
    await pool.query(
      `UPDATE ${q(schema, "accountless_v11_device_authorizations")}
          SET state='revoked', revoked_at=$2, revocation_reason='user_opt_out'
        WHERE enrollment_device_id=$1`,
      [accountless.deviceId, now],
    );
    await assert.rejects(
      transport.authenticatePostgresDevice(pool, accountless.bearer, { ...options, nowEpoch }),
      { code: "DEVICE_AUTH_INVALID" },
      "generic accountless bearer authentication keeps the shared v1.1 gate even when v1.2 remains active",
    );

    await pool.query(
      `DELETE FROM ${q(schema, "telemetry_transport_participant_floors")} WHERE participant_id=$1`,
      [social.participantId],
    );
    await assert.rejects(
      authority.assertPostgresTelemetryTransportWriteAllowed(
        pool, principal, "telemetry-contribution-v0.1", { ...options, nowEpoch },
      ),
      { code: "DEVICE_AUTH_INVALID" },
      "the current D1 query requires a participant-floor row; PostgreSQL refuses closed when it is absent",
    );
  } finally {
    if (pool && schemaCreated) {
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch {}
    }
    if (pool) await pool.end();
    if (vite) await vite.close();
  }
});
