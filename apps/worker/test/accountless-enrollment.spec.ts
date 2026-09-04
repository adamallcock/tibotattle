import { env, applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  ACCOUNTLESS_ENROLLMENT_DAILY_ISSUANCE_BUDGET,
  ACCOUNTLESS_ENROLLMENT_LIFETIME_ISSUANCE_CEILING,
  ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS,
  ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
  ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
  ACCOUNTLESS_ENROLLMENT_SCOPE,
  enrollAccountlessDevice,
  parseAccountlessEnrollmentJson,
  revokeAccountlessEnrollment,
} from "../src/accountless-enrollment";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { handleRequest } from "../src/index";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

const ORIGIN = "https://example.test";
const bindings = (): TestBindings => env as TestBindings;

function runtime(overrides: Record<string, unknown> = {}): Env {
  return {
    ...(env as TestBindings),
    ENVIRONMENT: "synthetic-development",
    ...overrides,
  } as unknown as Env;
}

async function deviceSecretHash(
  deviceId: string,
  rawSecret: Uint8Array,
): Promise<string> {
  const prefix = new TextEncoder().encode(
    `app-usagemonitor/device/v1\0${deviceId}\0`,
  );
  const input = new Uint8Array(prefix.byteLength + rawSecret.byteLength);
  input.set(prefix);
  input.set(rawSecret, prefix.byteLength);
  return sha256Hex(input);
}

async function enrollmentBody(): Promise<{
  body: {
    schemaVersion: string;
    deviceId: string;
    deviceSecretHash: string;
    policyVersion: string;
    authorizationBasis: string;
  };
  rawSecret: Uint8Array;
}> {
  const deviceId = crypto.randomUUID();
  const rawSecret = crypto.getRandomValues(new Uint8Array(32));
  return {
    rawSecret,
    body: {
      schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
      deviceId,
      deviceSecretHash: await deviceSecretHash(deviceId, rawSecret),
      policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
      authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
    },
  };
}

