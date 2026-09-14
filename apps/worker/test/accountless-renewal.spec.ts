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
import { makeV11Day, stageV11Day, v11UsageRecord } from "./helpers/telemetry-v11";
import { createTelemetryV11DomainPredecessor, activateTelemetryV11Domain } from "../src/telemetry-v11-domain";
import { telemetryV11DomainManifestDigestInput } from "@app-usagemonitor/telemetry-contract";
import { eraseParticipantAsOwner } from "../src/participant-erasure";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

const ORIGIN = "https://renewal.example.test";
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

  it("keeps accepted public data through scheduled lease expiry, renews, then withdraws on explicit disconnect", async () => {
    const wallClock = Date.now();
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const clock = vi.spyOn(Date, "now").mockReturnValue(wallClock - 23 * DAY);
    try {
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
      expect(await eligible()).toBeNull();
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
      const { authorization } = await enrollAndOwn(deviceId, secret);
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

      const rollbackId = crypto.randomUUID();
      const rollbackSecret = crypto.getRandomValues(new Uint8Array(32));
      // Create this independent graph with only seven days remaining too, so
      // the injected D1 failure reaches the four-statement renewal batch.
      clock.mockReturnValue(issuedAt);
      const rollback = await enrollAndOwn(rollbackId, rollbackSecret);
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
      rollbackSecret.fill(0);
    } finally {
      clock.mockRestore();
      secret.fill(0);
    }
  });
});
