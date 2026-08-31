import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../src/canonical-json";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { handleRequest } from "../src/index";
import { ownerErase } from "./helpers/owner-erasure";
import {
  rebuildPendingCommunityDailyAggregates,
} from "../src/community-daily-aggregates";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

interface EnrollmentResponse {
  participantId: string;
  recoveryCode: string;
  csrfToken: string;
  cookie: string;
}

interface PairedDevice {
  deviceId: string;
  deviceSecret: string;
  authorization: string;
}

let publicJwkJson = "";
let privateJwkJson = "";
let keyId = "";

function testBindings(overrides: Partial<Env> = {}): Env {
  const bindings = env as TestBindings;
  return {
    ASSETS: bindings.ASSETS,
    DELETION_LEDGER: bindings.DELETION_LEDGER,
    ENROLLMENT_MODE: bindings.ENROLLMENT_MODE,
    SIGN_IN_START_MAX_PER_MINUTE: "1200",
    ENROLLMENT_RATE_LIMIT: bindings.ENROLLMENT_RATE_LIMIT,
    CLIENT_ATTEMPT_RATE_LIMIT: bindings.CLIENT_ATTEMPT_RATE_LIMIT,
    ENVELOPE_PRIVATE_JWK: privateJwkJson,
    ENVELOPE_PUBLIC_JWK: publicJwkJson,
    ENVIRONMENT: "synthetic-development",
    ACCOUNT_SCOPED_INGEST_MODE: "disabled",
    QUARANTINE: bindings.QUARANTINE,
    PUBLIC_READ_RATE_LIMIT: bindings.PUBLIC_READ_RATE_LIMIT,
    RECOVERY_RATE_LIMIT: bindings.RECOVERY_RATE_LIMIT,
    UPLOAD_AUTHORIZATION_RATE_LIMIT: bindings.UPLOAD_AUTHORIZATION_RATE_LIMIT,
    UPLOAD_PRINCIPAL_RATE_LIMIT: bindings.UPLOAD_PRINCIPAL_RATE_LIMIT,
    UPLOAD_INGRESS_REQUEST_RATE_LIMIT:
      bindings.UPLOAD_INGRESS_REQUEST_RATE_LIMIT,
    UPLOAD_INGRESS_CLIENT_RATE_LIMIT:
      bindings.UPLOAD_INGRESS_CLIENT_RATE_LIMIT,
    UPLOAD_INGRESS_BUDGET: bindings.UPLOAD_INGRESS_BUDGET,
    UPLOAD_INGRESS_QUEUE_MODE: bindings.UPLOAD_INGRESS_QUEUE_MODE,
    UPLOAD_INGRESS_MAX_CONCURRENT: bindings.UPLOAD_INGRESS_MAX_CONCURRENT,
    UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE:
      bindings.UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE,
    UPLOAD_INGRESS_BURST: bindings.UPLOAD_INGRESS_BURST,
    UPLOAD_INGRESS_LEASE_SECONDS: bindings.UPLOAD_INGRESS_LEASE_SECONDS,
    UPLOAD_INGRESS_BODY_TOTAL_SECONDS: "60",
    UPLOAD_INGRESS_BODY_IDLE_SECONDS: "15",
    USAGE_MONITOR_DB: bindings.USAGE_MONITOR_DB,
    ...overrides,
  } as Env;
}

function db(): D1Database {
  return (env as TestBindings).USAGE_MONITOR_DB;
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
  const body = await response.json<Omit<EnrollmentResponse, "cookie">>();
  return { ...body, cookie: cookieFrom(response) };
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
  consentVersion = "ongoing-privacy-safe-telemetry-v1.0",
): Promise<PairedDevice> {
  const pairingResponse = await api("/api/v1/me/device-pairings", {
    method: "POST",
    headers: {
      cookie: participant.cookie,
      "x-usage-monitor-csrf": participant.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      consentVersion,
      ongoingUpload: true,
    }),
  });
  expect(pairingResponse.status).toBe(201);
  const pairing = await pairingResponse.json<{ pairingCode: string }>();
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
  return {
    deviceId,
    deviceSecret,
    authorization: `um_device_${deviceId}.${deviceSecret}`,
  };
}

