import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { handleRequest } from "../src/index";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

interface Participant {
  participantId: string;
  recoveryCode: string;
  csrfToken: string;
  cookie: string;
}

let publicJwkJson = "";
let privateJwkJson = "";
let keyId = "";

const TRACK_A = `account-track:v1:${"a".repeat(64)}`;
const TRACK_B = `account-track:v1:${"b".repeat(64)}`;
const DATASET = `dataset:v1:${"d".repeat(64)}`;

function bindings(overrides: Record<string, unknown> = {}): Env {
  const test = env as TestBindings;
  return {
    ASSETS: test.ASSETS,
    DELETION_LEDGER: test.DELETION_LEDGER,
    ENROLLMENT_MODE: test.ENROLLMENT_MODE,
    ENROLLMENT_RATE_LIMIT: test.ENROLLMENT_RATE_LIMIT,
    CLIENT_ATTEMPT_RATE_LIMIT: test.CLIENT_ATTEMPT_RATE_LIMIT,
    ENVELOPE_PRIVATE_JWK: privateJwkJson,
    ENVELOPE_PUBLIC_JWK: publicJwkJson,
    ENVIRONMENT: "synthetic-development",
    QUARANTINE: test.QUARANTINE,
    PUBLIC_READ_RATE_LIMIT: test.PUBLIC_READ_RATE_LIMIT,
    RECOVERY_RATE_LIMIT: test.RECOVERY_RATE_LIMIT,
    USAGE_MONITOR_DB: test.USAGE_MONITOR_DB,
    ACCOUNT_SCOPED_INGEST_MODE: "local_preview",
    ...overrides,
  } as unknown as Env;
}

async function api(
  path: string,
  init: RequestInit = {},
  runtimeEnv = bindings(),
  base = "http://127.0.0.1:8787",
): Promise<Response> {
  const headers = new Headers(init.headers);
  const method = init.method?.toUpperCase() ?? "GET";
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !headers.has("origin")) {
    headers.set("origin", base);
  }
  return handleRequest(
    new Request(`${base}${path}`, { ...init, headers }),
    runtimeEnv,
  );
}

function toolCounts(): Record<string, number> {
  return {
    webSearch: 0,
    fileSearch: 0,
    codeInterpreter: 0,
    hostedShell: 0,
    computerUse: 0,
    mcp: 0,
    applyPatch: 0,
    localShell: 0,
    subagent: 0,
    toolGateway: 0,
    other: 0,
    unknown: 0,
  };
}

function contribution(accountTrackId = TRACK_A): Record<string, unknown> {
  return {
    schemaVersion: "telemetry-contribution-v0.2",
    consentVersion: "privacy-safe-telemetry-v0.2",
    status: "implementation_disabled",
    synthetic: false,
    datasetId: DATASET,
    partIndex: 1,
    partCount: 1,
    completeness: "complete",
    createdAt: "2026-07-25T13:00:00.000Z",
    coveredAt: {
      startAt: "2026-07-25T12:00:00.000Z",
      endAt: "2026-07-25T12:30:00.000Z",
    },
    clientPlatform: "macos",
    providerPolicyEpoch: "openai_agentic_pool_2026_07_09",
    usageEvents: [{
      schemaVersion: "usage-event-v0.2",
      accountTrackId,
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
      toolClassCounts: toolCounts(),
      outcome: "completed",
      eventId: `event:v2:${"e".repeat(64)}`,
      accountingDiagnostic: {
        status: "untrusted_diagnostic",
        sourceSchemaVersion: "telemetry-contribution-v0.1",
        estimatedApiCostUsd: "999.000000",
        pricingCoveragePercent: 100,
        unknownBillableUnits: 0,
        priceBasis: "current_api_prices",
      },
    }],
    quotaSnapshots: [{
      schemaVersion: "quota-snapshot-v0.2",
      accountTrackId,
      observedTime: "2026-07-25T12:10:00.000Z",
      receivedTime: "2026-07-25T12:10:01.000Z",
      provider: "openai_codex",
      planType: "pro",
      planVariant: "pro-20x",
      limitId: "codex",
      slot: "seven_day",
      usedPercent: 31,
      displayPrecision: 0,
      windowDurationMinutes: 10_080,
      resetsAt: "2026-07-31T12:00:00.000Z",
      snapshotSource: "rollout",
      providerSurface: "account_shared_unallocated",
      snapshotId: `snapshot:v2:${"f".repeat(64)}`,
    }],
    activityMarkers: [],
    accountingDiagnostic: {
      status: "untrusted_diagnostic",
      sourceSchemaVersion: "telemetry-contribution-v0.1",
      estimatedApiCostUsd: "999.000000",
      pricedEventCoveragePercent: 100,
      unknownModelEventCount: 0,
      unknownBillableUnits: 0,
      priceBasis: "current_api_prices",
    },
  };
}

