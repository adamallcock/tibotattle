import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error The browser helper is intentionally framework-free JavaScript.
import { createSyntheticEnvelope } from "../../web/public/lib.js";
import { encodeBase64Url } from "../src/crypto";
import { hashInviteGrantSecret } from "../src/admission";
import { handleRequest } from "../src/index";
import { syntheticFixture } from "../src/validation";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
}

interface EnrollmentResponse {
  participantId: string;
  accessToken: string;
  recoveryCode: string;
}

let publicJwkJson = "";
let privateJwkJson = "";
let keyId = "";

function testBindings(overrides: Partial<Env> = {}): Env {
  const bindings = env as TestBindings;
  return {
    ASSETS: bindings.ASSETS,
    ENROLLMENT_MODE: bindings.ENROLLMENT_MODE,
    ENROLLMENT_RATE_LIMIT: bindings.ENROLLMENT_RATE_LIMIT,
    ENVELOPE_PRIVATE_JWK: privateJwkJson,
    ENVELOPE_PUBLIC_JWK: publicJwkJson,
    ENVIRONMENT: "synthetic-development",
    QUARANTINE: bindings.QUARANTINE,
    RECOVERY_RATE_LIMIT: bindings.RECOVERY_RATE_LIMIT,
    USAGE_MONITOR_DB: bindings.USAGE_MONITOR_DB,
    ...overrides,
  };
}

async function api(
  path: string,
  init: RequestInit = {},
  runtimeEnv = testBindings(),
): Promise<Response> {
  return handleRequest(new Request(`https://example.test${path}`, init), runtimeEnv);
}

async function enroll(): Promise<EnrollmentResponse> {
  const response = await api("/api/v1/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      consentVersion: "synthetic-preview-v0.1",
      syntheticOnly: true,
    }),
  });
  expect(response.status).toBe(201);
  return response.json<EnrollmentResponse>();
}

async function enrollTelemetry(): Promise<EnrollmentResponse> {
  const response = await api("/api/v1/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      consentVersion: "privacy-safe-telemetry-v0.1",
      syntheticOnly: false,
    }),
  });
  expect(response.status).toBe(201);
  return response.json<EnrollmentResponse>();
}

async function issueTestGrant({
  expiresAt = new Date(Date.now() + 60 * 60_000).toISOString(),
} = {}): Promise<string> {
  const id = crypto.randomUUID();
  const secret = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const secretHash = await hashInviteGrantSecret(id, secret);
  await testBindings().USAGE_MONITOR_DB.prepare(
    `INSERT INTO enrollment_grants (
      id, secret_hash, state, issued_at, expires_at
    ) VALUES (?, ?, 'issued', ?, ?)`,
  ).bind(id, secretHash, new Date().toISOString(), expiresAt).run();
  return `um_invite_${id}.${secret}`;
}

function inviteOnlyBindings(overrides: Partial<Env> = {}): Env {
  return testBindings({
    ENROLLMENT_MODE: "invite_only" as Env["ENROLLMENT_MODE"],
    ...overrides,
  });
}

async function enrollWithGrant(
  inviteGrant: unknown,
  runtimeEnv = inviteOnlyBindings(),
): Promise<Response> {
  return api("/api/v1/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      consentVersion: "privacy-safe-telemetry-v0.1",
      syntheticOnly: false,
      ...(inviteGrant === undefined ? {} : { inviteCode: inviteGrant }),
    }),
  }, runtimeEnv);
}