async function encryptV1(plaintext: string): Promise<object> {
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
  const rawDataKeyResult = await crypto.subtle.exportKey("raw", dataKeyResult);
  if (!(rawDataKeyResult instanceof ArrayBuffer)) {
    throw new Error("expected raw key bytes");
  }
  const wrappedKey = new Uint8Array(await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    rsaKey,
    new Uint8Array(rawDataKeyResult),
  ));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    dataKeyResult,
    new TextEncoder().encode(plaintext),
  ));
  return {
    schemaVersion: "telemetry-envelope-v1.0",
    synthetic: false,
    keyId,
    wrappedKey: encodeBase64Url(wrappedKey),
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(ciphertext),
  };
}

async function registerDeviceUpload(
  device: PairedDevice,
  rawEnvelope: string,
): Promise<string> {
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
  const body = await response.json<{ uploadAuthorization: string }>();
  return body.uploadAuthorization;
}

async function uploadRawEnvelope(
  device: PairedDevice,
  rawEnvelope: string,
): Promise<Response> {
  const uploadAuthorization = await registerDeviceUpload(device, rawEnvelope);
  return api("/api/v1/contributions", {
    method: "POST",
    headers: {
      authorization: `Upload ${uploadAuthorization}`,
      "content-type": "application/json",
    },
    body: rawEnvelope,
  });
}

async function uploadChunk(
  device: PairedDevice,
  chunk: object,
): Promise<Response> {
  const envelope = await encryptV1(JSON.stringify(chunk));
  return uploadRawEnvelope(device, JSON.stringify(envelope));
}

function usageEvent(
  day: string,
  fill: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: "usage-event-v1.0",
    eventId: `event:v2:${fill.repeat(64)}`,
    eventTime: `${day}T12:05:00.000Z`,
    sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    speedMode: "fast",
    apiServiceTier: "priority",
    surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription",
    reasoningEffort: "xhigh",
    agentScope: "root",
    outcome: "completed",
    totalInputContextTokens: 1000,
    components: {
      inputUncachedTokens: 100,
      inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0,
      outputTextTokens: 50,
      outputReasoningTokens: 25,
      outputCombinedTokens: null,
    },
    ...overrides,
  };
}

const REQUIRED_CONSENT = {
  telemetrySchemaVersion: "telemetry-contribution-v1.0",
  fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
  privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0",
};

async function usageChunk(
  day: string,
  seq: number,
  revision: number,
  records: unknown[],
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return {
    schemaVersion: "telemetry-contribution-v1.0",
    chunkId: `usage:${day}:${seq}`,
    chunkRevision: revision,
    chunkDigest: await sha256Hex(canonicalJson(records)),
    parserVersion: "parser-2.1.0",
    consent: { ...REQUIRED_CONSENT },
    records,
    ...overrides,
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
  keyId = `key:${crypto.randomUUID()}`;
  const publicJwk = await crypto.subtle.exportKey("jwk", pairResult.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pairResult.privateKey);
  publicJwkJson = JSON.stringify({ ...publicJwk, kid: keyId });
  privateJwkJson = JSON.stringify({ ...privateJwk, kid: keyId });
});

beforeEach(async () => {
  await reset();
  const bindings = env as TestBindings;
  await applyD1Migrations(bindings.USAGE_MONITOR_DB, bindings.TEST_MIGRATIONS);
  await applyD1Migrations(
    bindings.DELETION_LEDGER,
    bindings.TEST_DELETION_LEDGER_MIGRATIONS,
  );
});

