import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { telemetryV11RequiredConsent } from "@app-usagemonitor/telemetry-contract";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 24 * 60 * 60_000;
const LEASE = 30 * DAY;
const RENEWAL_BODY = Object.freeze({
  schemaVersion: "accountless-renewal-v0.1",
  policyVersion: "accountless-opt-out-v1",
  authorizationBasis: "accountless-policy-v1",
  telemetrySchemaVersion: "telemetry-contribution-v1.1",
});

async function localEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "PostgreSQL renewal tests require loopback or a private Unix socket");
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

function q(schema, table) {
  return `"${schema}"."${table}"`;
}

function deviceSecretHash(deviceId, secret) {
  return createHash("sha256")
    .update(`app-usagemonitor/device/v1\0${deviceId}\0`)
    .update(Buffer.from(secret, "base64url"))
    .digest();
}

function renewalAuthorization(deviceId, secret) {
  return `Device um_device_${deviceId}.${secret}`;
}

function interceptPool(pool, intercept) {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        query(text, values) {
          return intercept(text, values, () => client.query(text, values));
        },
        release(discard) { return client.release(discard); },
      };
    },
  };
}

async function seedAccountlessGraph({
  pool,
  schema,
  issuedAtEpoch,
  renewalGeneration = 0,
  renewedAtEpoch = null,
  withV12 = false,
  withOwner = true,
}) {
  const deviceId = randomUUID();
  const participantId = `participant:${randomUUID()}`;
  const secret = randomBytes(32).toString("base64url");
  const secretHash = deviceSecretHash(deviceId, secret);
  const issuedAt = new Date(issuedAtEpoch).toISOString();
  const renewedAt = renewedAtEpoch === null ? null : new Date(renewedAtEpoch).toISOString();
  const expiresAt = new Date((renewedAtEpoch ?? issuedAtEpoch) + LEASE).toISOString();
  await pool.query(
    `INSERT INTO ${q(schema, "accountless_enrollment_ledger")} (
       device_id, device_secret_hash, installation_principal_id, schema_version,
       policy_version, authorization_basis, state, issued_at, expires_at,
       renewal_generation, renewed_at
     ) VALUES ($1,$2,$3,'accountless-enrollment-v0.1','accountless-opt-out-v1',
       'accountless-policy-v1','active',$4::timestamptz,$5::timestamptz,$6,$7::timestamptz)`,
    [deviceId, secretHash, `accountless:${randomUUID()}`, issuedAt, expiresAt,
      renewalGeneration, renewedAt],
  );
  if (!withOwner) return { deviceId, participantId, secret, authorization: renewalAuthorization(deviceId, secret), issuedAt, expiresAt };

  await pool.query(
    `INSERT INTO ${q(schema, "participants")} (
       id, owner_kind, state, access_token_id, access_token_hash,
       recovery_token_id, recovery_token_hash, consent_version, consented_at, created_at
     ) VALUES ($1,'accountless','active',NULL,NULL,NULL,NULL,NULL,NULL,$2::timestamptz)`,
    [participantId, issuedAt],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "device_credentials")} (
       id, participant_id, authority_kind, paired_via_pairing_id,
       accountless_enrollment_device_id, secret_hash, state, issued_at,
       expires_at, last_used_at, revoked_at, social_verified_at, credential_generation
     ) VALUES ($1,$2,'accountless',NULL,$1,$3,'active',$4::timestamptz,
       $5::timestamptz,$4::timestamptz,NULL,NULL,1)`,
    [deviceId, participantId, secretHash, issuedAt, expiresAt],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "accountless_upload_owners")} (
       enrollment_device_id, participant_id, device_credential_id, policy_version,
       authorization_basis, authorized_at, expires_at, state
     ) VALUES ($1,$2,$1,'accountless-opt-out-v1','accountless-policy-v1',
       $3::timestamptz,$4::timestamptz,'active')`,
    [deviceId, participantId, issuedAt, expiresAt],
  );
  const consent = telemetryV11RequiredConsent();
  await pool.query(
    `INSERT INTO ${q(schema, "accountless_v11_device_authorizations")} (
       enrollment_device_id, participant_id, device_credential_id,
       telemetry_schema_version, field_dictionary_version, privacy_contract_version,
       authorized_at, expires_at, state
     ) VALUES ($1,$2,$1,'telemetry-contribution-v1.1',$3,$4,
       $5::timestamptz,$6::timestamptz,'active')`,
    [deviceId, participantId, consent.fieldDictionaryVersion,
      consent.privacyContractVersion, issuedAt, expiresAt],
  );
  if (withV12) {
    await pool.query(
      `INSERT INTO ${q(schema, "accountless_v12_device_authorizations")} (
         enrollment_device_id, participant_id, device_credential_id,
         schema_version, policy_version, authorization_basis,
         telemetry_schema_version, field_dictionary_version, privacy_contract_version,
         authorized_at, expires_at, state
       ) VALUES ($1,$2,$1,'accountless-upload-owner-v1.2',
         'accountless-telemetry-v1.2-policy-v1','accountless-policy-v1.2',
         'telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1',
         'ongoing-privacy-safe-telemetry-v1.2',$3::timestamptz,$4::timestamptz,'active')`,
      [deviceId, participantId, issuedAt, expiresAt],
    );
  }
  return {
    deviceId,
    participantId,
    secret,
    secretHash,
    authorization: renewalAuthorization(deviceId, secret),
    issuedAt,
    expiresAt,
  };
}