async function encrypt(value: unknown, telemetry = false): Promise<object> {
  const publicJwk = JSON.parse(publicJwkJson) as JsonWebKey;
  const rsaKey = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const dataKeyResult = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  );
  if ("publicKey" in dataKeyResult) throw new Error("expected a symmetric key");
  const dataKey = dataKeyResult;
  const rawDataKeyResult = await crypto.subtle.exportKey("raw", dataKey);
  if (!(rawDataKeyResult instanceof ArrayBuffer)) throw new Error("expected raw key bytes");
  const rawDataKey = new Uint8Array(rawDataKeyResult);
  const wrappedKey = new Uint8Array(await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    rsaKey,
    rawDataKey,
  ));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    dataKey,
    new TextEncoder().encode(JSON.stringify(value)),
  ));
  return {
    schemaVersion: telemetry ? "telemetry-envelope-v0.1" : "synthetic-envelope-v0.1",
    synthetic: !telemetry,
    keyId,
    wrappedKey: encodeBase64Url(wrappedKey),
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(ciphertext),
  };
}

function telemetryFixture(suffix = "a"): Record<string, unknown> {
  const toolClassCounts = {
    webSearch: 1,
    fileSearch: 0,
    codeInterpreter: 0,
    hostedShell: 0,
    computerUse: 0,
    mcp: 0,
    applyPatch: 1,
    localShell: 2,
    subagent: 0,
    toolGateway: 1,
    other: 0,
    unknown: 0,
  };
  return {
    schemaVersion: "telemetry-contribution-v0.1",
    synthetic: false,
    createdAt: "2026-07-25T13:00:00.000Z",
    coveredAt: {
      startAt: "2026-07-25T12:00:00.000Z",
      endAt: "2026-07-25T12:30:00.000Z",
    },
    clientPlatform: "macos",
    providerPolicyEpoch: "openai_agentic_pool_2026_07_09",
    usageEvents: [{
      schemaVersion: "usage-event-v0.1",
      eventTime: "2026-07-25T12:05:00.000Z",
      provider: "openai_codex",
      modelId: "gpt-5.6-sol",
      modelRecognition: "recognized",
      modelFingerprint: null,
      billingSurface: "chatgpt_subscription",
      speedMode: "fast",
      apiServiceTier: "priority",
      reasoningEffort: "xhigh",
      components: {
        inputUncachedTokens: 100,
        inputCacheReadTokens: 900,
        inputCacheWriteTokens: 0,
        inputCacheWrite5mTokens: null,
        inputCacheWrite1hTokens: null,
        outputTextTokens: 50,
        outputReasoningTokens: 25,
        outputCombinedTokens: null,
      },
      totalInputContextTokens: 1000,
      surface: "local_interactive_unclassified",
      agentScope: "root",
      lineageDisposition: "standalone",
      toolClassCounts,
      outcome: "completed",
      eventId: `event:v2:${suffix.repeat(64)}`,
      accounting: {
        estimatedApiCostUsd: "1.000000",
        pricingCoveragePercent: 100,
        unknownBillableUnits: 0,
        priceBasis: "current_api_prices",
      },
    }],
    quotaSnapshots: [{
      schemaVersion: "quota-snapshot-v0.1",
      observedTime: "2026-07-25T12:10:00.000Z",
      receivedTime: "2026-07-25T12:10:01.000Z",
      provider: "openai_codex",
      planType: "pro",
      planVariant: "pro-20x",
      limitId: "codex",
      slot: "seven_day",
      usedPercent: 31,
      displayPrecision: 0,
      windowDurationMinutes: 10080,
      resetsAt: "2026-07-31T12:00:00.000Z",
      snapshotSource: "rollout",
      providerSurface: "account_shared_unallocated",
      snapshotId: `snapshot:v2:${suffix.repeat(64)}`,
    }],
    activityMarkers: [],
    accounting: {
      estimatedApiCostUsd: "1.000000",
      pricedEventCoveragePercent: 100,
      unknownModelEventCount: 0,
      unknownBillableUnits: 0,
      priceBasis: "current_api_prices",
    },
  };
}

beforeAll(async () => {
  const pairResult = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  if (!("publicKey" in pairResult)) throw new Error("expected an RSA key pair");
  const pair = pairResult;
  keyId = `key:${crypto.randomUUID()}`;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  publicJwkJson = JSON.stringify({ ...publicJwk, kid: keyId });
  privateJwkJson = JSON.stringify({ ...privateJwk, kid: keyId });
});

