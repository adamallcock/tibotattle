import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error The browser helper is intentionally framework-free JavaScript.
import { createSyntheticEnvelope } from "../../web/public/lib.js";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { hashInviteGrantSecret } from "../src/admission";
import worker, { handleRequest, runScheduledMaintenance } from "../src/index";
import {
  createSessionMaterial,
  sessionCookie,
  sessionInsert,
} from "../src/session";
import { syntheticFixture } from "../src/validation";
import {
  buildCommunityWeeklySnapshot,
  communityWeekForScheduledTime,
  rebuildPendingCommunityWeeklySnapshots,
} from "../src/community-snapshots";
import {
  deleteDueQuarantineObjects,
  hasDeletionTombstone,
  hasIdentityReenrollmentCooldown,
  hasIdentityReenrollmentCooldownDigest,
  identityReenrollmentCooldownDigest,
  participantDeletionDigest,
  purgeExpiredDeletionTombstones,
  purgeExpiredIdentityReenrollmentCooldowns,
  purgeExpiredPrimaryIdentityReenrollmentCooldowns,
  recordDeletionTombstone,
  recordPrimaryIdentityReenrollmentCooldown,
  runBackendLifecycle,
} from "../src/retention";
import {
  telemetryContributionAdmission,
  telemetryContributionAdmissionWindow,
} from "../src/telemetry-repository";
import { warmAdminMetricsHistoryCache } from "../src/admin-metrics-history";
import {
  warmAdminCommunityAllowancePreviewCache,
} from "../src/admin-community-allowance";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

// Production deliberately permits deployment without an owner allowlist. The
// Worker treats this binding as optional and keeps every admin endpoint at
// ADMIN_NOT_CONFIGURED until the owner supplies their pairwise identity key.
interface OptionalAdminBinding {
  ADMIN_IDENTITY_LINK_KEY?: string;
}

interface OptionalDeploymentIdentityBinding {
  DEPLOYMENT_SOURCE_COMMIT?: string;
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

function testBindings(
  overrides: Partial<
    Env & OptionalAdminBinding & OptionalDeploymentIdentityBinding
  > = {},
): Env {
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

function d1PrepareProxy(
  base: D1Database,
  prepare: (query: string) => D1PreparedStatement,
): D1Database {
  return new Proxy(base, {
    get(target, property) {
      if (property === "prepare") return prepare;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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
  return encryptRaw(JSON.stringify(value), telemetry);
}

async function encryptRaw(
  plaintext: string,
  telemetry = false,
): Promise<object> {
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
    new TextEncoder().encode(plaintext),
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
  runtimeEnv = testBindings(),
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
  }, runtimeEnv);
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
  }, runtimeEnv);
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
  runtimeEnv = testBindings(),
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
  }, runtimeEnv);
  expect(response.status).toBe(201);
  return response.json<{ uploadAuthorization: string; expiresAt: string }>();
}

const pairedDevices = new Map<string, PairedDevice>();

