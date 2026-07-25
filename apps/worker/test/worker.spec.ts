import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error The browser helper is intentionally framework-free JavaScript.
import { createSyntheticEnvelope } from "../../web/public/lib.js";
import { encodeBase64Url } from "../src/crypto";
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

function testBindings(): Env {
  const bindings = env as TestBindings;
  return {
    ASSETS: bindings.ASSETS,
    ENVELOPE_PRIVATE_JWK: privateJwkJson,
    ENVELOPE_PUBLIC_JWK: publicJwkJson,
    ENVIRONMENT: "synthetic-development",
    QUARANTINE: bindings.QUARANTINE,
    USAGE_MONITOR_DB: bindings.USAGE_MONITOR_DB,
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

async function encrypt(value: unknown): Promise<object> {
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
    schemaVersion: "synthetic-envelope-v0.1",
    synthetic: true,
    keyId,
    wrappedKey: encodeBase64Url(wrappedKey),
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(ciphertext),
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
      mode: "synthetic-only",
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
      schemaVersion: "synthetic-participant-export-v0.1",
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
        "content-length": "999999",
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
});
