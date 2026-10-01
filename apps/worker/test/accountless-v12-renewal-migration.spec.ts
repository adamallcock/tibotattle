import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
  ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
  enrollAccountlessDevice,
  parseAccountlessEnrollmentRequest,
} from "../src/accountless-enrollment";
import {
  ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
  createAccountlessUploadOwner,
  parseAccountlessOwnershipRequest,
} from "../src/accountless-ownership";
import { ACCOUNTLESS_RENEWAL_SCHEMA_VERSION, renewAccountlessUploadOwner } from "../src/accountless-renewal";
import {
  ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS,
  ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,
  ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION,
  assertTelemetryV12WriteAllowed,
  grantTelemetryV12AccountlessAuthorization,
  parseTelemetryV12AccountlessAuthorizationRequest,
  telemetryTransportV12Capabilities,
} from "../src/telemetry-transport-policy";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { initializeStorageSource } from "../src/analytics-delivery";

interface Bindings extends Env {
  TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[]; TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[]; TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
}
const bindings = env as Bindings;
const db = () => bindings.USAGE_MONITOR_DB;
const RENEWAL = "0010_accountless_v12_renewal.sql";
const isolation = () => bindings.TEST_INGESTION_ISOLATION_MIGRATIONS;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), bindings.TEST_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  // The deployed predecessor: every isolation migration before the renewal fix.
  await applyD1Migrations(db(), isolation().filter((migration) => migration.name < RENEWAL));
  await initializeStorageSource(db(), "synthetic-v12-renewal-migration-source");
  await db().prepare("UPDATE telemetry_v12_runtime SET state = 'active' WHERE id = 1").run();
});

const v12Request = () => parseTelemetryV12AccountlessAuthorizationRequest({
  schemaVersion: ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION, policyVersion: ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,
  authorizationBasis: ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS, telemetrySchemaVersion: "telemetry-contribution-v1.2",
});

async function renewedV12Device() {
  const deviceId = crypto.randomUUID();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const prefix = new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
  const input = new Uint8Array(prefix.length + secret.length);
  input.set(prefix); input.set(secret, prefix.length);
  const secretHash = await sha256Hex(input);
  input.fill(0);
  const authorization = `Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
  secret.fill(0);
  const enrolledEpoch = Date.now() - 25 * 24 * 60 * 60 * 1000;
  await enrollAccountlessDevice(db(), parseAccountlessEnrollmentRequest({
    schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION, deviceId, deviceSecretHash: secretHash,
    policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION, authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  }), enrolledEpoch);
  await createAccountlessUploadOwner(db(), authorization, parseAccountlessOwnershipRequest({
    schemaVersion: ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION, policyVersion: ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
    authorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
    telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
  }), enrolledEpoch);
  const participantId = (await db().prepare(
    "SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id = ?",
  ).bind(deviceId).first<string>("participant_id"))!;
  const principal = { participantId, deviceId };
  await grantTelemetryV12AccountlessAuthorization(db(), principal, v12Request(), enrolledEpoch);
  await renewAccountlessUploadOwner(db(), authorization, {
    schemaVersion: ACCOUNTLESS_RENEWAL_SCHEMA_VERSION, policyVersion: ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
    authorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
    telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
  });
  return { deviceId, principal };
}

const admitted = async (deviceId: string) => await db().prepare(
  "SELECT count(*) AS n FROM telemetry_v12_active_authorizations WHERE device_id = ?",
).bind(deviceId).first<number>("n");
const expiries = (deviceId: string) => db().prepare(`SELECT ledger.expires_at AS ledger, grant_row.expires_at AS successor
  FROM accountless_enrollment_ledger ledger
  JOIN accountless_v12_device_authorizations grant_row ON grant_row.enrollment_device_id = ledger.device_id
  WHERE ledger.device_id = ?`).bind(deviceId).first<{ ledger: string; successor: string }>();

describe("isolation 0010 accountless v1.2 renewal", () => {
  it("renews an old-schema lease unchanged, reports the stale grant honestly, and repairs it on migration", async () => {
    const { deviceId, principal } = await renewedV12Device();
    // The predecessor renewal still commits: the grant is left behind, not the lease.
    const drifted = await expiries(deviceId);
    expect(drifted!.successor < drifted!.ledger).toBe(true);
    expect(await admitted(deviceId)).toBe(0);
    await expect(assertTelemetryV12WriteAllowed(db(), principal))
      .rejects.toMatchObject({ code: "TELEMETRY_TRANSPORT_BLOCKED" });
    await expect(telemetryTransportV12Capabilities(db(), principal, "https://example.test"))
      .resolves.toMatchObject({ successor: { authorizationCurrent: false } });
    // Before the migration a catch-up request is refused rather than acknowledged.
    await expect(grantTelemetryV12AccountlessAuthorization(db(), principal, v12Request()))
      .rejects.toMatchObject({ code: "TELEMETRY_TRANSPORT_BLOCKED" });

    await applyD1Migrations(db(), isolation());
    const repaired = await expiries(deviceId);
    expect(repaired!.successor).toBe(repaired!.ledger);
    expect(await admitted(deviceId)).toBe(1);
    await expect(assertTelemetryV12WriteAllowed(db(), principal)).resolves.toBeUndefined();
    await expect(telemetryTransportV12Capabilities(db(), principal, "https://example.test"))
      .resolves.toMatchObject({ successor: { authorizationCurrent: true } });
    // An idempotent re-request after repair changes nothing.
    await grantTelemetryV12AccountlessAuthorization(db(), principal, v12Request());
    expect(await expiries(deviceId)).toEqual(repaired);
  });

  it("still refuses shortening, identity changes, and reactivation after the migration", async () => {
    await applyD1Migrations(db(), isolation());
    const { deviceId } = await renewedV12Device();
    const current = (await expiries(deviceId))!;
    expect(current.successor).toBe(current.ledger);
    const update = (sql: string) => db().prepare(sql).bind(deviceId).run();
    await expect(update(`UPDATE accountless_v12_device_authorizations
      SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '-1 day') WHERE enrollment_device_id = ?`))
      .rejects.toThrow(/accountless v12 authorization immutable/u);
    await expect(update(`UPDATE accountless_v12_device_authorizations
      SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+1 day') WHERE enrollment_device_id = ?`))
      .rejects.toThrow(/accountless v12 authorization immutable/u);
    await expect(update(`UPDATE accountless_v12_device_authorizations
      SET authorized_at = expires_at WHERE enrollment_device_id = ?`))
      .rejects.toThrow(/accountless v12 authorization immutable/u);
  });
});