async function encrypt(value: unknown): Promise<object> {
  const rsaKey = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(publicJwkJson) as JsonWebKey,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const generated = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  );
  if ("publicKey" in generated) throw new Error("expected symmetric key");
  const exportedKey = await crypto.subtle.exportKey("raw", generated);
  if (!(exportedKey instanceof ArrayBuffer)) {
    throw new Error("expected raw key bytes");
  }
  const rawKey = new Uint8Array(exportedKey);
  const wrappedKey = new Uint8Array(await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    rsaKey,
    rawKey,
  ));
  rawKey.fill(0);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    generated,
    new TextEncoder().encode(JSON.stringify(value)),
  ));
  return {
    schemaVersion: "telemetry-envelope-v0.1",
    synthetic: false,
    keyId,
    wrappedKey: encodeBase64Url(wrappedKey),
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(ciphertext),
  };
}

async function enrollAccountScoped(
  runtimeEnv = bindings(),
  base = "http://127.0.0.1:8787",
): Promise<Response> {
  return api("/api/v1/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      consentVersion: "privacy-safe-telemetry-v0.2",
      syntheticOnly: false,
    }),
  }, runtimeEnv, base);
}

async function participantFrom(response: Response): Promise<Participant> {
  const body = await response.json<Omit<Participant, "cookie">>();
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("missing session cookie");
  return { ...body, cookie: setCookie.split(";", 1)[0]! };
}

async function upload(
  participant: Participant,
  value: unknown,
): Promise<{ response: Response; envelope: object }> {
  const envelope = await encrypt(value);
  const raw = JSON.stringify(envelope);
  const authorizationResponse = await api(
    "/api/v1/me/upload-authorizations",
    {
      method: "POST",
      headers: {
        cookie: participant.cookie,
        "content-type": "application/json",
        "x-usage-monitor-csrf": participant.csrfToken,
      },
      body: JSON.stringify({
        envelopeDigest: await sha256Hex(raw),
        contentLengthBytes: new TextEncoder().encode(raw).byteLength,
        contentType: "application/json",
      }),
    },
  );
  expect(authorizationResponse.status).toBe(201);
  const authorization = await authorizationResponse.json<{
    uploadAuthorization: string;
  }>();
  return {
    envelope,
    response: await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${authorization.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: raw,
    }),
  };
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

