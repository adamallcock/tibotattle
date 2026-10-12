import { env, applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
  ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
  revokeAccountlessEnrollment,
} from "../src/accountless-enrollment";
import {
  ACCOUNTLESS_RENEWAL_SCHEMA_VERSION,
  renewAccountlessUploadOwner,
} from "../src/accountless-renewal";
import {
  ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
} from "../src/accountless-ownership";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { handleRequest, runScheduledMaintenance } from "../src/index";
import { authenticateDevice, createDeviceUploadAuthorization, purgeStaleDeviceLifecycleRows } from "../src/device-auth";
import { initializeStorageSource } from "../src/analytics-delivery";
import { makeV11Day, stageV11Day, v11UsageRecord } from "./helpers/telemetry-v11";
import { createTelemetryV11DomainPredecessor, activateTelemetryV11Domain } from "../src/telemetry-v11-domain";
import { telemetryV11DomainManifestDigestInput } from "@app-usagemonitor/telemetry-contract";
import { eraseParticipantAsOwner } from "../src/participant-erasure";
import {
  ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS,
  ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,
  ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION,
  assertTelemetryV12WriteAllowed,
} from "../src/telemetry-transport-policy";
import {
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
} from "@app-usagemonitor/telemetry-contract";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
}

const ORIGIN = "https://renewal.example.test";
const STORAGE_SOURCE_ID = "synthetic-accountless-renewal-source";
const DAY = 24 * 60 * 60 * 1000;
const RENEWAL_BODY = Object.freeze({
  schemaVersion: ACCOUNTLESS_RENEWAL_SCHEMA_VERSION,
  policyVersion: ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  authorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
});
const OWNERSHIP_BODY = Object.freeze({
  schemaVersion: ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
  policyVersion: ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  authorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
});

function bindings(): TestBindings {
  return env as TestBindings;
}

function db(): D1Database {
  return bindings().USAGE_MONITOR_DB;
}

function runtime(overrides: Record<string, unknown> = {}): Env {
  return {
    ...bindings(),
    ENVIRONMENT: "synthetic-development",
    ACCOUNT_SCOPED_INGEST_MODE: "disabled",
    ACCOUNTLESS_ENROLLMENT_MODE: "enabled",
    ACCOUNTLESS_OWNERSHIP_MODE: "enabled",
    ...overrides,
  } as unknown as Env;
}

async function api(
  path: string,
  init: RequestInit = {},
  runtimeEnv = runtime(),
): Promise<Response> {
  const headers = new Headers(init.headers);
  if ((init.method ?? "GET").toUpperCase() !== "GET" && !headers.has("origin")) {
    headers.set("origin", ORIGIN);
  }
  return handleRequest(new Request(`${ORIGIN}${path}`, { ...init, headers }), runtimeEnv);
}

async function errorCode(response: Response): Promise<string> {
  const body = await response.json() as { error?: { code?: string } };
  return body.error?.code ?? "";
}

async function deviceSecretHash(deviceId: string, secret: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode(
    `app-usagemonitor/device/v1\0${deviceId}\0`,
  );
  const input = new Uint8Array(prefix.byteLength + secret.byteLength);
  input.set(prefix);
  input.set(secret, prefix.byteLength);
  try {
    return await sha256Hex(input);
  } finally {
    input.fill(0);
  }
}