async function api(
  body: unknown,
  runtimeEnv: Env = runtime({ ACCOUNTLESS_ENROLLMENT_MODE: "enabled" }),
): Promise<Response> {
  return handleRequest(
    new Request(`${ORIGIN}/api/v1/accountless/enrollment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    runtimeEnv,
  );
}

async function errorCode(response: Response): Promise<string> {
  const payload = await response.json() as {
    error?: { code?: string };
  };
  return payload.error?.code ?? "";
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings().USAGE_MONITOR_DB, bindings().TEST_MIGRATIONS);
  await applyD1Migrations(
    bindings().DELETION_LEDGER,
    bindings().TEST_DELETION_LEDGER_MIGRATIONS,
  );
});

describe("accountless enrollment ledger", () => {
  it("refuses before the synthetic gate and leaves the database untouched", async () => {
    const { body } = await enrollmentBody();
    // The disabled gate runs before any D1 access, so a pre-migration worker
    // cannot accidentally turn this route into a storage side effect.
    const response = await api(body, runtime({ USAGE_MONITOR_DB: undefined }));
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("ACCOUNTLESS_ENROLLMENT_DISABLED");
    const ledger = await bindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS count FROM accountless_enrollment_ledger",
    ).first<{ count: number }>();
    expect(ledger?.count).toBe(0);
  });

  it("refuses an enabled pre-migration request before any authority can be created", async () => {
    const { body } = await enrollmentBody();
    const response = await api(body, runtime({
      ACCOUNTLESS_ENROLLMENT_MODE: "enabled",
      USAGE_MONITOR_DB: undefined,
    }));
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("COLLECTION_CONTROL_UNAVAILABLE");
    const counts = await bindings().USAGE_MONITOR_DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM accountless_enrollment_ledger) AS accountless,
        (SELECT COUNT(*) FROM participants) AS participants,
        (SELECT COUNT(*) FROM device_credentials) AS credentials,
        (SELECT COUNT(*) FROM upload_authorizations) AS upload_authorizations
    `).first<{
      accountless: number;
      participants: number;
      credentials: number;
      upload_authorizations: number;
    }>();
    expect(counts).toEqual({
      accountless: 0,
      participants: 0,
      credentials: 0,
      upload_authorizations: 0,
    });
  });

  it("creates one enrollment-only row and never creates legacy authority", async () => {
    const { body, rawSecret } = await enrollmentBody();
    const first = await api(body);
    expect(first.status).toBe(201);
    const payload = await first.json() as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "authorizationBasis",
      "deviceId",
      "expiresAt",
      "policyVersion",
      "schemaVersion",
      "scope",
      "state",
    ]);
    expect(payload).toMatchObject({
      schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
      state: "enrolled",
      deviceId: body.deviceId,
      policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
      authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
      scope: ACCOUNTLESS_ENROLLMENT_SCOPE,
    });
    expect(typeof payload.expiresAt).toBe("string");
    expect(payload).not.toHaveProperty("participantId");
    expect(payload).not.toHaveProperty("credentialGeneration");
    expect(payload).not.toHaveProperty("commit");
    expect(payload).not.toHaveProperty("deviceAuthorization");
    expect(payload).not.toHaveProperty("deviceSecret");
    expect(JSON.stringify(payload)).not.toContain(encodeBase64Url(rawSecret));

    const state = await bindings().USAGE_MONITOR_DB.prepare(`
      SELECT state, device_id, device_secret_hash, installation_principal_id,
             policy_version, authorization_basis, issued_at, expires_at
        FROM accountless_enrollment_ledger
       WHERE device_id = ?
    `).bind(body.deviceId).first<{
      state: string;
      device_id: string;
      device_secret_hash: ArrayBuffer;
      installation_principal_id: string;
      policy_version: string;
      authorization_basis: string;
      issued_at: string;
      expires_at: string;
    }>();
    expect(state).toMatchObject({
      state: "active",
      device_id: body.deviceId,
      policy_version: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
      authorization_basis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
    });
    expect(state?.installation_principal_id.startsWith("accountless:")).toBe(true);
    expect(new Uint8Array(
      state?.device_secret_hash ?? new ArrayBuffer(0),
    ).byteLength).toBe(32);
    expect(Date.parse(state?.expires_at ?? "") - Date.parse(state?.issued_at ?? ""))
      .toBe(ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS);

    const counts = await bindings().USAGE_MONITOR_DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM participants) AS participants,
        (SELECT COUNT(*) FROM web_sessions) AS sessions,
        (SELECT COUNT(*) FROM device_pairings) AS pairings,
        (SELECT COUNT(*) FROM device_credentials) AS credentials,
        (SELECT COUNT(*) FROM upload_authorizations) AS upload_authorizations,
        (SELECT COUNT(*) FROM participant_community_eligibility) AS eligibility
    `).first<{
      participants: number;
      sessions: number;
      pairings: number;
      credentials: number;
      upload_authorizations: number;
      eligibility: number;
    }>();
    expect(counts).toEqual({
      participants: 0,
      sessions: 0,
      pairings: 0,
      credentials: 0,
      upload_authorizations: 0,
      eligibility: 0,
    });
    const issuance = await bindings().USAGE_MONITOR_DB.prepare(
      "SELECT daily_issued, lifetime_issued FROM accountless_enrollment_issuance",
    ).first<{ daily_issued: number; lifetime_issued: number }>();
    expect(issuance).toEqual({ daily_issued: 1, lifetime_issued: 1 });
  });

  it("replays exactly without charging issuance and rejects hash changes", async () => {
    const { body } = await enrollmentBody();
    const first = await api(body);
    const replay = await api(body);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    const replayPayload = await replay.json() as Record<string, unknown>;
    expect(replayPayload.state).toBe("existing");
    expect(replayPayload.deviceId).toBe(body.deviceId);
    expect(replayPayload.expiresAt).toBe(
      (await first.clone().json() as Record<string, unknown>).expiresAt,
    );

    const different = await enrollmentBody();
    const conflict = await api({ ...body, deviceSecretHash: different.body.deviceSecretHash });
    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe("ACCOUNTLESS_ENROLLMENT_CONFLICT");
    const issuance = await bindings().USAGE_MONITOR_DB.prepare(
      "SELECT daily_issued, lifetime_issued FROM accountless_enrollment_issuance",
    ).first<{ daily_issued: number; lifetime_issued: number }>();
    expect(issuance).toEqual({ daily_issued: 1, lifetime_issued: 1 });
    const rows = await bindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS count FROM accountless_enrollment_ledger",
    ).first<{ count: number }>();
    expect(rows?.count).toBe(1);
  });

  it("converges concurrent identical requests to one row and one issuance", async () => {
    const { body } = await enrollmentBody();
    const request = parseAccountlessEnrollmentJson(JSON.stringify(body));
    const results = await Promise.all(
      Array.from({ length: 8 }, () => enrollAccountlessDevice(
        bindings().USAGE_MONITOR_DB,
        request,
        Date.parse("2026-09-04T00:00:00.000Z"),
      )),
    );
    expect(results.map(({ status }) => status).sort()).toEqual([
      200, 200, 200, 200, 200, 200, 200, 201,
    ]);
    const state = await bindings().USAGE_MONITOR_DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM accountless_enrollment_ledger) AS rows,
        daily_issued,
        lifetime_issued
        FROM accountless_enrollment_issuance
    `).first<{ rows: number; daily_issued: number; lifetime_issued: number }>();
    expect(state).toEqual({ rows: 1, daily_issued: 1, lifetime_issued: 1 });
  });

  it("expires a lease without renewing it or consuming another issuance", async () => {
    const { body } = await enrollmentBody();
    const request = parseAccountlessEnrollmentJson(JSON.stringify(body));
    const issuedAt = Date.parse("2026-09-04T00:00:00.000Z");
    await expect(enrollAccountlessDevice(
      bindings().USAGE_MONITOR_DB,
      request,
      issuedAt,
    )).resolves.toMatchObject({ status: 201 });
    await expect(enrollAccountlessDevice(
      bindings().USAGE_MONITOR_DB,
      request,
      issuedAt + ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS,
    )).rejects.toMatchObject({
      status: 410,
      code: "ACCOUNTLESS_ENROLLMENT_EXPIRED",
    });
    const state = await bindings().USAGE_MONITOR_DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM accountless_enrollment_ledger) AS rows,
        daily_issued,
        lifetime_issued
        FROM accountless_enrollment_issuance
    `).first<{ rows: number; daily_issued: number; lifetime_issued: number }>();
    expect(state).toEqual({ rows: 1, daily_issued: 1, lifetime_issued: 1 });
  });

  it("rejects malformed or overlong stored leases on replay", async () => {
    const db = bindings().USAGE_MONITOR_DB;
    const { body } = await enrollmentBody();
    const request = parseAccountlessEnrollmentJson(JSON.stringify(body));
    const issuedAt = Date.parse("2026-09-04T00:00:00.000Z");
    await expect(enrollAccountlessDevice(db, request, issuedAt))
      .resolves.toMatchObject({ status: 201 });
    await db.prepare(
      "UPDATE accountless_enrollment_ledger SET expires_at = ? WHERE device_id = ?",
    ).bind("not-an-instant", body.deviceId).run();
    await expect(enrollAccountlessDevice(db, request, issuedAt))
      .rejects.toMatchObject({
        status: 503,
        code: "BACKEND_STORAGE_UNAVAILABLE",
      });
    await db.prepare(
      "UPDATE accountless_enrollment_ledger SET expires_at = ? WHERE device_id = ?",
    ).bind(
      new Date(issuedAt + 2 * ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS).toISOString(),
      body.deviceId,
    ).run();
    await expect(enrollAccountlessDevice(db, request, issuedAt))
      .rejects.toMatchObject({
        status: 503,
        code: "BACKEND_STORAGE_UNAVAILABLE",
      });
  });

  it("keeps a revocation tombstone and never silently re-enrolls", async () => {
    const { body } = await enrollmentBody();
    await expect(api(body)).resolves.toMatchObject({ status: 201 });
    expect(await revokeAccountlessEnrollment(
      bindings().USAGE_MONITOR_DB,
      body.deviceId,
      "user_opt_out",
    )).toBe(true);
    const replay = await api(body);
    expect(replay.status).toBe(401);
    expect(await errorCode(replay)).toBe("ACCOUNTLESS_ENROLLMENT_REVOKED");
    const row = await bindings().USAGE_MONITOR_DB.prepare(
      "SELECT state, revoked_at, revocation_reason FROM accountless_enrollment_ledger WHERE device_id = ?",
    ).bind(body.deviceId).first<{
      state: string;
      revoked_at: string | null;
      revocation_reason: string | null;
    }>();
    expect(row).toMatchObject({
      state: "revoked",
      revocation_reason: "user_opt_out",
    });
    expect(row?.revoked_at).toEqual(expect.any(String));
  });

  it("enforces the atomic daily budget and the closed body boundary", async () => {
    const { body } = await enrollmentBody();
    const now = new Date().toISOString();
    await bindings().USAGE_MONITOR_DB.prepare(`
      UPDATE accountless_enrollment_issuance
         SET budget_day = ?, daily_issued = ?, lifetime_issued = ?, updated_at = ?
       WHERE singleton = 1
    `).bind(
      now.slice(0, 10),
      ACCOUNTLESS_ENROLLMENT_DAILY_ISSUANCE_BUDGET,
      ACCOUNTLESS_ENROLLMENT_LIFETIME_ISSUANCE_CEILING - 1,
      now,
    ).run();
    const limited = await api(body);
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe("ACCOUNTLESS_ENROLLMENT_LIMIT_REACHED");
    const counts = await bindings().USAGE_MONITOR_DB.prepare(`
      SELECT daily_issued, lifetime_issued,
             (SELECT COUNT(*) FROM accountless_enrollment_ledger) AS rows
        FROM accountless_enrollment_issuance
    `).first<{ daily_issued: number; lifetime_issued: number; rows: number }>();
    expect(counts).toEqual({
      daily_issued: ACCOUNTLESS_ENROLLMENT_DAILY_ISSUANCE_BUDGET,
      lifetime_issued: ACCOUNTLESS_ENROLLMENT_LIFETIME_ISSUANCE_CEILING - 1,
      rows: 0,
    });

    const oversized = await handleRequest(
      new Request(`${ORIGIN}/api/v1/accountless/enrollment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `${JSON.stringify(body)}${" ".repeat(512)}`,
      }),
      runtime({ ACCOUNTLESS_ENROLLMENT_MODE: "enabled" }),
    );
    expect(oversized.status).toBe(413);
    expect(await errorCode(oversized)).toBe("BODY_TOO_LARGE");
  });

  it("converges final-slot duplicate requests without a spurious limit response", async () => {
    const db = bindings().USAGE_MONITOR_DB;
    const issuedAt = Date.parse("2026-09-05T00:00:00.000Z");
    await db.prepare(`
      UPDATE accountless_enrollment_issuance
         SET budget_day = ?, daily_issued = ?, lifetime_issued = ?, updated_at = ?
       WHERE singleton = 1
    `).bind(
      "2026-09-05",
      ACCOUNTLESS_ENROLLMENT_DAILY_ISSUANCE_BUDGET - 1,
      ACCOUNTLESS_ENROLLMENT_LIFETIME_ISSUANCE_CEILING - 1,
      new Date(issuedAt).toISOString(),
    ).run();
    const { body } = await enrollmentBody();
    const request = parseAccountlessEnrollmentJson(JSON.stringify(body));
    const results = await Promise.all([
      enrollAccountlessDevice(db, request, issuedAt),
      enrollAccountlessDevice(db, request, issuedAt),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual([200, 201]);
    const state = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM accountless_enrollment_ledger) AS rows,
        daily_issued,
        lifetime_issued
        FROM accountless_enrollment_issuance
    `).first<{ rows: number; daily_issued: number; lifetime_issued: number }>();
    expect(state).toEqual({
      rows: 1,
      daily_issued: ACCOUNTLESS_ENROLLMENT_DAILY_ISSUANCE_BUDGET,
      lifetime_issued: ACCOUNTLESS_ENROLLMENT_LIFETIME_ISSUANCE_CEILING,
    });
  });

  it("resets the daily fence on rollover and still enforces the lifetime ceiling", async () => {
    const db = bindings().USAGE_MONITOR_DB;
    const issuedAt = Date.parse("2026-09-05T00:00:00.000Z");
    await db.prepare(`
      UPDATE accountless_enrollment_issuance
         SET budget_day = ?, daily_issued = ?, lifetime_issued = ?, updated_at = ?
       WHERE singleton = 1
    `).bind(
      "2026-09-04",
      ACCOUNTLESS_ENROLLMENT_DAILY_ISSUANCE_BUDGET,
      1,
      new Date(issuedAt).toISOString(),
    ).run();
    const first = await enrollmentBody();
    const result = await enrollAccountlessDevice(
      db,
      parseAccountlessEnrollmentJson(JSON.stringify(first.body)),
      issuedAt,
    );
    expect(result.status).toBe(201);
    let state = await db.prepare(
      "SELECT daily_issued, lifetime_issued FROM accountless_enrollment_issuance",
    ).first<{ daily_issued: number; lifetime_issued: number }>();
    expect(state).toEqual({ daily_issued: 1, lifetime_issued: 2 });

    await db.prepare(`
      UPDATE accountless_enrollment_issuance
         SET budget_day = ?, daily_issued = 0, lifetime_issued = ?, updated_at = ?
       WHERE singleton = 1
    `).bind(
      "2026-09-05",
      ACCOUNTLESS_ENROLLMENT_LIFETIME_ISSUANCE_CEILING,
      new Date(issuedAt).toISOString(),
    ).run();
    const second = await enrollmentBody();
    await expect(enrollAccountlessDevice(
      db,
      parseAccountlessEnrollmentJson(JSON.stringify(second.body)),
      issuedAt,
    )).rejects.toMatchObject({
      status: 429,
      code: "ACCOUNTLESS_ENROLLMENT_LIMIT_REACHED",
    });
    state = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM accountless_enrollment_ledger) AS rows,
        daily_issued,
        lifetime_issued
        FROM accountless_enrollment_issuance
    `).first<{ rows: number; daily_issued: number; lifetime_issued: number }>();
    expect(state).toEqual({
      rows: 1,
      daily_issued: 0,
      lifetime_issued: ACCOUNTLESS_ENROLLMENT_LIFETIME_ISSUANCE_CEILING,
    });
  });

  it("does not reset a newer daily fence when the clock moves backwards", async () => {
    const db = bindings().USAGE_MONITOR_DB;
    const newerDay = Date.parse("2026-09-05T00:00:00.000Z");
    await db.prepare(`
      UPDATE accountless_enrollment_issuance
         SET budget_day = ?, daily_issued = ?, lifetime_issued = ?, updated_at = ?
       WHERE singleton = 1
    `).bind(
      "2026-09-05",
      ACCOUNTLESS_ENROLLMENT_DAILY_ISSUANCE_BUDGET,
      1,
      new Date(newerDay).toISOString(),
    ).run();
    const { body } = await enrollmentBody();
    await expect(enrollAccountlessDevice(
      db,
      parseAccountlessEnrollmentJson(JSON.stringify(body)),
      Date.parse("2026-09-04T00:00:00.000Z"),
    )).rejects.toMatchObject({
      status: 429,
      code: "ACCOUNTLESS_ENROLLMENT_LIMIT_REACHED",
    });
    const state = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM accountless_enrollment_ledger) AS rows,
        budget_day,
        daily_issued,
        lifetime_issued
        FROM accountless_enrollment_issuance
    `).first<{
      rows: number;
      budget_day: string;
      daily_issued: number;
      lifetime_issued: number;
    }>();
    expect(state).toEqual({
      rows: 0,
      budget_day: "2026-09-05",
      daily_issued: ACCOUNTLESS_ENROLLMENT_DAILY_ISSUANCE_BUDGET,
      lifetime_issued: 1,
    });
  });

  it("keeps parser input closed and duplicate-key safe", () => {
    const valid = JSON.stringify({
      schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
      deviceId: "00000000-0000-4000-8000-000000000000",
      deviceSecretHash: "00".repeat(32),
      policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
      authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
    });
    expect(() => parseAccountlessEnrollmentJson(valid)).not.toThrow();
    expect(() => parseAccountlessEnrollmentJson(
      valid.replace(
        '"schemaVersion":"accountless-enrollment-v0.1"',
        '"schemaVersion":"accountless-enrollment-v0.1","schemaVersion":"accountless-enrollment-v0.1"',
      ),
    )).toThrowError("BODY_INVALID");
    expect(() => parseAccountlessEnrollmentJson(
      JSON.stringify({
        schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
        deviceId: "00000000-0000-4000-8000-000000000000",
        deviceSecretHash: "00".repeat(32),
        policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
        authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
        extra: "rejected",
      }),
    )).toThrowError("BODY_INVALID");
  });
});