beforeAll(async () => {
  const generated = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  if (!("publicKey" in generated)) throw new Error("expected RSA key pair");
  keyId = `key:${crypto.randomUUID()}`;
  const publicJwk = await crypto.subtle.exportKey("jwk", generated.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", generated.privateKey);
  publicJwkJson = JSON.stringify({ ...publicJwk, kid: keyId });
  privateJwkJson = JSON.stringify({ ...privateJwk, kid: keyId });
});

beforeEach(async () => {
  await reset();
  const test = env as TestBindings;
  await applyD1Migrations(test.USAGE_MONITOR_DB, test.TEST_MIGRATIONS);
  await applyD1Migrations(
    test.DELETION_LEDGER,
    test.TEST_DELETION_LEDGER_MIGRATIONS,
  );
});

describe("account-scoped local HTTP ingestion", () => {
  it("fails closed unless mode, development configuration, and loopback all agree", async () => {
    const disabled = await enrollAccountScoped(bindings({
      ACCOUNT_SCOPED_INGEST_MODE: "disabled",
    }));
    expect(disabled.status).toBe(503);
    await expect(disabled.json()).resolves.toMatchObject({
      error: { code: "ACCOUNT_SCOPED_INGEST_DISABLED" },
    });

    const external = await enrollAccountScoped(
      bindings(),
      "https://example.test",
    );
    expect(external.status).toBe(403);
    await expect(external.json()).resolves.toMatchObject({
      error: { code: "ACCOUNT_SCOPED_LOCAL_ONLY" },
    });

    const production = await enrollAccountScoped(bindings({
      ENVIRONMENT: "production",
    }));
    expect(production.status).toBe(503);
    await expect(production.json()).resolves.toMatchObject({
      error: { code: "ADMISSION_CONFIGURATION_INVALID" },
    });
  });

  it("accepts, reprices, analyzes, exports, and deletes encrypted v0.2 data", async () => {
    const enrollment = await enrollAccountScoped();
    expect(enrollment.status).toBe(201);
    await expect(enrollment.clone().json()).resolves.toMatchObject({
      consentVersion: "privacy-safe-telemetry-v0.2",
    });
    const participant = await participantFrom(enrollment);

    const first = await upload(participant, contribution());
    expect(first.response.status).toBe(202);
    const receipt = await first.response.json<{
      contributionId: string;
      status: string;
      accountingVerification: string;
    }>();
    expect(receipt).toMatchObject({
      status: "accepted_account_scoped_local_preview",
      accountingVerification: "server_repriced",
    });

    const stored = await bindings().USAGE_MONITOR_DB.prepare(
      `SELECT c.transport_schema_version, c.r2_key,
          r.account_track_id, r.server_cost_usd
         FROM telemetry_contributions c
         JOIN telemetry_records r ON r.origin_contribution_id = c.id
        WHERE c.id = ? AND r.record_kind = 'usage'`,
    ).bind(receipt.contributionId).first<{
      transport_schema_version: string;
      r2_key: string;
      account_track_id: string;
      server_cost_usd: string;
    }>();
    expect(stored).toMatchObject({
      transport_schema_version: "telemetry-contribution-v0.2",
      account_track_id: TRACK_A,
    });
    expect(stored?.server_cost_usd).not.toBe("999.000000");
    expect(await bindings().QUARANTINE.head(stored!.r2_key)).not.toBeNull();

    const stats = await api("/api/v1/me/insights", {
      headers: { cookie: participant.cookie },
    });
    expect(stats.status).toBe(200);
    await expect(stats.json()).resolves.toMatchObject({
      totals: {
        usageEvents: 1,
        quotaSnapshots: 1,
        priceVerification: "server_repriced",
      },
      accountScopedQuotaAnalysis: {
        status: "ready",
        tracks: [{
          continuity: {
            accountTrackId: TRACK_A,
            windowDurationMinutes: 10_080,
          },
        }],
      },
    });

    const exported = await api("/api/v1/me/export", {
      headers: { cookie: participant.cookie },
    });
    expect(exported.status).toBe(200);
    const exportText = await exported.text();
    expect(exportText).toContain(TRACK_A);

    const deleted = await api("/api/v1/me/contributions/delete", {
      method: "POST",
      headers: {
        cookie: participant.cookie,
        "content-type": "application/json",
        "x-usage-monitor-csrf": participant.csrfToken,
      },
      body: JSON.stringify({ contributionId: receipt.contributionId }),
    });
    expect(deleted.status).toBe(200);
    expect(await bindings().QUARANTINE.head(stored!.r2_key)).toBeNull();
    const remaining = await bindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM telemetry_records WHERE participant_id = ?",
    ).bind(participant.participantId).first<{ total: number }>();
    expect(remaining?.total).toBe(0);
  });

  it("replays exact content and rejects conflicting account-track reuse", async () => {
    const participant = await participantFrom(await enrollAccountScoped());
    const first = await upload(participant, contribution());
    const firstReceipt = await first.response.json<{ contributionId: string }>();

    const replay = await upload(participant, contribution());
    expect(replay.response.status).toBe(202);
    expect(replay.response.headers.get("idempotency-replayed")).toBe("true");
    await expect(replay.response.json()).resolves.toMatchObject({
      contributionId: firstReceipt.contributionId,
      replayed: true,
    });

    const conflict = await upload(participant, contribution(TRACK_B));
    expect(conflict.response.status).toBe(409);
    await expect(conflict.response.json()).resolves.toMatchObject({
      error: { code: "TELEMETRY_OCCURRENCE_CONFLICT" },
    });
    const count = await bindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM telemetry_contributions WHERE participant_id = ?",
    ).bind(participant.participantId).first<{ total: number }>();
    expect(count?.total).toBe(1);
  });

  it("supports an upload-only v0.2 device without granting private-result access", async () => {
    const participant = await participantFrom(await enrollAccountScoped());
    const pairingResponse = await api("/api/v1/me/device-pairings", {
      method: "POST",
      headers: {
        cookie: participant.cookie,
        "content-type": "application/json",
        "x-usage-monitor-csrf": participant.csrfToken,
      },
      body: JSON.stringify({
        consentVersion: "ongoing-privacy-safe-telemetry-v0.2",
        ongoingUpload: true,
      }),
    });
    expect(pairingResponse.status).toBe(201);
    const pairing = await pairingResponse.json<{ pairingCode: string }>();

    const deviceId = crypto.randomUUID();
    const rawSecret = crypto.getRandomValues(new Uint8Array(32));
    const deviceSecret = encodeBase64Url(rawSecret);
    const secretHash = await deviceSecretHash(deviceId, rawSecret);
    rawSecret.fill(0);
    const claimed = await api("/api/v1/device-pairings/claim", {
      method: "POST",
      headers: {
        authorization: `Pairing ${pairing.pairingCode}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId, deviceSecretHash: secretHash }),
    });
    expect(claimed.status).toBe(201);

    const envelope = await encrypt(contribution());
    const raw = JSON.stringify(envelope);
    const registration = await api(
      "/api/v1/device/upload-authorizations",
      {
        method: "POST",
        headers: {
          authorization: `Device um_device_${deviceId}.${deviceSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          envelopeDigest: await sha256Hex(raw),
          contentLengthBytes: new TextEncoder().encode(raw).byteLength,
          contentType: "application/json",
        }),
      },
    );
    expect(registration.status).toBe(201);
    const authorization = await registration.json<{
      uploadAuthorization: string;
    }>();
    const accepted = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${authorization.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: raw,
    });
    expect(accepted.status).toBe(202);

    const denied = await api("/api/v1/me/insights", {
      headers: {
        authorization: `Device um_device_${deviceId}.${deviceSecret}`,
      },
    });
    expect(denied.status).toBe(401);
  });
});