async function enrollAndOwn(deviceId: string, secret: Uint8Array): Promise<{
  readonly authorization: string;
  readonly participantId: string;
}> {
  const authorization = `Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
  const enrollment = await api("/api/v1/accountless/enrollment", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
      deviceId,
      deviceSecretHash: await deviceSecretHash(deviceId, secret),
      policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
      authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
    }),
  });
  expect(enrollment.status, await enrollment.clone().text()).toBe(201);
  const ownership = await api("/api/v1/accountless/ownership", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(OWNERSHIP_BODY),
  });
  expect(ownership.status, await ownership.clone().text()).toBe(201);
  const owner = await db().prepare(
    "SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id = ?",
  ).bind(deviceId).first<{ participant_id: string }>();
  if (!owner) throw new Error("missing accountless owner");
  return { authorization, participantId: owner.participant_id };
}

async function applyV12AuthorityMigrations(): Promise<void> {
  await applyD1Migrations(db(), bindings().TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_INGESTION_ISOLATION_MIGRATIONS);
}

// Isolation 0010 is the migration that makes an existing v1.2 grant renewable
// and repairs grants an earlier renewal left behind.
const V12_RENEWAL_MIGRATION = "0010_accountless_v12_renewal.sql";

/** The deployed predecessor: every isolation migration before 0010, so the
 * original 0008 trigger still forbids any v1.2 expiry change. */
async function applyV12AuthorityMigrationsBeforeRenewal(): Promise<void> {
  await applyD1Migrations(db(), bindings().TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  const migrations = bindings().TEST_INGESTION_ISOLATION_MIGRATIONS;
  if (!migrations.some((migration) => migration.name === "0009_performance_reports.sql")
      || !migrations.some((migration) => migration.name === V12_RENEWAL_MIGRATION)) {
    throw new Error("missing v1.2 pre-renewal migration boundary");
  }
  await applyD1Migrations(
    db(),
    migrations.filter((migration) => migration.name < V12_RENEWAL_MIGRATION),
  );
}

/** A v1.2-only install: ownership always creates the v1.1 grant, but the
 * device has never activated a v1.1 domain (the public-eligibility test). */
async function v11DomainCount(deviceId: string): Promise<number | null> {
  return await db().prepare(
    "SELECT count(*) AS count FROM telemetry_v11_domains WHERE device_id = ?",
  ).bind(deviceId).first<number>("count");
}

async function insertV12Grant(
  deviceId: string,
  participantId: string,
  issuedAt: string,
  expiresAt: string,
  state: "active" | "revoked" = "active",
): Promise<void> {
  await db().prepare(`
    INSERT INTO accountless_v12_device_authorizations (
      enrollment_device_id, participant_id, device_credential_id,
      schema_version, policy_version, authorization_basis, telemetry_schema_version,
      field_dictionary_version, privacy_contract_version, authorized_at,
      expires_at, state, revoked_at, revocation_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    deviceId,
    participantId,
    deviceId,
    ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION,
    ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,
    ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS,
    TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
    TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
    TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
    issuedAt,
    expiresAt,
    state,
    state === "revoked" ? issuedAt : null,
    state === "revoked" ? "security_reset" : null,
  ).run();
}

async function insertMismatchedV12Grant(
  deviceId: string,
  mismatchedParticipantId: string,
  issuedAt: string,
  expiresAt: string,
): Promise<void> {
  // Construct impossible-but-defensive restored state: all referenced rows
  // exist, but the v1.2 row names another participant. The normal admission
  // trigger prevents creating this state; renewal must still avoid broadening
  // authority if it is encountered after restore/corruption.
  await db().prepare("DROP TRIGGER accountless_v12_authorization_admission").run();
  try {
    await insertV12Grant(deviceId, mismatchedParticipantId, issuedAt, expiresAt);
  } finally {
    await db().prepare(`
      CREATE TRIGGER accountless_v12_authorization_admission
      BEFORE INSERT ON accountless_v12_device_authorizations
      WHEN NOT EXISTS (
        SELECT 1 FROM accountless_upload_owners owner
          JOIN accountless_enrollment_ledger ledger
            ON ledger.device_id = owner.enrollment_device_id
          JOIN device_credentials device ON device.id = owner.device_credential_id
         WHERE owner.enrollment_device_id = NEW.enrollment_device_id
           AND owner.participant_id = NEW.participant_id
           AND owner.device_credential_id = NEW.device_credential_id
           AND owner.state = 'active' AND owner.expires_at = NEW.expires_at
           AND ledger.state = 'active' AND ledger.expires_at = NEW.expires_at
           AND device.authority_kind = 'accountless' AND device.state = 'active'
           AND device.accountless_enrollment_device_id = NEW.enrollment_device_id
           AND device.expires_at = NEW.expires_at
      )
      BEGIN SELECT RAISE(ABORT, 'accountless v12 authorization unavailable'); END
    `).run();
  }
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), bindings().TEST_MIGRATIONS);
  await applyD1Migrations(
    bindings().DELETION_LEDGER,
    bindings().TEST_DELETION_LEDGER_MIGRATIONS,
  );
  await db().prepare(
    `UPDATE telemetry_transport_formats SET lifecycle = 'accepted'
      WHERE schema_version = 'telemetry-contribution-v1.1'`,
  ).run();
});

