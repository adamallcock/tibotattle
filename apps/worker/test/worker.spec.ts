import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error The browser helper is intentionally framework-free JavaScript.
import { createSyntheticEnvelope } from "../../web/public/lib.js";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { hashInviteGrantSecret } from "../src/admission";
import worker, { handleRequest } from "../src/index";
import {
  createSessionMaterial,
  sessionCookie,
  sessionInsert,
} from "../src/session";
import { syntheticFixture } from "../src/validation";
import {
  buildCommunityWeeklySnapshot,
  communityWeekForScheduledTime,
} from "../src/community-snapshots";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
}

interface EnrollmentResponse {
  participantId: string;
  recoveryCode: string;
  csrfToken: string;
  cookie: string;
}

let publicJwkJson = "";
let privateJwkJson = "";
let keyId = "";

function recoveryAttemptId(): string {
  return `um_recovery_attempt_${encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

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
  const headers = new Headers(init.headers);
  const method = init.method?.toUpperCase() ?? "GET";
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !headers.has("origin")) {
    headers.set("origin", "https://example.test");
  }
  return handleRequest(
    new Request(`https://example.test${path}`, { ...init, headers }),
    runtimeEnv,
  );
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";", 1)[0]!;
}

async function enrollmentFrom(response: Response): Promise<EnrollmentResponse> {
  const body = await response.json<Omit<EnrollmentResponse, "cookie">>();
  return { ...body, cookie: cookieFrom(response) };
}

function personalHeaders(
  participant: EnrollmentResponse,
  { csrf = false }: { csrf?: boolean } = {},
): HeadersInit {
  return {
    cookie: participant.cookie,
    ...(csrf ? { "x-usage-monitor-csrf": participant.csrfToken } : {}),
  };
}

interface CollectionControlFlags {
  enrollment: boolean;
  uploadRegistration: boolean;
  processing: boolean;
  publication: boolean;
}

async function setCollectionControls(
  overrides: Partial<CollectionControlFlags>,
): Promise<CollectionControlFlags> {
  const current = await testBindings().USAGE_MONITOR_DB.prepare(`
    SELECT enrollment_enabled,
           upload_registration_enabled,
           processing_enabled,
           publication_enabled
      FROM collection_controls
     WHERE singleton = 1
  `).first<{
    enrollment_enabled: number;
    upload_registration_enabled: number;
    processing_enabled: number;
    publication_enabled: number;
  }>();
  if (!current) throw new Error("collection controls were not initialized");
  const flags = {
    enrollment: overrides.enrollment ?? current.enrollment_enabled === 1,
    uploadRegistration:
      overrides.uploadRegistration ?? current.upload_registration_enabled === 1,
    processing: overrides.processing ?? current.processing_enabled === 1,
    publication: overrides.publication ?? current.publication_enabled === 1,
  };
  const enabled = Object.values(flags).filter(Boolean).length;
  const state = enabled === 4
    ? "operational"
    : enabled === 0
      ? "contained"
      : "degraded";
  await testBindings().USAGE_MONITOR_DB.prepare(`
    UPDATE collection_controls
       SET enrollment_enabled = ?,
           upload_registration_enabled = ?,
           processing_enabled = ?,
           publication_enabled = ?,
           control_state = ?,
           revision = revision + 1,
           reason_code = 'maintenance',
           updated_at = ?
     WHERE singleton = 1
  `).bind(
    Number(flags.enrollment),
    Number(flags.uploadRegistration),
    Number(flags.processing),
    Number(flags.publication),
    state,
    new Date().toISOString(),
  ).run();
  return flags;
}

function contributionResource(
  participant: EnrollmentResponse,
  contributionId: string,
  operation: "read" | "delete",
  runtimeEnv = testBindings(),
): Promise<Response> {
  return api(`/api/v1/me/contributions/${operation}`, {
    method: "POST",
    headers: {
      ...personalHeaders(participant, { csrf: true }),
      "content-type": "application/json",
    },
    body: JSON.stringify({ contributionId }),
  }, runtimeEnv);
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
  return enrollmentFrom(response);
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
  return enrollmentFrom(response);
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

async function registerUpload(
  participant: EnrollmentResponse,
  rawEnvelope: string,
): Promise<{ uploadAuthorization: string; expiresAt: string }> {
  const response = await api("/api/v1/me/upload-authorizations", {
    method: "POST",
    headers: {
      ...personalHeaders(participant, { csrf: true }),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      envelopeDigest: await sha256Hex(rawEnvelope),
      contentLengthBytes: new TextEncoder().encode(rawEnvelope).byteLength,
      contentType: "application/json",
    }),
  });
  expect(response.status).toBe(201);
  return response.json<{ uploadAuthorization: string; expiresAt: string }>();
}

interface PairedDevice {
  deviceId: string;
  deviceSecret: string;
  authorization: string;
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
  try {
    return await sha256Hex(input);
  } finally {
    input.fill(0);
  }
}

async function pairDevice(
  participant: EnrollmentResponse,
): Promise<PairedDevice> {
  const pairingResponse = await api("/api/v1/me/device-pairings", {
    method: "POST",
    headers: {
      ...personalHeaders(participant, { csrf: true }),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      consentVersion: "ongoing-privacy-safe-telemetry-v0.1",
      ongoingUpload: true,
    }),
  });
  expect(pairingResponse.status).toBe(201);
  const pairing = await pairingResponse.json<{
    pairingCode: string;
    expiresAt: string;
  }>();
  expect(pairing.pairingCode).toMatch(/^um_pair_/u);

  const deviceId = crypto.randomUUID();
  const rawDeviceSecret = crypto.getRandomValues(new Uint8Array(32));
  const deviceSecret = encodeBase64Url(rawDeviceSecret);
  const hashedDeviceSecret = await deviceSecretHash(deviceId, rawDeviceSecret);
  rawDeviceSecret.fill(0);
  const claimed = await api("/api/v1/device-pairings/claim", {
    method: "POST",
    headers: {
      authorization: `Pairing ${pairing.pairingCode}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId, deviceSecretHash: hashedDeviceSecret }),
  });
  expect(claimed.status).toBe(201);
  await expect(claimed.json()).resolves.toEqual({
    deviceId,
    state: "active",
    scope: "upload_registration",
    expiresAt: expect.any(String),
  });
  return {
    deviceId,
    deviceSecret,
    authorization: `um_device_${deviceId}.${deviceSecret}`,
  };
}

async function registerDeviceUpload(
  device: PairedDevice,
  rawEnvelope: string,
): Promise<{ uploadAuthorization: string; expiresAt: string }> {
  const response = await api("/api/v1/device/upload-authorizations", {
    method: "POST",
    headers: {
      authorization: `Device ${device.authorization}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      envelopeDigest: await sha256Hex(rawEnvelope),
      contentLengthBytes: new TextEncoder().encode(rawEnvelope).byteLength,
      contentType: "application/json",
    }),
  });
  expect(response.status).toBe(201);
  return response.json<{ uploadAuthorization: string; expiresAt: string }>();
}

async function uploadEnvelope(
  participant: EnrollmentResponse,
  envelope: object,
): Promise<Response> {
  const rawEnvelope = JSON.stringify(envelope);
  const authorization = await registerUpload(participant, rawEnvelope);
  return api("/api/v1/contributions", {
    method: "POST",
    headers: {
      authorization: `Upload ${authorization.uploadAuthorization}`,
      "content-type": "application/json",
    },
    body: rawEnvelope,
  });
}