describe("telemetry-contribution-v1.0 incremental chunks", () => {
  it("accepts a device-authenticated chunk against the consent the pairing claim recorded", async () => {
    const participant = await enrollTelemetry();
    const device = await pairDevice(participant);
    // The consent-once grant is server-recorded by the v1.0 pairing claim,
    // before any upload exists.
    const grantedBeforeUpload = await db().prepare(
      `SELECT COUNT(*) AS total FROM telemetry_v1_device_consents
        WHERE participant_id = ? AND device_id = ?`,
    ).bind(participant.participantId, device.deviceId)
      .first<{ total: number }>();
    expect(grantedBeforeUpload?.total).toBe(1);
    const records = [usageEvent("2026-08-01", "a")];
    const response = await uploadChunk(
      device,
      await usageChunk("2026-08-01", 0, 1, records),
    );
    expect(response.status).toBe(202);
    const receipt = await response.json<Record<string, unknown>>();
    expect(receipt).toMatchObject({
      schemaVersion: "telemetry-chunk-receipt-v1.0",
      chunkId: "usage:2026-08-01:0",
      chunkRevision: 1,
      status: "accepted",
      supersededRevision: null,
      recordCounts: { declared: 1, accepted: 1 },
      acknowledgedThroughDay: "2026-08-01",
      admission: {
        schemaVersion: "telemetry-chunk-admission-v1.0",
        state: "available",
        budget: "launch_week",
        acceptedChunks: 1,
        maximumChunks: 20000,
        remainingChunks: 19999,
      },
    });
    expect(typeof receipt.contributionId).toBe("string");

    const journal = await db().prepare(
      `SELECT stream, chunk_day, chunk_seq, revision, record_count,
              accepted_record_count, superseded_at
         FROM telemetry_v1_chunks WHERE participant_id = ?`,
    ).bind(participant.participantId).all();
    expect(journal.results).toEqual([{
      stream: "usage",
      chunk_day: "2026-08-01",
      chunk_seq: 0,
      revision: 1,
      record_count: 1,
      accepted_record_count: 1,
      superseded_at: null,
    }]);
    const storedRecords = await db().prepare(
      `SELECT occurrence_id, observed_day, session_uuid, input_uncached_tokens
         FROM telemetry_v1_records WHERE participant_id = ?`,
    ).bind(participant.participantId).all();
    expect(storedRecords.results).toEqual([{
      occurrence_id: `event:v2:${"a".repeat(64)}`,
      observed_day: "2026-08-01",
      session_uuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
      input_uncached_tokens: 100,
    }]);
    const consent = await db().prepare(
      `SELECT telemetry_schema_version, field_dictionary_version,
              privacy_contract_version
         FROM telemetry_v1_device_consents
        WHERE participant_id = ? AND device_id = ?`,
    ).bind(participant.participantId, device.deviceId).first();
    expect(consent).toEqual({
      telemetry_schema_version: "telemetry-contribution-v1.0",
      field_dictionary_version: "telemetry-v1.0-registry-2026-08-07.1",
      privacy_contract_version: "ongoing-privacy-safe-telemetry-v1.0",
    });
    // The v0.1 weekly admission window is not consumed by the v1.0 path.
    const v01Windows = await db().prepare(
      "SELECT COUNT(*) AS total FROM telemetry_contribution_admission_windows",
    ).first<{ total: number }>();
    expect(v01Windows?.total).toBe(0);
  });

  it("replays identical envelopes and identical content idempotently", async () => {
    const participant = await enrollTelemetry();
    const device = await pairDevice(participant);
    const records = [usageEvent("2026-08-01", "b")];
    const chunk = await usageChunk("2026-08-01", 0, 1, records);
    const rawEnvelope = JSON.stringify(await encryptV1(JSON.stringify(chunk)));

    const first = await uploadRawEnvelope(device, rawEnvelope);
    expect(first.status).toBe(202);

    // Byte-identical envelope replay dedupes before decryption.
    const envelopeReplay = await uploadRawEnvelope(device, rawEnvelope);
    expect(envelopeReplay.status).toBe(202);
    expect(envelopeReplay.headers.get("idempotency-replayed")).toBe("true");
    await expect(envelopeReplay.json()).resolves.toMatchObject({
      status: "accepted",
      replayed: true,
      chunkId: "usage:2026-08-01:0",
      chunkRevision: 1,
    });

    // A re-encrypted envelope with identical plaintext dedupes on the
    // content digest.
    const contentReplay = await uploadChunk(device, chunk);
    expect(contentReplay.status).toBe(202);
    expect(contentReplay.headers.get("idempotency-replayed")).toBe("true");
    await expect(contentReplay.json()).resolves.toMatchObject({
      replayed: true,
      chunkRevision: 1,
    });

    const journal = await db().prepare(
      "SELECT COUNT(*) AS total FROM telemetry_v1_chunks WHERE participant_id = ?",
    ).bind(participant.participantId).first<{ total: number }>();
    expect(journal?.total).toBe(1);
  });

  it("supersedes a chunk with the next revision and replaces its records", async () => {
    const participant = await enrollTelemetry();
    const device = await pairDevice(participant);
    const initial = [usageEvent("2026-08-01", "c")];
    expect((await uploadChunk(
      device,
      await usageChunk("2026-08-01", 0, 1, initial),
    )).status).toBe(202);

    const rewritten = [usageEvent("2026-08-01", "c", {
      totalInputContextTokens: 2000,
      components: {
        inputUncachedTokens: 200,
        inputCacheReadTokens: 1800,
        inputCacheWriteTokens: 0,
        outputTextTokens: 60,
        outputReasoningTokens: 30,
        outputCombinedTokens: null,
      },
    })];

    // A same-revision re-send with different content is a cursor
    // disagreement, not a supersession.
    const conflicted = await uploadChunk(
      device,
      await usageChunk("2026-08-01", 0, 1, rewritten),
    );
    expect(conflicted.status).toBe(409);
    await expect(conflicted.json()).resolves.toMatchObject({
      error: { code: "CHUNK_REVISION_CONFLICT" },
    });

    const superseding = await uploadChunk(
      device,
      await usageChunk("2026-08-01", 0, 2, rewritten),
    );
    expect(superseding.status).toBe(202);
    await expect(superseding.json()).resolves.toMatchObject({
      status: "accepted",
      chunkRevision: 2,
      supersededRevision: 1,
    });

    const journal = await db().prepare(
      `SELECT revision, superseded_at IS NULL AS current
         FROM telemetry_v1_chunks
        WHERE participant_id = ? ORDER BY revision`,
    ).bind(participant.participantId).all();
    expect(journal.results).toEqual([
      { revision: 1, current: 0 },
      { revision: 2, current: 1 },
    ]);
    // The rewritten row with the same occurrence id won: the current view
    // holds exactly the latest revision's values.
    const storedRecords = await db().prepare(
      `SELECT occurrence_id, input_uncached_tokens
         FROM telemetry_v1_records WHERE participant_id = ?`,
    ).bind(participant.participantId).all();
    expect(storedRecords.results).toEqual([{
      occurrence_id: `event:v2:${"c".repeat(64)}`,
      input_uncached_tokens: 200,
    }]);
  });

  it("fails closed with a typed code when the daily chunk budget is exhausted", async () => {
    const participant = await enrollTelemetry();
    const device = await pairDevice(participant);
    const windowDay = new Date().toISOString().slice(0, 10);
    await db().prepare(
      `INSERT INTO telemetry_v1_chunk_admission_windows (
        participant_id, device_id, window_day, accepted_count, last_accepted_at
      ) VALUES (?, ?, ?, 20000, ?)`,
    ).bind(
      participant.participantId,
      device.deviceId,
      windowDay,
      new Date().toISOString(),
    ).run();

    const refused = await uploadChunk(
      device,
      await usageChunk("2026-08-01", 0, 1, [usageEvent("2026-08-01", "d")]),
    );
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    await expect(refused.json()).resolves.toMatchObject({
      error: {
        code: "CHUNK_ADMISSION_LIMIT_REACHED",
        details: {
          admission: {
            state: "exhausted",
            budget: "launch_week",
            maximumChunks: 20000,
            remainingChunks: 0,
          },
        },
      },
    });
    const journal = await db().prepare(
      "SELECT COUNT(*) AS total FROM telemetry_v1_chunks",
    ).first<{ total: number }>();
    expect(journal?.total).toBe(0);
  });

  it("fails closed on malformed chunks and digest mismatches", async () => {
    const participant = await enrollTelemetry();
    const device = await pairDevice(participant);

    // A record outside the chunk's UTC day partition.
    const strayDay = await usageChunk(
      "2026-08-01",
      0,
      1,
      [usageEvent("2026-08-02", "e")],
    );
    const strayResponse = await uploadChunk(device, strayDay);
    expect(strayResponse.status).toBe(400);
    await expect(strayResponse.json()).resolves.toMatchObject({
      error: { code: "CHUNK_INVALID" },
    });

    // An undeclared field anywhere in the closed schema.
    const extraField = await usageChunk(
      "2026-08-01",
      0,
      1,
      [usageEvent("2026-08-01", "e")],
      { unexpected: true },
    );
    const extraResponse = await uploadChunk(device, extraField);
    expect(extraResponse.status).toBe(400);
    await expect(extraResponse.json()).resolves.toMatchObject({
      error: { code: "CHUNK_INVALID" },
    });

    // A declared digest that does not match the canonical records.
    const mismatched = await usageChunk(
      "2026-08-01",
      0,
      1,
      [usageEvent("2026-08-01", "e")],
      { chunkDigest: "0".repeat(64) },
    );
    const mismatchResponse = await uploadChunk(device, mismatched);
    expect(mismatchResponse.status).toBe(400);
    await expect(mismatchResponse.json()).resolves.toMatchObject({
      error: { code: "CHUNK_DIGEST_MISMATCH" },
    });

    const journal = await db().prepare(
      "SELECT COUNT(*) AS total FROM telemetry_v1_chunks",
    ).first<{ total: number }>();
    expect(journal?.total).toBe(0);
  });

  it("admits unreviewed model and provider identities but still enforces token shape", async () => {
    const participant = await enrollTelemetry();
    const device = await pairDevice(participant);

    // Neither identity is in any server-side registry. A closed enum here was
    // a stale copy of the client's registry that silently withheld real usage,
    // so admission depends on shape alone; pricing decides recognition later.
    const widened = await usageChunk("2026-08-01", 0, 1, [
      usageEvent("2026-08-01", "e", {
        modelId: "nova-9-preview",
        provider: "unknown",
      }),
    ]);
    const accepted = await uploadChunk(device, widened);
    expect(accepted.status).toBe(202);
    const stored = await db().prepare(
      `SELECT provider, model_id FROM telemetry_v1_records
        WHERE stream = 'usage'`,
    ).first<{ provider: string; model_id: string }>();
    expect(stored).toEqual({
      provider: "unknown",
      model_id: "nova-9-preview",
    });

    // Shape is still the wire contract: an over-long identity is refused.
    const malformed = await usageChunk("2026-08-02", 0, 1, [
      usageEvent("2026-08-02", "f", { modelId: "n".repeat(65) }),
    ]);
    const refused = await uploadChunk(device, malformed);
    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toMatchObject({
      error: { code: "CHUNK_INVALID" },
    });
  });

  it("refuses chunks whose declared consent drifts from the server-recorded grant", async () => {
    const participant = await enrollTelemetry();
    const device = await pairDevice(participant);
    const drifted = await usageChunk(
      "2026-08-01",
      0,
      1,
      [usageEvent("2026-08-01", "f")],
      {
        consent: {
          ...REQUIRED_CONSENT,
          privacyContractVersion: "ongoing-privacy-safe-telemetry-v0.1",
        },
      },
    );
    const refused = await uploadChunk(device, drifted);
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({
      error: { code: "TELEMETRY_CONSENT_INVALID" },
    });
    // The pairing-claim grant is untouched by the refused upload; nothing
    // was journaled.
    const consents = await db().prepare(
      `SELECT privacy_contract_version FROM telemetry_v1_device_consents
        WHERE participant_id = ? AND device_id = ?`,
    ).bind(participant.participantId, device.deviceId)
      .first<{ privacy_contract_version: string }>();
    expect(consents?.privacy_contract_version)
      .toBe("ongoing-privacy-safe-telemetry-v1.0");
    const journal = await db().prepare(
      "SELECT COUNT(*) AS total FROM telemetry_v1_chunks",
    ).first<{ total: number }>();
    expect(journal?.total).toBe(0);
  });

  it("refuses chunks from a device without a server-recorded v1.0 consent grant", async () => {
    const participant = await enrollTelemetry();
    // Paired under the deployed v0.1 ongoing consent: no v1.0 grant exists,
    // and a well-formed chunk declaring the required consent must not be
    // able to create one for itself.
    const device = await pairDevice(
      participant,
      "ongoing-privacy-safe-telemetry-v0.1",
    );
    const refused = await uploadChunk(
      device,
      await usageChunk("2026-08-01", 0, 1, [usageEvent("2026-08-01", "f")]),
    );
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({
      error: { code: "TELEMETRY_CONSENT_INVALID" },
    });
    const consents = await db().prepare(
      "SELECT COUNT(*) AS total FROM telemetry_v1_device_consents",
    ).first<{ total: number }>();
    expect(consents?.total).toBe(0);
    const journal = await db().prepare(
      "SELECT COUNT(*) AS total FROM telemetry_v1_chunks",
    ).first<{ total: number }>();
    expect(journal?.total).toBe(0);
  });

  it("publishes a daily aggregate and bumps its revision when late data arrives", async () => {
    const participant = await enrollTelemetry();
    const device = await pairDevice(participant);
    expect((await uploadChunk(
      device,
      await usageChunk("2026-08-01", 0, 1, [usageEvent("2026-08-01", "1")]),
    )).status).toBe(202);

    const first = await rebuildPendingCommunityDailyAggregates(
      db(),
      Date.now(),
    );
    expect(first).toMatchObject({
      processed: 1,
      remaining: false,
      aggregateIds: ["community-daily:2026-08-01:r1"],
    });

    // Late data for the same day arrives afterwards; the day is re-enqueued
    // and recomputes as a new immutable revision — never mutated, never
    // sealed.
    expect((await uploadChunk(
      device,
      await usageChunk("2026-08-01", 1, 1, [usageEvent("2026-08-01", "2")]),
    )).status).toBe(202);
    const second = await rebuildPendingCommunityDailyAggregates(
      db(),
      Date.now(),
    );
    expect(second).toMatchObject({
      processed: 1,
      remaining: false,
      aggregateIds: ["community-daily:2026-08-01:r2"],
    });

    const revisions = await db().prepare(
      `SELECT revision, release_state, payload_json
         FROM community_daily_aggregates
        WHERE day = '2026-08-01' ORDER BY revision`,
    ).all<{ revision: number; release_state: string; payload_json: string }>();
    expect(revisions.results.map((row) => ({
      revision: row.revision,
      release_state: row.release_state,
    }))).toEqual([
      { revision: 1, release_state: "published" },
      { revision: 2, release_state: "published" },
    ]);
    const latest = JSON.parse(revisions.results[1]!.payload_json) as {
      totals: { usageEvents: number; contributingParticipants: number };
    };
    expect(latest.totals.usageEvents).toBe(2);
    expect(latest.totals.contributingParticipants).toBe(1);

    // Published revisions are immutable rows.
    await expect(db().prepare(
      `UPDATE community_daily_aggregates SET payload_json = '{}'
        WHERE day = '2026-08-01' AND revision = 1`,
    ).run()).rejects.toThrow(/immutable/u);
    await expect(db().prepare(
      "DELETE FROM community_daily_aggregates WHERE day = '2026-08-01'",
    ).run()).rejects.toThrow(/immutable/u);
  });

  it("serves the device sync state and manifest for the cursor protocol", async () => {
    const participant = await enrollTelemetry();
    const device = await pairDevice(participant);
    const dayOneRecords = [usageEvent("2026-08-01", "3")];
    const dayTwoRecords = [usageEvent("2026-08-02", "4", {
      eventTime: "2026-08-02T09:00:00.000Z",
    })];
    const dayOneChunk = await usageChunk("2026-08-01", 0, 1, dayOneRecords);
    const dayTwoChunk = await usageChunk("2026-08-02", 0, 1, dayTwoRecords);
    expect((await uploadChunk(device, dayOneChunk)).status).toBe(202);
    expect((await uploadChunk(device, dayTwoChunk)).status).toBe(202);

    const dayOneDigest = await sha256Hex(String(dayOneChunk.chunkDigest));
    const dayTwoDigest = await sha256Hex(String(dayTwoChunk.chunkDigest));
    const state = await api("/api/v1/device/sync/state", {
      headers: { authorization: `Device ${device.authorization}` },
    });
    expect(state.status).toBe(200);
    expect(state.headers.get("cache-control")).toBe("no-store");
    await expect(state.json()).resolves.toMatchObject({
      schemaVersion: "device-sync-state-v1.0",
      contractVersion: "telemetry-contribution-v1.0",
      acknowledgedThroughDay: "2026-08-02",
      historyDigest: await sha256Hex(dayOneDigest + dayTwoDigest),
      dayCount: 2,
      chunkCount: 2,
      admission: { state: "available" },
    });

    const manifest = await api(
      "/api/v1/device/sync/manifest?fromDay=2026-08-01&toDay=2026-08-02",
      { headers: { authorization: `Device ${device.authorization}` } },
    );
    expect(manifest.status).toBe(200);
    await expect(manifest.json()).resolves.toEqual({
      schemaVersion: "device-sync-manifest-v1.0",
      contractVersion: "telemetry-contribution-v1.0",
      fromDay: "2026-08-01",
      toDay: "2026-08-02",
      days: [
        {
          day: "2026-08-01",
          dayDigest: dayOneDigest,
          chunks: [{
            chunkId: "usage:2026-08-01:0",
            revision: 1,
            chunkDigest: dayOneChunk.chunkDigest,
            recordCount: 1,
          }],
        },
        {
          day: "2026-08-02",
          dayDigest: dayTwoDigest,
          chunks: [{
            chunkId: "usage:2026-08-02:0",
            revision: 1,
            chunkDigest: dayTwoChunk.chunkDigest,
            recordCount: 1,
          }],
        },
      ],
    });

    const tooWide = await api(
      "/api/v1/device/sync/manifest?fromDay=2026-01-01&toDay=2026-08-02",
      { headers: { authorization: `Device ${device.authorization}` } },
    );
    expect(tooWide.status).toBe(400);
    await expect(tooWide.json()).resolves.toMatchObject({
      error: { code: "SYNC_RANGE_TOO_LARGE" },
    });

    const missingRange = await api("/api/v1/device/sync/manifest", {
      headers: { authorization: `Device ${device.authorization}` },
    });
    expect(missingRange.status).toBe(400);

    const unauthenticated = await api("/api/v1/device/sync/state");
    expect(unauthenticated.status).toBe(401);
  });

  it("withdraws daily aggregates on participant deletion and a racing rebuild cannot re-publish the deleted data", async () => {
    const deleted = await enrollTelemetry();
    const surviving = await enrollTelemetry();
    const deletedDevice = await pairDevice(deleted);
    const survivingDevice = await pairDevice(surviving);
    expect((await uploadChunk(
      deletedDevice,
      await usageChunk("2026-08-01", 0, 1, [usageEvent("2026-08-01", "a")]),
    )).status).toBe(202);
    expect((await uploadChunk(
      survivingDevice,
      await usageChunk("2026-08-01", 0, 1, [usageEvent("2026-08-01", "b")]),
    )).status).toBe(202);

    const first = await rebuildPendingCommunityDailyAggregates(
      db(),
      Date.now(),
    );
    expect(first.aggregateIds).toEqual(["community-daily:2026-08-01:r1"]);
    const published = await db().prepare(
      `SELECT payload_json FROM community_daily_aggregates
        WHERE day = '2026-08-01' AND revision = 1`,
    ).first<{ payload_json: string }>();
    expect(JSON.parse(published!.payload_json).totals).toMatchObject({
      contributingParticipants: 2,
      usageEvents: 2,
    });

    // Deletion begins: the participant is 'deleting' but its records are
    // still present — exactly the window an aggregate rebuild can race.
    await db().prepare(
      "UPDATE participants SET state = 'deleting' WHERE id = ?",
    ).bind(deleted.participantId).run();

    // The withdrawal trigger retired every published revision immediately.
    const withdrawn = await db().prepare(
      `SELECT release_state, withdrawn_at IS NOT NULL AS stamped
         FROM community_daily_aggregates
        WHERE day = '2026-08-01' AND revision = 1`,
    ).first<{ release_state: string; stamped: number }>();
    expect(withdrawn).toEqual({ release_state: "withdrawn", stamped: 1 });

    // The racing rebuild publishes the day again — without any data from
    // the deleting participant, whose records are still in the table.
    const racing = await rebuildPendingCommunityDailyAggregates(
      db(),
      Date.now(),
    );
    expect(racing.aggregateIds).toEqual(["community-daily:2026-08-01:r2"]);
    const rebuilt = await db().prepare(
      `SELECT release_state, payload_json FROM community_daily_aggregates
        WHERE day = '2026-08-01' AND revision = 2`,
    ).first<{ release_state: string; payload_json: string }>();
    expect(rebuilt?.release_state).toBe("published");
    expect(JSON.parse(rebuilt!.payload_json).totals).toMatchObject({
      contributingParticipants: 1,
      usageEvents: 1,
    });

    // No published revision anywhere carries the deleted participant's data.
    const revisions = await db().prepare(
      `SELECT revision, release_state, payload_json
         FROM community_daily_aggregates ORDER BY revision`,
    ).all<{ revision: number; release_state: string; payload_json: string }>();
    for (const row of revisions.results) {
      if (row.release_state !== "published") continue;
      expect(
        JSON.parse(row.payload_json).totals.contributingParticipants,
      ).toBe(1);
    }
  });

  it("treats an equal digest at a different chunk identity as a new chunk, not a replay", async () => {
    const participant = await enrollTelemetry();
    const deviceA = await pairDevice(participant);
    const deviceB = await pairDevice(participant);
    const records = [usageEvent("2026-08-01", "a")];
    const chunk = await usageChunk("2026-08-01", 0, 1, records);
    expect((await uploadChunk(deviceA, chunk)).status).toBe(202);

    // Device B produces byte-identical chunk content for the same day and
    // seq. Its identity differs, so this must journal as its own chunk —
    // answering it as a "replay" of device A's chunk would wedge B's cursor.
    const accepted = await uploadChunk(deviceB, chunk);
    expect(accepted.status).toBe(202);
    const receipt = await accepted.json<Record<string, unknown>>();
    expect(receipt.status).toBe("accepted");
    expect(receipt.replayed).toBeUndefined();

    const journal = await db().prepare(
      `SELECT COUNT(*) AS total FROM telemetry_v1_chunks
        WHERE participant_id = ? AND superseded_at IS NULL`,
    ).bind(participant.participantId).first<{ total: number }>();
    expect(journal?.total).toBe(2);
  });

  it("refuses to steal a record owned by another current chunk", async () => {
    const participant = await enrollTelemetry();
    const device = await pairDevice(participant);
    const record = usageEvent("2026-08-01", "a");
    expect((await uploadChunk(
      device,
      await usageChunk("2026-08-01", 0, 1, [record]),
    )).status).toBe(202);

    // A different chunk claiming the same occurrence must be refused with a
    // typed conflict — silently reassigning it would falsify the origin
    // chunk's digest without enqueuing any rebuild.
    const stealing = await uploadChunk(
      device,
      await usageChunk("2026-08-01", 1, 1, [record]),
    );
    expect(stealing.status).toBe(409);
    await expect(stealing.json()).resolves.toMatchObject({
      error: { code: "RECORD_OWNED_BY_OTHER_CHUNK" },
    });
    const journal = await db().prepare(
      "SELECT COUNT(*) AS total FROM telemetry_v1_chunks",
    ).first<{ total: number }>();
    expect(journal?.total).toBe(1);
  });

  it("enforces the steady-state budget through the journal triggers after the launch week", async () => {
    const participant = await enrollTelemetry();
    const device = await pairDevice(participant);
    await db().prepare(
      "UPDATE device_credentials SET issued_at = ? WHERE id = ?",
    ).bind(
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      device.deviceId,
    ).run();

    // The journal trigger, not a pre-seeded counter, does the counting.
    const first = await uploadChunk(
      device,
      await usageChunk("2026-08-01", 0, 1, [usageEvent("2026-08-01", "a")]),
    );
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({
      admission: {
        budget: "steady_state",
        maximumChunks: 2000,
        acceptedChunks: 1,
        remainingChunks: 1999,
      },
    });
    const windowDay = new Date().toISOString().slice(0, 10);
    const counted = await db().prepare(
      `SELECT accepted_count FROM telemetry_v1_chunk_admission_windows
        WHERE participant_id = ? AND device_id = ? AND window_day = ?`,
    ).bind(participant.participantId, device.deviceId, windowDay)
      .first<{ accepted_count: number }>();
    expect(counted?.accepted_count).toBe(1);

    // Fast-forward the window to one below the steady-state ceiling; the
    // next accepted chunk is the 2,000th and exhausts the day.
    await db().prepare(
      `UPDATE telemetry_v1_chunk_admission_windows
          SET accepted_count = 1999
        WHERE participant_id = ? AND device_id = ? AND window_day = ?`,
    ).bind(participant.participantId, device.deviceId, windowDay).run();
    const boundary = await uploadChunk(
      device,
      await usageChunk("2026-08-01", 1, 1, [usageEvent("2026-08-01", "b")]),
    );
    expect(boundary.status).toBe(202);
    await expect(boundary.json()).resolves.toMatchObject({
      admission: {
        budget: "steady_state",
        acceptedChunks: 2000,
        remainingChunks: 0,
      },
    });

    const refused = await uploadChunk(
      device,
      await usageChunk("2026-08-01", 2, 1, [usageEvent("2026-08-01", "c")]),
    );
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toMatchObject({
      error: {
        code: "CHUNK_ADMISSION_LIMIT_REACHED",
        details: { admission: { budget: "steady_state", maximumChunks: 2000 } },
      },
    });
  });

  it("purges v1 chunk quarantine objects on participant deletion", async () => {
    const participant = await enrollTelemetry();
    const device = await pairDevice(participant);
    expect((await uploadChunk(
      device,
      await usageChunk("2026-08-01", 0, 1, [usageEvent("2026-08-01", "a")]),
    )).status).toBe(202);
    const chunkRow = await db().prepare(
      "SELECT r2_key FROM telemetry_v1_chunks WHERE participant_id = ?",
    ).bind(participant.participantId).first<{ r2_key: string }>();
    expect(chunkRow?.r2_key).toMatch(/^telemetry\/v1-/u);
    const quarantine = testBindings().QUARANTINE;
    expect(await quarantine.head(chunkRow!.r2_key)).not.toBeNull();

    const deletion = await ownerErase(testBindings(), participant.participantId);
    expect(deletion.status).toBe(200);
    await expect(deletion.json()).resolves.toMatchObject({
      result: { deleted: true, contributionsDeleted: 1 },
    });

    expect(await quarantine.head(chunkRow!.r2_key)).toBeNull();
    const journal = await db().prepare(
      "SELECT COUNT(*) AS total FROM telemetry_v1_chunks",
    ).first<{ total: number }>();
    expect(journal?.total).toBe(0);
    const records = await db().prepare(
      "SELECT COUNT(*) AS total FROM telemetry_v1_records",
    ).first<{ total: number }>();
    expect(records?.total).toBe(0);
  });
});