describe("accountless owner lease renewal", () => {
  it("renews a v1.2-only lease before migration 0010, reports its grant stale, and 0010 repairs it", async () => {
    const wallClock = Date.now();
    const issuedAtEpoch = wallClock - 23 * DAY;
    const issuedAt = new Date(issuedAtEpoch).toISOString();
    const oldExpiry = new Date(issuedAtEpoch + 30 * DAY).toISOString();
    const nextExpiry = new Date(wallClock + 30 * DAY).toISOString();
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const clock = vi.spyOn(Date, "now").mockReturnValue(issuedAtEpoch);
    try {
      await applyV12AuthorityMigrationsBeforeRenewal();
      const { authorization, participantId } = await enrollAndOwn(deviceId, secret);
      await insertV12Grant(deviceId, participantId, issuedAt, oldExpiry);
      expect(await v11DomainCount(deviceId)).toBe(0);

      const snapshot = async () => db().prepare(`
        SELECT ledger.expires_at AS ledger_expires_at,
               ledger.renewal_generation, ledger.renewed_at,
               device.expires_at AS device_expires_at,
               owner.expires_at AS owner_expires_at,
               v11.expires_at AS v11_expires_at,
               v12.state AS v12_state, v12.expires_at AS v12_expires_at
          FROM accountless_enrollment_ledger ledger
          JOIN device_credentials device ON device.id = ledger.device_id
          JOIN accountless_upload_owners owner
            ON owner.enrollment_device_id = ledger.device_id
          JOIN accountless_v11_device_authorizations v11
            ON v11.enrollment_device_id = ledger.device_id
          JOIN accountless_v12_device_authorizations v12
            ON v12.enrollment_device_id = ledger.device_id
         WHERE ledger.device_id = ?
      `).bind(deviceId).first();
      const before = await snapshot();
      expect(before).toEqual({
        ledger_expires_at: oldExpiry,
        renewal_generation: 0,
        renewed_at: null,
        device_expires_at: oldExpiry,
        owner_expires_at: oldExpiry,
        v11_expires_at: oldExpiry,
        v12_state: "active",
        v12_expires_at: oldExpiry,
      });

      // Before 0010 the original trigger forbids any v1.2 expiry change.
      await expect(db().prepare(`
        UPDATE accountless_v12_device_authorizations SET expires_at = ?
         WHERE enrollment_device_id = ?
      `).bind(nextExpiry, deviceId).run()).rejects.toThrow(
        "accountless v12 authorization immutable",
      );

      // On the old schema the four-row lease still renews; only the grant is
      // left behind, instead of the whole renewal failing and the lease lapsing.
      clock.mockReturnValue(wallClock);
      const response = await api("/api/v1/accountless/renewal", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(RENEWAL_BODY),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({
        state: "renewed", renewalGeneration: 1, expiresAt: nextExpiry,
      });
      expect(await snapshot()).toEqual({
        ledger_expires_at: nextExpiry,
        renewal_generation: 1,
        renewed_at: new Date(wallClock).toISOString(),
        device_expires_at: nextExpiry,
        owner_expires_at: nextExpiry,
        v11_expires_at: nextExpiry,
        v12_state: "active",
        v12_expires_at: oldExpiry,
      });
      // The stale grant is honestly not current: the v1.2 write gate refuses it.
      await db().prepare("UPDATE telemetry_v12_runtime SET state = 'active' WHERE id = 1").run();
      await expect(assertTelemetryV12WriteAllowed(db(), { participantId, deviceId }))
        .rejects.toMatchObject({ code: "TELEMETRY_TRANSPORT_BLOCKED" });

      // Applying 0010 (and the later isolation migrations) repairs the grant
      // onto the renewed lease, and v1.2 uploads are admitted again.
      await applyD1Migrations(db(), bindings().TEST_INGESTION_ISOLATION_MIGRATIONS);
      expect(await snapshot()).toMatchObject({
        ledger_expires_at: nextExpiry,
        renewal_generation: 1,
        v12_state: "active",
        v12_expires_at: nextExpiry,
      });
      await expect(assertTelemetryV12WriteAllowed(db(), { participantId, deviceId }))
        .resolves.toBeUndefined();
    } finally {
      clock.mockRestore();
      secret.fill(0);
    }
  });

  it("uses a local HTTP renewal journey to advance only the same active graph", async () => {
    const wallClock = Date.now();
    const issuedAt = wallClock - 23 * DAY;
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const clock = vi.spyOn(Date, "now").mockReturnValue(issuedAt);
    try {
      const { authorization, participantId } = await enrollAndOwn(deviceId, secret);
      const before = await db().prepare(`
        SELECT ledger.device_id, ledger.device_secret_hash, ledger.issued_at,
               ledger.expires_at, ledger.renewal_generation, ledger.renewed_at,
               owner.participant_id, owner.device_credential_id,
               device.credential_generation, device.social_verified_at
          FROM accountless_enrollment_ledger ledger
          JOIN accountless_upload_owners owner
            ON owner.enrollment_device_id = ledger.device_id
          JOIN device_credentials device ON device.id = owner.device_credential_id
         WHERE ledger.device_id = ?
      `).bind(deviceId).first<{
        device_id: string;
        device_secret_hash: ArrayBuffer;
        issued_at: string;
        expires_at: string;
        renewal_generation: number;
        renewed_at: string | null;
        participant_id: string;
        device_credential_id: string;
        credential_generation: number;
        social_verified_at: string | null;
      }>();
      expect(before).toMatchObject({
        device_id: deviceId,
        participant_id: participantId,
        device_credential_id: deviceId,
        renewal_generation: 0,
        renewed_at: null,
        social_verified_at: null,
      });

      clock.mockReturnValue(wallClock);
      const renewed = await api("/api/v1/accountless/renewal", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(RENEWAL_BODY),
      });
      expect(renewed.status, await renewed.clone().text()).toBe(200);
      const renewalReceipt = await renewed.json() as Record<string, unknown>;
      expect(renewalReceipt).toEqual({
        schemaVersion: ACCOUNTLESS_RENEWAL_SCHEMA_VERSION,
        state: "renewed",
        deviceId,
        expiresAt: new Date(wallClock + 30 * DAY).toISOString(),
        renewalGeneration: 1,
        policyVersion: ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
        authorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
        scope: "upload_registration",
        telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
      });
      expect(Object.keys(renewalReceipt).sort()).toEqual([
        "authorizationBasis",
        "deviceId",
        "expiresAt",
        "policyVersion",
        "renewalGeneration",
        "schemaVersion",
        "scope",
        "state",
        "telemetrySchemaVersion",
      ]);
      expect(JSON.stringify(renewalReceipt))
        .not.toMatch(/participant|secret|session|pairing|consent/iu);

      const after = await db().prepare(`
        SELECT ledger.device_id, ledger.device_secret_hash, ledger.issued_at,
               ledger.expires_at AS ledger_expires_at, ledger.renewal_generation,
               ledger.renewed_at, owner.participant_id, owner.device_credential_id,
               owner.expires_at AS owner_expires_at, device.expires_at AS device_expires_at,
               device.credential_generation, device.social_verified_at,
               grant_row.expires_at AS authorization_expires_at,
               (SELECT COUNT(*) FROM web_sessions WHERE participant_id = owner.participant_id)
                 AS sessions,
               (SELECT COUNT(*) FROM device_pairings WHERE participant_id = owner.participant_id)
                 AS pairings,
               (SELECT COUNT(*) FROM telemetry_v11_device_consents
                 WHERE participant_id = owner.participant_id) AS social_consents,
               (SELECT COUNT(*) FROM participant_community_eligibility
                 WHERE participant_id = owner.participant_id) AS public_eligibility
          FROM accountless_enrollment_ledger ledger
          JOIN accountless_upload_owners owner
            ON owner.enrollment_device_id = ledger.device_id
          JOIN device_credentials device ON device.id = owner.device_credential_id
          JOIN accountless_v11_device_authorizations grant_row
            ON grant_row.enrollment_device_id = owner.enrollment_device_id
         WHERE ledger.device_id = ?
      `).bind(deviceId).first<{
        device_id: string;
        device_secret_hash: ArrayBuffer;
        issued_at: string;
        ledger_expires_at: string;
        renewal_generation: number;
        renewed_at: string;
        participant_id: string;
        device_credential_id: string;
        owner_expires_at: string;
        device_expires_at: string;
        credential_generation: number;
        social_verified_at: string | null;
        authorization_expires_at: string;
        sessions: number;
        pairings: number;
        social_consents: number;
        public_eligibility: number;
      }>();
      const nextExpiry = new Date(wallClock + 30 * DAY).toISOString();
      expect(after).toMatchObject({
        device_id: deviceId,
        issued_at: before!.issued_at,
        ledger_expires_at: nextExpiry,
        renewal_generation: 1,
        renewed_at: new Date(wallClock).toISOString(),
        participant_id: participantId,
        device_credential_id: deviceId,
        owner_expires_at: nextExpiry,
        device_expires_at: nextExpiry,
        credential_generation: before!.credential_generation,
        social_verified_at: null,
        authorization_expires_at: nextExpiry,
        sessions: 0,
        pairings: 0,
        social_consents: 0,
        public_eligibility: 0,
      });
      expect(new Uint8Array(after!.device_secret_hash)).toEqual(
        new Uint8Array(before!.device_secret_hash),
      );

      clock.mockReturnValue(wallClock + 1_000);
      const replay = await api("/api/v1/accountless/renewal", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(RENEWAL_BODY),
      });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({
        state: "existing",
        renewalGeneration: 1,
        expiresAt: nextExpiry,
      });

      const invalidExpiry = new Date(wallClock + 31 * DAY).toISOString();
      await expect(db().prepare(
        "UPDATE accountless_enrollment_ledger SET expires_at = ? WHERE device_id = ?",
      ).bind(invalidExpiry, deviceId).run()).rejects.toThrow(
        /accountless_enrollment_lease_shape|CHECK constraint failed/u,
      );
      await expect(db().prepare(
        `UPDATE accountless_enrollment_ledger
            SET renewed_at = 'not-a-canonical-timestamp', expires_at = 'zzzz'
          WHERE device_id = ?`,
      ).bind(deviceId).run()).rejects.toThrow(
        /accountless_enrollment_lease_shape|CHECK constraint failed/u,
      );
      await expect(db().prepare(
        "UPDATE accountless_enrollment_ledger SET issued_at = '0000' WHERE device_id = ?",
      ).bind(deviceId).run()).rejects.toThrow(
        /accountless_enrollment_lease_shape|CHECK constraint failed/u,
      );
      await expect(db().prepare(
        "UPDATE device_credentials SET expires_at = ? WHERE id = ?",
      ).bind(invalidExpiry, deviceId).run()).rejects.toThrow(
        "accountless device credential immutable",
      );
      await expect(db().prepare(
        "UPDATE accountless_upload_owners SET expires_at = ? WHERE enrollment_device_id = ?",
      ).bind(invalidExpiry, deviceId).run()).rejects.toThrow(
        "accountless owner immutable",
      );
      await expect(db().prepare(
        `UPDATE accountless_v11_device_authorizations
            SET expires_at = ? WHERE enrollment_device_id = ?`,
      ).bind(invalidExpiry, deviceId).run()).rejects.toThrow(
        "accountless authorization immutable",
      );
    } finally {
      clock.mockRestore();
      secret.fill(0);
    }
  });

  it("keeps accepted public data through scheduled lease expiry, renewal, and disconnect", async () => {
    const wallClock = Date.now();
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const clock = vi.spyOn(Date, "now").mockReturnValue(wallClock - 23 * DAY);
    try {
      await applyD1Migrations(
        db(),
        bindings().TEST_TYPED_INGESTION_MIGRATIONS.filter((item) => item.name.startsWith("0002_")),
      );
      await applyD1Migrations(db(), bindings().TEST_INGESTION_BRIDGE_MIGRATIONS);
      await applyD1Migrations(
        db(),
        bindings().TEST_INGESTION_ISOLATION_MIGRATIONS.filter((item) => item.name.startsWith("0005_")),
      );
      await initializeStorageSource(db(), STORAGE_SOURCE_ID);
      const { authorization, participantId } = await enrollAndOwn(deviceId, secret);
      clock.mockReturnValue(wallClock);
      const sourceDay = new Date(wallClock).toISOString().slice(0,10);
      const fixture = { authorization, participantId, deviceId, nowEpoch:wallClock, sessionId:"", cookie:"", csrfToken:"" };
      const acceptedDay = await stageV11Day(db(), fixture, await makeV11Day(sourceDay, {usage:[v11UsageRecord(sourceDay)]}));
      const prior = await createTelemetryV11DomainPredecessor(db(), fixture);
      const manifest = {schemaVersion:"telemetry-domain-manifest-v1.1" as const, fromDay:sourceDay, throughDay:sourceDay,
        predecessor:{token:prior.token,previousGenerationId:prior.previousGenerationId,legacyFingerprint:prior.legacyFingerprint},
        days:[{day:sourceDay,manifestId:acceptedDay.manifestId,manifestDigest:acceptedDay.manifestDigest}],manifestDigest:"0".repeat(64)};
      manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
      await activateTelemetryV11Domain(db(), fixture, manifest);
      const principal = await authenticateDevice(db(),authorization);
      await createDeviceUploadAuthorization(db(),principal,"d".repeat(64),200);
      const eligible = () => db().prepare("SELECT participant_id,device_id FROM community_public_source_owners WHERE participant_id=?")
        .bind(participantId).first();
      const head = await db().prepare("SELECT generation_id,revision FROM telemetry_v11_domain_heads WHERE participant_id=?")
        .bind(participantId).first();
      expect(await eligible()).toEqual({participant_id:participantId,device_id:deviceId});
      expect(await purgeStaleDeviceLifecycleRows(db(), {nowEpoch:wallClock+1_000,policy:{idleMilliseconds:1}}))
        .toMatchObject({devicesRevoked:0});
      expect(await eligible()).toEqual({participant_id:participantId,device_id:deviceId});
      // The lease has expired and the old upload grant is unusable. A scheduled
      // purge must not turn renewable expiry into irreversible disconnection.
      clock.mockReturnValue(wallClock + 8 * DAY);
      await expect(authenticateDevice(db(),authorization)).rejects.toMatchObject({code:"DEVICE_AUTH_INVALID"});
      const maintenance = await runScheduledMaintenance(runtime({ALLOWANCE_RECONSTRUCTION_MODE:"paused"}),wallClock + 8 * DAY);
      expect(maintenance).toMatchObject({outcome:"success",lifecycleComplete:true,staleDeviceCredentialsRevoked:0});
      expect(maintenance.staleDeviceUploadAuthorizationsRevoked).toBeGreaterThan(0);
      expect(await eligible()).toEqual({participant_id:participantId,device_id:deviceId});
      expect(await db().prepare("SELECT generation_id,revision FROM telemetry_v11_domain_heads WHERE participant_id=?")
        .bind(participantId).first()).toEqual(head);
      expect(await db().prepare("SELECT state,revoked_at FROM device_credentials WHERE id=?")
        .bind(deviceId).first()).toEqual({state:"active",revoked_at:null});
      const renewed = await api("/api/v1/accountless/renewal", {method:"POST",
        headers:{authorization,"content-type":"application/json"},body:JSON.stringify(RENEWAL_BODY)});
      expect(renewed.status,await renewed.clone().text()).toBe(200);
      expect(await renewed.json()).toMatchObject({state:"renewed",deviceId,renewalGeneration:1});
      await expect(authenticateDevice(db(),authorization)).resolves.toMatchObject({participantId,deviceId,authorityKind:"accountless"});
      expect(await eligible()).toEqual({participant_id:participantId,device_id:deviceId});
      const disconnected = await api("/api/v1/device/disconnect", {method:"POST",headers:{authorization}});
      expect(disconnected.status,await disconnected.clone().text()).toBe(200);
      expect(await eligible()).toEqual({participant_id:participantId,device_id:deviceId});
      expect(await db().prepare("SELECT generation_id,head_revision FROM accountless_public_history_retention WHERE participant_id=?")
        .bind(participantId).first()).toMatchObject({generation_id:head?.generation_id,head_revision:head?.revision});
      expect(await db().prepare("SELECT count(*) n FROM telemetry_v11_records")
        .first("n")).toBeGreaterThan(0);
      expect(await db().prepare("SELECT generation_id,revision FROM telemetry_v11_domain_heads WHERE participant_id=?")
        .bind(participantId).first()).toEqual(head);
      await expect(authenticateDevice(db(),authorization)).rejects.toMatchObject({code:"DEVICE_AUTH_INVALID"});
      expect(await db().prepare("SELECT maintenance_lease_token FROM retention_state WHERE singleton=1").first())
        .toEqual({maintenance_lease_token:null});
    } finally { clock.mockRestore(); secret.fill(0); }
  });

  it("keeps enrollment expiry finite, then renews the same expired graph through HTTP", async () => {
    const wallClock = Date.now();
    const issuedAt = wallClock - 23 * DAY;
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const clock = vi.spyOn(Date, "now").mockReturnValue(issuedAt);
    try {
      const { authorization } = await enrollAndOwn(deviceId, secret);
      clock.mockReturnValue(wallClock + 8 * DAY);

      const expiredEnrollment = await api("/api/v1/accountless/enrollment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
          deviceId,
          deviceSecretHash: await deviceSecretHash(deviceId, secret),
          policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
          authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
        }),
      });
      expect(expiredEnrollment.status).toBe(410);
      expect(await errorCode(expiredEnrollment)).toBe("ACCOUNTLESS_ENROLLMENT_EXPIRED");

      const renewed = await api("/api/v1/accountless/renewal", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(RENEWAL_BODY),
      });
      expect(renewed.status, await renewed.clone().text()).toBe(200);
      expect(await renewed.json()).toMatchObject({
        state: "renewed",
        renewalGeneration: 1,
        expiresAt: new Date(wallClock + 38 * DAY).toISOString(),
      });

      const ownership = await api("/api/v1/accountless/ownership", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(OWNERSHIP_BODY),
      });
      expect(ownership.status, await ownership.clone().text()).toBe(200);
      expect(await ownership.json()).toMatchObject({ state: "existing", deviceId });
      const capabilities = await api("/api/v1/device/sync-capabilities", {
        headers: { authorization },
      });
      expect(capabilities.status, await capabilities.clone().text()).toBe(200);
    } finally {
      clock.mockRestore();
      secret.fill(0);
    }
  });

  it("does not create, reactivate, or extend absent, revoked, or mismatched v1.2 grants", async () => {
    const wallClock = Date.now();
    const issuedAtEpoch = wallClock - 23 * DAY;
    const issuedAt = new Date(issuedAtEpoch).toISOString();
    const oldExpiry = new Date(issuedAtEpoch + 30 * DAY).toISOString();
    const clock = vi.spyOn(Date, "now").mockReturnValue(issuedAtEpoch);
    const absentId = crypto.randomUUID();
    const absentSecret = crypto.getRandomValues(new Uint8Array(32));
    const revokedId = crypto.randomUUID();
    const revokedSecret = crypto.getRandomValues(new Uint8Array(32));
    const mismatchedId = crypto.randomUUID();
    const mismatchedSecret = crypto.getRandomValues(new Uint8Array(32));
    const otherId = crypto.randomUUID();
    const otherSecret = crypto.getRandomValues(new Uint8Array(32));
    try {
      await applyV12AuthorityMigrations();
      const absent = await enrollAndOwn(absentId, absentSecret);
      const revoked = await enrollAndOwn(revokedId, revokedSecret);
      const mismatched = await enrollAndOwn(mismatchedId, mismatchedSecret);
      const other = await enrollAndOwn(otherId, otherSecret);
      await insertV12Grant(revokedId, revoked.participantId, issuedAt, oldExpiry, "revoked");
      await insertMismatchedV12Grant(mismatchedId, other.participantId, issuedAt, oldExpiry);

      clock.mockReturnValue(wallClock);
      for (const owner of [absent, revoked, mismatched]) {
        const response = await api("/api/v1/accountless/renewal", {
          method: "POST",
          headers: { authorization: owner.authorization, "content-type": "application/json" },
          body: JSON.stringify(RENEWAL_BODY),
        });
        expect(response.status, await response.clone().text()).toBe(200);
        expect(await response.json()).toMatchObject({ state: "renewed", renewalGeneration: 1 });
      }

      expect(await db().prepare(`SELECT count(*) AS count
        FROM accountless_v12_device_authorizations WHERE enrollment_device_id = ?`)
        .bind(absentId).first("count")).toBe(0);
      expect(await db().prepare(`SELECT participant_id, state, expires_at
        FROM accountless_v12_device_authorizations WHERE enrollment_device_id = ?`)
        .bind(revokedId).first()).toEqual({
        participant_id: revoked.participantId,
        state: "revoked",
        expires_at: oldExpiry,
      });
      expect(await db().prepare(`SELECT participant_id, state, expires_at
        FROM accountless_v12_device_authorizations WHERE enrollment_device_id = ?`)
        .bind(mismatchedId).first()).toEqual({
        participant_id: other.participantId,
        state: "active",
        expires_at: oldExpiry,
      });

      await db().prepare("UPDATE telemetry_v12_runtime SET state = 'active' WHERE id = 1").run();
      for (const [owner, deviceId] of [
        [absent, absentId], [revoked, revokedId], [mismatched, mismatchedId],
      ] as const) {
        await expect(assertTelemetryV12WriteAllowed(db(), {
          participantId: owner.participantId,
          deviceId,
        })).rejects.toMatchObject({ code: "TELEMETRY_TRANSPORT_BLOCKED" });
      }
    } finally {
      clock.mockRestore();
      absentSecret.fill(0);
      revokedSecret.fill(0);
      mismatchedSecret.fill(0);
      otherSecret.fill(0);
    }
  });

  it("fails closed for a ledger-only enrollment and permanently revoked or erased graphs", async () => {
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const authorization = `Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
    try {
      const enrollment = await api("/api/v1/accountless/enrollment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
          deviceId,
          deviceSecretHash: await deviceSecretHash(deviceId, secret),
          policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
          authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
        }),
      });
      expect(enrollment.status).toBe(201);
      const missingOwner = await api("/api/v1/accountless/renewal", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(RENEWAL_BODY),
      });
      expect(missingOwner.status).toBe(401);
      expect(await errorCode(missingOwner)).toBe("DEVICE_AUTH_INVALID");
      expect(await db().prepare(`SELECT renewal_generation FROM accountless_enrollment_ledger
        WHERE device_id = ?`).bind(deviceId).first()).toEqual({ renewal_generation: 0 });

      const ownedId = crypto.randomUUID();
      const ownedSecret = crypto.getRandomValues(new Uint8Array(32));
      const owned = await enrollAndOwn(ownedId, ownedSecret);
      expect(await revokeAccountlessEnrollment(
        db(), ownedId, "user_opt_out", Date.now(),
      )).toBe(true);
      const revoked = await api("/api/v1/accountless/renewal", {
        method: "POST",
        headers: { authorization: owned.authorization, "content-type": "application/json" },
        body: JSON.stringify(RENEWAL_BODY),
      });
      expect(revoked.status).toBe(401);
      expect(await errorCode(revoked)).toBe("ACCOUNTLESS_OWNERSHIP_REVOKED");

      const erasedId = crypto.randomUUID();
      const erasedSecret = crypto.getRandomValues(new Uint8Array(32));
      const erased = await enrollAndOwn(erasedId, erasedSecret);
      await expect(eraseParticipantAsOwner(
        runtime(),
        "e".repeat(64),
        erased.participantId,
      )).resolves.toMatchObject({ deleted: true });
      const erasedRenewal = await api("/api/v1/accountless/renewal", {
        method: "POST",
        headers: { authorization: erased.authorization, "content-type": "application/json" },
        body: JSON.stringify(RENEWAL_BODY),
      });
      expect(erasedRenewal.status).toBe(401);
      expect(await errorCode(erasedRenewal)).toBe("ACCOUNTLESS_OWNERSHIP_REVOKED");
      ownedSecret.fill(0);
      erasedSecret.fill(0);
    } finally {
      secret.fill(0);
    }
  });

  it("converges concurrent renewal and rolls every row back when its batch cannot commit", async () => {
    const wallClock = Date.now();
    const issuedAt = wallClock - 23 * DAY;
    const clock = vi.spyOn(Date, "now").mockReturnValue(issuedAt);
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    try {
      await applyV12AuthorityMigrations();
      const { authorization, participantId } = await enrollAndOwn(deviceId, secret);
      const originalExpiry = new Date(issuedAt + 30 * DAY).toISOString();
      await insertV12Grant(deviceId, participantId,
        new Date(issuedAt).toISOString(), originalExpiry);
      // The renewed grant belongs to a v1.2-only install: no v1.1 domain.
      expect(await v11DomainCount(deviceId)).toBe(0);
      clock.mockReturnValue(wallClock);
      const concurrent = await Promise.all(Array.from({ length: 4 }, () =>
        renewAccountlessUploadOwner(db(), authorization, RENEWAL_BODY, wallClock),
      ));
      expect(concurrent.filter((entry) => entry.state === "renewed")).toHaveLength(1);
      expect(concurrent.every((entry) => entry.renewalGeneration === 1)).toBe(true);
      expect(await db().prepare(`SELECT ledger.renewal_generation, ledger.expires_at,
        device.expires_at AS device_expires_at, owner.expires_at AS owner_expires_at,
        grant_row.expires_at AS authorization_expires_at
        FROM accountless_enrollment_ledger ledger
        JOIN device_credentials device ON device.id = ledger.device_id
        JOIN accountless_upload_owners owner ON owner.enrollment_device_id = ledger.device_id
        JOIN accountless_v11_device_authorizations grant_row
          ON grant_row.enrollment_device_id = ledger.device_id
        WHERE ledger.device_id = ?`).bind(deviceId).first()).toEqual({
        renewal_generation: 1,
        expires_at: new Date(wallClock + 30 * DAY).toISOString(),
        device_expires_at: new Date(wallClock + 30 * DAY).toISOString(),
        owner_expires_at: new Date(wallClock + 30 * DAY).toISOString(),
        authorization_expires_at: new Date(wallClock + 30 * DAY).toISOString(),
      });
      const v12Expiry = new Date(wallClock + 30 * DAY).toISOString();
      expect(await db().prepare(`SELECT state, expires_at
        FROM accountless_v12_device_authorizations WHERE enrollment_device_id = ?`)
        .bind(deviceId).first()).toEqual({ state: "active", expires_at: v12Expiry });
      await db().prepare("UPDATE telemetry_v12_runtime SET state = 'active' WHERE id = 1").run();
      await expect(assertTelemetryV12WriteAllowed(db(), { participantId, deviceId }))
        .resolves.toBeUndefined();

      const rollbackId = crypto.randomUUID();
      const rollbackSecret = crypto.getRandomValues(new Uint8Array(32));
      // Create this independent graph with a matching v1.2 grant too, so the
      // appended failure proves the complete D1 batch rolls its renewal back.
      clock.mockReturnValue(issuedAt);
      const rollback = await enrollAndOwn(rollbackId, rollbackSecret);
      const rollbackExpiry = new Date(issuedAt + 30 * DAY).toISOString();
      await insertV12Grant(rollbackId, rollback.participantId,
        new Date(issuedAt).toISOString(), rollbackExpiry);
      clock.mockReturnValue(wallClock);
      const snapshot = await db().prepare(`SELECT expires_at, renewal_generation, renewed_at
        FROM accountless_enrollment_ledger WHERE device_id = ?`).bind(rollbackId).first();
      const underlying = db();
      const failingDb = new Proxy(underlying, {
        get(target, property, receiver) {
          if (property === "batch") {
            return async (statements: D1PreparedStatement[]) => target.batch([
              ...statements,
              target.prepare(`INSERT INTO accountless_enrollment_issuance (
                singleton, budget_day, daily_issued, lifetime_issued,
                last_issue_token, updated_at
              ) VALUES (1, '1970-01-01', 0, 0, '', '1970-01-01T00:00:00.000Z')`),
            ]);
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as unknown as D1Database;
      await expect(renewAccountlessUploadOwner(
        failingDb,
        rollback.authorization,
        RENEWAL_BODY,
        wallClock,
      )).rejects.toMatchObject({
        status: 503,
        code: "BACKEND_STORAGE_UNAVAILABLE",
      });
      expect(await db().prepare(`SELECT expires_at, renewal_generation, renewed_at
        FROM accountless_enrollment_ledger WHERE device_id = ?`).bind(rollbackId).first())
        .toEqual(snapshot);
      expect(await db().prepare(`SELECT device.expires_at AS device_expires_at,
        owner.expires_at AS owner_expires_at,
        grant_row.expires_at AS authorization_expires_at
        FROM device_credentials device
        JOIN accountless_upload_owners owner ON owner.device_credential_id = device.id
        JOIN accountless_v11_device_authorizations grant_row
          ON grant_row.enrollment_device_id = owner.enrollment_device_id
        WHERE device.id = ?`).bind(rollbackId).first()).toEqual({
        device_expires_at: snapshot?.expires_at,
        owner_expires_at: snapshot?.expires_at,
        authorization_expires_at: snapshot?.expires_at,
      });
      expect(await db().prepare(`SELECT state, expires_at
        FROM accountless_v12_device_authorizations WHERE enrollment_device_id = ?`)
        .bind(rollbackId).first()).toEqual({ state: "active", expires_at: rollbackExpiry });
      rollbackSecret.fill(0);
    } finally {
      clock.mockRestore();
      secret.fill(0);
    }
  });
});