async function uploadRaw(
  participant: EnrollmentResponse,
  rawEnvelope: string,
  {
    requestContentType = "application/json",
    cookie,
  }: { requestContentType?: string; cookie?: string } = {},
): Promise<Response> {
  const authorization = await registerUpload(participant, rawEnvelope);
  return api("/api/v1/contributions", {
    method: "POST",
    headers: {
      authorization: `Upload ${authorization.uploadAuthorization}`,
      "content-type": requestContentType,
      ...(cookie ? { cookie } : {}),
    },
    body: rawEnvelope,
  });
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

async function seedSealedSuppressedSnapshot(): Promise<void> {
  const payload = JSON.stringify({
    schemaVersion: "community-weekly-snapshot-v0.1",
    releaseStatus: "suppressed",
    immutable: true,
    nonOverlapping: true,
    cells: [],
    reason: "privacy_release_policy_not_met",
  });
  await testBindings().USAGE_MONITOR_DB.prepare(
    `INSERT INTO community_weekly_snapshots (
      snapshot_id, week_start, week_end, ingestion_cutoff_at, released_at,
      policy_version, payload_json, payload_sha256, release_state, sealed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'suppressed', ?)`,
  ).bind(
    "community-weekly:2026-07-20",
    "2026-07-20T00:00:00.000Z",
    "2026-07-27T00:00:00.000Z",
    "2026-07-29T00:00:00.000Z",
    "2026-07-29T00:00:00.000Z",
    "community-weekly-v0.1",
    payload,
    await sha256Hex(payload),
    "2026-07-29T00:00:00.000Z",
  ).run();
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
  it("issues only a hash-backed secure cookie session and resists fixation", async () => {
    const response = await api("/api/v1/enroll", {
      method: "POST",
      headers: {
        cookie: `${"__Host-usage_monitor_session"}=um_session_${crypto.randomUUID()}.${"A".repeat(43)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        consentVersion: "privacy-safe-telemetry-v0.1",
        syntheticOnly: false,
      }),
    });
    expect(response.status).toBe(201);
    const responseText = await response.clone().text();
    expect(responseText).not.toContain("accessToken");
    expect(responseText).not.toContain("um_session_");
    const participant = await enrollmentFrom(response);
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toMatch(
      /^__Host-usage_monitor_session=um_session_[^;]+; Path=\/; Max-Age=1800; Secure; HttpOnly; SameSite=Strict$/u,
    );
    expect(setCookie).not.toContain("Domain=");
    expect(setCookie).not.toContain(`${"A".repeat(43)}`);

    const session = await api("/api/v1/session", {
      headers: personalHeaders(participant),
    });
    expect(session.status).toBe(200);
    expect(session.headers.get("cache-control")).toBe("no-store");
    expect(session.headers.get("vary")).toBe("Cookie");
    await expect(session.json()).resolves.toMatchObject({
      participantId: participant.participantId,
      csrfToken: participant.csrfToken,
    });

    const stored = await testBindings().USAGE_MONITOR_DB.prepare(
      `SELECT length(secret_hash) AS secret_bytes, length(csrf_hash) AS csrf_bytes
         FROM web_sessions WHERE participant_id = ?`,
    ).bind(participant.participantId).first<{
      secret_bytes: number;
      csrf_bytes: number;
    }>();
    expect(stored).toEqual({ secret_bytes: 32, csrf_bytes: 32 });

    const expiredId = participant.cookie.match(/um_session_([^.]+)\./u)?.[1];
    expect(expiredId).toBeTruthy();
    await testBindings().USAGE_MONITOR_DB.prepare(
      "UPDATE web_sessions SET expires_at = ? WHERE id = ?",
    ).bind(new Date(Date.now() - 1_000).toISOString(), expiredId).run();
    const expired = await api("/api/v1/session", {
      headers: personalHeaders(participant),
    });
    expect(expired.status).toBe(401);
  });

  it("requires same-origin CSRF for session mutations and issues no authority on failure", async () => {
    const crossOrigin = await api("/api/v1/enroll", {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        consentVersion: "privacy-safe-telemetry-v0.1",
        syntheticOnly: false,
      }),
    });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.headers.get("set-cookie")).toBeNull();
    const participantCount = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM participants",
    ).first<{ total: number }>();
    expect(participantCount?.total).toBe(0);

    const participant = await enrollTelemetry();
    const envelope = JSON.stringify(await encrypt(telemetryFixture("a"), true));
    const registrationBody = JSON.stringify({
      envelopeDigest: await sha256Hex(envelope),
      contentLengthBytes: new TextEncoder().encode(envelope).byteLength,
      contentType: "application/json",
    });
    for (const headers of [
      new Headers({
        cookie: participant.cookie,
        "content-type": "application/json",
      }),
      new Headers({
        cookie: participant.cookie,
        "content-type": "application/json",
        "x-usage-monitor-csrf": "um_csrf_wrong",
      }),
      new Headers({
        cookie: participant.cookie,
        origin: "https://attacker.example",
        "content-type": "application/json",
        "x-usage-monitor-csrf": participant.csrfToken,
      }),
    ]) {
      const rejected = await api("/api/v1/me/upload-authorizations", {
        method: "POST",
        headers,
        body: registrationBody,
      });
      expect(rejected.status).toBe(403);
    }
    const authorizationCount = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM upload_authorizations",
    ).first<{ total: number }>();
    expect(authorizationCount?.total).toBe(0);
  });

  it("strictly separates cookie sessions from one-use scoped upload authority", async () => {
    const participant = await enrollTelemetry();
    const envelope = await encrypt(telemetryFixture("a"), true);
    const rawEnvelope = JSON.stringify(envelope);
    const authorization = await registerUpload(participant, rawEnvelope);

    const cookieUpload = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${authorization.uploadAuthorization}`,
        cookie: participant.cookie,
        "content-type": "application/json",
      },
      body: rawEnvelope,
    });
    expect(cookieUpload.status).toBe(401);

    const uploadReadsPersonal = await api("/api/v1/me", {
      headers: { authorization: `Upload ${authorization.uploadAuthorization}` },
    });
    expect(uploadReadsPersonal.status).toBe(401);

    const wrongScope = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${authorization.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: `${rawEnvelope} `,
    });
    expect(wrongScope.status).toBe(401);

    const bomScope = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${authorization.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: `\uFEFF${rawEnvelope}`,
    });
    expect(bomScope.status).toBe(401);

    const accepted = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${authorization.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: rawEnvelope,
    });
    expect(accepted.status).toBe(202);
    const replay = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${authorization.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: rawEnvelope,
    });
    expect(replay.status).toBe(401);

    const personal = await api("/api/v1/me/export", {
      headers: personalHeaders(participant),
    });
    const exportText = await personal.text();
    expect(personal.headers.get("cache-control")).toBe("no-store");
    for (const secretPrefix of [
      "um_session_",
      "um_upload_",
      "um_recovery_",
      "um_csrf_",
      "__Host-usage_monitor_session",
    ]) {
      expect(exportText).not.toContain(secretPrefix);
    }
  });

  it("enforces upload expiry and exactly one concurrent claimant", async () => {
    const expiredParticipant = await enrollTelemetry();
    const expiredRaw = JSON.stringify(await encrypt(telemetryFixture("a"), true));
    const expiredAuthorization = await registerUpload(expiredParticipant, expiredRaw);
    const expiredId = expiredAuthorization.uploadAuthorization
      .match(/^um_upload_([^.]+)\./u)?.[1];
    await testBindings().USAGE_MONITOR_DB.prepare(
      "UPDATE upload_authorizations SET expires_at = ? WHERE id = ?",
    ).bind(new Date(Date.now() - 1_000).toISOString(), expiredId).run();
    const expired = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${expiredAuthorization.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: expiredRaw,
    });
    expect(expired.status).toBe(401);

    const participant = await enrollTelemetry();
    const raw = JSON.stringify(await encrypt(telemetryFixture("b"), true));
    const authorization = await registerUpload(participant, raw);
    const responses = await Promise.all([
      api("/api/v1/contributions", {
        method: "POST",
        headers: {
          authorization: `Upload ${authorization.uploadAuthorization}`,
          "content-type": "application/json",
        },
        body: raw,
      }),
      api("/api/v1/contributions", {
        method: "POST",
        headers: {
          authorization: `Upload ${authorization.uploadAuthorization}`,
          "content-type": "application/json",
        },
        body: raw,
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 401]);
    const state = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT state, consumed_contribution_id FROM upload_authorizations WHERE id = ?",
    ).bind(authorization.uploadAuthorization.match(/^um_upload_([^.]+)\./u)?.[1])
      .first<{ state: string; consumed_contribution_id: string | null }>();
    expect(state?.state).toBe("consumed");
    expect(state?.consumed_contribution_id).toMatch(/^contribution:/u);
  });

  it("does not revoke a consuming upload and records acceptance atomically", async () => {
    const participant = await enrollTelemetry();
    const raw = JSON.stringify(await encrypt(telemetryFixture("a"), true));
    const authorization = await registerUpload(participant, raw);
    let reachedPut!: () => void;
    let releasePut!: () => void;
    const putReached = new Promise<void>((resolve) => {
      reachedPut = resolve;
    });
    const putReleased = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const baseBucket = testBindings().QUARANTINE;
    const pausedBucket = new Proxy(baseBucket, {
      get(target, property) {
        if (property === "put") {
          return async (...args: Parameters<R2Bucket["put"]>) => {
            reachedPut();
            await putReleased;
            return target.put(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const upload = api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${authorization.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: raw,
    }, testBindings({ QUARANTINE: pausedBucket }));
    await putReached;

    const authorizationId = authorization.uploadAuthorization
      .match(/^um_upload_([^.]+)\./u)?.[1];
    const inFlight = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT state FROM upload_authorizations WHERE id = ?",
    ).bind(authorizationId).first<{ state: string }>();
    expect(inFlight?.state).toBe("consuming");

    const reset = await api("/api/v1/me/security-reset", {
      method: "POST",
      headers: personalHeaders(participant, { csrf: true }),
    });
    expect(reset.status).toBe(200);
    const stillConsuming = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT state FROM upload_authorizations WHERE id = ?",
    ).bind(authorizationId).first<{ state: string }>();
    expect(stillConsuming?.state).toBe("consuming");

    const deletion = await api("/api/v1/me", {
      method: "DELETE",
      headers: personalHeaders(participant, { csrf: true }),
    });
    expect(deletion.status).toBe(409);
    await expect(deletion.json()).resolves.toMatchObject({
      error: { code: "UPLOAD_IN_PROGRESS" },
    });
    const participantState = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT state FROM participants WHERE id = ?",
    ).bind(participant.participantId).first<{ state: string }>();
    expect(participantState?.state).toBe("active");

    releasePut();
    const accepted = await upload;
    expect(accepted.status).toBe(202);
    const receipt = await accepted.json<{ contributionId: string }>();
    const audited = await testBindings().USAGE_MONITOR_DB.prepare(
      `SELECT u.state, u.consumed_contribution_id,
              t.upload_authorization_id
         FROM upload_authorizations u
         JOIN telemetry_contributions t
           ON t.upload_authorization_id = u.id
        WHERE u.id = ?`,
    ).bind(authorizationId).first<{
      state: string;
      consumed_contribution_id: string;
      upload_authorization_id: string;
    }>();
    expect(audited).toEqual({
      state: "consumed",
      consumed_contribution_id: receipt.contributionId,
      upload_authorization_id: authorizationId,
    });
  });

  it("expires a crashed upload lease without accepting late ingestion or stranding deletion", async () => {
    const participant = await enrollTelemetry();
    const raw = JSON.stringify(await encrypt(telemetryFixture("a"), true));
    const authorization = await registerUpload(participant, raw);
    let reachedPut!: () => void;
    let releasePut!: () => void;
    const putReached = new Promise<void>((resolve) => {
      reachedPut = resolve;
    });
    const putReleased = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const baseBucket = testBindings().QUARANTINE;
    const pausedBucket = new Proxy(baseBucket, {
      get(target, property) {
        if (property === "put") {
          return async (...args: Parameters<R2Bucket["put"]>) => {
            reachedPut();
            await putReleased;
            return target.put(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const upload = api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${authorization.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: raw,
    }, testBindings({ QUARANTINE: pausedBucket }));
    await putReached;
    const authorizationId = authorization.uploadAuthorization
      .match(/^um_upload_([^.]+)\./u)?.[1];
    await testBindings().USAGE_MONITOR_DB.prepare(
      `UPDATE upload_authorizations
          SET consume_lease_expires_at = ?
        WHERE id = ? AND state = 'consuming'`,
    ).bind(new Date(Date.now() - 1_000).toISOString(), authorizationId).run();

    releasePut();
    const late = await upload;
    expect(late.status).toBe(500);
    const persisted = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM telemetry_contributions",
    ).first<{ total: number }>();
    expect(persisted?.total).toBe(0);
    expect((await testBindings().QUARANTINE.list()).objects).toHaveLength(0);
    const state = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT state, consumed_contribution_id FROM upload_authorizations WHERE id = ?",
    ).bind(authorizationId).first<{
      state: string;
      consumed_contribution_id: string | null;
    }>();
    expect(state).toEqual({ state: "revoked", consumed_contribution_id: null });

    const deletion = await api("/api/v1/me", {
      method: "DELETE",
      headers: personalHeaders(participant, { csrf: true }),
    });
    expect(deletion.status).toBe(200);
  });

  it("security reset revokes uploads and rotates recovery while logout revokes the session", async () => {
    const participant = await enrollTelemetry();
    const pendingRaw = JSON.stringify(await encrypt(telemetryFixture("a"), true));
    const pending = await registerUpload(participant, pendingRaw);
    const device = await pairDevice(participant);
    const devicePendingRaw = JSON.stringify(await encrypt(telemetryFixture("c"), true));
    const devicePending = await registerDeviceUpload(device, devicePendingRaw);
    const reset = await api("/api/v1/me/security-reset", {
      method: "POST",
      headers: personalHeaders(participant, { csrf: true }),
    });
    expect(reset.status).toBe(200);
    const resetBody = await reset.json<{
      recoveryCode: string;
      csrfToken: string;
    }>();
    expect(resetBody.recoveryCode).toMatch(/^um_recovery_/u);
    expect(resetBody.recoveryCode).not.toBe(participant.recoveryCode);
    expect(resetBody.csrfToken).toBe(participant.csrfToken);

    const currentSession = await api("/api/v1/session", {
      headers: personalHeaders(participant),
    });
    expect(currentSession.status).toBe(200);
    const revokedUpload = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${pending.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: pendingRaw,
    });
    expect(revokedUpload.status).toBe(401);
    const revokedDevice = await api("/api/v1/device/upload-authorizations", {
      method: "POST",
      headers: {
        authorization: `Device ${device.authorization}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        envelopeDigest: "a".repeat(64),
        contentLengthBytes: 1,
        contentType: "application/json",
      }),
    });
    expect(revokedDevice.status).toBe(401);
    const revokedDeviceUpload = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${devicePending.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: devicePendingRaw,
    });
    expect(revokedDeviceUpload.status).toBe(401);
    const oldRecovery = await api("/api/v1/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recoveryCode: participant.recoveryCode, recoveryAttemptId: recoveryAttemptId() }),
    });
    expect(oldRecovery.status).toBe(401);

    const noCsrfLogout = await api("/api/v1/logout", {
      method: "POST",
      headers: personalHeaders(participant),
    });
    expect(noCsrfLogout.status).toBe(403);
    const logout = await api("/api/v1/logout", {
      method: "POST",
      headers: personalHeaders(participant, { csrf: true }),
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toBe(
      "__Host-usage_monitor_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict",
    );
    const afterLogout = await api("/api/v1/session", {
      headers: personalHeaders(participant),
    });
    expect(afterLogout.status).toBe(401);
    const staleLogout = await api("/api/v1/logout", {
      method: "POST",
      headers: { cookie: participant.cookie },
    });
    expect(staleLogout.status).toBe(200);
    expect(staleLogout.headers.get("set-cookie")).toBe(
      "__Host-usage_monitor_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict",
    );
  });

  it("enrolls only with exact consent and persists it", async () => {
    const participant = await enroll();
    expect(participant.participantId).toMatch(/^participant:/u);
    expect(participant.csrfToken).toMatch(/^um_csrf_/u);
    expect(participant.recoveryCode).toMatch(/^um_recovery_/u);
    expect(participant.cookie).toMatch(/^__Host-usage_monitor_session=um_session_/u);

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
        body: JSON.stringify({ recoveryCode: participant.recoveryCode, recoveryAttemptId: recoveryAttemptId() }),
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
      collectionControls: {
        state: "operational",
        enrollment: true,
        uploadRegistration: true,
        processing: true,
        publication: true,
      },
      checks: {
        database: "ok",
        encryptedObjectStore: "reachable",
      },
      contracts: {
        acceptedContribution: "telemetry-contribution-v0.1",
        accountScopedContribution: {
          schemaVersion: "telemetry-contribution-v0.2",
          status: "implementation_disabled",
        },
      },
      capabilities: {
        encryptedUpload: true,
        serverValidation: true,
        idempotentDeduplication: true,
        participantStats: true,
        delayedAggregateStats: true,
        participantExport: true,
        participantDeletion: true,
        ongoingDeviceUploadRegistration: true,
      },
    });
  });

  it("independently contains collection while preserving participant rights", async () => {
    const participant = await enrollTelemetry();
    const device = await pairDevice(participant);
    const rawEnvelope = JSON.stringify(
      await encrypt(telemetryFixture("d"), true),
    );

    await setCollectionControls({ uploadRegistration: false });
    const blockedPairing = await api("/api/v1/me/device-pairings", {
      method: "POST",
      headers: {
        ...personalHeaders(participant, { csrf: true }),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        consentVersion: "ongoing-privacy-safe-telemetry-v0.1",
        ongoingUpload: true,
      }),
    });
    expect(blockedPairing.status).toBe(503);
    await expect(blockedPairing.json()).resolves.toMatchObject({
      error: { code: "UPLOAD_REGISTRATION_DISABLED" },
    });

    const registrationBody = JSON.stringify({
      envelopeDigest: await sha256Hex(rawEnvelope),
      contentLengthBytes: new TextEncoder().encode(rawEnvelope).byteLength,
      contentType: "application/json",
    });
    for (const [path, headers] of [
      [
        "/api/v1/me/upload-authorizations",
        {
          ...personalHeaders(participant, { csrf: true }),
          "content-type": "application/json",
        },
      ],
      [
        "/api/v1/device/upload-authorizations",
        {
          authorization: `Device ${device.authorization}`,
          "content-type": "application/json",
        },
      ],
    ] as const) {
      const response = await api(path, {
        method: "POST",
        headers,
        body: registrationBody,
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "UPLOAD_REGISTRATION_DISABLED" },
      });
    }

    await setCollectionControls({ uploadRegistration: true });
    const authorization = await registerUpload(participant, rawEnvelope);
    await setCollectionControls({ processing: false });
    const blockedUpload = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${authorization.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: rawEnvelope,
    });
    expect(blockedUpload.status).toBe(503);
    await expect(blockedUpload.json()).resolves.toMatchObject({
      error: { code: "PROCESSING_DISABLED" },
    });

    await setCollectionControls({ processing: true });
    const resumedUpload = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${authorization.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: rawEnvelope,
    });
    expect(resumedUpload.status).toBe(202);

    await setCollectionControls({ enrollment: false });
    const blockedEnrollment = await api("/api/v1/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        consentVersion: "privacy-safe-telemetry-v0.1",
        syntheticOnly: false,
      }),
    });
    expect(blockedEnrollment.status).toBe(503);
    await expect(blockedEnrollment.json()).resolves.toMatchObject({
      error: { code: "COLLECTION_ENROLLMENT_DISABLED" },
    });

    for (const path of ["/api/v1/me/stats", "/api/v1/me/export"]) {
      const response = await api(path, {
        headers: personalHeaders(participant),
      });
      expect(response.status).toBe(200);
    }

    await setCollectionControls({ publication: false });
    for (const path of [
      "/api/v1/stats/aggregate",
      "/api/v1/community/insights",
    ]) {
      const response = await api(path);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "PUBLICATION_DISABLED" },
      });
    }

    await setCollectionControls({
      enrollment: false,
      uploadRegistration: false,
      processing: false,
      publication: false,
    });
    const health = await api("/api/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      status: "ok",
      collectionControls: {
        state: "contained",
        enrollment: false,
        uploadRegistration: false,
        processing: false,
        publication: false,
      },
      capabilities: {
        encryptedUpload: false,
        participantStats: true,
        participantExport: true,
        participantDeletion: true,
        ongoingDeviceUploadRegistration: false,
      },
    });

    const deleted = await api("/api/v1/me", {
      method: "DELETE",
      headers: personalHeaders(participant, { csrf: true }),
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      deleted: true,
      contributionsDeleted: 1,
    });
    expect((await testBindings().QUARANTINE.list()).objects).toHaveLength(0);
  });

  it("fails collection closed when the control record is unavailable", async () => {
    const participant = await enrollTelemetry();
    const rawEnvelope = JSON.stringify(
      await encrypt(telemetryFixture("e"), true),
    );
    const authorization = await registerUpload(participant, rawEnvelope);
    await testBindings().USAGE_MONITOR_DB.prepare(
      "DELETE FROM collection_controls WHERE singleton = 1",
    ).run();

    for (const [path, init] of [
      [
        "/api/v1/enroll",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            consentVersion: "privacy-safe-telemetry-v0.1",
            syntheticOnly: false,
          }),
        },
      ],
      [
        "/api/v1/contributions",
        {
          method: "POST",
          headers: {
            authorization: `Upload ${authorization.uploadAuthorization}`,
            "content-type": "application/json",
          },
          body: rawEnvelope,
        },
      ],
      ["/api/v1/stats/aggregate", {}],
    ] as const) {
      const response = await api(path, init);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "COLLECTION_CONTROL_UNAVAILABLE" },
      });
    }

    const personalStats = await api("/api/v1/me/stats", {
      headers: personalHeaders(participant),
    });
    expect(personalStats.status).toBe(200);
    const deleted = await api("/api/v1/me", {
      method: "DELETE",
      headers: personalHeaders(participant, { csrf: true }),
    });
    expect(deleted.status).toBe(200);
    expect((await testBindings().QUARANTINE.list()).objects).toHaveLength(0);
  });

  it("accepts the real browser envelope, replays, exports, and deletes it", async () => {
    const participant = await enroll();
    const envelope = await createSyntheticEnvelope({
      publicJwk: JSON.parse(publicJwkJson) as JsonWebKey,
      keyId,
      cryptoImpl: crypto,
    });
    const contribution = await uploadEnvelope(participant, envelope);
    expect(contribution.status).toBe(202);
    const accepted = await contribution.json<{
      contributionId: string;
      status: string;
    }>();
    expect(accepted.status).toBe("accepted_synthetic");

    const replay = await uploadEnvelope(participant, envelope);
    expect(replay.status).toBe(202);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    await expect(replay.json()).resolves.toEqual(accepted);

    const me = await api("/api/v1/me", {
      headers: personalHeaders(participant),
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
      headers: personalHeaders(participant),
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
      headers: personalHeaders(participant, { csrf: true }),
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
      headers: personalHeaders(participant),
    });
    expect(oldAccess.status).toBe(401);
    const repeatedDelete = await api("/api/v1/me", {
      method: "DELETE",
      headers: personalHeaders(participant, { csrf: true }),
    });
    expect(repeatedDelete.status).toBe(401);
  });

  it("rejects real, mutated, oversized, and unauthenticated contributions", async () => {
    const participant = await enroll();
    const realEnvelope = {
      ...(await encrypt(syntheticFixture())),
      synthetic: false,
    };
    const real = await uploadEnvelope(participant, realEnvelope);
    expect(real.status).toBe(400);
    await expect(real.json()).resolves.toMatchObject({
      error: { code: "SYNTHETIC_REQUIRED" },
    });

    const mutatedFixture = syntheticFixture();
    mutatedFixture.accounting.estimatedApiCostUsd = "12.840001";
    const mutated = await uploadEnvelope(participant, await encrypt(mutatedFixture));
    expect(mutated.status).toBe(400);
    await expect(mutated.json()).resolves.toMatchObject({
      error: { code: "SYNTHETIC_RECORD_INVALID" },
    });

    const extraPlaintext = await uploadEnvelope(
      participant,
      await encrypt({
        ...syntheticFixture(),
        prompt: "rejected-after-decryption",
      }),
    );
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
        authorization: "Upload PRIVATE_UPLOAD_CANARY",
        "content-length": "9999999",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(oversized.status).toBe(413);

    const wrongContentType = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: "Upload PRIVATE_UPLOAD_CANARY",
        "content-type": "text/plain",
      },
      body: "{}",
    });
    expect(wrongContentType.status).toBe(415);

    const malformedJson = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: "Upload PRIVATE_UPLOAD_CANARY",
        "content-type": "application/json",
      },
      body: "{",
    });
    expect(malformedJson.status).toBe(400);

    const extraEnvelope = {
      ...(await encrypt(syntheticFixture())),
      prompt: "rejected-before-decryption",
    };
    const extraEnvelopeResponse = await uploadEnvelope(participant, extraEnvelope);
    expect(extraEnvelopeResponse.status).toBe(400);
    await expect(extraEnvelopeResponse.json()).resolves.toMatchObject({
      error: { code: "ENVELOPE_INVALID" },
    });

    const unknownKeyEnvelope = {
      ...(await encrypt(syntheticFixture())),
      keyId: "key:unknown",
    };
    const unknownKey = await uploadEnvelope(participant, unknownKeyEnvelope);
    expect(unknownKey.status).toBe(400);
    await expect(unknownKey.json()).resolves.toMatchObject({
      error: { code: "KEY_ID_INVALID" },
    });
  });

  it("accepts one contribution only and rejects a distinct valid envelope", async () => {
    const participant = await enroll();
    const first = await uploadEnvelope(participant, await encrypt(syntheticFixture()));
    expect(first.status).toBe(202);

    const distinct = await uploadEnvelope(participant, await encrypt(syntheticFixture()));
    expect(distinct.status).toBe(429);
    await expect(distinct.json()).resolves.toMatchObject({
      error: { code: "CONTRIBUTION_LIMIT_REACHED" },
    });
  });

  it("uses recovery once to rotate recovery, sessions, and upload authority", async () => {
    const participant = await enroll();
    const attemptId = recoveryAttemptId();
    const pendingRaw = JSON.stringify(await encrypt(syntheticFixture()));
    const pendingUpload = await registerUpload(participant, pendingRaw);
    const recovered = await api("/api/v1/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recoveryCode: participant.recoveryCode, recoveryAttemptId: attemptId }),
    });
    expect(recovered.status).toBe(200);
    const replacement = await enrollmentFrom(recovered);
    expect(replacement.participantId).toBe(participant.participantId);
    expect(replacement.recoveryCode).not.toBe(participant.recoveryCode);
    expect(replacement.cookie).not.toBe(participant.cookie);

    const oldAccess = await api("/api/v1/me", {
      headers: personalHeaders(participant),
    });
    expect(oldAccess.status).toBe(401);
    const newAccess = await api("/api/v1/me", {
      headers: personalHeaders(replacement),
    });
    expect(newAccess.status).toBe(200);
    const revokedUpload = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${pendingUpload.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: pendingRaw,
    });
    expect(revokedUpload.status).toBe(401);

    const unboundReplay = await api("/api/v1/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recoveryCode: participant.recoveryCode,
        recoveryAttemptId: recoveryAttemptId(),
      }),
    });
    expect(unboundReplay.status).toBe(401);
    const codeAlone = await api("/api/v1/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recoveryCode: participant.recoveryCode }),
    });
    expect(codeAlone.status).toBe(400);

    const replay = await api("/api/v1/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recoveryCode: participant.recoveryCode, recoveryAttemptId: attemptId }),
    });
    expect(replay.status).toBe(200);
    const replayed = await enrollmentFrom(replay);
    expect(replayed).toEqual(replacement);
    const secondReplay = await api("/api/v1/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recoveryCode: participant.recoveryCode, recoveryAttemptId: attemptId }),
    });
    expect(secondReplay.status).toBe(200);
    expect(await enrollmentFrom(secondReplay)).toEqual(replacement);
    const exhausted = await api("/api/v1/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recoveryCode: participant.recoveryCode, recoveryAttemptId: attemptId }),
    });
    expect(exhausted.status).toBe(401);
    const retryReceipt = await testBindings().USAGE_MONITOR_DB.prepare(
      `SELECT replay_count, length(old_recovery_token_hash) AS hash_bytes
         FROM recovery_retry_receipts WHERE old_recovery_token_id = ?`,
    ).bind(participant.recoveryCode.match(/^um_recovery_([^.]+)\./u)?.[1])
      .first<{ replay_count: number; hash_bytes: number }>();
    expect(retryReceipt).toEqual({ replay_count: 2, hash_bytes: 32 });

    const invalid = await api("/api/v1/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recoveryCode: `um_recovery_${crypto.randomUUID()}.${"A".repeat(43)}`,
      recoveryAttemptId: recoveryAttemptId(),
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
    const first = await uploadEnvelope(participant, firstEnvelope);
    expect(first.status).toBe(202);
    const accepted = await first.json<{
      contributionId: string;
      recordCounts: { accepted: number; deduplicated: number };
      accountingVerification: string;
    }>();
    expect(accepted.recordCounts).toMatchObject({ accepted: 2, deduplicated: 0 });
    expect(accepted.accountingVerification).toBe("server_repriced");
    const repriced = await testBindings().USAGE_MONITOR_DB.prepare(
      `SELECT server_cost_usd, server_cost_nanousd, server_pricing_status,
              server_pricing_method_version, server_price_registry_sha256,
              server_price_card_ids, server_tier_basis, server_api_service_tier,
              speed_mode, api_service_tier
         FROM telemetry_records
        WHERE participant_id = ? AND record_kind = 'usage'`,
    ).bind(participant.participantId).first<{
      server_cost_usd: string;
      server_cost_nanousd: number;
      server_pricing_status: string;
      server_pricing_method_version: string;
      server_price_registry_sha256: string;
      server_price_card_ids: string;
      server_tier_basis: string;
      server_api_service_tier: string;
      speed_mode: string;
      api_service_tier: string;
    }>();
    expect(repriced).toMatchObject({
      server_cost_usd: "0.0032",
      server_cost_nanousd: 3_200_000,
      server_pricing_status: "fully_priced",
      server_pricing_method_version: "server-api-price-equivalent-v0.1",
      server_tier_basis: "subscription_standard_counterfactual",
      server_api_service_tier: "standard",
      speed_mode: "fast",
      api_service_tier: "priority",
    });
    expect(repriced?.server_price_registry_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(repriced?.server_price_card_ids).toContain(":standard:");
    expect(repriced?.server_price_card_ids).not.toContain(":priority:");

    const replay = await uploadEnvelope(participant, firstEnvelope);
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
    const second = await uploadEnvelope(participant, await encrypt(overlap, true));
    expect(second.status).toBe(202);
    const secondAccepted = await second.json<{ contributionId: string; recordCounts: object }>();
    expect(secondAccepted).toMatchObject({
      recordCounts: { accepted: 1, deduplicated: 2 },
    });
    expect(secondAccepted.contributionId).not.toBe(accepted.contributionId);

    const stats = await api("/api/v1/me/stats", {
      headers: personalHeaders(participant),
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
        apiPriceEquivalentUsd: "0.0032",
        priceVerification: "server_repriced",
      },
      quotaGradients: [{
        status: "not_testable",
        reason: "account_continuity_not_transmitted",
        verification: "server_repriced",
      }],
    });

    const contribution = await contributionResource(
      participant,
      accepted.contributionId,
      "read",
    );
    expect(contribution.status).toBe(200);
    await expect(contribution.json()).resolves.toMatchObject({
      contributionId: accepted.contributionId,
      records: [{ kind: "usage" }, { kind: "quota" }],
    });
    const invalidContributionRead = await api(
      "/api/v1/me/contributions/read",
      {
        method: "POST",
        headers: {
          ...personalHeaders(participant, { csrf: true }),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          contributionId: accepted.contributionId,
          unexpected: true,
        }),
      },
    );
    expect(invalidContributionRead.status).toBe(400);
    const identifierBearingLegacyRoute = await api(
      `/api/v1/contributions/${encodeURIComponent(accepted.contributionId)}`,
      { headers: personalHeaders(participant) },
    );
    expect(identifierBearingLegacyRoute.status).toBe(404);

    const stranger = await enrollTelemetry();
    const isolated = await contributionResource(
      stranger,
      accepted.contributionId,
      "read",
    );
    expect(isolated.status).toBe(404);

    const community = await api("/api/v1/community/insights");
    await expect(community.json()).resolves.toMatchObject({
      schemaVersion: "community-weekly-snapshot-v0.1",
      releaseStatus: "not_yet_published",
      reason: "stable_snapshot_unavailable",
    });

    const stored = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT id FROM telemetry_contributions WHERE participant_id = ? ORDER BY created_at, id",
    ).bind(participant.participantId).all<{ id: string }>();
    expect(stored.results.map((row) => row.id)).toContain(secondAccepted.contributionId);

    const deleted = await contributionResource(
      participant,
      accepted.contributionId,
      "delete",
    );
    expect(deleted.status).toBe(200);
    const afterDelete = await api("/api/v1/me/stats", {
      headers: personalHeaders(participant),
    });
    await expect(afterDelete.json()).resolves.toMatchObject({
      totals: { contributions: 1, usageEvents: 1, quotaSnapshots: 1, activityMarkers: 1 },
    });
    const surviving = await contributionResource(
      participant,
      secondAccepted.contributionId,
      "read",
    );
    await expect(surviving.json()).resolves.toMatchObject({
      records: [{ kind: "usage" }, { kind: "quota" }, { kind: "activity" }],
    });
  });

  it("refuses a rolling quota conversion when account continuity was not transmitted", async () => {
    const participant = await enrollTelemetry();
    const first = await uploadEnvelope(
      participant,
      await encrypt(telemetryFixture("a"), true),
    );
    expect(first.status).toBe(202);

    const second = telemetryFixture("b");
    Reflect.set(second, "createdAt", "2026-07-25T14:00:00.000Z");
    Reflect.set(second, "coveredAt", {
      startAt: "2026-07-25T13:00:00.000Z",
      endAt: "2026-07-25T13:30:00.000Z",
    });
    const usage = Reflect.get(second, "usageEvents") as Array<Record<string, unknown>>;
    usage[0]!.eventTime = "2026-07-25T13:05:00.000Z";
    const quota = Reflect.get(second, "quotaSnapshots") as Array<Record<string, unknown>>;
    quota[0]!.observedTime = "2026-07-25T13:10:00.000Z";
    quota[0]!.receivedTime = "2026-07-25T13:10:01.000Z";
    quota[0]!.usedPercent = 33;
    const uploaded = await uploadEnvelope(
      participant,
      await encrypt(second, true),
    );
    expect(uploaded.status).toBe(202);

    const response = await api("/api/v1/me/stats", {
      headers: personalHeaders(participant),
    });
    expect(response.status).toBe(200);
    const stats = await response.json<{
      totals: { apiPriceEquivalentUsd: string };
      rollingQuotaMovement: {
        status: string;
        reason: string;
        accountContinuity: string;
        rows: unknown[];
      };
    }>();
    expect(stats.totals.apiPriceEquivalentUsd).toBe("0.0064");
    expect(stats.rollingQuotaMovement).toMatchObject({
      status: "not_testable",
      reason: "account_continuity_not_transmitted",
      accountContinuity: "not_transmitted",
      rows: [],
    });
  });

  it("does not label unbackfilled legacy rows as server repriced", async () => {
    const participant = await enrollTelemetry();
    const uploaded = await uploadEnvelope(
      participant,
      await encrypt(telemetryFixture("a"), true),
    );
    expect(uploaded.status).toBe(202);
    const accepted = await uploaded.json<{ contributionId: string }>();
    await testBindings().USAGE_MONITOR_DB.batch([
      testBindings().USAGE_MONITOR_DB.prepare(
        `UPDATE telemetry_records
            SET server_cost_usd = NULL,
                server_cost_nanousd = NULL,
                server_pricing_status = NULL,
                server_pricing_method_version = NULL,
                server_price_registry_version = NULL,
                server_price_registry_sha256 = NULL
          WHERE participant_id = ? AND record_kind = 'usage'`,
      ).bind(participant.participantId),
      testBindings().USAGE_MONITOR_DB.prepare(
        `UPDATE telemetry_contributions
            SET server_cost_nanousd = 0,
                server_pricing_method_version = NULL,
                server_price_registry_version = NULL,
                server_price_registry_sha256 = NULL
          WHERE id = ? AND participant_id = ?`,
      ).bind(accepted.contributionId, participant.participantId),
    ]);

    const stats = await api("/api/v1/me/stats", {
      headers: personalHeaders(participant),
    });
    await expect(stats.json()).resolves.toMatchObject({
      totals: {
        usageEvents: 1,
        apiPriceEquivalentUsd: null,
        priceVerification: "server_repricing_unavailable_for_legacy_records",
      },
      byModel: [{
        apiPriceEquivalentUsd: null,
        priceVerification: "server_repricing_unavailable_for_legacy_records",
      }],
      daily: [{
        apiPriceEquivalentUsd: null,
        priceVerification: "server_repricing_unavailable_for_legacy_records",
      }],
    });

    const contribution = await contributionResource(
      participant,
      accepted.contributionId,
      "read",
    );
    await expect(contribution.json()).resolves.toMatchObject({
      serverAccounting: {
        apiPriceEquivalentUsd: null,
        verification: "server_repricing_unavailable",
      },
    });
  });

  it("rejects privacy canaries and inconsistent accounting after decryption", async () => {
    const participant = await enrollTelemetry();
    const otherwiseValidEnvelope = JSON.stringify(await encrypt(telemetryFixture("d"), true));
    const duplicateKeyEnvelope = otherwiseValidEnvelope.replace(
      '"keyId":',
      '"keyId":"PRIVATE_PROMPT_CANARY","keyId":',
    );
    const duplicate = await uploadRaw(participant, duplicateKeyEnvelope);
    expect(duplicate.status).toBe(400);
    expect(await duplicate.text()).not.toContain("PRIVATE_PROMPT_CANARY");

    const contaminated = {
      ...telemetryFixture("b"),
      prompt: "PRIVATE USER CONTENT",
    };
    const privacy = await uploadEnvelope(participant, await encrypt(contaminated, true));
    expect(privacy.status).toBe(400);
    await expect(privacy.json()).resolves.toMatchObject({
      error: { code: "PRIVACY_CANARY_DETECTED" },
    });

    const inconsistent = telemetryFixture("c");
    const accounting = Reflect.get(inconsistent, "accounting") as Record<string, unknown>;
    accounting.estimatedApiCostUsd = "2.000000";
    const rejected = await uploadEnvelope(participant, await encrypt(inconsistent, true));
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: "TELEMETRY_RECORD_INVALID" },
    });
    expect((await testBindings().QUARANTINE.list()).objects).toHaveLength(0);
  });

  it("never serves the old live aggregate when no stable snapshot exists", async () => {
    for (const suffix of ["a", "b", "c"]) {
      const participant = await enrollTelemetry();
      const response = await uploadEnvelope(
        participant,
        await encrypt(telemetryFixture(suffix), true),
      );
      expect(response.status).toBe(202);
    }
    const response = await api("/api/v1/stats/aggregate");
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      schemaVersion: "community-weekly-snapshot-v0.1",
      releaseStatus: "not_yet_published",
      reason: "stable_snapshot_unavailable",
    });
    expect(JSON.stringify(body)).not.toContain("participantCount");
    expect(JSON.stringify(body)).not.toContain("totals");
    await expect(buildCommunityWeeklySnapshot(
      testBindings().USAGE_MONITOR_DB,
      Date.parse("2026-07-29T00:00:00.000Z"),
    )).resolves.toMatchObject({ state: "built" });
    const sealedSuppressionText = await (
      await api("/api/v1/stats/aggregate")
    ).text();
    expect(JSON.parse(sealedSuppressionText)).toMatchObject({
      releaseStatus: "suppressed",
      reason: "privacy_release_policy_not_met",
      immutable: true,
      nonOverlapping: true,
      cells: [],
    });
    expect(sealedSuppressionText).not.toContain("participantCount");
  });

  it("uses the scheduled event time and waitUntil to seal a weekly snapshot", async () => {
    const waits: Promise<unknown>[] = [];
    worker.scheduled?.(
      {
        cron: "",
        scheduledTime: Date.parse("2026-07-29T00:00:00.000Z"),
        noRetry() {},
      },
      testBindings(),
      {
        waitUntil(promise) {
          waits.push(promise);
        },
      } as ExecutionContext,
    );
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    const sealed = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT week_start, week_end, release_state FROM community_weekly_snapshots",
    ).first<{ week_start: string; week_end: string; release_state: string }>();
    expect(sealed).toEqual({
      week_start: "2026-07-20T00:00:00.000Z",
      week_end: "2026-07-27T00:00:00.000Z",
      release_state: "suppressed",
    });
  });

  it("prevents scheduled aggregate publication while publication is paused", async () => {
    await setCollectionControls({ publication: false });
    const waits: Promise<unknown>[] = [];
    worker.scheduled?.(
      {
        cron: "",
        scheduledTime: Date.parse("2026-07-29T00:00:00.000Z"),
        noRetry() {},
      },
      testBindings(),
      {
        waitUntil(promise) {
          waits.push(promise);
        },
      } as ExecutionContext,
    );
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    const snapshots = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM community_weekly_snapshots",
    ).first<{ total: number }>();
    expect(snapshots?.total).toBe(0);
  });

  it("seals, serves, protects, and withdraws a clipped weekly snapshot", async () => {
    let participantToDelete: EnrollmentResponse | null = null;
    let contributionToDelete = "";
    const cohort: EnrollmentResponse[] = [];
    for (let index = 0; index < 20; index += 1) {
      const grant = await issueTestGrant();
      const enrolled = await enrollWithGrant(grant);
      expect(enrolled.status).toBe(201);
      const participant = await enrollmentFrom(enrolled);
      cohort.push(participant);
      participantToDelete ??= participant;
      const contribution = await uploadEnvelope(
        participant,
        await encrypt(telemetryFixture("a"), true),
      );
      expect(contribution.status).toBe(202);
      const contributionBody = await contribution.json<{ contributionId: string }>();
      if (index === 0) contributionToDelete = contributionBody.contributionId;
    }
    const cutoffContribution = await uploadEnvelope(
      cohort[0]!,
      await encrypt(telemetryFixture("b"), true),
    );
    expect(cutoffContribution.status).toBe(202);
    const cutoffContributionBody = await cutoffContribution.json<{
      contributionId: string;
    }>();
    await testBindings().USAGE_MONITOR_DB.prepare(
      "UPDATE telemetry_contributions SET created_at = ? WHERE id = ?",
    ).bind(
      "2026-07-29T00:00:00.000Z",
      cutoffContributionBody.contributionId,
    ).run();
    await testBindings().USAGE_MONITOR_DB.prepare(
      `UPDATE telemetry_records
          SET input_uncached_tokens = 9000000,
              output_reasoning_tokens = NULL,
              tool_units = 2000
        WHERE participant_id = ? AND record_kind = 'usage'`,
    ).bind(cohort[0]!.participantId).run();
    const scheduledTime = Date.parse("2026-07-29T00:00:00.000Z");
    expect(communityWeekForScheduledTime(scheduledTime)).toEqual({
      startAt: "2026-07-20T00:00:00.000Z",
      endAt: "2026-07-27T00:00:00.000Z",
      cutoffAt: "2026-07-29T00:00:00.000Z",
    });
    const built = await Promise.all([
      buildCommunityWeeklySnapshot(testBindings().USAGE_MONITOR_DB, scheduledTime),
      buildCommunityWeeklySnapshot(testBindings().USAGE_MONITOR_DB, scheduledTime),
    ]);
    expect(built.filter((result) => result.state === "built")).toHaveLength(1);
    expect(built.every((result) => [
      "built", "existing", "lease_unavailable",
    ].includes(result.state))).toBe(true);
    const response = await api("/api/v1/stats/aggregate");
    const publishedText = await response.text();
    const published = JSON.parse(publishedText) as Record<string, unknown>;
    expect(published).toMatchObject({
      schemaVersion: "community-weekly-snapshot-v0.1",
      releaseStatus: "published",
      immutable: true,
      nonOverlapping: true,
      period: {
        startAt: "2026-07-20T00:00:00.000Z",
        endAt: "2026-07-27T00:00:00.000Z",
      },
      ingestionCutoffAt: "2026-07-29T00:00:00.000Z",
      releasedAt: "2026-07-29T00:00:00.000Z",
      cells: [{
        provider: "openai_codex",
        modelId: "gpt-5.6-sol",
        metrics: {
          usageEvents: {
            status: "released",
            value: 20,
            unit: "events_rounded_down",
          },
          inputUncachedTokens: {
            status: "released",
            value: 5_000_000,
            unit: "tokens_rounded_down",
          },
          inputCacheWriteTokens: {
            status: "released",
            value: 0,
            unit: "tokens_rounded_down",
          },
          outputCombinedTokens: { status: "suppressed" },
          outputReasoningTokens: { status: "suppressed" },
          toolUnits: {
            status: "released",
            value: 1_090,
            unit: "tool_units_rounded_down",
          },
        },
      }],
    });
    for (const forbidden of [
      "participantCount", "participant_id", "estimatedApiCost", "eligibility:",
      "occurrence_id", "model:v1:", "record_json",
    ]) {
      expect(publishedText).not.toContain(forbidden);
    }
    const sealed = await testBindings().USAGE_MONITOR_DB.prepare(
      `SELECT snapshot_id, payload_json, payload_sha256, release_state
         FROM community_weekly_snapshots`,
    ).all();
    expect(sealed.results).toHaveLength(1);
    expect(Reflect.get(sealed.results[0]!, "payload_json")).toBe(publishedText);
    expect(Reflect.get(sealed.results[0]!, "payload_sha256")).toBe(
      await sha256Hex(publishedText),
    );
    await testBindings().USAGE_MONITOR_DB.prepare(
      `UPDATE telemetry_records
          SET input_uncached_tokens = input_uncached_tokens + 99999
        WHERE participant_id = ? AND occurrence_id = ?`,
    ).bind(cohort[0]!.participantId, `event:v2:${"b".repeat(64)}`).run();
    await expect(
      buildCommunityWeeklySnapshot(testBindings().USAGE_MONITOR_DB, scheduledTime),
    ).resolves.toMatchObject({ state: "existing" });
    expect(await (await api("/api/v1/stats/aggregate")).text()).toBe(publishedText);
    await expect(testBindings().USAGE_MONITOR_DB.prepare(
      `UPDATE community_weekly_snapshots SET payload_json = '{}'`,
    ).run()).rejects.toThrow();
    await expect(testBindings().USAGE_MONITOR_DB.prepare(
      "DELETE FROM community_weekly_snapshots",
    ).run()).rejects.toThrow();

    const deleted = await contributionResource(
      participantToDelete!,
      contributionToDelete,
      "delete",
    );
    expect(deleted.status).toBe(200);
    const withdrawn = await api("/api/v1/stats/aggregate");
    const withdrawnText = await withdrawn.text();
    expect(JSON.parse(withdrawnText)).toMatchObject({
      schemaVersion: "community-weekly-snapshot-v0.1",
      releaseStatus: "withdrawn",
      reason: "source_data_withdrawn",
      immutable: true,
      nonOverlapping: true,
    });
    expect(withdrawnText).not.toContain("\"cells\"");
    await expect(testBindings().USAGE_MONITOR_DB.prepare(
      `UPDATE community_weekly_snapshots
          SET release_state = 'published',
              withdrawn_at = NULL,
              withdrawal_epoch = NULL`,
    ).run()).rejects.toThrow();
    await expect(
      buildCommunityWeeklySnapshot(testBindings().USAGE_MONITOR_DB, scheduledTime),
    ).resolves.toMatchObject({ state: "existing" });
  });

  it("withdraws a sealed snapshot before a contribution R2 deletion can fail", async () => {
    const participant = await enrollTelemetry();
    const uploaded = await uploadEnvelope(
      participant,
      await encrypt(telemetryFixture("a"), true),
    );
    expect(uploaded.status).toBe(202);
    const { contributionId } = await uploaded.json<{ contributionId: string }>();
    await seedSealedSuppressedSnapshot();

    const baseBucket = testBindings().QUARANTINE;
    const failingBucket = new Proxy(baseBucket, {
      get(target, property) {
        if (property === "delete") {
          return async (..._keys: Parameters<R2Bucket["delete"]>) => {
            throw new Error("injected contribution R2 deletion failure");
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failed = await contributionResource(
      participant,
      contributionId,
      "delete",
      testBindings({ QUARANTINE: failingBucket }),
    );
    expect(failed.status).toBe(500);
    const row = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT status FROM telemetry_contributions WHERE id = ?",
    ).bind(contributionId).first<{ status: string }>();
    expect(row?.status).toBe("deleting");
    const withdrawn = await api("/api/v1/stats/aggregate");
    const withdrawnText = await withdrawn.text();
    expect(JSON.parse(withdrawnText)).toMatchObject({
      releaseStatus: "withdrawn",
      immutable: true,
      nonOverlapping: true,
    });
    expect(withdrawnText).not.toContain("\"cells\"");

    const retried = await contributionResource(
      participant,
      contributionId,
      "delete",
    );
    expect(retried.status).toBe(200);
  });

  it("does not let local-open participants unlock invite-only community aggregates", async () => {
    for (const suffix of ["a", "b", "c"]) {
      const participant = await enrollTelemetry();
      const response = await uploadEnvelope(
        participant,
        await encrypt(telemetryFixture(suffix), true),
      );
      expect(response.status).toBe(202);
    }
    const suppressed = await api(
      "/api/v1/community/insights",
      {},
      inviteOnlyBindings(),
    );
    await expect(suppressed.json()).resolves.toMatchObject({
      schemaVersion: "community-weekly-snapshot-v0.1",
      releaseStatus: "not_yet_published",
      reason: "stable_snapshot_unavailable",
    });

    let invitedParticipant: EnrollmentResponse | null = null;
    for (const suffix of ["d", "e", "f"]) {
      const grant = await issueTestGrant();
      const enrolled = await enrollWithGrant(grant);
      expect(enrolled.status).toBe(201);
      const participant = await enrollmentFrom(enrolled);
      invitedParticipant ??= participant;
      const contribution = await uploadEnvelope(
        participant,
        await encrypt(telemetryFixture(suffix), true),
      );
      expect(contribution.status).toBe(202);
    }
    const community = await api(
      "/api/v1/community/insights",
      {},
      inviteOnlyBindings(),
    );
    const communityText = await community.text();
    expect(JSON.parse(communityText)).toMatchObject({
      schemaVersion: "community-weekly-snapshot-v0.1",
      releaseStatus: "not_yet_published",
      reason: "stable_snapshot_unavailable",
    });
    for (const forbidden of ["eligibility:", "um_invite_", "grant_id"]) {
      expect(communityText).not.toContain(forbidden);
    }

    const exported = await api("/api/v1/me/export", {
      headers: personalHeaders(invitedParticipant!),
    });
    const exportText = await exported.text();
    for (const forbidden of ["eligibility:", "um_invite_", "grant_id"]) {
      expect(exportText).not.toContain(forbidden);
    }
  });

  it("conditions concurrent deletion loser effects and preserves the winning retry session", async () => {
    const participant = await enrollTelemetry();
    const contribution = await uploadEnvelope(
      participant,
      await encrypt(telemetryFixture("a"), true),
    );
    expect(contribution.status).toBe(202);
    const pendingRaw = JSON.stringify(await encrypt(telemetryFixture("b"), true));
    const pendingUpload = await registerUpload(participant, pendingRaw);
    await seedSealedSuppressedSnapshot();

    const otherSession = await createSessionMaterial(participant.participantId);
    await sessionInsert(testBindings().USAGE_MONITOR_DB, otherSession).run();
    const otherParticipant: EnrollmentResponse = {
      participantId: participant.participantId,
      recoveryCode: participant.recoveryCode,
      csrfToken: otherSession.csrfToken,
      cookie: sessionCookie(otherSession).split(";", 1)[0]!,
    };

    let deleteCalls = 0;
    const baseBucket = testBindings().QUARANTINE;
    const flakyBucket = new Proxy(baseBucket, {
      get(target, property) {
        if (property === "delete") {
          return async (..._keys: Parameters<R2Bucket["delete"]>) => {
            deleteCalls += 1;
            throw new Error("injected R2 deletion failure");
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const responses = await Promise.all([
      api("/api/v1/me", {
        method: "DELETE",
        headers: personalHeaders(participant, { csrf: true }),
      }, testBindings({ QUARANTINE: flakyBucket })),
      api("/api/v1/me", {
        method: "DELETE",
        headers: personalHeaders(otherParticipant, { csrf: true }),
      }, testBindings({ QUARANTINE: flakyBucket })),
    ]);
    expect(responses.filter((response) => response.status === 500)).toHaveLength(1);
    expect(responses.filter((response) => [401, 409].includes(response.status))).toHaveLength(1);
    expect(deleteCalls).toBe(1);
    const withdrawnSnapshot = await api("/api/v1/stats/aggregate");
    await expect(withdrawnSnapshot.json()).resolves.toMatchObject({
      releaseStatus: "withdrawn",
      immutable: true,
      nonOverlapping: true,
    });

    const state = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT state, deletion_session_id FROM participants WHERE id = ?",
    ).bind(participant.participantId).first<{
      state: string;
      deletion_session_id: string;
    }>();
    expect(state?.state).toBe("deleting");
    const firstSessionId = participant.cookie.match(/um_session_([^.]+)\./u)?.[1];
    const winningParticipant = state?.deletion_session_id === firstSessionId
      ? participant
      : otherParticipant;
    const losingParticipant = winningParticipant === participant
      ? otherParticipant
      : participant;
    const otherRejected = await api("/api/v1/me", {
      headers: personalHeaders(losingParticipant),
    });
    expect(otherRejected.status).toBe(401);
    const uploadRejected = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${pendingUpload.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: pendingRaw,
    });
    expect(uploadRejected.status).toBe(401);

    await testBindings().USAGE_MONITOR_DB.prepare(
      `UPDATE web_sessions SET expires_at = ?
        WHERE id = ?`,
    ).bind("2020-01-01T00:00:00.000Z", state?.deletion_session_id).run();
    const expiredRetry = await api("/api/v1/me", {
      method: "DELETE",
      headers: personalHeaders(winningParticipant, { csrf: true }),
    });
    expect(expiredRetry.status).toBe(401);

    const recoveredResponse = await api("/api/v1/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recoveryCode: participant.recoveryCode,
        recoveryAttemptId: recoveryAttemptId(),
      }),
    });
    expect(recoveredResponse.status).toBe(200);
    const deletionOnly = await enrollmentFrom(recoveredResponse);
    const personalRead = await api("/api/v1/me/stats", {
      headers: personalHeaders(deletionOnly),
    });
    expect(personalRead.status).toBe(401);
    const uploadRegistration = await api("/api/v1/me/upload-authorizations", {
      method: "POST",
      headers: {
        ...personalHeaders(deletionOnly, { csrf: true }),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        envelopeDigest: "a".repeat(64),
        contentLengthBytes: 1,
        contentType: "application/json",
      }),
    });
    expect(uploadRegistration.status).toBe(401);

    const retried = await api("/api/v1/me", {
      method: "DELETE",
      headers: personalHeaders(deletionOnly, { csrf: true }),
    });
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({
      deleted: true,
      contributionsDeleted: 1,
    });
    expect((await testBindings().QUARANTINE.list()).objects).toHaveLength(0);
  });

  it("pairs a client-secret device and confines it to one-use v0.1 uploads", async () => {
    const participant = await enrollTelemetry();
    const device = await pairDevice(participant);

    const personalRead = await api("/api/v1/me", {
      headers: { authorization: `Device ${device.authorization}` },
    });
    expect(personalRead.status).toBe(401);

    const listed = await api("/api/v1/me/devices", {
      headers: personalHeaders(participant),
    });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      devices: [{
        deviceId: device.deviceId,
        state: "active",
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
        lastUsedAt: expect.any(String),
      }],
    });

    const raw = JSON.stringify(await encrypt(telemetryFixture("d"), true));
    const scoped = await registerDeviceUpload(device, raw);
    expect(scoped.uploadAuthorization).toMatch(/^um_device_upload_/u);
    const accepted = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${scoped.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: raw,
    });
    expect(accepted.status).toBe(202);
    const acceptedBody = await accepted.json<{ contributionId: string }>();
    expect(acceptedBody.contributionId).toMatch(/^contribution:/u);
    const reused = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${scoped.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: raw,
    });
    expect(reused.status).toBe(401);

    const stats = await api("/api/v1/me/stats", {
      headers: personalHeaders(participant),
    });
    expect(stats.status).toBe(200);
    await expect(stats.json()).resolves.toMatchObject({
      totals: { contributions: 1 },
    });

    const pendingRaw = JSON.stringify(await encrypt(telemetryFixture("e"), true));
    const pending = await registerDeviceUpload(device, pendingRaw);
    const invalidRevocation = await api("/api/v1/me/devices/revoke", {
      method: "POST",
      headers: {
        ...personalHeaders(participant, { csrf: true }),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deviceId: device.deviceId,
        unexpected: true,
      }),
    });
    expect(invalidRevocation.status).toBe(400);
    const revoked = await api("/api/v1/me/devices/revoke", {
      method: "POST",
      headers: {
        ...personalHeaders(participant, { csrf: true }),
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId: device.deviceId }),
    });
    expect(revoked.status).toBe(200);
    const identifierBearingLegacyRoute = await api(
      `/api/v1/me/devices/${device.deviceId}`,
      {
        method: "DELETE",
        headers: personalHeaders(participant, { csrf: true }),
      },
    );
    expect(identifierBearingLegacyRoute.status).toBe(404);
    const deniedRegistration = await api("/api/v1/device/upload-authorizations", {
      method: "POST",
      headers: {
        authorization: `Device ${device.authorization}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        envelopeDigest: await sha256Hex(pendingRaw),
        contentLengthBytes: new TextEncoder().encode(pendingRaw).byteLength,
        contentType: "application/json",
      }),
    });
    expect(deniedRegistration.status).toBe(401);
    const deniedPending = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${pending.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: pendingRaw,
    });
    expect(deniedPending.status).toBe(401);

    const deleted = await api("/api/v1/me", {
      method: "DELETE",
      headers: personalHeaders(participant, { csrf: true }),
    });
    expect(deleted.status).toBe(200);
    for (const table of [
      "device_pairings",
      "device_credentials",
      "device_upload_authorizations",
    ]) {
      const row = await testBindings().USAGE_MONITOR_DB.prepare(
        `SELECT COUNT(*) AS total FROM ${table}`,
      ).first<{ total: number }>();
      expect(row?.total).toBe(0);
    }
  });

  it("rejects cookie-bearing pairing claims and revokes device authority on recovery", async () => {
    const participant = await enrollTelemetry();
    const pairingResponse = await api("/api/v1/me/device-pairings", {
      method: "POST",
      headers: {
        ...personalHeaders(participant, { csrf: true }),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        consentVersion: "ongoing-privacy-safe-telemetry-v0.1",
        ongoingUpload: true,
      }),
    });
    const pairing = await pairingResponse.json<{ pairingCode: string }>();
    const deviceId = "11111111-1111-4111-8111-111111111111";
    const rawDeviceSecret = new Uint8Array(32).fill(37);
    const deviceSecret = encodeBase64Url(rawDeviceSecret);
    const hashedDeviceSecret = await deviceSecretHash(deviceId, rawDeviceSecret);
    expect(hashedDeviceSecret).toBe(
      "1ec2f641ad37bc1446708db769a3f6d86911bc17240912bc2f60a5b1113d66ec",
    );
    rawDeviceSecret.fill(0);
    const cookieClaim = await api("/api/v1/device-pairings/claim", {
      method: "POST",
      headers: {
        authorization: `Pairing ${pairing.pairingCode}`,
        cookie: participant.cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId, deviceSecretHash: hashedDeviceSecret }),
    });
    expect(cookieClaim.status).toBe(401);
    const claim = await api("/api/v1/device-pairings/claim", {
      method: "POST",
      headers: {
        authorization: `Pairing ${pairing.pairingCode}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId, deviceSecretHash: hashedDeviceSecret }),
    });
    expect(claim.status).toBe(201);
    const replay = await api("/api/v1/device-pairings/claim", {
      method: "POST",
      headers: {
        authorization: `Pairing ${pairing.pairingCode}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId, deviceSecretHash: hashedDeviceSecret }),
    });
    expect(replay.status).toBe(201);

    const recovered = await api("/api/v1/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recoveryCode: participant.recoveryCode,
        recoveryAttemptId: recoveryAttemptId(),
      }),
    });
    expect(recovered.status).toBe(200);
    const denied = await api("/api/v1/device/upload-authorizations", {
      method: "POST",
      headers: {
        authorization: `Device um_device_${deviceId}.${deviceSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        envelopeDigest: "a".repeat(64),
        contentLengthBytes: 1,
        contentType: "application/json",
      }),
    });
    expect(denied.status).toBe(401);
    const state = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT state FROM device_credentials WHERE id = ?",
    ).bind(deviceId).first<{ state: string }>();
    expect(state?.state).toBe("revoked");
  });

  it("deletes every telemetry object and database row with the participant", async () => {
    const participant = await enrollTelemetry();
    for (const suffix of ["a", "b"]) {
      const response = await uploadEnvelope(
        participant,
        await encrypt(telemetryFixture(suffix), true),
      );
      expect(response.status).toBe(202);
    }
    expect((await testBindings().QUARANTINE.list()).objects).toHaveLength(2);
    const deleted = await api("/api/v1/me", {
      method: "DELETE",
      headers: personalHeaders(participant, { csrf: true }),
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