async function readGraphSnapshot(pool, schema, deviceId) {
  const result = await pool.query(
    `SELECT ledger.state AS ledger_state,
            ledger.renewal_generation,
            ledger.renewed_at,
            ledger.issued_at,
            ledger.expires_at AS ledger_expires_at,
            device.expires_at AS device_expires_at,
            owner.expires_at AS owner_expires_at,
            v11.expires_at AS v11_expires_at,
            v12.expires_at AS v12_expires_at
       FROM ${q(schema, "accountless_enrollment_ledger")} ledger
       LEFT JOIN ${q(schema, "device_credentials")} device ON device.id=ledger.device_id
       LEFT JOIN ${q(schema, "accountless_upload_owners")} owner
         ON owner.enrollment_device_id=ledger.device_id
       LEFT JOIN ${q(schema, "accountless_v11_device_authorizations")} v11
         ON v11.enrollment_device_id=ledger.device_id
       LEFT JOIN ${q(schema, "accountless_v12_device_authorizations")} v12
         ON v12.enrollment_device_id=ledger.device_id
      WHERE ledger.device_id=$1`,
    [deviceId],
  );
  return result.rows[0];
}

test("PostgreSQL accountless renewal preserves Cloudflare authority, boundary, and replay semantics", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  const endpoint = await localEndpoint();
  const pool = new pg.Pool({
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 8,
    connectionTimeoutMillis: 5_000,
  });
  const schema = `renewal_${randomBytes(6).toString("hex")}`;
  const options = { schema: { primarySchema: schema } };
  let createdSchema = false;
  let vite;
  try {
    const server = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17,
      "the PostgreSQL renewal regression requires PG17");
    await pool.query(`CREATE SCHEMA "${schema}"`);
    createdSchema = true;
    await applyPostgresMigrations({ role: "primary", schema, pool });
    vite = await createServer({
      root: WORKER_ROOT,
      configFile: false,
      server: { middlewareMode: true },
      appType: "custom",
    });
    const adapter = await vite.ssrLoadModule("/src/postgres-accountless-renewal.ts");
    const contract = await vite.ssrLoadModule("/src/accountless-renewal.ts");
    const request = contract.parseAccountlessRenewalJson(JSON.stringify(RENEWAL_BODY));
    const base = Date.UTC(2026, 0, 1, 12, 0, 0);
    const renew = (device, nowEpoch, clientPool = pool) =>
      adapter.renewPostgresAccountlessUploadOwner(
        clientPool, device.authorization, request, { ...options, nowEpoch },
      );

    // Far outside the renewal window: exact no-op receipt.
    const undue = await seedAccountlessGraph({ pool, schema, issuedAtEpoch: base });
    const undueBefore = await readGraphSnapshot(pool, schema, undue.deviceId);
    const undueResult = await renew(undue, base + DAY);
    assert.equal(undueResult.state, "existing");
    assert.equal(undueResult.renewalGeneration, 0);
    assert.deepEqual(await readGraphSnapshot(pool, schema, undue.deviceId), undueBefore,
      "an early retry changes no authority row");

    // One millisecond beyond the cutoff stays untouched; equality renews.
    const beyond = await seedAccountlessGraph({ pool, schema, issuedAtEpoch: base + 10 * DAY });
    const expiryBeyond = Date.parse(beyond.expiresAt);
    const beyondResult = await renew(beyond, expiryBeyond - 7 * DAY - 1);
    assert.equal(beyondResult.state, "existing");
    const boundary = await seedAccountlessGraph({
      pool, schema, issuedAtEpoch: base + 20 * DAY, withV12: true,
    });
    const boundaryExpiry = Date.parse(boundary.expiresAt);
    const boundaryNow = boundaryExpiry - 7 * DAY;
    const boundaryResult = await renew(boundary, boundaryNow);
    assert.equal(boundaryResult.state, "renewed", "exactly seven days remaining is due");
    assert.equal(boundaryResult.renewalGeneration, 1);
    assert.equal(Date.parse(boundaryResult.expiresAt), boundaryNow + LEASE);
    const boundarySnapshot = await readGraphSnapshot(pool, schema, boundary.deviceId);
    assert.equal(boundarySnapshot.renewal_generation, 1);
    assert.equal(Date.parse(boundarySnapshot.renewed_at), boundaryNow);
    assert.equal(new Set([
      boundarySnapshot.ledger_expires_at,
      boundarySnapshot.device_expires_at,
      boundarySnapshot.owner_expires_at,
      boundarySnapshot.v11_expires_at,
    ].map((value) => new Date(value).getTime())).size, 1,
    "ledger/device/owner/v1.1 expires move together");
    assert.equal(new Date(boundarySnapshot.v12_expires_at).getTime(), Date.parse(boundaryResult.expiresAt),
      "an exact active v1.2 grant follows the same renewed lease");
    const boundaryReplay = await renew(boundary, boundaryNow);
    assert.equal(boundaryReplay.state, "existing");
    assert.equal(boundaryReplay.renewalGeneration, 1);
    const v12Row = await pool.query(
      `SELECT expires_at FROM ${q(schema, "accountless_v12_device_authorizations")}
        WHERE enrollment_device_id=$1`, [boundary.deviceId],
    );
    assert.equal(new Date(v12Row.rows[0].expires_at).getTime(), Date.parse(boundaryResult.expiresAt));

    // Expired-but-active ledgers are renewable through explicit bearer authority.
    const expired = await seedAccountlessGraph({ pool, schema, issuedAtEpoch: base + 40 * DAY });
    const expiredAt = Date.parse(expired.expiresAt) + DAY;
    const expiredResult = await renew(expired, expiredAt);
    assert.equal(expiredResult.state, "renewed");
    assert.equal(expiredResult.renewalGeneration, 1);
    assert.equal(Date.parse(expiredResult.expiresAt), expiredAt + LEASE);
    assert.equal((await pool.query(
      `SELECT 1 FROM ${q(schema, "accountless_v12_device_authorizations")}
        WHERE enrollment_device_id=$1`, [expired.deviceId],
    )).rowCount, 0, "renewal never creates an absent v1.2 grant");

    // Prove the renewed exact grant is still accepted by PostgreSQL's live
    // v1.2 authority view, not merely that its stored expiry looks plausible.
    const activeNow = Date.now();
    const activeV12 = await seedAccountlessGraph({
      pool, schema, issuedAtEpoch: activeNow - 23 * DAY, withV12: true,
    });
    await pool.query(`UPDATE ${q(schema, "telemetry_v12_runtime")} SET state='active' WHERE id=1`);
    await pool.query(`UPDATE ${q(schema, "telemetry_v12_typed_runtime")} SET state='active' WHERE id=1`);
    const activeResult = await renew(activeV12, activeNow);
    assert.equal(activeResult.state, "renewed");
    assert.equal((await pool.query(
      `SELECT participant_id, device_id FROM ${q(schema, "telemetry_v12_typed_active_authorizations")}
        WHERE participant_id=$1 AND device_id=$2`,
      [activeV12.participantId, activeV12.deviceId],
    )).rowCount, 1, "the renewed grant continues to authorize v1.2 writes");

    // Optional grants which are revoked or point at another participant stay
    // untouched while the independent accountless/v1.1 lease renews.
    const revokedV12 = await seedAccountlessGraph({
      pool, schema, issuedAtEpoch: base + 50 * DAY, withV12: true,
    });
    const revokedAt = new Date(base + 51 * DAY).toISOString();
    await pool.query(
      `UPDATE ${q(schema, "accountless_v12_device_authorizations")}
          SET state='revoked', revoked_at=$2::timestamptz,
              revocation_reason='security_reset' WHERE enrollment_device_id=$1`,
      [revokedV12.deviceId, revokedAt],
    );
    const revokedResult = await renew(revokedV12, Date.parse(revokedV12.expiresAt));
    assert.equal(revokedResult.state, "renewed");
    const revokedGrant = await pool.query(
      `SELECT state, expires_at FROM ${q(schema, "accountless_v12_device_authorizations")}
        WHERE enrollment_device_id=$1`, [revokedV12.deviceId],
    );
    assert.equal(revokedGrant.rows[0].state, "revoked");
    assert.equal(new Date(revokedGrant.rows[0].expires_at).getTime(), Date.parse(revokedV12.expiresAt));

    const mismatchedV12 = await seedAccountlessGraph({
      pool, schema, issuedAtEpoch: base + 55 * DAY, withV12: true,
    });
    const otherOwner = await seedAccountlessGraph({
      pool, schema, issuedAtEpoch: base + 56 * DAY,
    });
    await pool.query(
      `UPDATE ${q(schema, "accountless_v12_device_authorizations")}
          SET participant_id=$2 WHERE enrollment_device_id=$1`,
      [mismatchedV12.deviceId, otherOwner.participantId],
    );
    const mismatchedResult = await renew(mismatchedV12, Date.parse(mismatchedV12.expiresAt));
    assert.equal(mismatchedResult.state, "renewed");
    const mismatchedGrant = await pool.query(
      `SELECT participant_id, state, expires_at
         FROM ${q(schema, "accountless_v12_device_authorizations")}
        WHERE enrollment_device_id=$1`, [mismatchedV12.deviceId],
    );
    assert.equal(mismatchedGrant.rows[0].participant_id, otherOwner.participantId);
    assert.equal(mismatchedGrant.rows[0].state, "active");
    assert.equal(new Date(mismatchedGrant.rows[0].expires_at).getTime(), Date.parse(mismatchedV12.expiresAt));

    // Multiple requests serialize on the ledger and converge on one generation.
    const concurrent = await seedAccountlessGraph({ pool, schema, issuedAtEpoch: base + 60 * DAY, withV12: true });
    const concurrentNow = Date.parse(concurrent.expiresAt) - 5 * DAY;
    const concurrentResults = await Promise.all(Array.from({ length: 4 }, () =>
      renew(concurrent, concurrentNow)));
    assert.deepEqual(concurrentResults.map((result) => result.state).sort(),
      ["existing", "existing", "existing", "renewed"]);
    assert.ok(concurrentResults.every((result) => result.renewalGeneration === 1));

    // A mid-transaction provider failure rolls the ledger and all graph rows back.
    const rollback = await seedAccountlessGraph({ pool, schema, issuedAtEpoch: base + 80 * DAY, withV12: true });
    const rollbackNow = Date.parse(rollback.expiresAt) - 2 * DAY;
    const rollbackBefore = await readGraphSnapshot(pool, schema, rollback.deviceId);
    let injected = false;
    const failingPool = interceptPool(pool, async (text, values, query) => {
      if (!injected && /^\s*UPDATE\b/u.test(text)
          && text.includes('"accountless_v12_device_authorizations"')) {
        await query();
        injected = true;
        throw new Error("private provider diagnostic");
      }
      return query();
    });
    await assert.rejects(renew(rollback, rollbackNow, failingPool), (error) =>
      error?.code === "BACKEND_STORAGE_UNAVAILABLE"
        && !error.message.includes("private provider diagnostic"));
    assert.equal(injected, true);
    assert.deepEqual(await readGraphSnapshot(pool, schema, rollback.deviceId), rollbackBefore,
      "failure after the v1.2 update rolls the full renewal transaction back");

    // A lost commit acknowledgement is resolved from durable generation state.
    const ambiguous = await seedAccountlessGraph({ pool, schema, issuedAtEpoch: base + 90 * DAY });
    const ambiguousNow = Date.parse(ambiguous.expiresAt) - 3 * DAY;
    let commitAcknowledgementLost = false;
    const ambiguousPool = interceptPool(pool, async (text, values, query) => {
      if (!commitAcknowledgementLost && text === "COMMIT") {
        await query();
        commitAcknowledgementLost = true;
        throw new Error("private commit acknowledgement diagnostic");
      }
      return query();
    });
    const ambiguousResult = await renew(ambiguous, ambiguousNow, ambiguousPool);
    assert.equal(commitAcknowledgementLost, true);
    assert.equal(ambiguousResult.state, "existing");
    assert.equal(ambiguousResult.renewalGeneration, 1,
      "a committed renewal whose acknowledgement is lost is recognized on bounded replay");

    // Exact-owner checks, revoked state, malformed lease shape, and bounds fail closed.
    await assert.rejects(
      adapter.renewPostgresAccountlessUploadOwner(
        pool,
        renewalAuthorization(undue.deviceId, randomBytes(32).toString("base64url")),
        request,
        { ...options, nowEpoch: base + DAY },
      ),
      (error) => error?.status === 401 && error?.code === "DEVICE_AUTH_INVALID",
    );
    const socialized = await seedAccountlessGraph({ pool, schema, issuedAtEpoch: base + 100 * DAY });
    await pool.query(
      `UPDATE ${q(schema, "participants")} SET consent_version='social-consent-v1'
        WHERE id=$1`, [socialized.participantId],
    );
    await assert.rejects(renew(socialized, Date.parse(socialized.expiresAt)),
      (error) => error?.status === 401 && error?.code === "DEVICE_AUTH_INVALID");
    const revoked = await seedAccountlessGraph({ pool, schema, issuedAtEpoch: base + 120 * DAY });
    await pool.query(
      `UPDATE ${q(schema, "accountless_enrollment_ledger")}
          SET state='revoked', revoked_at=$2::timestamptz,
              revocation_reason='user_opt_out' WHERE device_id=$1`,
      [revoked.deviceId, new Date(base + 121 * DAY).toISOString()],
    );
    await assert.rejects(renew(revoked, Date.parse(revoked.expiresAt)),
      (error) => error?.status === 401 && error?.code === "ACCOUNTLESS_OWNERSHIP_REVOKED");
    const badLease = await seedAccountlessGraph({ pool, schema, issuedAtEpoch: base + 140 * DAY });
    await pool.query(
      `UPDATE ${q(schema, "accountless_enrollment_ledger")}
          SET renewed_at=issued_at WHERE device_id=$1`, [badLease.deviceId],
    );
    await assert.rejects(renew(badLease, Date.parse(badLease.expiresAt)),
      (error) => error?.status === 503 && error?.code === "BACKEND_STORAGE_UNAVAILABLE");
    const maxGeneration = await seedAccountlessGraph({
      pool, schema, issuedAtEpoch: base + 160 * DAY,
      renewalGeneration: 2_147_483_647, renewedAtEpoch: base + 160 * DAY,
    });
    await assert.rejects(renew(maxGeneration, Date.parse(maxGeneration.expiresAt)),
      (error) => error?.status === 409 && error?.code === "LIFECYCLE_BOUNDS_EXCEEDED");
    const ledgerOnly = await seedAccountlessGraph({
      pool, schema, issuedAtEpoch: base + 180 * DAY, withOwner: false,
    });
    await assert.rejects(renew(ledgerOnly, Date.parse(ledgerOnly.expiresAt)),
      (error) => error?.status === 401 && error?.code === "DEVICE_AUTH_INVALID");
  } finally {
    await vite?.close();
    if (createdSchema) {
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch {}
    }
    await pool.end();
  }
});