beforeEach(async () => {
  await reset();
  const bindings = env as TestBindings;
  await applyD1Migrations(bindings.USAGE_MONITOR_DB, bindings.TEST_MIGRATIONS);
});

describe("synthetic usage monitor service", () => {
  it("enrolls only with exact consent and persists it", async () => {
    const participant = await enroll();
    expect(participant.participantId).toMatch(/^participant:/u);
    expect(participant.accessToken).toMatch(/^um_access_/u);
    expect(participant.recoveryCode).toMatch(/^um_recovery_/u);

    const row = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT consent_version, consented_at FROM participants WHERE id = ?",
    ).bind(participant.participantId).first<{
      consent_version: string;
      consented_at: string;
    }>();
    expect(row?.consent_version).toBe("synthetic-preview-v0.1");
    expect(row?.consented_at).toMatch(/Z$/u);

    const malformed = await api("/api/v1/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        consentVersion: "synthetic-preview-v0.1",
        syntheticOnly: true,
        extra: "rejected",
      }),
    });
    expect(malformed.status).toBe(400);
  });

  it("fails closed for disabled, missing, invalid, and production-local enrollment modes", async () => {
    const cases = [
      {
        env: testBindings({
          ENROLLMENT_MODE: "disabled" as Env["ENROLLMENT_MODE"],
        }),
        code: "ENROLLMENT_DISABLED",
      },
      {
        env: testBindings({
          ENROLLMENT_MODE: undefined,
        } as unknown as Partial<Env>),
        code: "ADMISSION_CONFIGURATION_INVALID",
      },
      {
        env: testBindings({
          ENROLLMENT_MODE: "unreviewed" as Env["ENROLLMENT_MODE"],
        }),
        code: "ADMISSION_CONFIGURATION_INVALID",
      },
      {
        env: testBindings({
          ENVIRONMENT: "production" as Env["ENVIRONMENT"],
          ENROLLMENT_MODE: "local_open",
        }),
        code: "ADMISSION_CONFIGURATION_INVALID",
      },
      {
        env: testBindings({
          ENROLLMENT_RATE_LIMIT: undefined,
        } as unknown as Partial<Env>),
        code: "ADMISSION_CONFIGURATION_INVALID",
      },
    ];
    for (const testCase of cases) {
      const response = await api("/api/v1/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          consentVersion: "privacy-safe-telemetry-v0.1",
          syntheticOnly: false,
        }),
      }, testCase.env);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: testCase.code },
      });
    }
    const count = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM participants",
    ).first<{ total: number }>();
    expect(count?.total).toBe(0);
  });

  it("rejects missing, malformed, expired, and replayed grants without reflecting values", async () => {
    const expired = await issueTestGrant({
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...values: unknown[]) => {
      warnings.push(values.map(String).join(" "));
    };
    try {
      for (const value of [
        undefined,
        "PRIVATE_INVITE_CANARY",
        expired,
      ]) {
        const response = await enrollWithGrant(value);
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(JSON.parse(text)).toMatchObject({
          error: { code: "INVITE_GRANT_INVALID" },
        });
        expect(text).not.toContain(String(value));
      }
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.join("\n")).not.toContain("PRIVATE_INVITE_CANARY");
    let count = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM participants",
    ).first<{ total: number }>();
    expect(count?.total).toBe(0);

    const grant = await issueTestGrant();
    const accepted = await enrollWithGrant(grant);
    expect(accepted.status).toBe(201);
    const replay = await enrollWithGrant(grant);
    expect(replay.status).toBe(400);
    const replayText = await replay.text();
    expect(JSON.parse(replayText)).toMatchObject({
      error: { code: "INVITE_GRANT_INVALID" },
    });
    expect(replayText).not.toContain(grant);
    count = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM participants",
    ).first<{ total: number }>();
    expect(count?.total).toBe(1);
  });

  it("rejects a matching grant whose stored expiry is not a canonical instant", async () => {
    const grant = await issueTestGrant();
    const id = grant.slice("um_invite_".length, grant.indexOf("."));
    await testBindings().USAGE_MONITOR_DB.prepare(
      "UPDATE enrollment_grants SET expires_at = ? WHERE id = ?",
    ).bind("not-a-canonical-instant", id).run();
    const response = await enrollWithGrant(grant);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVITE_GRANT_INVALID" },
    });
    const count = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM participants",
    ).first<{ total: number }>();
    expect(count?.total).toBe(0);
  });

  it("atomically redeems an invite grant only once under concurrency", async () => {
    const grant = await issueTestGrant();
    const responses = await Promise.all([
      enrollWithGrant(grant),
      enrollWithGrant(grant),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 400]);
    const participants = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM participants",
    ).first<{ total: number }>();
    const eligible = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM participant_community_eligibility",
    ).first<{ total: number }>();
    expect(participants?.total).toBe(1);
    expect(eligible?.total).toBe(1);
  });

  it("bounds enrollment and recovery without persisting or logging client identifiers", async () => {
    const limiterKeys: string[] = [];
    const blockedLimiter = {
      async limit(input: { key: string }): Promise<{ success: boolean }> {
        limiterKeys.push(input.key);
        return { success: false };
      },
    } satisfies RateLimit;
    const allowedLimiter = {
      async limit(input: { key: string }): Promise<{ success: boolean }> {
        limiterKeys.push(input.key);
        return { success: true };
      },
    } satisfies RateLimit;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...values: unknown[]) => {
      warnings.push(values.map(String).join(" "));
    };
    try {
      const enrollment = await api("/api/v1/enroll", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "PRIVATE_IP_CANARY",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          consentVersion: "privacy-safe-telemetry-v0.1",
          syntheticOnly: false,
        }),
      }, testBindings({
        ENROLLMENT_RATE_LIMIT: blockedLimiter,
        RECOVERY_RATE_LIMIT: allowedLimiter,
      }));
      expect(enrollment.status).toBe(429);

      const participant = await enroll();
      const recovery = await api("/api/v1/recover", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "PRIVATE_IP_CANARY",
          "content-type": "application/json",
        },
        body: JSON.stringify({ recoveryCode: participant.recoveryCode }),
      }, testBindings({
        ENROLLMENT_RATE_LIMIT: allowedLimiter,
        RECOVERY_RATE_LIMIT: blockedLimiter,
      }));
      expect(recovery.status).toBe(429);
      const malformedPath = await api(
        "/api/v1/contributions/PRIVATE_PATH_CANARY",
        { headers: { authorization: "Bearer PRIVATE_CAPABILITY_CANARY" } },
      );
      expect(malformedPath.status).toBe(404);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.join("\n")).not.toContain("PRIVATE_IP_CANARY");
    expect(limiterKeys).toEqual([
      "usage-monitor:enrollment:global",
      "usage-monitor:recovery:global",
    ]);
    expect(warnings.join("\n")).not.toContain("PRIVATE_PATH_CANARY");
    expect(warnings.join("\n")).not.toContain("PRIVATE_CAPABILITY_CANARY");
    const attemptsTable = await testBindings().USAGE_MONITOR_DB.prepare(
      `SELECT COUNT(*) AS total FROM sqlite_master
        WHERE type = 'table' AND name LIKE '%attempt%'`,
    ).first<{ total: number }>();
    expect(attemptsTable?.total).toBe(0);
  });

  it("publishes the configured public key and a non-sensitive health result", async () => {
    const key = await api("/api/v1/envelope-key");
    expect(key.status).toBe(200);
    await expect(key.json()).resolves.toMatchObject({
      algorithm: "RSA-OAEP-256",
      keyId,
      publicJwk: { kid: keyId, key_ops: ["encrypt"], kty: "RSA" },
    });

    const health = await api("/api/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      status: "ok",
      mode: "synthetic-and-private-telemetry",
      enrollmentMode: "local_open",
    });
  });

  it("accepts the real browser envelope, replays, exports, and deletes it", async () => {
    const participant = await enroll();
    const envelope = await createSyntheticEnvelope({
      publicJwk: JSON.parse(publicJwkJson) as JsonWebKey,
      keyId,
      cryptoImpl: crypto,
    });
    const contribution = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${participant.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(envelope),
    });
    expect(contribution.status).toBe(202);
    const accepted = await contribution.json<{
      contributionId: string;
      status: string;
    }>();
    expect(accepted.status).toBe("accepted_synthetic");

    const replay = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${participant.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(envelope),
    });
    expect(replay.status).toBe(202);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    await expect(replay.json()).resolves.toEqual(accepted);

    const me = await api("/api/v1/me", {
      headers: { authorization: `Bearer ${participant.accessToken}` },
    });
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({
      participantId: participant.participantId,
      contributionCount: 1,
      latestContribution: {
        contributionId: accepted.contributionId,
        accounting: {
          unknownBillableUnits: 1,
          limitation: expect.stringContaining("no provider allowance formula"),
        },
      },
    });

    const exported = await api("/api/v1/me/export", {
      headers: { authorization: `Bearer ${participant.accessToken}` },
    });
    expect(exported.status).toBe(200);
    await expect(exported.json()).resolves.toMatchObject({
      schemaVersion: "participant-export-v0.2",
      syntheticOnly: true,
      contributions: [{ fixtureId: "codex-weekly-demo-v0.1" }],
    });
    expect((await testBindings().QUARANTINE.list()).objects).toHaveLength(1);

    const deleted = await api("/api/v1/me", {
      method: "DELETE",
      headers: { authorization: `Bearer ${participant.accessToken}` },
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      deleted: true,
      participantId: participant.participantId,
      contributionsDeleted: 1,
    });
    expect((await testBindings().QUARANTINE.list()).objects).toHaveLength(0);
    const participantCount = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM participants",
    ).first<{ total: number }>();
    expect(participantCount?.total).toBe(0);

    const oldAccess = await api("/api/v1/me", {
      headers: { authorization: `Bearer ${participant.accessToken}` },
    });
    expect(oldAccess.status).toBe(401);
    const repeatedDelete = await api("/api/v1/me", {
      method: "DELETE",
      headers: { authorization: `Bearer ${participant.accessToken}` },
    });
    expect(repeatedDelete.status).toBe(401);
  });

  it("rejects real, mutated, oversized, and unauthenticated contributions", async () => {
    const participant = await enroll();
    const realEnvelope = {
      ...(await encrypt(syntheticFixture())),
      synthetic: false,
    };
    const real = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${participant.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(realEnvelope),
    });
    expect(real.status).toBe(400);
    await expect(real.json()).resolves.toMatchObject({
      error: { code: "SYNTHETIC_REQUIRED" },
    });

    const mutatedFixture = syntheticFixture();
    mutatedFixture.accounting.estimatedApiCostUsd = "12.840001";
    const mutated = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${participant.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(await encrypt(mutatedFixture)),
    });
    expect(mutated.status).toBe(400);
    await expect(mutated.json()).resolves.toMatchObject({
      error: { code: "SYNTHETIC_RECORD_INVALID" },
    });

    const extraPlaintext = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${participant.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(await encrypt({
        ...syntheticFixture(),
        prompt: "rejected-after-decryption",
      })),
    });
    expect(extraPlaintext.status).toBe(400);
    await expect(extraPlaintext.json()).resolves.toMatchObject({
      error: { code: "SYNTHETIC_RECORD_INVALID" },
    });

    const unauthenticated = await api("/api/v1/contributions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(await encrypt(syntheticFixture())),
    });
    expect(unauthenticated.status).toBe(401);

    const oversized = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${participant.accessToken}`,
        "content-length": "9999999",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(oversized.status).toBe(413);

    const wrongContentType = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${participant.accessToken}`,
        "content-type": "text/plain",
      },
      body: "{}",
    });
    expect(wrongContentType.status).toBe(415);

    const malformedJson = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${participant.accessToken}`,
        "content-type": "application/json",
      },
      body: "{",
    });
    expect(malformedJson.status).toBe(400);

    const extraEnvelope = {
      ...(await encrypt(syntheticFixture())),
      prompt: "rejected-before-decryption",
    };
    const extraEnvelopeResponse = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${participant.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(extraEnvelope),
    });
    expect(extraEnvelopeResponse.status).toBe(400);
    await expect(extraEnvelopeResponse.json()).resolves.toMatchObject({
      error: { code: "ENVELOPE_INVALID" },
    });

    const unknownKeyEnvelope = {
      ...(await encrypt(syntheticFixture())),
      keyId: "key:unknown",
    };
    const unknownKey = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${participant.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(unknownKeyEnvelope),
    });
    expect(unknownKey.status).toBe(400);
    await expect(unknownKey.json()).resolves.toMatchObject({
      error: { code: "KEY_ID_INVALID" },
    });
  });

  it("accepts one contribution only and rejects a distinct valid envelope", async () => {
    const participant = await enroll();
    const first = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${participant.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(await encrypt(syntheticFixture())),
    });
    expect(first.status).toBe(202);

    const distinct = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${participant.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(await encrypt(syntheticFixture())),
    });
    expect(distinct.status).toBe(429);
    await expect(distinct.json()).resolves.toMatchObject({
      error: { code: "CONTRIBUTION_LIMIT_REACHED" },
    });
  });

  it("uses the recovery capability once to rotate access", async () => {
    const participant = await enroll();
    const recovered = await api("/api/v1/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recoveryCode: participant.recoveryCode }),
    });
    expect(recovered.status).toBe(200);
    const replacement = await recovered.json<{
      participantId: string;
      accessToken: string;
    }>();
    expect(replacement.participantId).toBe(participant.participantId);
    expect(replacement.accessToken).not.toBe(participant.accessToken);

    const oldAccess = await api("/api/v1/me", {
      headers: { authorization: `Bearer ${participant.accessToken}` },
    });
    expect(oldAccess.status).toBe(401);
    const newAccess = await api("/api/v1/me", {
      headers: { authorization: `Bearer ${replacement.accessToken}` },
    });
    expect(newAccess.status).toBe(200);

    const invalid = await api("/api/v1/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recoveryCode: `um_recovery_${crypto.randomUUID()}.${"A".repeat(43)}`,
      }),
    });
    expect(invalid.status).toBe(401);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: "AUTH_INVALID" },
    });
  });

  it("ingests closed telemetry, deduplicates overlaps, and isolates participant data", async () => {
    const participant = await enrollTelemetry();
    const firstEnvelope = await encrypt(telemetryFixture("a"), true);
    const first = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${participant.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(firstEnvelope),
    });
    expect(first.status).toBe(202);
    const accepted = await first.json<{
      contributionId: string;
      recordCounts: { accepted: number; deduplicated: number };
      accountingVerification: string;
    }>();
    expect(accepted.recordCounts).toMatchObject({ accepted: 2, deduplicated: 0 });
    expect(accepted.accountingVerification).toBe("client_declared_unverified");

    const replay = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${participant.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(firstEnvelope),
    });
    expect(replay.headers.get("idempotency-replayed")).toBe("true");

    const overlap = telemetryFixture("a");
    Reflect.set(overlap, "createdAt", "2026-07-25T13:01:00.000Z");
    Reflect.set(overlap, "activityMarkers", [{
      schemaVersion: "export-activity-marker-v0.1",
      observedTime: "2026-07-25T12:20:00.000Z",
      surface: "controlled_experiment",
      state: "pulse",
      agenticPoolCoupling: "depends_on_experiment_surface",
      planType: "pro",
      planVariant: "pro-20x",
      markerId: `marker:v2:${"d".repeat(64)}`,
    }]);
    const second = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${participant.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(await encrypt(overlap, true)),
    });
    expect(second.status).toBe(202);
    const secondAccepted = await second.json<{ contributionId: string; recordCounts: object }>();
    expect(secondAccepted).toMatchObject({
      recordCounts: { accepted: 1, deduplicated: 2 },
    });
    expect(secondAccepted.contributionId).not.toBe(accepted.contributionId);

    const stats = await api("/api/v1/me/stats", {
      headers: { authorization: `Bearer ${participant.accessToken}` },
    });
    expect(stats.status).toBe(200);
    const personal = await stats.json<Record<string, unknown>>();
    expect(personal).toMatchObject({
      participantId: participant.participantId,
      totals: {
        contributions: 2,
        usageEvents: 1,
        quotaSnapshots: 1,
        activityMarkers: 1,
        inputCacheReadTokens: 900,
        priceVerification: "client_declared_unverified",
      },
      quotaGradients: [{
        status: "not_testable",
        reason: "insufficient_quota_observations",
        verification: "client_declared_unverified",
      }],
    });

    const contribution = await api(
      `/api/v1/contributions/${encodeURIComponent(accepted.contributionId)}`,
      {
      headers: { authorization: `Bearer ${participant.accessToken}` },
      },
    );
    expect(contribution.status).toBe(200);
    await expect(contribution.json()).resolves.toMatchObject({
      contributionId: accepted.contributionId,
      records: [{ kind: "usage" }, { kind: "quota" }],
    });

    const stranger = await enrollTelemetry();
    const isolated = await api(`/api/v1/contributions/${accepted.contributionId}`, {
      headers: { authorization: `Bearer ${stranger.accessToken}` },
    });
    expect(isolated.status).toBe(404);

    const community = await api("/api/v1/community/insights");
    await expect(community.json()).resolves.toMatchObject({
      suppressed: true,
      participantCount: 1,
      minimumParticipants: 3,
    });

    const stored = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT id FROM telemetry_contributions WHERE participant_id = ? ORDER BY created_at, id",
    ).bind(participant.participantId).all<{ id: string }>();
    expect(stored.results.map((row) => row.id)).toContain(secondAccepted.contributionId);

    const deleted = await api(`/api/v1/contributions/${accepted.contributionId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${participant.accessToken}` },
    });
    expect(deleted.status).toBe(200);
    const afterDelete = await api("/api/v1/me/stats", {
      headers: { authorization: `Bearer ${participant.accessToken}` },
    });
    await expect(afterDelete.json()).resolves.toMatchObject({
      totals: { contributions: 1, usageEvents: 1, quotaSnapshots: 1, activityMarkers: 1 },
    });
    const surviving = await api(`/api/v1/contributions/${secondAccepted.contributionId}`, {
      headers: { authorization: `Bearer ${participant.accessToken}` },
    });
    await expect(surviving.json()).resolves.toMatchObject({
      records: [{ kind: "usage" }, { kind: "quota" }, { kind: "activity" }],
    });
  });

  it("rejects privacy canaries and inconsistent accounting after decryption", async () => {
    const participant = await enrollTelemetry();
    const otherwiseValidEnvelope = JSON.stringify(await encrypt(telemetryFixture("d"), true));
    const duplicateKeyEnvelope = otherwiseValidEnvelope.replace(
      '"keyId":',
      '"keyId":"PRIVATE_PROMPT_CANARY","keyId":',
    );
    const duplicate = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${participant.accessToken}`,
        "content-type": "application/json",
      },
      body: duplicateKeyEnvelope,
    });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.text()).not.toContain("PRIVATE_PROMPT_CANARY");

    const contaminated = {
      ...telemetryFixture("b"),
      prompt: "PRIVATE USER CONTENT",
    };
    const privacy = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${participant.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(await encrypt(contaminated, true)),
    });
    expect(privacy.status).toBe(400);
    await expect(privacy.json()).resolves.toMatchObject({
      error: { code: "PRIVACY_CANARY_DETECTED" },
    });

    const inconsistent = telemetryFixture("c");
    const accounting = Reflect.get(inconsistent, "accounting") as Record<string, unknown>;
    accounting.estimatedApiCostUsd = "2.000000";
    const rejected = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${participant.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(await encrypt(inconsistent, true)),
    });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: "TELEMETRY_RECORD_INVALID" },
    });
    expect((await testBindings().QUARANTINE.list()).objects).toHaveLength(0);
  });

  it("publishes only k-anonymous community slices", async () => {
    for (const suffix of ["a", "b", "c"]) {
      const participant = await enrollTelemetry();
      const response = await api("/api/v1/contributions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${participant.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(await encrypt(telemetryFixture(suffix), true)),
      });
      expect(response.status).toBe(202);
    }
    const response = await api("/api/v1/stats/aggregate");
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      suppressed: false,
      participantCount: 3,
      totals: { usageEvents: 3, quotaSnapshots: 3 },
      byModel: [{ modelId: "gpt-5.6-sol", participants: 3 }],
    });
    expect(JSON.stringify(body)).not.toContain("participant:");
    expect(JSON.stringify(body)).not.toContain("model:v1:");
  });

  it("does not let local-open participants unlock invite-only community aggregates", async () => {
    for (const suffix of ["a", "b", "c"]) {
      const participant = await enrollTelemetry();
      const response = await api("/api/v1/contributions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${participant.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(await encrypt(telemetryFixture(suffix), true)),
      });
      expect(response.status).toBe(202);
    }
    const suppressed = await api(
      "/api/v1/community/insights",
      {},
      inviteOnlyBindings(),
    );
    await expect(suppressed.json()).resolves.toMatchObject({
      suppressed: true,
      participantCount: 0,
      cohortEligibility: "invite_only",
    });

    let invitedParticipant: EnrollmentResponse | null = null;
    for (const suffix of ["d", "e", "f"]) {
      const grant = await issueTestGrant();
      const enrolled = await enrollWithGrant(grant);
      expect(enrolled.status).toBe(201);
      const participant = await enrolled.json<EnrollmentResponse>();
      invitedParticipant ??= participant;
      const contribution = await api("/api/v1/contributions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${participant.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(await encrypt(telemetryFixture(suffix), true)),
      });
      expect(contribution.status).toBe(202);
    }
    const community = await api(
      "/api/v1/community/insights",
      {},
      inviteOnlyBindings(),
    );
    const communityText = await community.text();
    expect(JSON.parse(communityText)).toMatchObject({
      suppressed: false,
      participantCount: 3,
      cohortEligibility: "invite_only",
      totals: { usageEvents: 3, quotaSnapshots: 3 },
    });
    for (const forbidden of ["eligibility:", "um_invite_", "grant_id"]) {
      expect(communityText).not.toContain(forbidden);
    }

    const exported = await api("/api/v1/me/export", {
      headers: { authorization: `Bearer ${invitedParticipant?.accessToken}` },
    });
    const exportText = await exported.text();
    for (const forbidden of ["eligibility:", "um_invite_", "grant_id"]) {
      expect(exportText).not.toContain(forbidden);
    }
  });

  it("deletes every telemetry object and database row with the participant", async () => {
    const participant = await enrollTelemetry();
    for (const suffix of ["a", "b"]) {
      const response = await api("/api/v1/contributions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${participant.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(await encrypt(telemetryFixture(suffix), true)),
      });
      expect(response.status).toBe(202);
    }
    expect((await testBindings().QUARANTINE.list()).objects).toHaveLength(2);
    const deleted = await api("/api/v1/me", {
      method: "DELETE",
      headers: { authorization: `Bearer ${participant.accessToken}` },
    });
    await expect(deleted.json()).resolves.toMatchObject({
      deleted: true,
      contributionsDeleted: 2,
    });
    expect((await testBindings().QUARANTINE.list()).objects).toHaveLength(0);
    const rows = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM telemetry_records",
    ).first<{ total: number }>();
    expect(rows?.total).toBe(0);
  });
});