async function registerUpload(
  participant: EnrollmentResponse,
  rawEnvelope: string,
  runtimeEnv = testBindings(),
): Promise<{ uploadAuthorization: string; expiresAt: string }> {
  let device = pairedDevices.get(participant.participantId);
  if (device === undefined) {
    device = await pairDevice(participant, runtimeEnv);
    pairedDevices.set(participant.participantId, device);
  }
  return registerDeviceUpload(device, rawEnvelope, runtimeEnv);
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
    schemaVersion: "community-weekly-snapshot-v0.2",
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

/**
 * A minimally valid *published* snapshot (empty cells) with revision 1.
 * Cheap alternative to sealing a real 20-participant cohort when a test only
 * needs `readParticipantCommunityComparison` to see a published snapshot, not
 * to exercise cohort aggregation itself — that function resolves the caller's
 * own plan cohort before it ever looks at `cells`.
 */
async function seedPublishedSnapshotWithNoCells(): Promise<void> {
  const payload = JSON.stringify({
    schemaVersion: "community-weekly-snapshot-v0.3",
    snapshotId: "community-weekly:2026-07-20",
    snapshotRevision: 1,
    releaseStatus: "published",
    immutable: true,
    nonOverlapping: true,
    cells: [],
  });
  await testBindings().USAGE_MONITOR_DB.prepare(
    `INSERT INTO community_weekly_snapshots (
      snapshot_id, week_start, week_end, ingestion_cutoff_at, released_at,
      policy_version, payload_json, payload_sha256, release_state, sealed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)`,
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
  pairedDevices.clear();
  await reset();
  const bindings = env as TestBindings;
  await applyD1Migrations(bindings.USAGE_MONITOR_DB, bindings.TEST_MIGRATIONS);
  await applyD1Migrations(
    bindings.DELETION_LEDGER,
    bindings.TEST_DELETION_LEDGER_MIGRATIONS,
  );
});

describe("synthetic usage monitor service", () => {
  it("atomically enrolls an invited participant with a claimable device bootstrap", async () => {
    const inviteCode = await issueTestGrant();
    const response = await api("/api/v1/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        consentVersion: "privacy-safe-telemetry-v0.1",
        syntheticOnly: false,
        inviteCode,
        deviceBootstrap: {
          ongoingUpload: true,
          consentVersion: "ongoing-privacy-safe-telemetry-v0.1",
        },
      }),
    }, inviteOnlyBindings());
    expect(response.status).toBe(201);
    const payload = await response.clone().json<{
      participantId: string;
      csrfToken: string;
      recoveryCode: string;
      session: { issuedAt: string; expiresAt: string };
      pairing: {
        pairingCode: string;
        issuedAt: string;
        expiresAt: string;
      };
    }>();
    expect(payload).toMatchObject({
      schemaVersion: "participant-bootstrap-v0.1",
      state: "pairing_ready",
      invitation: {
        state: "redeemed",
        redeemedAt: expect.any(String),
        expiresAt: expect.any(String),
      },
      session: {
        state: "active",
        issuedAt: expect.any(String),
        expiresAt: expect.any(String),
      },
      recovery: {
        state: "issued",
        issuedAt: expect.any(String),
        expiresAt: null,
        requiresAcknowledgement: true,
      },
      pairing: {
        state: "claimable",
        scope: "upload_registration",
        oneUse: true,
        pairingCode: expect.stringMatching(/^um_pair_/u),
        issuedAt: expect.any(String),
        expiresAt: expect.any(String),
      },
    });
    expect(Date.parse(payload.session.expiresAt) - Date.parse(payload.session.issuedAt))
      .toBe(30 * 60_000);
    expect(Date.parse(payload.pairing.expiresAt) - Date.parse(payload.pairing.issuedAt))
      .toBe(10 * 60_000);

    const state = await testBindings().USAGE_MONITOR_DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM participants WHERE id = ?) AS participants,
        (SELECT COUNT(*) FROM web_sessions WHERE participant_id = ?) AS sessions,
        (SELECT COUNT(*) FROM device_pairings WHERE participant_id = ?) AS pairings,
        (SELECT COUNT(*) FROM enrollment_grants
          WHERE redeemed_participant_id = ? AND state = 'redeemed') AS grants`,
    ).bind(
      payload.participantId,
      payload.participantId,
      payload.participantId,
      payload.participantId,
    ).first<{
      participants: number;
      sessions: number;
      pairings: number;
      grants: number;
    }>();
    expect(state).toEqual({
      participants: 1,
      sessions: 1,
      pairings: 1,
      grants: 1,
    });

    const deviceId = crypto.randomUUID();
    const rawSecret = crypto.getRandomValues(new Uint8Array(32));
    const secretHash = await deviceSecretHash(deviceId, rawSecret);
    rawSecret.fill(0);
    const claimed = await api("/api/v1/device-pairings/claim", {
      method: "POST",
      headers: {
        authorization: `Pairing ${payload.pairing.pairingCode}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId, deviceSecretHash: secretHash }),
    });
    expect(claimed.status).toBe(201);
    await expect(claimed.json()).resolves.toMatchObject({
      deviceId,
      state: "active",
      scope: "upload_registration",
      expiresAt: expect.any(String),
    });
  });

  it("fails device bootstrap closed before redeeming an invite", async () => {
    await setCollectionControls({ uploadRegistration: false });
    const inviteCode = await issueTestGrant();
    const inviteId = /^um_invite_([^.]+)\./u.exec(inviteCode)?.[1];
    expect(inviteId).toBeTruthy();
    const response = await api("/api/v1/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        consentVersion: "privacy-safe-telemetry-v0.1",
        syntheticOnly: false,
        inviteCode,
        deviceBootstrap: {
          ongoingUpload: true,
          consentVersion: "ongoing-privacy-safe-telemetry-v0.1",
        },
      }),
    }, inviteOnlyBindings());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UPLOAD_REGISTRATION_DISABLED" },
    });
    const grant = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT state, redeemed_participant_id FROM enrollment_grants WHERE id = ?",
    ).bind(inviteId).first<{
      state: string;
      redeemed_participant_id: string | null;
    }>();
    expect(grant).toEqual({ state: "issued", redeemed_participant_id: null });
    const participantCount = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM participants",
    ).first<{ total: number }>();
    expect(participantCount?.total).toBe(0);
  });

  it("rejects malformed or synthetic device bootstrap without side effects", async () => {
    for (const body of [
      {
        consentVersion: "synthetic-preview-v0.1",
        syntheticOnly: true,
        deviceBootstrap: {
          ongoingUpload: true,
          consentVersion: "ongoing-privacy-safe-telemetry-v0.1",
        },
      },
      {
        consentVersion: "privacy-safe-telemetry-v0.1",
        syntheticOnly: false,
        deviceBootstrap: null,
      },
      {
        consentVersion: "privacy-safe-telemetry-v0.1",
        syntheticOnly: false,
        deviceBootstrap: {
          ongoingUpload: true,
          consentVersion: "ongoing-privacy-safe-telemetry-v0.2",
        },
      },
      {
        consentVersion: "privacy-safe-telemetry-v0.1",
        syntheticOnly: false,
        deviceBootstrap: {
          ongoingUpload: true,
          consentVersion: "ongoing-privacy-safe-telemetry-v0.1",
          unexpected: true,
        },
      },
    ]) {
      const response = await api("/api/v1/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "BODY_INVALID" },
      });
    }
    const state = await testBindings().USAGE_MONITOR_DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM participants) AS participants,
        (SELECT COUNT(*) FROM web_sessions) AS sessions,
        (SELECT COUNT(*) FROM device_pairings) AS pairings`,
    ).first<{ participants: number; sessions: number; pairings: number }>();
    expect(state).toEqual({ participants: 0, sessions: 0, pairings: 0 });
  });

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

  it("requires same-origin enrollment and keeps retired session upload minting absent", async () => {
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
      expect(rejected.status).toBe(404);
      await expect(rejected.json()).resolves.toMatchObject({
        error: { code: "NOT_FOUND" },
      });
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
    expect(uploadReadsPersonal.status).toBe(405);

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
      "um_device_upload_",
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
      .match(/^um_device_upload_([^.]+)\./u)?.[1];
    await testBindings().USAGE_MONITOR_DB.prepare(
      "UPDATE device_upload_authorizations SET expires_at = ? WHERE id = ?",
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
      "SELECT state, consumed_contribution_id FROM device_upload_authorizations WHERE id = ?",
    ).bind(authorization.uploadAuthorization.match(/^um_device_upload_([^.]+)\./u)?.[1])
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
      .match(/^um_device_upload_([^.]+)\./u)?.[1];
    const inFlight = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT state FROM device_upload_authorizations WHERE id = ?",
    ).bind(authorizationId).first<{ state: string }>();
    expect(inFlight?.state).toBe("consuming");

    const reset = await api("/api/v1/me/security-reset", {
      method: "POST",
      headers: personalHeaders(participant, { csrf: true }),
    });
    expect(reset.status).toBe(200);
    const stillConsuming = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT state FROM device_upload_authorizations WHERE id = ?",
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
              t.device_upload_authorization_id
         FROM device_upload_authorizations u
         JOIN telemetry_contributions t
           ON t.device_upload_authorization_id = u.id
        WHERE u.id = ?`,
    ).bind(authorizationId).first<{
      state: string;
      consumed_contribution_id: string;
      device_upload_authorization_id: string;
    }>();
    expect(audited).toEqual({
      state: "consumed",
      consumed_contribution_id: receipt.contributionId,
      device_upload_authorization_id: authorizationId,
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
      .match(/^um_device_upload_([^.]+)\./u)?.[1];
    await testBindings().USAGE_MONITOR_DB.prepare(
      `UPDATE device_upload_authorizations
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
      "SELECT state, consumed_contribution_id FROM device_upload_authorizations WHERE id = ?",
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

  it("security reset revokes device authority while logout revokes the session", async () => {
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
    const retiredRecovery = await api("/api/v1/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recoveryCode: participant.recoveryCode }),
    });
    expect(retiredRecovery.status).toBe(404);

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
      {
        env: testBindings({
          CLIENT_ATTEMPT_RATE_LIMIT: undefined,
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

  const GOOGLE_CLIENT = "test-google-client.apps.googleusercontent.com";
  const APPLE_CLIENT = "com.usagemonitor.local";

  function identityBindings(overrides: Partial<Env> = {}): Env {
    return testBindings({
      GOOGLE_OIDC_CLIENT_ID: GOOGLE_CLIENT,
      APPLE_SERVICES_ID: APPLE_CLIENT,
      IDENTITY_LINK_SECRET: "identity-link-secret-for-tests-0123456789abcdef",
      IDENTITY_LINK_SECRET_VERSION: "test-v1",
      ...overrides,
    } as unknown as Partial<Env>);
  }

  function configuredIdentityLinkSecret(runtimeEnv: Env): string {
    const secret = runtimeEnv.IDENTITY_LINK_SECRET;
    if (typeof secret !== "string") throw new Error("identity test secret missing");
    return secret;
  }

  // The initiating client holds this verifier; the delivered handoff carries
  // SHA-256(verifier) as its binding, and enrollment must re-present the raw
  // verifier to consume the proof.
  const HOSTED_IDENTITY_TEST_VERIFIER = "z".repeat(64);

  async function deliveredHostedProof(
    runtimeEnv: Env,
    provider: "apple" | "google",
    linkKeyHex: string,
  ): Promise<string> {
    const state = encodeBase64Url(crypto.getRandomValues(new Uint8Array(48)));
    const proof = encodeBase64Url(crypto.getRandomValues(new Uint8Array(48)));
    const bindingHash = await sha256Hex(HOSTED_IDENTITY_TEST_VERIFIER);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1_000).toISOString();
    if (provider === "apple") {
      await runtimeEnv.USAGE_MONITOR_DB.prepare(
        `INSERT INTO apple_signin_handoffs
           (state, nonce_hash, binding_hash, identity_link_key, proof, created_at, expires_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        state,
        "a".repeat(64),
        bindingHash,
        linkKeyHex,
        proof,
        now.toISOString(),
        expiresAt,
        now.toISOString(),
      ).run();
    } else {
      await runtimeEnv.USAGE_MONITOR_DB.prepare(
        `INSERT INTO google_signin_handoffs
           (state, code_verifier, binding_hash, identity_link_key, proof, created_at, expires_at, delivered_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        state,
        bindingHash,
        linkKeyHex,
        proof,
        now.toISOString(),
        expiresAt,
        now.toISOString(),
      ).run();
    }
    return proof;
  }

  async function identityEnroll(
    linkKeyHex: string,
    provider = "google",
    runtimeEnv: Env | null = null,
  ): Promise<Response> {
    const effectiveEnv = runtimeEnv ?? identityBindings();
    return api("/api/v1/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        consentVersion: "privacy-safe-telemetry-v0.1",
        syntheticOnly: false,
        identity: {
          provider,
          proof: await deliveredHostedProof(
            effectiveEnv,
            provider as "apple" | "google",
            linkKeyHex,
          ),
          verifier: HOSTED_IDENTITY_TEST_VERIFIER,
        },
      }),
    }, effectiveEnv);
  }

  async function enrollMatureOpenCohortParticipant(
    index: number,
    runtimeEnv: Env,
  ): Promise<EnrollmentResponse> {
    const response = await identityEnroll(
      await sha256Hex(`open-community-cohort-${index}`),
      "google",
      runtimeEnv,
    );
    expect(response.status).toBe(201);
    const participant = await enrollmentFrom(response);
    await runtimeEnv.USAGE_MONITOR_DB.prepare(
      "UPDATE participants SET created_at = ? WHERE id = ?",
    ).bind("2026-07-01T00:00:00.000Z", participant.participantId).run();
    return participant;
  }

  async function uploadTelemetryAt(
    participant: EnrollmentResponse,
    telemetry: Record<string, unknown>,
    createdAt: string,
  ): Promise<{ contributionId: string }> {
    Reflect.set(telemetry, "createdAt", createdAt);
    const response = await uploadEnvelope(participant, await encrypt(telemetry, true));
    expect(response.status).toBe(202);
    const receipt = await response.json<{ contributionId: string }>();
    await testBindings().USAGE_MONITOR_DB.prepare(
      "UPDATE telemetry_contributions SET created_at = ? WHERE id = ?",
    ).bind(createdAt, receipt.contributionId).run();
    return receipt;
  }

  it("enrolls open-mode production participants with grant-backed eligibility", async () => {
    const env = identityBindings({
      ENVIRONMENT: "production" as Env["ENVIRONMENT"],
      ENROLLMENT_MODE: "open" as Env["ENROLLMENT_MODE"],
    });
    const response = await api("/api/v1/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        consentVersion: "privacy-safe-telemetry-v0.1",
        syntheticOnly: false,
        identity: {
          provider: "google",
          proof: await deliveredHostedProof(
            env,
            "google",
            await sha256Hex("test-open-mode-primary"),
          ),
          verifier: HOSTED_IDENTITY_TEST_VERIFIER,
        },
      }),
    }, env);
    expect(response.status).toBe(201);
    const payload = await response.clone().json<{ participantId: string }>();
    const eligibility = await env.USAGE_MONITOR_DB.prepare(
      `SELECT e.participant_id AS participantId, e.grant_id AS grantId,
              g.state AS state
         FROM participant_community_eligibility e
         JOIN enrollment_grants g ON g.id = e.grant_id
        WHERE e.participant_id = ?`,
    ).bind(payload.participantId).first<{
      participantId: string;
      grantId: string;
      state: string;
    }>();
    expect(eligibility?.participantId).toBe(payload.participantId);
    expect(eligibility?.grantId.startsWith("open:")).toBe(true);
    expect(eligibility?.state).toBe("redeemed");

    const synthetic = await api("/api/v1/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        consentVersion: "synthetic-preview-v0.1",
        syntheticOnly: true,
        identity: {
          provider: "google",
          proof: await deliveredHostedProof(
            env,
            "google",
            await sha256Hex("test-open-mode-synthetic"),
          ),
          verifier: HOSTED_IDENTITY_TEST_VERIFIER,
        },
      }),
    }, env);
    expect(synthetic.status).toBe(201);
    const syntheticPayload = await synthetic.clone().json<{
      participantId: string;
    }>();
    const syntheticEligibility = await env.USAGE_MONITOR_DB.prepare(
      `SELECT COUNT(*) AS total FROM participant_community_eligibility
        WHERE participant_id = ?`,
    ).bind(syntheticPayload.participantId).first<{ total: number }>();
    expect(syntheticEligibility?.total).toBe(0);

    const inviteKeyRejection = await api("/api/v1/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        consentVersion: "privacy-safe-telemetry-v0.1",
        syntheticOnly: false,
        inviteCode: "invite:unused",
      }),
    }, env);
    expect(inviteKeyRejection.status).toBe(400);
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

  it("separates coarse and per-client enrollment, sign-in, and device limits without identifiers", async () => {
    const limiterKeys: string[] = [];
    const allowedLimiter = {
      async limit(input: { key: string }): Promise<{ success: boolean }> {
        limiterKeys.push(input.key);
        return { success: true };
      },
    } satisfies RateLimit;
    const clientBlockedLimiter = {
      async limit(input: { key: string }): Promise<{ success: boolean }> {
        limiterKeys.push(input.key);
        return { success: false };
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
        ENROLLMENT_RATE_LIMIT: allowedLimiter,
        RECOVERY_RATE_LIMIT: allowedLimiter,
        CLIENT_ATTEMPT_RATE_LIMIT: clientBlockedLimiter,
        IDENTITY_LINK_SECRET: "rate-limit-secret-for-tests-0123456789abcdef",
      }));
      expect(enrollment.status).toBe(429);

      const signInStart = await api("/api/v1/identity/google/start", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.9",
          "content-type": "application/json",
        },
        body: "{}",
      }, identityBindings({
        ENROLLMENT_RATE_LIMIT: allowedLimiter,
        CLIENT_ATTEMPT_RATE_LIMIT: allowedLimiter,
      }));
      expect(signInStart.status).toBe(503);
      const deviceDisconnect = await api("/api/v1/device/disconnect", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.9",
          authorization: "Device um_device_00000000-0000-4000-8000-000000000000.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      }, testBindings({
        RECOVERY_RATE_LIMIT: allowedLimiter,
        CLIENT_ATTEMPT_RATE_LIMIT: clientBlockedLimiter,
        IDENTITY_LINK_SECRET: "rate-limit-secret-for-tests-0123456789abcdef",
      }));
      expect(deviceDisconnect.status).toBe(429);
      const malformedPath = await api(
        "/api/v1/contributions/PRIVATE_PATH_CANARY",
        { headers: { authorization: "Bearer PRIVATE_CAPABILITY_CANARY" } },
      );
      expect(malformedPath.status).toBe(404);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.join("\n")).not.toContain("PRIVATE_IP_CANARY");
    expect(limiterKeys).toContain(
      "usage-monitor:enrollment:global",
    );
    expect(limiterKeys).toContain("usage-monitor:sign_in_start:global");
    expect(limiterKeys).toContain("usage-monitor:device_disconnect:global");
    const clientKeys = limiterKeys.filter((key) => key.includes(":client:"));
    expect(clientKeys).toHaveLength(3);
    for (const key of clientKeys) {
      expect(key).toMatch(/:client:[0-9a-f]{64}$/u);
      expect(key).not.toContain("PRIVATE_IP_CANARY");
      expect(key).not.toContain("203.0.113.9");
    }
    expect(new Set(clientKeys).size).toBe(3);
    expect(warnings.join("\n")).not.toContain("PRIVATE_PATH_CANARY");
    expect(warnings.join("\n")).not.toContain("PRIVATE_CAPABILITY_CANARY");
    const attemptsTable = await testBindings().USAGE_MONITOR_DB.prepare(
      `SELECT COUNT(*) AS total FROM sqlite_master
        WHERE type = 'table' AND name LIKE '%attempt%'`,
    ).first<{ total: number }>();
    expect(attemptsTable?.total).toBe(0);
  });

  it("limits device upload authorization before parsing the body and never places a participant identifier in the rate key", async () => {
    const participant = await enrollTelemetry();
    const device = await pairDevice(participant);
    const limiterKeys: string[] = [];
    const allowedLimiter = {
      async limit(input: { key: string }): Promise<{ success: boolean }> {
        limiterKeys.push(input.key);
        return { success: true };
      },
    } satisfies RateLimit;
    const blockedPrincipalLimiter = {
      async limit(input: { key: string }): Promise<{ success: boolean }> {
        limiterKeys.push(input.key);
        return { success: false };
      },
    } satisfies RateLimit;

    const response = await api("/api/v1/device/upload-authorizations", {
      method: "POST",
      headers: {
        authorization: `Device ${device.authorization}`,
        "content-type": "application/json",
      },
      // A limiter rejection must win over this malformed request body.
      body: "{",
    }, testBindings({
      UPLOAD_AUTHORIZATION_RATE_LIMIT: allowedLimiter,
      UPLOAD_PRINCIPAL_RATE_LIMIT: blockedPrincipalLimiter,
      IDENTITY_LINK_SECRET: "rate-limit-secret-for-tests-0123456789abcdef",
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UPLOAD_ADMISSION_LIMIT_REACHED" },
    });
    expect(limiterKeys).toEqual([
      "usage-monitor:upload_authorization:global",
      expect.stringMatching(
        /^usage-monitor:upload_authorization:participant:[0-9a-f]{64}$/u,
      ),
    ]);
    expect(limiterKeys.join("\n")).not.toContain(participant.cookie);
    expect(limiterKeys.join("\n")).not.toContain(participant.participantId);
  });

  it("returns the shared-ingress retry deadline without consuming a token that could not enter", async () => {
    const participant = await enrollTelemetry();
    const rawEnvelope = JSON.stringify(await encrypt(telemetryFixture("f"), true));
    const authorization = await registerUpload(participant, rawEnvelope);
    const blockedBudget = {
      getByName() {
        return {
          async acquire() {
            return {
              allowed: false,
              leaseId: null,
              retryAfterSeconds: 23,
            };
          },
          async release() {},
        };
      },
    } as unknown as Env["UPLOAD_INGRESS_BUDGET"];

    const rejected = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${authorization.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: rawEnvelope,
    }, testBindings({ UPLOAD_INGRESS_BUDGET: blockedBudget }));
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("23");
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: "UPLOAD_INGRESS_LIMIT_REACHED" },
    });

    const replay = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${authorization.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: rawEnvelope,
    });
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({ status: "accepted" });
  });

  it("sheds a valid-looking public upload before its body is consumed or token claimed", async () => {
    const participant = await enrollTelemetry();
    const rawEnvelope = JSON.stringify(await encrypt(telemetryFixture("e"), true));
    const authorization = await registerUpload(participant, rawEnvelope);
    const allowedLimiter = {
      async limit(): Promise<{ success: boolean }> { return { success: true }; },
    } satisfies RateLimit;
    const blockedLimiter = {
      async limit(): Promise<{ success: boolean }> { return { success: false }; },
    } satisfies RateLimit;
    const rawRequest = new Request("https://example.test/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${authorization.uploadAuthorization}`,
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.7",
      },
      body: rawEnvelope,
    });
    let bodyReaderRequested = false;
    const request = new Proxy(rawRequest, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== "body" || value === null) {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return new Proxy(value as ReadableStream<Uint8Array>, {
          get(stream, streamProperty) {
            const streamValue = Reflect.get(stream, streamProperty, stream);
            if (streamProperty === "getReader") {
              return (...args: unknown[]) => {
                bodyReaderRequested = true;
                return Reflect.apply(
                  streamValue as (...inner: unknown[]) => unknown,
                  stream,
                  args,
                );
              };
            }
            return typeof streamValue === "function"
              ? streamValue.bind(stream) : streamValue;
          },
        });
      },
    }) as Request;
    const rejected = await handleRequest(request, testBindings({
      UPLOAD_INGRESS_REQUEST_RATE_LIMIT: allowedLimiter,
      UPLOAD_INGRESS_CLIENT_RATE_LIMIT: blockedLimiter,
      IDENTITY_LINK_SECRET: "rate-limit-secret-for-tests-0123456789abcdef",
    }));
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("60");
    expect(bodyReaderRequested).toBe(false);

    const retry = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${authorization.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: rawEnvelope,
    });
    expect(retry.status).toBe(202);
  });

  it("does not issue upload tokens or report traffic ready when ingress is misconfigured", async () => {
    const participant = await enrollTelemetry();
    const device = await pairDevice(participant);
    const broken = testBindings({
      UPLOAD_INGRESS_QUEUE_MODE: "queues" as unknown as Env["UPLOAD_INGRESS_QUEUE_MODE"],
    });
    const registration = await api("/api/v1/device/upload-authorizations", {
      method: "POST",
      headers: {
        authorization: `Device ${device.authorization}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        envelopeDigest: "a".repeat(64),
        contentLengthBytes: 10,
        contentType: "application/json",
      }),
    }, broken);
    expect(registration.status).toBe(503);
    await expect(registration.json()).resolves.toMatchObject({
      error: { code: "ADMISSION_CONFIGURATION_INVALID" },
    });
    const ready = await api("/api/ready", {}, broken);
    expect(ready.status).toBe(503);
    await expect(ready.json()).resolves.toMatchObject({
      error: { code: "ADMISSION_CONFIGURATION_INVALID" },
    });
  });

  it("maps a failed upload admission binding to a retryable service response", async () => {
    const participant = await enrollTelemetry();
    const device = await pairDevice(participant);
    const unavailable = {
      async limit(): Promise<{ success: boolean }> {
        throw new Error("rate binding unavailable");
      },
    } satisfies RateLimit;
    const response = await api("/api/v1/device/upload-authorizations", {
      method: "POST",
      headers: {
        authorization: `Device ${device.authorization}`,
        "content-type": "application/json",
      },
      body: "{",
    }, testBindings({
      UPLOAD_AUTHORIZATION_RATE_LIMIT: unavailable,
    }));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UPLOAD_INGRESS_UNAVAILABLE" },
    });
  });

  it("fails health closed if Queue ingress is enabled before its protocol is implemented", async () => {
    const response = await api("/api/health", {}, testBindings({
      UPLOAD_INGRESS_QUEUE_MODE: "queues" as unknown as Env["UPLOAD_INGRESS_QUEUE_MODE"],
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ADMISSION_CONFIGURATION_INVALID" },
    });
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
        deletionLedger: "ok",
        encryptedObjectStore: "reachable",
        lifecycle: "never_run",
        quarantineRetentionComplete: true,
        restoreReplayComplete: true,
      },
      contracts: {
        acceptedContribution: "telemetry-contribution-v0.1",
        accountScopedContribution: {
          schemaVersion: "telemetry-contribution-v0.2",
          status: "implementation_disabled",
          externalParticipantsAuthorized: false,
        },
        incrementalContribution: {
          schemaVersion: "telemetry-contribution-v1.0",
          status: "implementation_ready",
          // False here because the spec env carries no
          // INCREMENTAL_EXTERNAL_PARTICIPANTS var — the closed default every
          // deployment gets unless its vars say "authorized", which only
          // env.production does (owner decision 2026-08-21).
          externalParticipantsAuthorized: false,
        },
      },
      capabilities: {
        encryptedUpload: true,
        serverValidation: true,
        idempotentDeduplication: true,
        communityDaily: true,
        participantExport: true,
        participantDeletion: true,
        boundedQuarantineRetention: true,
        deletionSafeRestoreReplay: true,
        ongoingDeviceUploadRegistration: true,
        coordinatedSignInAdmission: true,
      },
    });
  });

  it("exposes the validated non-secret deployment source commit when configured", async () => {
    const response = await api("/api/health", {}, testBindings({
      DEPLOYMENT_SOURCE_COMMIT: "c26823c",
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deployment: { sourceCommit: "c26823c" },
    });
  });

  it("fails health closed for an invalid configured deployment source commit", async () => {
    const response = await api("/api/health", {}, testBindings({
      DEPLOYMENT_SOURCE_COMMIT: "not-a-commit",
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "DEPLOYMENT_SOURCE_COMMIT_INVALID" },
    });
  });

  it("keeps operations owner-gated and exposes only bounded audited controls", async () => {
    const notConfigured = await api("/api/v1/admin/overview");
    expect(notConfigured.status).toBe(503);
    await expect(notConfigured.json()).resolves.toMatchObject({
      error: { code: "ADMIN_NOT_CONFIGURED" },
    });

    const participant = await enrollTelemetry();
    const adminIdentityKey = "a".repeat(64);
    const otherIdentityKey = "b".repeat(64);
    await testBindings().USAGE_MONITOR_DB.prepare(
      "UPDATE participants SET identity_link_key = ? WHERE id = ?",
    ).bind(adminIdentityKey, participant.participantId).run();

    const denied = await api(
      "/api/v1/admin/overview",
      { headers: personalHeaders(participant) },
      testBindings({ ADMIN_IDENTITY_LINK_KEY: otherIdentityKey }),
    );
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: "ADMIN_REQUIRED" },
    });

    // Keep an approved non-contributor beside one account with accepted data:
    // the owner view must not conflate enrollment with contribution.
    await enrollTelemetry();
    const accepted = await uploadEnvelope(
      participant,
      await encrypt(telemetryFixture("d"), true),
    );
    expect(accepted.status).toBe(202);
    const acceptedBody = await accepted.json<{ contributionId: string }>();
    const acceptedAgain = await uploadEnvelope(
      participant,
      await encrypt(telemetryFixture("e"), true),
    );
    expect(acceptedAgain.status).toBe(202);

    // Exercise every operator-facing storage-safety bucket. A referenced row
    // models the v1 chunk path, whose accepted object retains its crash marker
    // until reconciliation; the two manually registered rows model recent and
    // due uncommitted registrations without exposing object identifiers in the API.
    const acceptedStorage = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT id, r2_key FROM telemetry_contributions WHERE id = ?",
    ).bind(acceptedBody.contributionId).first<{
      id: string;
      r2_key: string;
    }>();
    expect(acceptedStorage).not.toBeNull();
    const quarantineNow = Date.now();
    const dueRegisteredAt = new Date(
      quarantineNow - 2 * 60 * 60 * 1_000,
    ).toISOString();
    const recentRegisteredAt = new Date(quarantineNow).toISOString();
    await testBindings().USAGE_MONITOR_DB.batch([
      testBindings().USAGE_MONITOR_DB.prepare(
        `INSERT INTO pending_quarantine_objects (
          r2_key, contribution_id, object_kind, registered_at
        ) VALUES (?, ?, 'telemetry', ?)`,
      ).bind(
        acceptedStorage!.r2_key,
        acceptedStorage!.id,
        dueRegisteredAt,
      ),
      testBindings().USAGE_MONITOR_DB.prepare(
        `INSERT INTO pending_quarantine_objects (
          r2_key, contribution_id, object_kind, registered_at
        ) VALUES ('telemetry/admin-due-orphan',
                  'contribution:admin-due-orphan', 'telemetry', ?)`,
      ).bind(dueRegisteredAt),
      testBindings().USAGE_MONITOR_DB.prepare(
        `INSERT INTO pending_quarantine_objects (
          r2_key, contribution_id, object_kind, registered_at
        ) VALUES ('telemetry/admin-recent',
                  'contribution:admin-recent', 'telemetry', ?)`,
      ).bind(recentRegisteredAt),
    ]);

    const failedRequest = await api("/api/v1/this-route-does-not-exist");
    expect(failedRequest.status).toBe(404);
    const failedBody = await failedRequest.json<{
      error: { requestId: string; code: string };
    }>();
    expect(failedBody.error.code).toBe("NOT_FOUND");

    const ownerEnv = testBindings({ ADMIN_IDENTITY_LINK_KEY: adminIdentityKey });
    const overview = await api(
      "/api/v1/admin/overview",
      { headers: personalHeaders(participant) },
      ownerEnv,
    );
    expect(overview.status).toBe(200);
    const overviewBody = await overview.json<{
      ingress: { lastDeniedAt: unknown } | null;
    }>();
    expect(overviewBody).toMatchObject({
      schemaVersion: "admin-overview-v0.3",
      collection: {
        state: "operational",
        enrollment: true,
        uploadRegistration: true,
        processing: true,
        publication: true,
      },
      counts: {
        participants: {
          active: 2,
          enrolledLast24Hours: 2,
          enrolledLast7Days: 2,
        },
        contributions: {
          contributingAccounts: {
            total: 1,
            acceptedLast24Hours: 1,
            acceptedLast7Days: 1,
            acceptedLast30Days: 1,
          },
          telemetry: {
            total: 2,
            accepted: 2,
            acceptedLast24Hours: 2,
            acceptedLast7Days: 2,
          },
          incrementalChunks: {
            total: 0,
            current: 0,
            acceptedLast24Hours: 0,
            acceptedLast7Days: 0,
          },
          acceptedLast24Hours: 2,
          acceptedLast7Days: 2,
          latestAcceptedAt: expect.any(String),
          storedTelemetryRecords: 4,
        },
      },
      quarantine: {
        pendingObjects: 3,
        pendingObjectsBounded: false,
        gracePeriodMinutes: 60,
        cutoffAt: expect.any(String),
        withinGrace: 1,
        dueReferenced: 1,
        dueUnreferenced: 1,
        oldestRegisteredAt: dueRegisteredAt,
        newestRegisteredAt: recentRegisteredAt,
        nextEligibleAt: expect.any(String),
      },
      reconciliation: {
        state: "never_run",
        lastCompletedAt: null,
        maintenanceRunAt: null,
        cutoffAt: null,
        registrationsExamined: 0,
        orphanObjectsDeleted: 0,
        referencedObjectsPreserved: 0,
        reconciliationComplete: false,
        failureCode: null,
      },
      distribution: {
        cloudflare: {
          status: "not_configured",
          reasonCode: "DISTRIBUTION_DISABLED",
        },
        github: {
          status: "not_configured",
          reasonCode: "DISTRIBUTION_DISABLED",
        },
      },
      dailyPublication: {
        latestEvidenceDay: null,
        latestReleasedAt: null,
        pendingRebuilds: 0,
      },
      // The shared Durable Object runtime may carry leases or denials from
      // sibling tests; only the configured capacities are deterministic here.
      ingress: {
        maximumConcurrent: 64,
        burst: 1200,
        activeLeases: expect.any(Number),
        availableStartTokens: expect.any(Number),
        concurrencyDenials: expect.any(Number),
        startRateDenials: expect.any(Number),
      },
      errors: { sampled: true, capacity: 256 },
    });
    expect([null, expect.any(String)]).toContainEqual(
      overviewBody.ingress?.lastDeniedAt,
    );

    // Losing the ingress budget binding must degrade the pressure section to
    // null, never take the rest of the authenticated overview down.
    const overviewWithoutBudget = await api(
      "/api/v1/admin/overview",
      { headers: personalHeaders(participant) },
      testBindings({
        ADMIN_IDENTITY_LINK_KEY: adminIdentityKey,
        UPLOAD_INGRESS_BUDGET:
          undefined as unknown as Env["UPLOAD_INGRESS_BUDGET"],
      }),
    );
    expect(overviewWithoutBudget.status).toBe(200);
    await expect(overviewWithoutBudget.json()).resolves.toMatchObject({
      schemaVersion: "admin-overview-v0.3",
      ingress: null,
    });

    const csrfRejected = await api(
      "/api/v1/admin/action",
      {
        method: "POST",
        headers: {
          ...personalHeaders(participant),
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "run_maintenance" }),
      },
      ownerEnv,
    );
    expect(csrfRejected.status).toBe(403);

    // The owner-only GitHub refresh has its own audited action. Development
    // deliberately returns a disabled result without contacting GitHub rather
    // than exposing a network-dependent test path.
    const distributionSync = await api(
      "/api/v1/admin/action",
      {
        method: "POST",
        headers: {
          ...personalHeaders(participant, { csrf: true }),
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "sync_distribution" }),
      },
      ownerEnv,
    );
    expect(distributionSync.status).toBe(200);
    await expect(distributionSync.json()).resolves.toMatchObject({
      schemaVersion: "admin-action-v0.1",
      action: "sync_distribution",
      result: { code: "DISTRIBUTION_DISABLED" },
    });

    const changed = await api(
      "/api/v1/admin/action",
      {
        method: "POST",
        headers: {
          ...personalHeaders(participant, { csrf: true }),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "set_collection_controls",
          expectedRevision: 1,
          enrollment: true,
          uploadRegistration: true,
          processing: true,
          publication: false,
          reasonCode: "maintenance",
        }),
      },
      ownerEnv,
    );
    expect(changed.status).toBe(200);
    await expect(changed.json()).resolves.toMatchObject({
      action: "set_collection_controls",
      collection: { state: "degraded", publication: false, revision: 2 },
    });
    const audit = await testBindings().USAGE_MONITOR_DB.prepare(
      `SELECT action, outcome, details_json FROM admin_action_audit
        ORDER BY id DESC LIMIT 1`,
    ).first<{ action: string; outcome: string; details_json: string }>();
    expect(audit).toMatchObject({
      action: "set_collection_controls",
      outcome: "success",
    });
    expect(audit?.details_json).toContain("maintenance");

    // A damaged persisted audit payload must not take the owner dashboard
    // down. The read path should return a bounded null detail instead.
    await testBindings().USAGE_MONITOR_DB.prepare(
      `UPDATE admin_action_audit
          SET details_json = ?
        WHERE action = ? AND outcome = ?`,
    ).bind("{malformed", "set_collection_controls", "success").run();
    const overviewWithCorruptAudit = await api(
      "/api/v1/admin/overview",
      { headers: personalHeaders(participant) },
      ownerEnv,
    );
    expect(overviewWithCorruptAudit.status).toBe(200);
    const corruptAuditBody = await overviewWithCorruptAudit.json<{
      audit: Array<{ details: unknown }>;
    }>();
    expect(corruptAuditBody.audit[0]?.details).toBeNull();

    const conflict = await api(
      "/api/v1/admin/action",
      {
        method: "POST",
        headers: {
          ...personalHeaders(participant, { csrf: true }),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "set_collection_controls",
          expectedRevision: 1,
          enrollment: true,
          uploadRegistration: true,
          processing: true,
          publication: true,
          reasonCode: "maintenance",
        }),
      },
      ownerEnv,
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "ADMIN_ACTION_CONFLICT" },
    });
    const controls = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT revision, publication_enabled FROM collection_controls WHERE singleton = 1",
    ).first<{ revision: number; publication_enabled: number }>();
    expect(controls).toEqual({ revision: 2, publication_enabled: 0 });
    const conflictAudit = await testBindings().USAGE_MONITOR_DB.prepare(
      `SELECT outcome, details_json FROM admin_action_audit
        ORDER BY id DESC LIMIT 1`,
    ).first<{ outcome: string; details_json: string }>();
    expect(conflictAudit?.outcome).toBe("failure");
    expect(conflictAudit?.details_json).toContain("ADMIN_ACTION_CONFLICT");
  });

  it("serves owner metrics history with day series and gauge snapshots", async () => {
    const notConfigured = await api("/api/v1/admin/metrics/history");
    expect(notConfigured.status).toBe(503);
    await expect(notConfigured.json()).resolves.toMatchObject({
      error: { code: "ADMIN_NOT_CONFIGURED" },
    });

    const participant = await enrollTelemetry();
    const adminIdentityKey = "a".repeat(64);
    await testBindings().USAGE_MONITOR_DB.prepare(
      "UPDATE participants SET identity_link_key = ? WHERE id = ?",
    ).bind(adminIdentityKey, participant.participantId).run();
    const adminBindings = testBindings({
      ADMIN_IDENTITY_LINK_KEY: adminIdentityKey,
    });

    const denied = await api(
      "/api/v1/admin/metrics/history",
      { headers: personalHeaders(participant) },
      testBindings({ ADMIN_IDENTITY_LINK_KEY: "b".repeat(64) }),
    );
    expect(denied.status).toBe(403);

    const rejectedMethod = await api(
      "/api/v1/admin/metrics/history",
      { method: "POST", headers: personalHeaders(participant, { csrf: true }) },
      adminBindings,
    );
    expect(rejectedMethod.status).toBe(405);

    const cacheMissing = await api(
      "/api/v1/admin/metrics/history",
      { headers: personalHeaders(participant) },
      adminBindings,
    );
    expect(cacheMissing.status).toBe(503);
    await expect(cacheMissing.json()).resolves.toMatchObject({
      error: { code: "ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE" },
    });
    const cacheFailureDiagnostics = await testBindings().USAGE_MONITOR_DB
      .prepare(
        `SELECT COUNT(*) AS n FROM diagnostic_error_events
          WHERE error_code = 'ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE'`,
      ).first<{ n: number }>();
    expect(cacheFailureDiagnostics?.n).toBe(0);

    // A stored gauge snapshot rides along; non-numeric values never leave D1.
    await testBindings().USAGE_MONITOR_DB.prepare(
      `INSERT INTO admin_metric_snapshots (captured_at, metrics_json)
       VALUES (?, ?)`,
    ).bind(
      "2026-08-21T11:00:00.000Z",
      JSON.stringify({ bandParticipantCount: 1, smuggled: "text" }),
    ).run();
    expect((await warmAdminMetricsHistoryCache(
      testBindings().USAGE_MONITOR_DB,
      Date.now(),
    )).code).toBe("HISTORY_CACHE_REFRESHED");

    const history = await api(
      "/api/v1/admin/metrics/history",
      { headers: personalHeaders(participant) },
      adminBindings,
    );
    expect(history.status).toBe(200);
    expect(history.headers.get("cache-control")).toBe("no-store");
    const body = await history.json<{
      schemaVersion: string;
      generatedAt: string;
      events: Record<string, {
        total: number;
        last24Hours: number;
        previous24Hours: number;
        byDay: { day: string; count: number }[];
      }>;
      gauges: { snapshots: { metrics: Record<string, unknown> }[] };
    }>();
    expect(body.schemaVersion).toBe("admin-metrics-history-v0.2");
    const today = body.generatedAt.slice(0, 10);
    // The enrolled participant is a real event in today's bucket.
    const participants = body.events.participants;
    if (!participants) throw new Error("participants series missing");
    expect(participants.total).toBeGreaterThanOrEqual(1);
    expect(participants.last24Hours).toBeGreaterThanOrEqual(1);
    expect(
      participants.byDay.find((row) => row.day === today)?.count,
    ).toBeGreaterThanOrEqual(1);
    for (const key of [
      "participants", "webSessions", "devicePairings", "deviceCredentials",
      "deviceConsents", "uploadedChunks", "uploadedRecords",
      "uploadingParticipants",
    ]) {
      const series = body.events[key];
      if (!series) throw new Error(`series missing: ${key}`);
      expect(Array.isArray(series.byDay)).toBe(true);
    }
    expect(body.gauges.snapshots).toEqual([{
      capturedAt: "2026-08-21T11:00:00.000Z",
      metrics: { bandParticipantCount: 1 },
    }]);
  });

  it("serves the owner-only allowance merge preview without publishing it", async () => {
    const notConfigured = await api(
      "/api/v1/admin/community/allowance-preview",
    );
    expect(notConfigured.status).toBe(503);
    await expect(notConfigured.json()).resolves.toMatchObject({
      error: { code: "ADMIN_NOT_CONFIGURED" },
    });

    const participant = await enrollTelemetry();
    const adminIdentityKey = "a".repeat(64);
    await testBindings().USAGE_MONITOR_DB.prepare(
      "UPDATE participants SET identity_link_key = ? WHERE id = ?",
    ).bind(adminIdentityKey, participant.participantId).run();
    const adminBindings = testBindings({
      ADMIN_IDENTITY_LINK_KEY: adminIdentityKey,
    });

    const rejectedMethod = await api(
      "/api/v1/admin/community/allowance-preview",
      { method: "POST", headers: personalHeaders(participant, { csrf: true }) },
      adminBindings,
    );
    expect(rejectedMethod.status).toBe(405);

    const cacheMissing = await api(
      "/api/v1/admin/community/allowance-preview",
      { headers: personalHeaders(participant) },
      adminBindings,
    );
    expect(cacheMissing.status).toBe(503);
    await expect(cacheMissing.json()).resolves.toMatchObject({
      error: { code: "ADMIN_ALLOWANCE_CACHE_UNAVAILABLE" },
    });
    const cacheFailureDiagnostics = await testBindings().USAGE_MONITOR_DB
      .prepare(
        `SELECT COUNT(*) AS n FROM diagnostic_error_events
          WHERE error_code = 'ADMIN_ALLOWANCE_CACHE_UNAVAILABLE'`,
      ).first<{ n: number }>();
    expect(cacheFailureDiagnostics?.n).toBe(0);

    await testBindings().USAGE_MONITOR_DB.prepare(
      `INSERT INTO admin_community_allowance_preview_cache (
         singleton, generated_at, payload_json
       ) VALUES (1, ?, '{')`,
    ).bind(new Date().toISOString()).run();
    const cacheCorrupt = await api(
      "/api/v1/admin/community/allowance-preview",
      { headers: personalHeaders(participant) },
      adminBindings,
    );
    expect(cacheCorrupt.status).toBe(503);
    await expect(cacheCorrupt.json()).resolves.toMatchObject({
      error: { code: "ADMIN_ALLOWANCE_CACHE_UNAVAILABLE" },
    });
    const corruptFailureDiagnostics = await testBindings().USAGE_MONITOR_DB
      .prepare(
        `SELECT COUNT(*) AS n FROM diagnostic_error_events
          WHERE error_code = 'ADMIN_ALLOWANCE_CACHE_UNAVAILABLE'`,
      ).first<{ n: number }>();
    expect(corruptFailureDiagnostics?.n).toBe(0);

    expect((await warmAdminCommunityAllowancePreviewCache(
      testBindings().USAGE_MONITOR_DB,
      Date.now(),
    )).code).toBe("ALLOWANCE_PREVIEW_CACHE_REFRESHED");

    const response = await api(
      "/api/v1/admin/community/allowance-preview",
      { headers: personalHeaders(participant) },
      adminBindings,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json<{
      schemaVersion: string;
      basis: string;
      plans: { planType: string; multiplier: number }[];
      days: {
        combined: { fitCount: number; centralUsd: number | null };
      }[];
    }>();
    expect(body.schemaVersion).toBe("admin-community-allowance-preview-v0.1");
    expect(body.basis).toBe(
      "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d_preview",
    );
    expect(body.plans).toMatchObject([
      { planType: "pro", multiplier: 1 },
      { planType: "prolite", multiplier: 4 },
      { planType: "plus", multiplier: 20 },
    ]);
    expect(body.days).toHaveLength(70);
    expect(body.days.every((day) => (
      day.combined.fitCount === 0 && day.combined.centralUsd === null
    ))).toBe(true);
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
    const blockedRegistration = await api("/api/v1/device/upload-authorizations", {
      method: "POST",
      headers: {
        authorization: `Device ${device.authorization}`,
        "content-type": "application/json",
      },
      body: registrationBody,
    });
    expect(blockedRegistration.status).toBe(503);
    await expect(blockedRegistration.json()).resolves.toMatchObject({
      error: { code: "UPLOAD_REGISTRATION_DISABLED" },
    });

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

    const participantExport = await api("/api/v1/me/export", {
      headers: personalHeaders(participant),
    });
    expect(participantExport.status).toBe(200);

    await setCollectionControls({ publication: false });
    const communityDaily = await api(
      "/api/v1/community/daily?from=2026-07-01&to=2026-07-02",
    );
    expect(communityDaily.status).toBe(503);
    await expect(communityDaily.json()).resolves.toMatchObject({
      error: { code: "PUBLICATION_DISABLED" },
    });

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
        communityDaily: false,
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
      ["/api/v1/community/daily?from=2026-07-01&to=2026-07-02", {}],
    ] as const) {
      const response = await api(path, init);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "COLLECTION_CONTROL_UNAVAILABLE" },
      });
    }

    const session = await api("/api/v1/session", {
      headers: personalHeaders(participant),
    });
    expect(session.status).toBe(200);
    const deleted = await api("/api/v1/me", {
      method: "DELETE",
      headers: personalHeaders(participant, { csrf: true }),
    });
    expect(deleted.status).toBe(200);
    expect((await testBindings().QUARANTINE.list()).objects).toHaveLength(0);
  });

  it("keeps retired browser upload, recovery, profile, and contribution-resource routes absent", async () => {
    const participant = await enroll();
    const envelope = JSON.stringify(await encrypt(syntheticFixture()));
    const legacyUpload = `um_upload_${crypto.randomUUID()}.${"a".repeat(43)}`;
    const rejectedUpload = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${legacyUpload}`,
        "content-type": "application/json",
      },
      body: envelope,
    });
    expect(rejectedUpload.status).toBe(401);
    await expect(rejectedUpload.json()).resolves.toMatchObject({
      error: { code: "UPLOAD_AUTH_INVALID" },
    });

    for (const [path, method] of [
      ["/api/v1/recover", "POST"],
      ["/api/v1/me/upload-authorizations", "POST"],
      ["/api/v1/me/contributions/read", "POST"],
      ["/api/v1/me/contributions/delete", "POST"],
      ["/api/v1/me/stats", "GET"],
      ["/api/v1/me/insights", "GET"],
      ["/api/v1/stats/aggregate", "GET"],
      ["/api/v1/community/insights", "GET"],
    ] as const) {
      const response = await api(path, {
        method,
        headers: method === "GET"
          ? personalHeaders(participant)
          : {
            ...personalHeaders(participant, { csrf: true }),
            "content-type": "application/json",
          },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "NOT_FOUND" },
      });
    }

    const stored = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM contributions",
    ).first<{ total: number }>();
    expect(stored?.total).toBe(0);
  });
  it("renews bounded telemetry admission without refunding deleted batches", async () => {
    const participant = await enrollTelemetry();
    const expectedWindow = telemetryContributionAdmissionWindow(
      Date.parse("2026-07-29T18:30:00.000Z"),
    );
    expect(expectedWindow).toEqual({
      startsAt: "2026-07-27T00:00:00.000Z",
      endsAt: "2026-08-03T00:00:00.000Z",
    });
    const currentWindow = telemetryContributionAdmissionWindow();
    await testBindings().USAGE_MONITOR_DB.prepare(
      `INSERT INTO telemetry_contribution_admission_windows (
        participant_id, window_started_at, accepted_count, last_accepted_at
      ) VALUES (?, ?, 100, ?)`,
    ).bind(
      participant.participantId,
      currentWindow.startsAt,
      new Date().toISOString(),
    ).run();

    await expect(telemetryContributionAdmission(
      testBindings().USAGE_MONITOR_DB,
      participant.participantId,
    )).resolves.toMatchObject({
        schemaVersion: "telemetry-contribution-admission-v0.1",
        state: "exhausted",
        window: {
          kind: "fixed_utc",
          anchor: "monday_00_00_utc",
          startsAt: currentWindow.startsAt,
          endsAt: currentWindow.endsAt,
          durationMilliseconds: 7 * 24 * 60 * 60 * 1000,
        },
        acceptedBatches: 100,
        remainingBatches: 0,
        maximumBatches: 100,
        slotRefundPolicy: "not_refunded_by_contribution_deletion",
    });
    const blocked = await uploadEnvelope(
      participant,
      await encrypt(telemetryFixture("a"), true),
    );
    expect(blocked.status).toBe(429);
    const retryAfterSeconds = Number(blocked.headers.get("retry-after"));
    expect(Number.isSafeInteger(retryAfterSeconds)).toBe(true);
    expect(retryAfterSeconds).toBeGreaterThan(0);
    await expect(blocked.json()).resolves.toMatchObject({
      error: {
        code: "CONTRIBUTION_LIMIT_REACHED",
        details: {
          admission: {
            schemaVersion: "telemetry-contribution-admission-v0.1",
            state: "exhausted",
            remainingBatches: 0,
            maximumBatches: 100,
            window: {
              startsAt: currentWindow.startsAt,
              endsAt: currentWindow.endsAt,
            },
          },
          retryAt: currentWindow.endsAt,
        },
      },
    });

    await testBindings().USAGE_MONITOR_DB.prepare(
      `UPDATE telemetry_contribution_admission_windows
          SET window_started_at = ?
        WHERE participant_id = ? AND window_started_at = ?`,
    ).bind(
      new Date(
        Date.parse(currentWindow.startsAt) - 7 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      participant.participantId,
      currentWindow.startsAt,
    ).run();
    const accepted = await uploadEnvelope(
      participant,
      await encrypt(telemetryFixture("b"), true),
    );
    expect(accepted.status).toBe(202);
    const acceptedBody = await accepted.json<{ contributionId: string }>();
    const deleted = await testBindings().USAGE_MONITOR_DB.prepare(
      "DELETE FROM telemetry_contributions WHERE id = ? AND participant_id = ?",
    ).bind(acceptedBody.contributionId, participant.participantId).run();
    expect(deleted.meta.changes).toBeGreaterThanOrEqual(1);
    const remaining = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM telemetry_contributions WHERE id = ?",
    ).bind(acceptedBody.contributionId).first<{ total: number }>();
    expect(remaining?.total).toBe(0);
    await expect(telemetryContributionAdmission(
      testBindings().USAGE_MONITOR_DB,
      participant.participantId,
    )).resolves.toMatchObject({
        state: "available",
        acceptedBatches: 1,
        remainingBatches: 99,
    });
  });

  it("pulls participant exports on demand with one bounded query per telemetry page", async () => {
    const participant = await enrollTelemetry();
    for (const suffix of ["a", "b", "c", "d", "e"]) {
      const response = await uploadEnvelope(
        participant,
        await encrypt(telemetryFixture(suffix), true),
      );
      expect(response.status).toBe(202);
    }
    const stranger = await enrollTelemetry();
    const strangerUpload = await uploadEnvelope(
      stranger,
      await encrypt(telemetryFixture("f"), true),
    );
    expect(strangerUpload.status).toBe(202);
    const expected = await testBindings().USAGE_MONITOR_DB.prepare(
      `SELECT id FROM telemetry_contributions
        WHERE participant_id = ? ORDER BY created_at ASC, id ASC`,
    ).bind(participant.participantId).all<{ id: string }>();
    const strangerContributionId = (
      await strangerUpload.json<{ contributionId: string }>()
    ).contributionId;

    const base = testBindings().USAGE_MONITOR_DB;
    const slowQueries: string[] = [];
    const slowDatabase = d1PrepareProxy(base, (query) => {
      if (query.includes("WITH contribution_page AS")) slowQueries.push(query);
      return base.prepare(query);
    });
    const slowResponse = await api("/api/v1/me/export", {
      headers: personalHeaders(participant),
    }, testBindings({ USAGE_MONITOR_DB: slowDatabase }));
    expect(slowResponse.status).toBe(200);
    expect(slowQueries).toHaveLength(0);
    const slowReader = slowResponse.body!.getReader();
    const prefix = await slowReader.read();
    expect(prefix.done).toBe(false);
    expect(new TextDecoder().decode(prefix.value)).toContain(
      '"schemaVersion":"participant-export-v0.2"',
    );
    expect(slowQueries).toHaveLength(0);
    const firstContribution = await slowReader.read();
    expect(firstContribution.done).toBe(false);
    expect(slowQueries).toHaveLength(1);
    await Promise.resolve();
    expect(slowQueries).toHaveLength(1);
    await slowReader.cancel();
    expect(slowQueries).toHaveLength(1);

    const fullQueries: string[] = [];
    const fullDatabase = d1PrepareProxy(base, (query) => {
      if (query.includes("WITH contribution_page AS")) fullQueries.push(query);
      return base.prepare(query);
    });
    const fullResponse = await api("/api/v1/me/export", {
      headers: personalHeaders(participant),
    }, testBindings({ USAGE_MONITOR_DB: fullDatabase }));
    const exported = await fullResponse.json<{
      schemaVersion: string;
      participant: { participantId: string };
      contributions: Array<{
        contributionId: string;
        records: Array<{ kind: string }>;
      }>;
    }>();
    expect(exported.schemaVersion).toBe("participant-export-v0.2");
    expect(exported.participant.participantId).toBe(participant.participantId);
    expect(exported.contributions.map((row) => row.contributionId)).toEqual(
      expected.results.map((row) => row.id),
    );
    expect(exported.contributions).toHaveLength(5);
    expect(exported.contributions.every((row) => (
      row.records.map((record) => record.kind).join(",") === "usage,quota"
    ))).toBe(true);
    expect(JSON.stringify(exported)).not.toContain(strangerContributionId);
    expect(fullQueries).toHaveLength(2);
    expect(fullQueries.every((query) => (
      query.includes("WHERE c.participant_id = ?")
        && query.includes("WHERE selected_page.participant_id = ?")
    ))).toBe(true);
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

    const validPlaintext = JSON.stringify(telemetryFixture("hidden"));
    const hiddenDuplicate = validPlaintext.replace(
      '"accounting":',
      '"accounting":{"prompt":"PRIVATE_CONTENT"},"accounting":',
    );
    const duplicatePlaintext = await uploadEnvelope(
      participant,
      await encryptRaw(hiddenDuplicate, true),
    );
    expect(duplicatePlaintext.status).toBe(400);
    await expect(duplicatePlaintext.json()).resolves.toMatchObject({
      error: { code: "DECRYPTION_FAILED" },
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
  it("isolates an allowance-preview cache failure from scheduled maintenance", async () => {
    await testBindings().USAGE_MONITOR_DB.prepare(
      "DROP TABLE admin_community_allowance_preview_cache",
    ).run();
    const result = await runScheduledMaintenance(
      testBindings(),
      Date.parse("2026-08-23T12:00:00.000Z"),
    );
    expect(result).toMatchObject({
      outcome: "success",
      event: "scheduled_backend_maintenance",
    });
    const retention = await testBindings().USAGE_MONITOR_DB.prepare(
      `SELECT state, maintenance_lease_token
         FROM retention_state WHERE singleton = 1`,
    ).first<{ state: string; maintenance_lease_token: string | null }>();
    expect(retention?.state).not.toBe("failed");
    expect(retention?.maintenance_lease_token).toBeNull();
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

  it("processes historical aggregate rebuilds in bounded resumable batches", async () => {
    await testBindings().USAGE_MONITOR_DB.prepare(
      `UPDATE community_snapshot_mutation_control
          SET mutation_epoch = 1 WHERE singleton_id = 1`,
    ).run();
    const day = 24 * 60 * 60 * 1000;
    const initialStart = Date.parse("2026-06-08T00:00:00.000Z");
    await testBindings().USAGE_MONITOR_DB.batch(
      Array.from({ length: 6 }, (_, index) => {
        const start = initialStart + index * 7 * day;
        return testBindings().USAGE_MONITOR_DB.prepare(
          `INSERT INTO community_weekly_snapshot_rebuilds (
            week_start, week_end, ingestion_cutoff_at, requested_epoch,
            requested_at
          ) VALUES (?, ?, ?, 1, ?)`,
        ).bind(
          new Date(start).toISOString(),
          new Date(start + 7 * day).toISOString(),
          new Date(start + 9 * day).toISOString(),
          "2026-07-29T00:00:00.000Z",
        );
      }),
    );
    await expect(rebuildPendingCommunityWeeklySnapshots(
      testBindings().USAGE_MONITOR_DB,
      Date.parse("2026-07-29T00:00:00.000Z"),
      0,
    )).rejects.toThrow("invalid community snapshot rebuild request");
    const first = await rebuildPendingCommunityWeeklySnapshots(
      testBindings().USAGE_MONITOR_DB,
      Date.parse("2026-07-29T00:00:00.000Z"),
      2,
    );
    expect(first).toMatchObject({ processed: 2, remaining: true });
    const firstCounts = await testBindings().USAGE_MONITOR_DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM community_weekly_snapshots) AS snapshots,
        (SELECT COUNT(*) FROM community_weekly_snapshot_rebuilds) AS rebuilds`,
    ).first<{ snapshots: number; rebuilds: number }>();
    expect(firstCounts).toEqual({ snapshots: 2, rebuilds: 4 });

    const second = await rebuildPendingCommunityWeeklySnapshots(
      testBindings().USAGE_MONITOR_DB,
      Date.parse("2026-07-29T01:00:00.000Z"),
      10,
    );
    expect(second).toMatchObject({ processed: 4, remaining: false });
    const finalCounts = await testBindings().USAGE_MONITOR_DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM community_weekly_snapshots) AS snapshots,
        (SELECT COUNT(*) FROM community_weekly_snapshot_rebuilds) AS rebuilds`,
    ).first<{ snapshots: number; rebuilds: number }>();
    expect(finalCounts).toEqual({ snapshots: 6, rebuilds: 0 });
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
    const withdrawnSnapshot = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT release_state FROM community_weekly_snapshots",
    ).first<{ release_state: string }>();
    expect(withdrawnSnapshot?.release_state).toBe("withdrawn");

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
    const otherRejected = await api("/api/v1/session", {
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

    const retried = await api("/api/v1/me", {
      method: "DELETE",
      headers: personalHeaders(winningParticipant, { csrf: true }),
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
    expect(personalRead.status).toBe(405);

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

    const contributionCount = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM telemetry_contributions WHERE participant_id = ?",
    ).bind(participant.participantId).first<{ total: number }>();
    expect(contributionCount?.total).toBe(1);

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

  it("keeps aged quarantine objects because retention is disabled", async () => {
    const participant = await enrollTelemetry();
    const accepted = await uploadEnvelope(
      participant,
      await encrypt(telemetryFixture("a"), true),
    );
    const receipt = await accepted.json<{ contributionId: string }>();
    const stored = await testBindings().USAGE_MONITOR_DB.prepare(
      `SELECT r2_key FROM telemetry_contributions
        WHERE id = ? AND participant_id = ?`,
    ).bind(receipt.contributionId, participant.participantId)
      .first<{ r2_key: string }>();
    expect(stored?.r2_key).toBeTruthy();
    expect(await testBindings().QUARANTINE.head(stored!.r2_key)).not.toBeNull();

    await testBindings().USAGE_MONITOR_DB.prepare(
      `UPDATE telemetry_contributions
          SET created_at = '2026-07-17T00:00:00.000Z'
        WHERE id = ?`,
    ).bind(receipt.contributionId).run();
    const result = await runBackendLifecycle(
      testBindings().USAGE_MONITOR_DB,
      testBindings().DELETION_LEDGER,
      testBindings().QUARANTINE,
      Date.parse("2026-07-25T00:00:00.000Z"),
    );
    expect(result).toEqual({
      quarantineCutoffAt: null,
      quarantineObjectsDeleted: 0,
      quarantineRetentionComplete: true,
      restoredParticipantsSuppressed: 0,
      restoreReplayComplete: true,
    });
    expect(await testBindings().QUARANTINE.head(stored!.r2_key)).not.toBeNull();
    const retained = await testBindings().USAGE_MONITOR_DB.prepare(
      `SELECT quarantine_deleted_at FROM telemetry_contributions
        WHERE id = ? AND participant_id = ?`,
    ).bind(receipt.contributionId, participant.participantId)
      .first<{ quarantine_deleted_at: string | null }>();
    expect(retained?.quarantine_deleted_at).toBeNull();
  });

  it("retains indeterminate telemetry quarantine objects after committed ingest accounting fails", async () => {
    const participant = await enrollTelemetry();
    const rawEnvelope = JSON.stringify(
      await encrypt(telemetryFixture("e"), true),
    );
    const authorization = await registerUpload(participant, rawEnvelope);
    const baseDb = testBindings().USAGE_MONITOR_DB;
    let ingestBatchCommitted = false;
    let accountingFailureInjected = false;
    const failingDb = new Proxy(baseDb, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            ingestBatchCommitted = true;
            return result;
          };
        }
        if (property === "prepare") {
          return (query: string) => {
            if (ingestBatchCommitted
                && !accountingFailureInjected) {
              accountingFailureInjected = true;
              throw new Error("injected post-commit accounting failure");
            }
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const request = {
      method: "POST",
      headers: {
        authorization: `Upload ${authorization.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: rawEnvelope,
    } satisfies RequestInit;

    const recovered = await api(
      "/api/v1/contributions",
      request,
      testBindings({ USAGE_MONITOR_DB: failingDb }),
    );
    expect(ingestBatchCommitted).toBe(true);
    expect(accountingFailureInjected).toBe(true);
    expect(recovered.status).toBe(202);
    expect(recovered.headers.get("idempotency-replayed")).toBe("true");
    await expect(recovered.json()).resolves.toMatchObject({
      status: "accepted",
      replayed: true,
    });

    const accepted = await baseDb.prepare(
      `SELECT id, status, r2_key, declared_record_count, accepted_record_count
         FROM telemetry_contributions
        WHERE participant_id = ?`,
    ).bind(participant.participantId).first<{
      id: string;
      status: string;
      r2_key: string;
      declared_record_count: number;
      accepted_record_count: number | null;
    }>();
    expect(accepted).toMatchObject({
      status: "accepted",
      declared_record_count: 2,
      accepted_record_count: 2,
    });
    expect(await testBindings().QUARANTINE.head(accepted!.r2_key)).not.toBeNull();

    const replayAuthorization = await registerUpload(participant, rawEnvelope);
    const replay = await api("/api/v1/contributions", {
      ...request,
      headers: {
        ...request.headers,
        authorization: `Upload ${replayAuthorization.uploadAuthorization}`,
      },
    });
    expect(replay.status).toBe(202);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    await expect(replay.json()).resolves.toMatchObject({
      contributionId: accepted!.id,
      status: "accepted",
      replayed: true,
    });
    expect(await testBindings().QUARANTINE.head(accepted!.r2_key)).not.toBeNull();

    await baseDb.prepare(
      `UPDATE telemetry_contributions
          SET created_at = '2026-07-17T00:00:00.000Z'
        WHERE id = ?`,
    ).bind(accepted!.id).run();
    await expect(runBackendLifecycle(
      baseDb,
      testBindings().DELETION_LEDGER,
      testBindings().QUARANTINE,
      Date.parse("2026-07-25T00:00:00.000Z"),
    )).resolves.toMatchObject({ quarantineObjectsDeleted: 0 });
    expect(await testBindings().QUARANTINE.head(accepted!.r2_key)).not.toBeNull();
    const retainedMetadata = await baseDb.prepare(
      `SELECT status, quarantine_deleted_at
         FROM telemetry_contributions WHERE id = ?`,
    ).bind(accepted!.id).first<{
      status: string;
      quarantine_deleted_at: string | null;
    }>();
    expect(retainedMetadata).toEqual({
      status: "accepted",
      quarantine_deleted_at: null,
    });
  });

  it("does not mark quarantine deleted when a retention sweep's R2 delete fails", async () => {
    const participant = await enrollTelemetry();
    const accepted = await uploadEnvelope(
      participant,
      await encrypt(telemetryFixture("b"), true),
    );
    const receipt = await accepted.json<{ contributionId: string }>();
    await testBindings().USAGE_MONITOR_DB.prepare(
      `UPDATE telemetry_contributions
          SET created_at = '2026-07-17T00:00:00.000Z'
        WHERE id = ?`,
    ).bind(receipt.contributionId).run();
    const failingBucket = new Proxy(testBindings().QUARANTINE, {
      get(target, property) {
        if (property === "delete") {
          return async () => {
            throw new Error("injected retention R2 deletion failure");
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    // Retention is disabled, so the lifecycle never enters this phase. The
    // sweep is driven directly to keep the dormant machinery honest: a failed
    // R2 delete must never leave a row claiming its envelope is gone.
    await expect(deleteDueQuarantineObjects(
      testBindings().USAGE_MONITOR_DB,
      failingBucket,
      "2026-07-18T00:00:00.000Z",
    )).rejects.toThrow("injected retention R2 deletion failure");
    const contribution = await testBindings().USAGE_MONITOR_DB.prepare(
      `SELECT quarantine_deleted_at FROM telemetry_contributions WHERE id = ?`,
    ).bind(receipt.contributionId)
      .first<{ quarantine_deleted_at: string | null }>();
    expect(contribution?.quarantine_deleted_at).toBeNull();

    await expect(deleteDueQuarantineObjects(
      testBindings().USAGE_MONITOR_DB,
      testBindings().QUARANTINE,
      "2026-07-18T00:00:00.000Z",
    )).resolves.toMatchObject({ deleted: 1, complete: true });
  });

  it("fails participant deletion closed when its independent ledger is unavailable", async () => {
    const participant = await enrollTelemetry();
    await uploadEnvelope(
      participant,
      await encrypt(telemetryFixture("c"), true),
    );
    const unavailableLedger = new Proxy(testBindings().DELETION_LEDGER, {
      get(target, property) {
        if (property === "prepare") {
          return () => {
            throw new Error("injected deletion ledger failure");
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failed = await api("/api/v1/me", {
      method: "DELETE",
      headers: personalHeaders(participant, { csrf: true }),
    }, testBindings({ DELETION_LEDGER: unavailableLedger }));
    expect(failed.status).toBe(500);
    const primary = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT state FROM participants WHERE id = ?",
    ).bind(participant.participantId).first<{ state: string }>();
    expect(primary?.state).toBe("deleting");
    expect((await testBindings().QUARANTINE.list()).objects).toHaveLength(1);
    const tombstones = await testBindings().DELETION_LEDGER.prepare(
      "SELECT COUNT(*) AS total FROM deletion_tombstones",
    ).first<{ total: number }>();
    expect(tombstones?.total).toBe(0);

    const retried = await api("/api/v1/me", {
      method: "DELETE",
      headers: personalHeaders(participant, { csrf: true }),
    });
    expect(retried.status).toBe(200);
    expect((await testBindings().QUARANTINE.list()).objects).toHaveLength(0);
  });

  it("does not let expired tombstones block auth and purges them one bounded page at a time", async () => {
    const nowEpoch = Date.parse("2026-08-04T00:00:00.000Z");
    const participantIds = Array.from(
      { length: 101 },
      () => `participant:${crypto.randomUUID()}`,
    );
    const ledger = testBindings().DELETION_LEDGER;
    for (let offset = 0; offset < participantIds.length; offset += 50) {
      const rows = participantIds.slice(offset, offset + 50);
      await ledger.batch(await Promise.all(
        rows.map(async (participantId) => ledger.prepare(
          `INSERT INTO deletion_tombstones (
            participant_digest, schema_version, deleted_at, retain_until
          ) VALUES (?, 'participant-deletion-tombstone-v0.1', ?, ?)`,
        ).bind(
          await participantDeletionDigest(participantId),
          "2026-01-01T00:00:00.000Z",
          "2026-07-01T00:00:00.000Z",
        )),
      ));
    }

    await expect(hasDeletionTombstone(
      ledger,
      participantIds[0]!,
      nowEpoch,
    )).resolves.toBe(false);
    const first = await purgeExpiredDeletionTombstones(ledger, nowEpoch);
    expect(first).toEqual({ purged: 100, complete: false });
    const second = await purgeExpiredDeletionTombstones(ledger, nowEpoch);
    expect(second).toEqual({ purged: 1, complete: true });
    const remaining = await ledger.prepare(
      "SELECT COUNT(*) AS total FROM deletion_tombstones",
    ).first<{ total: number }>();
    expect(remaining?.total).toBe(0);
  });

  it("suppresses a pre-deletion primary restore using only the independent digest", async () => {
    const participant = await enrollTelemetry();
    await uploadEnvelope(
      participant,
      await encrypt(telemetryFixture("d"), true),
    );
    await seedSealedSuppressedSnapshot();
    await recordDeletionTombstone(
      testBindings().DELETION_LEDGER,
      participant.participantId,
      Date.parse("2026-07-25T00:00:00.000Z"),
    );

    const deniedBeforeReplay = await api("/api/v1/session", {
      headers: personalHeaders(participant),
    });
    expect(deniedBeforeReplay.status).toBe(401);
    const result = await runBackendLifecycle(
      testBindings().USAGE_MONITOR_DB,
      testBindings().DELETION_LEDGER,
      testBindings().QUARANTINE,
      Date.parse("2026-07-25T01:00:00.000Z"),
    );
    expect(result.restoredParticipantsSuppressed).toBe(1);
    expect((await testBindings().QUARANTINE.list()).objects).toHaveLength(0);
    for (const table of [
      "participants",
      "web_sessions",
      "upload_authorizations",
      "telemetry_contributions",
      "telemetry_contribution_occurrences",
      "telemetry_records",
    ]) {
      const row = await testBindings().USAGE_MONITOR_DB.prepare(
        `SELECT COUNT(*) AS total FROM ${table}`,
      ).first<{ total: number }>();
      expect(row?.total).toBe(0);
    }
    const snapshot = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT release_state FROM community_weekly_snapshots",
    ).first<{ release_state: string }>();
    expect(snapshot?.release_state).toBe("withdrawn");
    const ledgerRow = await testBindings().DELETION_LEDGER.prepare(
      `SELECT schema_version, participant_digest, retain_until
         FROM deletion_tombstones`,
    ).first<{
      schema_version: string;
      participant_digest: string;
      retain_until: string;
    }>();
    expect(ledgerRow?.schema_version).toBe(
      "participant-deletion-tombstone-v0.1",
    );
    expect(ledgerRow?.participant_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(ledgerRow)).not.toContain(participant.participantId);
    expect(ledgerRow?.retain_until).toBe("2027-08-29T00:00:00.000Z");
  });

  it("bounds a mass restore replay and reports incomplete until the next pass", async () => {
    const participantIds = Array.from(
      { length: 101 },
      () => `participant:${crypto.randomUUID()}`,
    );
    for (let offset = 0; offset < participantIds.length; offset += 50) {
      const statements = participantIds.slice(offset, offset + 50).map(
        (participantId) => testBindings().USAGE_MONITOR_DB.prepare(
          `INSERT INTO participants (
            id, access_token_id, access_token_hash, recovery_token_id,
            recovery_token_hash, state, consent_version, consented_at,
            created_at, deletion_session_id
          ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)`,
        ).bind(
          participantId,
          crypto.randomUUID(),
          new Uint8Array(32),
          crypto.randomUUID(),
          new Uint8Array(32),
          "privacy-safe-telemetry-v0.1",
          "2026-07-25T00:00:00.000Z",
          "2026-07-25T00:00:00.000Z",
        ),
      );
      await testBindings().USAGE_MONITOR_DB.batch(statements);
    }
    const digests = await Promise.all(
      participantIds.map(participantDeletionDigest),
    );
    for (let offset = 0; offset < digests.length; offset += 50) {
      const statements = digests.slice(offset, offset + 50).map(
        (digest) => testBindings().DELETION_LEDGER.prepare(
          `INSERT INTO deletion_tombstones (
            participant_digest, schema_version, deleted_at, retain_until
          ) VALUES (?, 'participant-deletion-tombstone-v0.1', ?, ?)`,
        ).bind(
          digest,
          "2026-07-25T00:00:00.000Z",
          "2027-08-29T00:00:00.000Z",
        ),
      );
      await testBindings().DELETION_LEDGER.batch(statements);
    }

    const first = await runBackendLifecycle(
      testBindings().USAGE_MONITOR_DB,
      testBindings().DELETION_LEDGER,
      testBindings().QUARANTINE,
      Date.parse("2026-07-26T00:00:00.000Z"),
    );
    expect(first).toMatchObject({
      restoredParticipantsSuppressed: 100,
      restoreReplayComplete: false,
    });
    const afterFirst = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM participants",
    ).first<{ total: number }>();
    expect(afterFirst?.total).toBe(1);

    const second = await runBackendLifecycle(
      testBindings().USAGE_MONITOR_DB,
      testBindings().DELETION_LEDGER,
      testBindings().QUARANTINE,
      Date.parse("2026-07-26T01:00:00.000Z"),
    );
    expect(second).toMatchObject({
      restoredParticipantsSuppressed: 1,
      restoreReplayComplete: true,
    });
    const afterSecond = await testBindings().USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM participants",
    ).first<{ total: number }>();
    expect(afterSecond?.total).toBe(0);
  });

  describe("mandatory hosted identity", () => {
    it("pins production hosted-identity callbacks to the configured public origin", async () => {
      const production = identityBindings({
        ENVIRONMENT: "production" as Env["ENVIRONMENT"],
        ENROLLMENT_MODE: "open" as Env["ENROLLMENT_MODE"],
        PUBLIC_ORIGIN: "https://tibotattle.com",
      } as unknown as Partial<Env>);
      const response = await handleRequest(
        new Request(
          "https://unexpected-worker.example/api/v1/identity/google/callback?state=x&code=y",
        ),
        production,
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "NOT_FOUND" },
      });
    });

    it("requires identity for production enrollment and keeps recovery retired", async () => {
      const production = identityBindings({
        ENVIRONMENT: "production" as Env["ENVIRONMENT"],
        ENROLLMENT_MODE: "open" as Env["ENROLLMENT_MODE"],
      });
      const withoutIdentity = await api("/api/v1/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          consentVersion: "privacy-safe-telemetry-v0.1",
          syntheticOnly: false,
        }),
      }, production);
      expect(withoutIdentity.status).toBe(401);
      expect(await withoutIdentity.json()).toMatchObject({
        error: { code: "IDENTITY_REQUIRED" },
      });
      const recovery = await api("/api/v1/recover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recoveryCode: "um_recovery_x.y",
        }),
      }, production);
      expect(recovery.status).toBe(404);
      expect(await recovery.json()).toMatchObject({
        error: { code: "NOT_FOUND" },
      });
    });

    it("pins the hosted identity key configuration and rejects an in-place rotation", async () => {
      const production = identityBindings({
        ENVIRONMENT: "production" as Env["ENVIRONMENT"],
        ENROLLMENT_MODE: "open" as Env["ENROLLMENT_MODE"],
        PUBLIC_ORIGIN: "https://tibotattle.com",
      });
      const first = await identityEnroll(
        await sha256Hex("test-hosted-identity\\0configuration-pin-first"),
        "google",
        production,
      );
      expect(first.status).toBe(201);
      const pinned = await production.USAGE_MONITOR_DB.prepare(
        `SELECT key_version, secret_fingerprint
           FROM identity_link_secret_configuration
          WHERE singleton = 1`,
      ).first<{ key_version: string; secret_fingerprint: string }>();
      expect(pinned?.key_version).toBe("test-v1");
      expect(pinned?.secret_fingerprint).toMatch(/^[0-9a-f]{64}$/u);
      expect(JSON.stringify(pinned)).not.toContain(
        configuredIdentityLinkSecret(production),
      );

      const changedSecret = identityBindings({
        ENVIRONMENT: "production" as Env["ENVIRONMENT"],
        ENROLLMENT_MODE: "open" as Env["ENROLLMENT_MODE"],
        PUBLIC_ORIGIN: "https://tibotattle.com",
        IDENTITY_LINK_SECRET: "rotated-identity-link-secret-for-tests-0123456789",
      });
      const secretRejected = await identityEnroll(
        await sha256Hex("test-hosted-identity\\0configuration-pin-secret"),
        "google",
        changedSecret,
      );
      expect(secretRejected.status).toBe(503);
      await expect(secretRejected.json()).resolves.toMatchObject({
        error: { code: "IDENTITY_CONFIGURATION_INVALID" },
      });

      const changedVersion = identityBindings({
        ENVIRONMENT: "production" as Env["ENVIRONMENT"],
        ENROLLMENT_MODE: "open" as Env["ENROLLMENT_MODE"],
        PUBLIC_ORIGIN: "https://tibotattle.com",
        IDENTITY_LINK_SECRET_VERSION:
          "test-v2" as unknown as Env["IDENTITY_LINK_SECRET_VERSION"],
      } as unknown as Partial<Env>);
      const versionRejected = await identityEnroll(
        await sha256Hex("test-hosted-identity\\0configuration-pin-version"),
        "google",
        changedVersion,
      );
      expect(versionRejected.status).toBe(503);
      await expect(versionRejected.json()).resolves.toMatchObject({
        error: { code: "IDENTITY_CONFIGURATION_INVALID" },
      });

      const participants = await production.USAGE_MONITOR_DB.prepare(
        "SELECT COUNT(*) AS total FROM participants",
      ).first<{ total: number }>();
      expect(participants?.total).toBe(1);
    });

    it("enrolls, stores only the pairwise hash, and reattaches the same participant", async () => {
      const subject = "google-subject-alpha";
      const linkKey = await sha256Hex(`test-hosted-identity\0${subject}`);
      const first = await identityEnroll(linkKey);
      expect(first.status).toBe(201);
      const firstBody = await first.json<{ participantId: string; recoveryCode: string }>();

      const row = await testBindings().USAGE_MONITOR_DB.prepare(
        `SELECT identity_link_key, identity_cooldown_digest
           FROM participants
          WHERE id = ?`,
      ).bind(firstBody.participantId).first<{
        identity_link_key: string;
        identity_cooldown_digest: string | null;
      }>();
      expect(row?.identity_link_key).toMatch(/^[0-9a-f]{64}$/u);
      expect(row?.identity_link_key.includes(subject)).toBe(false);
      expect(row?.identity_cooldown_digest).toBeNull();

      const second = await identityEnroll(linkKey);
      expect(second.status).toBe(201);
      const secondBody = await second.json<{ participantId: string; recoveryCode: string }>();
      expect(secondBody.participantId).toBe(firstBody.participantId);
      expect(secondBody.recoveryCode).not.toBe(firstBody.recoveryCode);

      const count = await testBindings().USAGE_MONITOR_DB.prepare(
        "SELECT COUNT(*) AS total FROM participants",
      ).first<{ total: number }>();
      expect(count?.total).toBe(1);
    });

    it("accepts an Apple proof and rejects invalid identities fail-closed", async () => {
      const apple = await identityEnroll(
        await sha256Hex("test-hosted-identity\0apple-subject"),
        "apple",
      );
      expect(apple.status).toBe(201);

      for (const identity of [
        { provider: "google", proof: "x".repeat(64) },
        { provider: "google", proof: "too-short" },
        { provider: "github", proof: "x".repeat(64) },
        { provider: "google", idToken: "not-a-jwt" },
      ]) {
        const rejected = await api("/api/v1/enroll", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            consentVersion: "privacy-safe-telemetry-v0.1",
            syntheticOnly: false,
            identity,
          }),
        }, identityBindings());
        expect(rejected.status).toBe(401);
        expect(await rejected.json()).toMatchObject({
          error: { code: "IDENTITY_TOKEN_INVALID" },
        });
      }
    });

    // csf_b814237b / csf_42bcd8fd: the delivered proof is a bearer credential.
    // Enrollment must carry the initiator binding through to the reattachment
    // sink so a leaked proof alone — or one presented with the wrong verifier —
    // cannot reattach an existing participant.
    it("binds hosted-proof enrollment to the initiating client's verifier", async () => {
      const runtimeEnv = identityBindings();
      const linkKey = await sha256Hex("test-hosted-identity-binding-subject");
      const proof = await deliveredHostedProof(runtimeEnv, "google", linkKey);

      // The proof alone (no verifier) and the proof with a wrong verifier are
      // both refused, and neither failed attempt consumes the one-use proof.
      for (const identity of [
        { provider: "google", proof },
        { provider: "google", proof, verifier: "y".repeat(64) },
      ]) {
        const rejected = await api("/api/v1/enroll", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            consentVersion: "privacy-safe-telemetry-v0.1",
            syntheticOnly: false,
            identity,
          }),
        }, runtimeEnv);
        expect(rejected.status).toBe(401);
        expect(await rejected.json()).toMatchObject({
          error: { code: "IDENTITY_TOKEN_INVALID" },
        });
      }

      // Re-presenting the initiator's verifier reattaches exactly once: the
      // failed attempts left the proof collectable.
      const accepted = await api("/api/v1/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          consentVersion: "privacy-safe-telemetry-v0.1",
          syntheticOnly: false,
          identity: {
            provider: "google",
            proof,
            verifier: HOSTED_IDENTITY_TEST_VERIFIER,
          },
        }),
      }, runtimeEnv);
      expect(accepted.status).toBe(201);

      // Single use: the same proof and verifier cannot be spent again.
      const replay = await api("/api/v1/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          consentVersion: "privacy-safe-telemetry-v0.1",
          syntheticOnly: false,
          identity: {
            provider: "google",
            proof,
            verifier: HOSTED_IDENTITY_TEST_VERIFIER,
          },
        }),
      }, runtimeEnv);
      expect(replay.status).toBe(401);
    });

    it("reattaches an existing identity under disabled mode and refuses a new one", async () => {
      // Disabled mode pauses NEW participation only: an identity already
      // linked to a participant signs back in and reattaches; an identity
      // with no link is refused at the enrollment write.
      const linkKey = await sha256Hex("test-hosted-identity\0disabled-reattach");
      const first = await identityEnroll(linkKey);
      expect(first.status).toBe(201);
      const firstBody = await first.json<{ participantId: string }>();

      const disabledEnv = identityBindings({
        ENROLLMENT_MODE: "disabled",
      } as unknown as Partial<Env>);
      const reattached = await identityEnroll(linkKey, "google", disabledEnv);
      expect(reattached.status).toBe(201);
      const reattachedBody = await reattached.json<{ participantId: string }>();
      expect(reattachedBody.participantId).toBe(firstBody.participantId);

      const fresh = await identityEnroll(
        await sha256Hex("test-hosted-identity\0disabled-new-identity"),
        "google",
        disabledEnv,
      );
      expect(fresh.status).toBe(503);
      await expect(fresh.json()).resolves.toMatchObject({
        error: { code: "ENROLLMENT_DISABLED" },
      });

      const count = await testBindings().USAGE_MONITOR_DB.prepare(
        "SELECT COUNT(*) AS total FROM participants",
      ).first<{ total: number }>();
      expect(count?.total).toBe(1);
    });

    it("refuses reattachment during deletion and unlinks after deletion", async () => {
      const subject = "google-subject-deleting";
      const linkKey = await sha256Hex(`test-hosted-identity\0${subject}`);
      const first = await identityEnroll(linkKey);
      expect(first.status).toBe(201);
      const firstBody = await first.json<{ participantId: string }>();
      await testBindings().USAGE_MONITOR_DB.prepare(
        "UPDATE participants SET state = 'deleting' WHERE id = ?",
      ).bind(firstBody.participantId).run();
      const duringDeletion = await identityEnroll(linkKey);
      expect(duringDeletion.status).toBe(409);
      await expect(duringDeletion.json()).resolves.toMatchObject({
        error: { code: "PARTICIPANT_DELETING" },
      });

      const { finishParticipantDeletion } = await import("../src/repository");
      await finishParticipantDeletion(
        testBindings().USAGE_MONITOR_DB,
        firstBody.participantId,
      );
      const afterDeletion = await identityEnroll(linkKey);
      expect(afterDeletion.status).toBe(201);
      const freshBody = await afterDeletion.json<{ participantId: string }>();
      expect(freshBody.participantId).not.toBe(firstBody.participantId);
    });

    it("suppresses immediate hosted re-enrollment and permits it after cooldown expiry", async () => {
      const env = identityBindings();
      const linkKey = await sha256Hex("test-hosted-identity\0cooldown-subject");
      const first = await identityEnroll(linkKey, "google", env);
      expect(first.status).toBe(201);
      const participant = await enrollmentFrom(first);

      const deleted = await api("/api/v1/me", {
        method: "DELETE",
        headers: personalHeaders(participant, { csrf: true }),
      }, env);
      expect(deleted.status).toBe(200);

      const cooldown = await env.DELETION_LEDGER.prepare(
        `SELECT identity_cooldown_digest, deleted_at, retain_until
           FROM identity_reenrollment_cooldowns`,
      ).first<{
        identity_cooldown_digest: string;
        deleted_at: string;
        retain_until: string;
      }>();
      expect(cooldown?.identity_cooldown_digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(cooldown?.deleted_at).toMatch(/Z$/u);
      expect(cooldown?.retain_until).toMatch(/Z$/u);
      expect(JSON.stringify(cooldown)).not.toContain(linkKey);
      const cooldownDigest = await identityReenrollmentCooldownDigest(
        configuredIdentityLinkSecret(env),
        linkKey,
      );
      expect(cooldown?.identity_cooldown_digest).toBe(cooldownDigest);
      const primaryCooldown = await env.USAGE_MONITOR_DB.prepare(
        `SELECT identity_cooldown_digest, deleted_at, retain_until
           FROM identity_reenrollment_cooldowns`,
      ).first<{
        identity_cooldown_digest: string;
        deleted_at: string;
        retain_until: string;
      }>();
      expect(primaryCooldown?.identity_cooldown_digest).toBe(cooldownDigest);
      expect(primaryCooldown?.deleted_at).toMatch(/Z$/u);
      expect(primaryCooldown?.retain_until).toMatch(/Z$/u);
      expect(JSON.stringify(primaryCooldown)).not.toContain(linkKey);
      await expect(hasIdentityReenrollmentCooldown(
        env.DELETION_LEDGER,
        linkKey,
        env.IDENTITY_LINK_SECRET,
      )).resolves.toBe(true);
      await expect(hasIdentityReenrollmentCooldownDigest(
        env.USAGE_MONITOR_DB,
        cooldownDigest,
      )).resolves.toBe(true);

      const immediate = await identityEnroll(linkKey, "google", env);
      expect(immediate.status).toBe(409);
      await expect(immediate.json()).resolves.toMatchObject({
        error: { code: "IDENTITY_REENROLLMENT_COOLDOWN" },
      });

      await env.DELETION_LEDGER.prepare(
        `UPDATE identity_reenrollment_cooldowns
            SET deleted_at = ?, retain_until = ?`,
      ).bind(
        "2026-01-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
      ).run();
      await env.USAGE_MONITOR_DB.prepare(
        `UPDATE identity_reenrollment_cooldowns
            SET deleted_at = ?, retain_until = ?`,
      ).bind(
        "2026-01-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
      ).run();
      await expect(hasIdentityReenrollmentCooldown(
        env.DELETION_LEDGER,
        linkKey,
        env.IDENTITY_LINK_SECRET,
        Date.parse("2026-08-04T00:00:00.000Z"),
      )).resolves.toBe(false);
      await expect(purgeExpiredIdentityReenrollmentCooldowns(
        env.DELETION_LEDGER,
        Date.parse("2026-08-04T00:00:00.000Z"),
      )).resolves.toEqual({ purged: 1, complete: true });
      await expect(purgeExpiredPrimaryIdentityReenrollmentCooldowns(
        env.USAGE_MONITOR_DB,
        Date.parse("2026-08-04T00:00:00.000Z"),
      )).resolves.toEqual({ purged: 1, complete: true });
      const afterExpiry = await identityEnroll(linkKey, "google", env);
      expect(afterExpiry.status).toBe(201);
      const fresh = await afterExpiry.json<{ participantId: string }>();
      expect(fresh.participantId).not.toBe(participant.participantId);
    });

    it("enforces the primary cooldown at the participant INSERT boundary", async () => {
      const env = identityBindings();
      const linkKey = await sha256Hex("test-hosted-identity\\0insert-boundary");
      const first = await identityEnroll(linkKey, "google", env);
      expect(first.status).toBe(201);
      const participant = await enrollmentFrom(first);
      const cooldownDigest = await identityReenrollmentCooldownDigest(
        configuredIdentityLinkSecret(env),
        linkKey,
      );

      // Model the vulnerable interleaving precisely: the request observed an
      // active participant, deletion then persisted its primary marker and
      // removed the unique link row before the request reached enroll(). No
      // external-ledger marker is present in this test, so only primary D1 can
      // reject it.
      await env.USAGE_MONITOR_DB.prepare(
        "UPDATE participants SET state = 'deleting' WHERE id = ?",
      ).bind(participant.participantId).run();
      await recordPrimaryIdentityReenrollmentCooldown(
        env.USAGE_MONITOR_DB,
        cooldownDigest,
      );
      const { enroll: enrollParticipant, finishParticipantDeletion } =
        await import("../src/repository");
      await finishParticipantDeletion(
        env.USAGE_MONITOR_DB,
        participant.participantId,
      );

      await expect(enrollParticipant(
        env.USAGE_MONITOR_DB,
        "privacy-safe-telemetry-v0.1",
        null,
        {
          identityLinkKey: linkKey,
          identityCooldownDigest: cooldownDigest,
        },
      )).rejects.toThrow("identity reenrollment cooldown active");
      const afterDirectInsert = await env.USAGE_MONITOR_DB.prepare(
        "SELECT COUNT(*) AS total FROM participants",
      ).first<{ total: number }>();
      expect(afterDirectInsert?.total).toBe(0);

      const throughHandler = await identityEnroll(linkKey, "google", env);
      expect(throughHandler.status).toBe(409);
      await expect(throughHandler.json()).resolves.toMatchObject({
        error: { code: "IDENTITY_REENROLLMENT_COOLDOWN" },
      });
    });

    it("writes both cooldown copies before restore replay removes a hosted link", async () => {
      const env = identityBindings();
      const linkKey = await sha256Hex("test-hosted-identity\\0restore-replay");
      const first = await identityEnroll(linkKey, "google", env);
      expect(first.status).toBe(201);
      const participant = await enrollmentFrom(first);
      const now = Date.now();
      await recordDeletionTombstone(
        env.DELETION_LEDGER,
        participant.participantId,
        now,
      );

      const lifecycle = await runBackendLifecycle(
        env.USAGE_MONITOR_DB,
        env.DELETION_LEDGER,
        env.QUARANTINE,
        now,
        undefined,
        configuredIdentityLinkSecret(env),
        false,
      );
      expect(lifecycle.restoredParticipantsSuppressed).toBe(1);
      const cooldownDigest = await identityReenrollmentCooldownDigest(
        configuredIdentityLinkSecret(env),
        linkKey,
      );
      for (const database of [env.USAGE_MONITOR_DB, env.DELETION_LEDGER]) {
        await expect(hasIdentityReenrollmentCooldownDigest(
          database,
          cooldownDigest,
        )).resolves.toBe(true);
      }
    });

    it("keeps the synthetic development identity path usable without the hosted secret", async () => {
      const env = identityBindings({ IDENTITY_LINK_SECRET: undefined });
      const linkKey = await sha256Hex("test-development-identity-without-secret");
      const first = await identityEnroll(linkKey, "google", env);
      expect(first.status).toBe(201);
      const participant = await enrollmentFrom(first);
      const deleted = await api("/api/v1/me", {
        method: "DELETE",
        headers: personalHeaders(participant, { csrf: true }),
      }, env);
      expect(deleted.status).toBe(200);
      const second = await identityEnroll(linkKey, "google", env);
      expect(second.status).toBe(201);
    });
  });
});
